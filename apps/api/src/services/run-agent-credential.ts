/**
 * The stored agent credential a workspace run is actually using, for the paths
 * that write back into it: the Codex refresh proxy (`CodexRefreshLock`) and the
 * post-session credential sync (`POST /api/workspaces/:id/agent-credential-sync`).
 *
 * Both used to re-derive "the credential" from the legacy `credentials` table
 * (project row, else the active user row). That table knows nothing about
 * account pins made through `/api/cc/attachments` or `cc_profile_attachments`,
 * so a run seeded with a pinned account refreshed against, and wrote over, the
 * user's default account instead.
 *
 * Resolution is not re-implemented here. The agent-key callback records the
 * credential it seeded each session with (`agent_sessions.agent_credential_reference`,
 * written by `persistAgentCredentialAttribution` from `getDecryptedAgentKey`).
 * When a workspace has no recorded reference, the same cc resolver the
 * agent-key callback uses picks it (`getSelectedAgentCredentialReference`).
 *
 * Write-back is a compare-and-set on the exact ciphertext that was read. The
 * `(encrypted_token, iv)` pair is the identity of one stored credential
 * generation across the legacy and cc stores: every dual-write copies the
 * ciphertext verbatim (`syncAgentCredentialToCC`, the cc backfill fingerprint,
 * `makeAgentAccountDefault`), and a fresh random IV makes two encryptions of
 * different secrets indistinguishable from nothing. Mirroring by that pair can
 * therefore only ever touch copies of the account being rotated.
 */
import type { CredentialKind } from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { getSelectedAgentCredentialReference } from './agent-key-resolution';
import { ccKindForAgentCredential } from './composable-credentials/agent-sync';
import { resolveSessionProfileCredentialContext } from './composable-credentials/profile-context';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Safety cap on distinct recorded credentials considered for one workspace run.
 * Each reference names one of the user's own credential rows, so real workspaces
 * hold one or two; the cap only bounds the per-candidate reads in a pathological
 * case, keeping the most recently used.
 */
export const RUN_CREDENTIAL_CANDIDATE_LIMIT = 20;

export type RunCredentialTable = 'cc_credentials' | 'credentials';

/** A stored credential row a run may write rotated tokens into. */
export interface RunAgentCredential {
  /** `cc_credentials:<id>` or `credentials:<id>`, as recorded on the agent session. */
  reference: string;
  table: RunCredentialTable;
  id: string;
  encryptedToken: string;
  iv: string;
  isActive: boolean;
}

interface CredentialRowRef {
  table: RunCredentialTable;
  id: string;
}

/**
 * Parse a recorded credential reference into a writable row, or null when the
 * reference names something a workspace never writes into (platform
 * credentials, the platform proxy).
 */
export function parseRunCredentialReference(reference: unknown): CredentialRowRef | null {
  // Recorded references come from D1 rows; a malformed value (wrong type) is skipped,
  // never thrown on, so one bad row cannot fail a refresh for the valid ones.
  if (typeof reference !== 'string' || !reference) return null;
  for (const table of ['cc_credentials', 'credentials'] as const) {
    const prefix = `${table}:`;
    if (reference.startsWith(prefix)) {
      const id = reference.slice(prefix.length);
      return id ? { table, id } : null;
    }
  }
  return null;
}

/**
 * References of the credentials this workspace's runs of `agentType` were seeded
 * with, most recently used first. Falls back to the agent-key resolver when no
 * session recorded one. Never falls back to "the user's default": an empty list
 * means there is nothing this run may refresh or overwrite.
 */
