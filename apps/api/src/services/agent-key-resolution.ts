/**
 * Agent credential resolution for workspaces: which key an agent runs with.
 *
 * Moved out of `routes/credentials.ts` (which re-exports these) so the
 * resolution chain lives in one service module. Every caller that picks an
 * agent credential for a run passes the same `ProfileCredentialContext`
 * (`services/composable-credentials/profile-context.ts`), so the agent-key
 * callback and provider-limit admission cannot disagree.
 */
import type {
  AgentCredentialScope,
  CredentialKind,
  CredentialSource,
  Dialect,
} from '@simple-agent-manager/shared';
import {
  credentialOwnerFromSource,
  credentialScopeFromSource,
  DIALECT_VALUES,
} from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { hasUserCCData, lazyBackfillIfNeeded } from './composable-credentials/lazy-backfill';
import type { ProfileCredentialContext } from './composable-credentials/profile-context';
import { explainForConsumer, resolveForConsumer } from './composable-credentials/resolve';
import { decrypt } from './encryption';
import { getPlatformAgentCredential } from './platform-credentials';

/** The resolved agent credential, in the shape the agent-key callback returns. */
export interface ResolvedAgentKey {
  credential: string;
  credentialKind: CredentialKind;
  credentialSource: CredentialSource;
  /** Which tier chose it; `credentialSource` says who owns it. */
  credentialScope: AgentCredentialScope;
  credentialReference: string;
  credentialProvider?: string;
  baseUrl?: string;
  providerDialect?: Dialect;
}

/**
 * Get the decrypted agent credential a run uses.
 *
 * Resolution order (composable-credentials PRIMARY, old path FALLBACK):
 *   1. CC resolver: profile pin → project pin → user default → platform default
 *   2. If cc_* tables are empty for user, lazy-backfill from legacy tables, retry
 *   3. If CC still returns nothing, fall back to legacy single-table lookup
 *
 * Rule 28: an unusable profile or project pin halts resolution. A halt is
 * definitive: it never falls back to the legacy table, which has no profile
 * pins and would silently hand out the user's default instead.
 */
export async function getDecryptedAgentKey(
  db: ReturnType<typeof drizzle>,
  userId: string,
  agentType: string,
  encryptionKey: string,
  projectId?: string | null,
  profile?: ProfileCredentialContext | null
): Promise<ResolvedAgentKey | null> {
  // --- Primary path: composable-credentials resolver -------------------------
  const ccResult = await resolveAgentKeyViaCC(
    db,
    userId,
    agentType,
    encryptionKey,
    projectId,
    profile
  );
  if (ccResult !== undefined) return ccResult;

  // --- Fallback: legacy single-table lookup ----------------------------------
  return resolveAgentKeyLegacy(db, userId, agentType, encryptionKey, projectId);
}

/** Admission reads current selection without lazy backfill or credential writes. */
export async function getSelectedAgentCredentialReference(
  db: ReturnType<typeof drizzle>,
  userId: string,
  agentType: string,
  encryptionKey: string,
  projectId: string,
  profile?: ProfileCredentialContext | null
): Promise<string | null> {
  const trace = await explainForConsumer(
    db,
    userId,
    encryptionKey,
    { kind: 'agent', agentType },
    projectId,
    profile
  );
  if (trace.halted) return null;
  const resolved = trace.resolved;
  if (resolved && resolved.source !== 'platform' && resolved.source !== 'platform-proxy') {
    return mapResolvedToLegacy(resolved)?.credentialReference ?? null;
  }
  // Match lazy-backfill precedence without performing credential writes. Once
  // CC data exists, a platform-only result is authoritative, just as injection.
  if (!resolved || !(await hasUserCCData(db, userId))) {
    const legacy = await resolveAgentKeyLegacy(db, userId, agentType, encryptionKey, projectId);
    if (legacy && legacy.credentialSource !== 'platform') return legacy.credentialReference;
  }
  return null;
}

