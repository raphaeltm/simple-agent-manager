/**
 * Composable Credentials — migration backfill mapper.
 *
 * Deterministic, NON-DESTRUCTIVE pathway from the current single-table model
 * into the three-primitive model. Pure over row metadata — never decrypts or
 * moves ciphertext.
 *
 * The backfill fans each row into:
 *   credential row  →  1 Credential + 1 Configuration + 1 Attachment
 *   platform row    →  1 Credential + 1 PlatformDefault
 *
 * Two invariants preserved:
 *   - Rule 28: inactive project-scoped rows become inactive Attachments
 *   - Secret dedup: identical secrets per owner collapse into ONE Credential
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
  projectId: string | null;
  credentialType: 'agent-api-key' | 'cloud-provider';
  agentType: string | null;
  provider: string;
  credentialKind: 'api-key' | 'oauth-token';
  isActive: boolean;
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

export interface BackfillResult {
  snapshot: CompositionSnapshot;
  report: BackfillReport;
}

export interface BackfillReport {
  sourceCredentialRows: number;
  sourcePlatformRows: number;
  producedCredentials: number;
  producedConfigurations: number;
  producedAttachments: number;
  producedPlatformDefaults: number;
  sharedSecretGroups: number;
  inactiveProjectRows: number;
  skipped: { rowId: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Kind mapping
// ---------------------------------------------------------------------------

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
  const credentialBySecret = new Map<string, Credential>();
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
      id: `cred-${row.userId}-${row.secretFingerprint}`,
      ownerId: row.userId,
      name: credentialName(row),
      kind: mapKind(row.credentialType, row.credentialKind),
      secret: placeholderSecret(mapKind(row.credentialType, row.credentialKind)),
      isActive: true,
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
    if (!row.isEnabled) continue;
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