export async function resolveRunAgentCredentialReferences(
  db: Db,
  database: D1Database,
  encryptionKey: string,
  input: { workspaceId: string; userId: string; projectId: string | null; agentType: string }
): Promise<string[]> {
  // Every recorded attribution counts, including platform ones: a workspace whose runs
  // were seeded by the platform proxy must not fall back to whatever personal default
  // the user configures later. Sessions still running rank first so the cap can only
  // drop references of runs that have ended.
  const recorded = await database
    .prepare(
      `SELECT agent_credential_reference AS reference,
              MAX(CASE WHEN agent_credential_source = 'platform' THEN 1 ELSE 0 END) AS platform,
              MAX(CASE WHEN status IN ('running', 'recovery') THEN 1 ELSE 0 END) AS live,
              MAX(updated_at) AS last_used
         FROM agent_sessions
        WHERE workspace_id = ?
          AND user_id = ?
          AND agent_type = ?
          AND agent_credential_reference IS NOT NULL
        GROUP BY agent_credential_reference
        ORDER BY live DESC, last_used DESC, agent_credential_reference
        LIMIT ?`
    )
    .bind(input.workspaceId, input.userId, input.agentType, RUN_CREDENTIAL_CANDIDATE_LIMIT + 1)
    .all<{ reference: unknown; platform: number; live: number }>();
  const rows = recorded.results ?? [];
  if (rows.length > RUN_CREDENTIAL_CANDIDATE_LIMIT) {
    log.warn('run_credential.candidates_truncated', {
      workspaceId: input.workspaceId,
      agentType: input.agentType,
      limit: RUN_CREDENTIAL_CANDIDATE_LIMIT,
    });
  }
  const references: string[] = [];
  for (const row of rows.slice(0, RUN_CREDENTIAL_CANDIDATE_LIMIT)) {
    if (row.platform === 1) continue;
    if (parseRunCredentialReference(row.reference) && typeof row.reference === 'string') {
      references.push(row.reference);
    } else {
      log.warn('run_credential.reference_skipped', {
        workspaceId: input.workspaceId,
        agentType: input.agentType,
        referenceType: typeof row.reference,
      });
    }
  }
  if (references.length > 0) {
    if (rows.some((row) => row.live === 1)) return references;
    // Only ended sessions recorded a reference, yet a run is calling. It may be one
    // agent-key could not attribute (no running D1 session to record it on), seeded
    // with whatever was selected then. Add the current selection so an ended run's
    // reference never answers alone for it: possession or account matching decides,
    // and a second candidate closes the refresh proxy's stale path.
    const selected = await selectedRunCredentialReference(db, encryptionKey, input);
    return selected && !references.includes(selected) ? [...references, selected] : references;
  }
  // Something was recorded but none of it is writable (platform proxy, malformed):
  // the run has no credential of its own to refresh.
  if (rows.length > 0) return [];

  const selected = await selectedRunCredentialReference(db, encryptionKey, input);
  return selected ? [selected] : [];
}

/** The writable reference agent-key would seed a new run of this workspace with now. */
async function selectedRunCredentialReference(
  db: Db,
  encryptionKey: string,
  input: { workspaceId: string; userId: string; projectId: string | null; agentType: string }
): Promise<string | null> {
  const profile = await resolveSessionProfileCredentialContext(db, {
    workspaceId: input.workspaceId,
  });
  const selected = await getSelectedAgentCredentialReference(
    db,
    input.userId,
    input.agentType,
    encryptionKey,
    input.projectId,
    profile
  );
  return parseRunCredentialReference(selected) && selected ? selected : null;
}

/**
 * Read the referenced row, bound to its owner and to the agent's credential kind.
 * Returns null when the row is missing or belongs to someone else.
 */
export async function loadRunAgentCredential(
  database: D1Database,
  input: {
    userId: string;
    reference: string;
    agentType: string;
    credentialKind: CredentialKind;
  }
): Promise<RunAgentCredential | null> {
  const ref = parseRunCredentialReference(input.reference);
  if (!ref) return null;

  const row =
    ref.table === 'cc_credentials'
      ? await database
          .prepare(
            `SELECT id, owner_id AS owner, encrypted_token, iv, is_active
               FROM cc_credentials
              WHERE id = ? AND owner_id = ? AND ${CC_KIND_PREDICATE}`
          )
          .bind(ref.id, input.userId, ...ccKindBinds(input.agentType, input.credentialKind))
          .first<CredentialRow>()
      : await database
          .prepare(
            `SELECT id, user_id AS owner, encrypted_token, iv, is_active
               FROM credentials
              WHERE id = ? AND user_id = ? AND ${LEGACY_KIND_PREDICATE}`
          )
          .bind(ref.id, input.userId, input.agentType, input.credentialKind)
          .first<CredentialRow>();

  // Defence in depth (rule 28): the predicate already binds the owner.
  if (!row || row.owner !== input.userId) return null;
  return {
    reference: input.reference,
    table: ref.table,
    id: row.id,
    encryptedToken: row.encrypted_token,
    iv: row.iv,
    isActive: row.is_active === 1,
  };
}

/**
 * Store rotated ciphertext into `target`, compare-and-set on the ciphertext that
 * was read, then rotate every other copy of that exact credential generation
 * (legacy or cc, same owner). The mirror statements only apply when the primary
 * write did, so a lost compare-and-set writes nothing anywhere.
 *
 * `guard` adds a condition to the primary write (the sync route binds it to the
 * workspace callback identity; that guard joins `nodes`, so it assumes the
 * workspace has a node, which every callback-active workspace does).
 */