/**
 * Try composable-credentials resolution with lazy backfill.
 * Returns:
 *   - the resolved credential (or null for a Rule 28 halt) when CC has data
 *   - `undefined` when CC has no data and fallback should be attempted
 */
async function resolveAgentKeyViaCC(
  db: ReturnType<typeof drizzle>,
  userId: string,
  agentType: string,
  encryptionKey: string,
  projectId?: string | null,
  profile?: ProfileCredentialContext | null
): Promise<ResolvedAgentKey | null | undefined> {
  const consumer = { kind: 'agent' as const, agentType };

  // First attempt with current cc_* data
  const first = await explainForConsumer(db, userId, encryptionKey, consumer, projectId, profile);
  // A halt comes from a pin row, so cc_* already holds this user's data: the halt
  // is the answer. Falling through to legacy would replace it with the default.
  if (first.halted) return null;
  let resolved = first.resolved;

  // A platform-tier first resolution must NOT pre-empt lazy backfill + the user's own
  // (higher-precedence) credentials. If the user's agent credential still lives only in the
  // legacy tables and a matching ENABLED platform default exists, the first resolve returns
  // the platform default (Tier 3) and the original `if (!resolved)` guard skipped backfill —
  // leaving cc_* empty, skipping the legacy fallback, and 404ing the user's own credential at
  // the VM agent for non-'sam' provider modes. Treat a platform-only hit like a miss: backfill
  // migrates the user's legacy credential into a Tier 1/2 attachment that out-precedes the
  // platform default on re-resolution.
  const platformOnly =
    resolved !== null && (resolved.source === 'platform' || resolved.source === 'platform-proxy');

  if (!resolved || platformOnly) {
    const didBackfill = await lazyBackfillIfNeeded(db, userId);
    if (didBackfill) {
      const reResolved = await resolveForConsumer(
        db,
        userId,
        encryptionKey,
        consumer,
        projectId,
        profile
      );
      if (platformOnly) {
        // cc_* is now authoritative for this user. Commit to the re-resolved result —
        // including a Rule 28 null halt (inactive project attachment) — rather than the
        // platform default we started with. Do not fall back to legacy after backfill.
        return reResolved ? mapResolvedToLegacy(reResolved) : null;
      }
      // First resolution was a genuine miss — preserve original null-path semantics.
      resolved = reResolved;
    } else if (!resolved) {
      // cc_* tables already had data but no match — this is a definitive "no credential"
      // from the CC model. However, the user may have legacy data that wasn't backfilled
      // for this specific consumer (e.g. cloud-provider credentials used as agent fallback).
      // Let the legacy path handle those edge cases.
      return undefined;
    }
    // else: platformOnly && !didBackfill — cc_* already reflects this user, so the platform
    // default is authoritative. Fall through and return it.
  }

  if (!resolved) return undefined;

  return mapResolvedToLegacy(resolved);
}

/**
 * Map a CC ResolvedEnvironment to the legacy getDecryptedAgentKey return shape.
 */
