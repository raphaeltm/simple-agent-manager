/**
 * EXPERIMENT (E3) — migration backfill: today's schema → three primitives.
 *
 * This proves there is a deterministic, NON-DESTRUCTIVE pathway from the current
 * single-table credential model into the Credential / Configuration / Attachment
 * model from E2, without breaking any existing deployment.
 *
 * Today the secret, the consumer binding, and the scope all live on ONE row:
 *
 *   credentials(user_id, project_id, credential_type, agent_type, provider,
 *               credential_kind, is_active, encrypted_token, iv)
 *   platform_credentials(credential_type, agent_type, provider, credential_kind,
 *               is_enabled, encrypted_token, iv)
 *
 * The backfill fans each row out into the three primitives:
 *
 *   credential row  ──►  1 Credential   (the agent-agnostic secret)
 *                   ──►  1 Configuration (consumer + credential ref + settings)
 *                   ──►  1 Attachment    (user-default OR project-override scope)
 *
 *   platform row    ──►  1 Credential
 *                   ──►  1 Configuration  registered as a PlatformDefault
 *
 * Two invariants the backfill MUST preserve (otherwise it would change runtime
 * behavior and break deployments):
 *
 *   - Rule 28: an INACTIVE project-scoped credential row becomes an INACTIVE
 *     project Attachment. The E2 resolver halts on it (does NOT fall through to
 *     the user scope), reproducing getDecryptedAgentKey()'s inactive-row halt.
 *   - Identical secrets owned by one user (same encrypted_token+iv) collapse into
 *     ONE Credential — the decoupling the whole model is built around — while the
 *     per-consumer Configurations keep them wired exactly as before.
 *
 * This module is PURE over row metadata. It never decrypts or moves ciphertext;
 * the real migration would carry encrypted_token/iv into the new credentials
 * table verbatim. The dry-run (backfill-dryrun.ts) feeds it live, read-only,
 * NON-SECRET staging row metadata and reports the resulting primitive counts.
 */

import type {
  Attachment,
  Configuration,
  Credential,
  CredentialKind,
  CompositionSnapshot,
  PlatformDefault,
} from './types';
import { consumerKey } from './types';

// ---------------------------------------------------------------------------
// Source row shapes — NON-SECRET projection of today's tables
// ---------------------------------------------------------------------------

/** A `credentials` row, secret material replaced by an opaque fingerprint. */
export interface SourceCredentialRow {
  id: string;
  userId: string;
  /** null = user scope; set = project override scope. */
  projectId: string | null;
  credentialType: 'agent-api-key' | 'cloud-provider';
  /** Set for agent rows ('claude-code', ...); null for cloud rows. */
  agentType: string | null;
  provider: string;
  credentialKind: 'api-key' | 'oauth-token';
  isActive: boolean;
  /**
   * Stable identifier for the underlying secret WITHOUT exposing it — distinct
   * secrets get distinct fingerprints; identical secrets share one. The dry-run
   * derives this from a GROUP BY on (user_id, encrypted_token, iv) so ciphertext
   * never leaves D1.
   */
  secretFingerprint: string;
}

/** A `platform_credentials` row, secret material replaced by a fingerprint. */
export interface SourcePlatformRow {
  id: string;
  credentialType: 'agent-api-key' | 'cloud-provider';
  agentType: string | null;
  provider: string | null;
  credentialKind: 'api-key' | 'oauth-token';
  isEnabled: boolean;
  secretFingerprint: string;
}

// ---------------------------------------------------------------------------
// Backfill result + edge-case report
// ---------------------------------------------------------------------------

/**
 * The structural backfill output. `credentials` here carry a placeholder secret
 * (the dry-run does not decrypt) — only the shape, kind, and dedup matter.
 */
export interface BackfillResult {
  snapshot: CompositionSnapshot;
  report: BackfillReport;
}