export async function writeRotatedAgentCredential(
  database: D1Database,
  input: {
    userId: string;
    agentType: string;
    credentialKind: CredentialKind;
    target: RunAgentCredential;
    next: { encryptedToken: string; iv: string };
    guard?: { sql: string; binds: unknown[] };
  }
): Promise<{ applied: boolean; mirroredRows: number; mirroredReferences: string[] }> {
  const { target, next } = input;
  const now = new Date().toISOString();
  const ownerColumn = target.table === 'cc_credentials' ? 'owner_id' : 'user_id';
  const kindPredicate =
    target.table === 'cc_credentials' ? CC_KIND_PREDICATE : LEGACY_KIND_PREDICATE;
  const kindBinds =
    target.table === 'cc_credentials'
      ? ccKindBinds(input.agentType, input.credentialKind)
      : [input.agentType, input.credentialKind];
  const primaryApplied = `EXISTS (
    SELECT 1 FROM ${target.table}
     WHERE id = ? AND encrypted_token = ? AND iv = ?
  )`;
  const primaryAppliedBinds = [target.id, next.encryptedToken, next.iv];

  const primary = database
    .prepare(
      `UPDATE ${target.table}
          SET encrypted_token = ?, iv = ?, updated_at = ?
        WHERE id = ? AND ${ownerColumn} = ? AND ${kindPredicate}
          AND is_active = 1
          AND encrypted_token = ? AND iv = ?
          ${input.guard ? `AND ${input.guard.sql}` : ''}`
    )
    .bind(
      next.encryptedToken,
      next.iv,
      now,
      target.id,
      input.userId,
      ...kindBinds,
      target.encryptedToken,
      target.iv,
      ...(input.guard?.binds ?? [])
    );
  const ccMirror = database
    .prepare(
      `UPDATE cc_credentials
          SET encrypted_token = ?, iv = ?, updated_at = ?
        WHERE owner_id = ? AND id != ? AND ${CC_KIND_PREDICATE}
          AND encrypted_token = ? AND iv = ?
          AND ${primaryApplied}
        RETURNING id`
    )
    .bind(
      next.encryptedToken,
      next.iv,
      now,
      input.userId,
      target.id,
      ...ccKindBinds(input.agentType, input.credentialKind),
      target.encryptedToken,
      target.iv,
      ...primaryAppliedBinds
    );
  const legacyMirror = database
    .prepare(
      `UPDATE credentials
          SET encrypted_token = ?, iv = ?, updated_at = ?
        WHERE user_id = ? AND id != ? AND ${LEGACY_KIND_PREDICATE}
          AND encrypted_token = ? AND iv = ?
          AND ${primaryApplied}
        RETURNING id`
    )
    .bind(
      next.encryptedToken,
      next.iv,
      now,
      input.userId,
      target.id,
      input.agentType,
      input.credentialKind,
      target.encryptedToken,
      target.iv,
      ...primaryAppliedBinds
    );

  const [primaryResult, ccResult, legacyResult] = await database.batch([
    primary,
    ccMirror,
    legacyMirror,
  ]);
  const idsOf = (result: D1Result | undefined): string[] =>
    (result?.results ?? []).flatMap((row) => {
      const id = maybeJsonRecord(row)?.id;
      return typeof id === 'string' ? [id] : [];
    });
  const mirroredReferences = [
    ...idsOf(ccResult).map((id) => `cc_credentials:${id}`),
    ...idsOf(legacyResult).map((id) => `credentials:${id}`),
  ];
  return {
    applied: (primaryResult?.meta.changes ?? 0) === 1,
    mirroredRows: mirroredReferences.length,
    mirroredReferences,
  };
}

/**
 * Identity of one stored credential generation: a digest of its exact ciphertext.
 * Grace entries are bound to the generation a rotation wrote, so a row that is
 * replaced (another account) or rotated again no longer honours them.
 */
export async function credentialGenerationFingerprint(
  encryptedToken: string,
  iv: string
): Promise<string> {
  const data = new TextEncoder().encode(`${encryptedToken}:${iv}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The parts of a Codex auth.json that identify its account and token family. */
export interface CodexAuthIdentity {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
}

/** Parse a Codex auth.json without throwing; null when it is not a JSON object. */
export function parseCodexAuth(authJson: string): {
  auth: Record<string, unknown>;
  identity: CodexAuthIdentity;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  const auth = maybeJsonRecord(parsed);
  if (!auth) return null;
  const tokens = maybeJsonRecord(auth.tokens) ?? {};
  const read = (key: string) => (typeof tokens[key] === 'string' ? tokens[key] : undefined);
  return {
    auth,
    identity: {
      accessToken: read('access_token'),
      refreshToken: read('refresh_token'),
      idToken: read('id_token'),
      accountId: read('account_id'),
    },
  };
}

interface CredentialRow {
  id: string;
  owner: string;
  encrypted_token: string;
  iv: string;
  is_active: number;
}

// Codex auth.json lives in cc as kind 'auth-json'; older backfilled rows use
// 'oauth-token' (mirrors `ccKindForAgentCredential` and the cc assembler).
const CC_KIND_PREDICATE = `(kind = ? OR (? = 'auth-json' AND kind = 'oauth-token'))`;
const LEGACY_KIND_PREDICATE = `credential_type = 'agent-api-key' AND agent_type = ? AND credential_kind = ?`;

function ccKindBinds(agentType: string, credentialKind: CredentialKind): [string, string] {
  const kind = ccKindForAgentCredential(agentType, credentialKind);
  return [kind, kind];
}