function mapResolvedToLegacy(
  resolved: NonNullable<Awaited<ReturnType<typeof resolveForConsumer>>>
): ResolvedAgentKey | null {
  // Platform proxy — no raw credential to return
  if (resolved.source === 'platform-proxy' || !resolved.credential) {
    return null;
  }

  const secret = resolved.credential.secret;
  let credential = '';
  let credentialKind: CredentialKind = 'api-key';

  switch (secret.kind) {
    case 'api-key':
      credential = secret.apiKey;
      credentialKind = 'api-key';
      break;
    case 'oauth-token':
      credential = secret.token;
      credentialKind = 'oauth-token';
      break;
    case 'auth-json':
      credential = secret.authJson;
      if (resolved.consumer.kind !== 'agent' || resolved.consumer.agentType !== 'openai-codex') {
        return null;
      }
      // auth-json is a file-style credential (Codex ~/.codex/auth.json), so
      // preserve the VM agent's auth-file injection path rather than treating
      // the JSON blob as an API key env var.
      credentialKind = 'oauth-token';
      break;
    case 'openai-compatible':
      credential = secret.apiKey;
      credentialKind = 'api-key';
      break;
    case 'cloud-provider':
      // Agent consumers should not receive cloud-provider secrets
      return null;
  }

  const credentialSource = credentialOwnerFromSource(resolved.source);
  const credentialReference = resolved.credential.id
    ? `cc_credentials:${resolved.credential.id}`
    : `cc_credentials:${resolved.source}`;
  const settings = resolved.configuration?.settings ?? {};
  const settingsBaseUrl =
    typeof settings.baseUrl === 'string' && settings.baseUrl.trim() !== ''
      ? settings.baseUrl.trim()
      : undefined;
  const providerDialect =
    readProviderDialect(settings.dialect) ??
    (secret.kind === 'openai-compatible' ? 'openai-compatible' : undefined);
  const baseUrl =
    settingsBaseUrl ??
    (secret.kind === 'openai-compatible' && secret.baseUrl ? secret.baseUrl : undefined);

  return {
    credential,
    credentialKind,
    credentialSource,
    credentialScope: credentialScopeFromSource(resolved.source),
    credentialReference,
    credentialProvider: providerDialect ?? resolved.consumer.kind,
    ...(baseUrl ? { baseUrl } : {}),
    ...(providerDialect ? { providerDialect } : {}),
  };
}

function readProviderDialect(value: unknown): Dialect | undefined {
  return typeof value === 'string' && (DIALECT_VALUES as readonly string[]).includes(value)
    ? (value as Dialect)
    : undefined;
}

/**
 * Legacy single-table credential resolution (fallback when CC has no data).
 * Preserves the original Rule 28 invariant.
 */
async function resolveAgentKeyLegacy(
  db: ReturnType<typeof drizzle>,
  userId: string,
  agentType: string,
  encryptionKey: string,
  projectId?: string | null
): Promise<ResolvedAgentKey | null> {
  // 1. Project-scoped credential (Rule 28: inactive blocks fallthrough)
  if (projectId) {
    const projectCreds = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.projectId, projectId),
          eq(schema.credentials.credentialType, 'agent-api-key'),
          eq(schema.credentials.agentType, agentType)
        )
      )
      .limit(1);

    const projectCred = projectCreds[0];
    if (projectCred) {
      if (projectCred.isActive) {
        const credential = await decrypt(projectCred.encryptedToken, projectCred.iv, encryptionKey);
        return {
          credential,
          credentialKind: projectCred.credentialKind as CredentialKind,
          credentialSource: 'project',
          credentialScope: 'project',
          credentialReference: `credentials:${projectCred.id}`,
          credentialProvider: agentType,
        };
      }
      return null;
    }
  }

  // 2. User-scoped credential
  const userCreds = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        isNull(schema.credentials.projectId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, agentType),
        eq(schema.credentials.isActive, true)
      )
    )
    .limit(1);

  const foundCred = userCreds[0];
  if (foundCred) {
    const credential = await decrypt(foundCred.encryptedToken, foundCred.iv, encryptionKey);
    return {
      credential,
      credentialKind: foundCred.credentialKind as CredentialKind,
      credentialSource: 'user',
      credentialScope: 'user',
      credentialReference: `credentials:${foundCred.id}`,
      credentialProvider: agentType,
    };
  }

  // 3. Platform credential
  const platformCred = await getPlatformAgentCredential(db, agentType, encryptionKey);
  if (platformCred) {
    return {
      credential: platformCred.credential,
      credentialKind: platformCred.credentialKind as CredentialKind,
      credentialSource: 'platform',
      credentialScope: 'platform',
      credentialReference: `platform_credentials:${platformCred.credentialId}`,
      credentialProvider: agentType,
    };
  }

  return null;
}