export interface BackfillReport {
  sourceCredentialRows: number;
  sourcePlatformRows: number;
  /** Distinct secrets after dedup — <= sourceCredentialRows when secrets are shared. */
  producedCredentials: number;
  producedConfigurations: number;
  producedAttachments: number;
  producedPlatformDefaults: number;
  /** User rows whose secret is shared across >1 configuration (the decoupling win). */
  sharedSecretGroups: number;
  /** Inactive project rows — become halting project Attachments (Rule 28 preserved). */
  inactiveProjectRows: number;
  /** Rows skipped because metadata was malformed (reported, never silently dropped). */
  skipped: { rowId: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Kind mapping
// ---------------------------------------------------------------------------

/**
 * Derive the E2 CredentialKind from today's (credential_type, credential_kind).
 *
 * Today only api-key / oauth-token / cloud-provider exist. The richer kinds the
 * E2 model adds — 'openai-compatible' (z.ai) and 'auth-json' (Codex) — have no
 * representation in the current schema yet, so they never arise from a backfill.
 * They are introduced going forward, not migrated.
 */
export function mapKind(
  credentialType: 'agent-api-key' | 'cloud-provider',
  credentialKind: 'api-key' | 'oauth-token',
): CredentialKind {
  if (credentialType === 'cloud-provider') return 'cloud-provider';
  return credentialKind === 'oauth-token' ? 'oauth-token' : 'api-key';
}

function credentialName(row: SourceCredentialRow): string {
  if (row.credentialType === 'cloud-provider') return `${row.provider} (migrated)`;
  return `${row.agentType ?? row.provider} ${row.credentialKind} (migrated)`;
}

// ---------------------------------------------------------------------------
// The backfill
// ---------------------------------------------------------------------------

export function backfill(
  credentialRows: SourceCredentialRow[],
  platformRows: SourcePlatformRow[],
): BackfillResult {
  const skipped: { rowId: string; reason: string }[] = [];

  // --- Pass 1: dedup secrets into Credentials -------------------------------
  // Identical secrets owned by one user (same fingerprint) collapse into ONE
  // Credential. We key by (userId, secretFingerprint).
  const credentialBySecret = new Map<string, Credential>();
  // Tracks which configurations reference each credential, to count the
  // shared-secret groups (the decoupling the model exists to enable).
  const configCountByCredential = new Map<string, number>();

  function credentialFor(row: SourceCredentialRow): Credential | null {
    if (row.credentialType === 'agent-api-key' && !row.agentType) {
      skipped.push({ rowId: row.id, reason: 'agent-api-key row missing agent_type' });
      return null;
    }
    const key = `${row.userId}::${row.secretFingerprint}`;
    const existing = credentialBySecret.get(key);
    if (existing) return existing;
    const credential: Credential = {
      // Scope the id by owner — identical secret bytes owned by DIFFERENT users
      // are distinct Credentials and must not collide onto one id.
      id: `cred-${row.userId}-${row.secretFingerprint}`,
      ownerId: row.userId,
      name: credentialName(row),
      kind: mapKind(row.credentialType, row.credentialKind),
      // Dry-run placeholder — the real migration carries encrypted_token/iv.
      secret: placeholderSecret(mapKind(row.credentialType, row.credentialKind)),
      isActive: true, // credential-level active; row.isActive becomes attachment state
    };
    credentialBySecret.set(key, credential);
    return credential;
  }

  // --- Pass 2: one Configuration + one Attachment per source row ------------
  const configurations: Configuration[] = [];
  const attachments: Attachment[] = [];
  let inactiveProjectRows = 0;

  for (const row of credentialRows) {
    const credential = credentialFor(row);
    if (!credential) continue;

    configCountByCredential.set(
      credential.id,
      (configCountByCredential.get(credential.id) ?? 0) + 1,
    );

    const consumer =
      row.credentialType === 'cloud-provider'
        ? ({ kind: 'compute', provider: row.provider } as const)
        : ({ kind: 'agent', agentType: row.agentType as string } as const);

    const configuration: Configuration = {
      id: `cfg-${row.id}`,
      ownerId: row.userId,
      name: `${credentialName(row)} → ${consumerKey(consumer)}`,
      consumer,
      credentialId: credential.id,
      settings: {},
      isActive: true,
    };
    configurations.push(configuration);

    const attachment: Attachment =
      row.projectId === null
        ? {
            id: `att-${row.id}`,
            configurationId: configuration.id,
            consumer,
            target: { scope: 'user', userId: row.userId },
            isActive: row.isActive,
          }
        : {
            id: `att-${row.id}`,
            configurationId: configuration.id,
            consumer,
            target: { scope: 'project', userId: row.userId, projectId: row.projectId },
            // Rule 28: an inactive project row becomes an inactive project
            // Attachment. The resolver halts on it — does NOT fall through.
            isActive: row.isActive,
          };
    if (row.projectId !== null && !row.isActive) inactiveProjectRows++;
    attachments.push(attachment);
  }

  // --- Pass 3: platform rows become PlatformDefaults ------------------------
  const platform: Record<string, PlatformDefault> = {};
  let producedPlatformDefaults = 0;
  const platformCredentials: Credential[] = [];

  for (const row of platformRows) {
    if (!row.isEnabled) continue; // disabled platform creds are not a default
    const consumer =
      row.credentialType === 'cloud-provider'
        ? row.provider
          ? ({ kind: 'compute', provider: row.provider } as const)
          : null
        : row.agentType
          ? ({ kind: 'agent', agentType: row.agentType } as const)
          : null;
    if (!consumer) {
      skipped.push({ rowId: row.id, reason: 'platform row missing provider/agent_type' });
      continue;
    }
    const credential: Credential = {
      id: `plat-cred-${row.secretFingerprint}`,
      ownerId: '__platform__',
      name: `platform ${consumerKey(consumer)} (migrated)`,
      kind: mapKind(row.credentialType, row.credentialKind),
      secret: placeholderSecret(mapKind(row.credentialType, row.credentialKind)),
      isActive: true,
    };
    platformCredentials.push(credential);
    platform[consumerKey(consumer)] = { mode: 'credential', credential };
    producedPlatformDefaults++;
  }

  const sharedSecretGroups = [...configCountByCredential.values()].filter((n) => n > 1).length;

  const snapshot: CompositionSnapshot = {
    credentials: [...credentialBySecret.values(), ...platformCredentials],
    configurations,
    attachments,
    platform,
  };

  return {
    snapshot,
    report: {
      sourceCredentialRows: credentialRows.length,
      sourcePlatformRows: platformRows.length,
      producedCredentials: credentialBySecret.size,
      producedConfigurations: configurations.length,
      producedAttachments: attachments.length,
      producedPlatformDefaults,
      sharedSecretGroups,
      inactiveProjectRows,
      skipped,
    },
  };
}

/** Structural placeholder — the dry-run never decrypts real secret material. */
function placeholderSecret(kind: CredentialKind): Credential['secret'] {
  switch (kind) {
    case 'api-key':
      return { kind: 'api-key', apiKey: '__migrated__' };
    case 'oauth-token':
      return { kind: 'oauth-token', token: '__migrated__' };
    case 'openai-compatible':
      return { kind: 'openai-compatible', apiKey: '__migrated__', baseUrl: '__migrated__' };
    case 'cloud-provider':
      return { kind: 'cloud-provider', provider: '__migrated__', token: '__migrated__' };
    case 'auth-json':
      return { kind: 'auth-json', authJson: '__migrated__' };
  }
}
