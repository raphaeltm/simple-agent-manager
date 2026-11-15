/**
 * Credential handling for the secondary-installation bootstrap: AES-GCM and HMAC helpers that are
 * byte-compatible with the API Worker, and the choice of which primary cloud credential to copy.
 */
import type { BootstrapInput, D1Like } from './bootstrap-staging-installation';

// ---------------------------------------------------------------------------
// Crypto, byte-compatible with apps/api/src/services/encryption.ts (AES-256-GCM, no AAD) and
// the token-login HMAC in apps/api/src/routes/api-tokens.ts.
// ---------------------------------------------------------------------------

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

export async function encryptToken(
  plaintext: string,
  keyBase64: string
): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey('raw', base64ToBytes(keyBase64), 'AES-GCM', false, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  };
}

export async function decryptToken(
  ciphertext: string,
  iv: string,
  keyBase64: string
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base64ToBytes(keyBase64), 'AES-GCM', false, [
    'decrypt',
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}

export async function hmacApiToken(rawToken: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawToken));
  return Buffer.from(signature).toString('hex');
}

// ---------------------------------------------------------------------------
// Cloud credential selection
// ---------------------------------------------------------------------------

interface EncryptedRow {
  id: string;
  provider: string | null;
  encrypted_token: string;
  iv: string;
}

export interface SelectedCloudCredential {
  provider: string;
  plaintext: string;
  sourceTable: 'platform_credentials' | 'credentials';
  sourceId: string;
  authType: string | null;
}

/** Bound on the owner list bound into one statement (D1 allows 100 parameters). */
const MAX_TEST_ACCOUNT_OWNERS = 20;

function gcpAuthType(plaintext: string): string | null {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (parsed && typeof parsed === 'object' && 'authType' in parsed) {
      const value = (parsed as { authType: unknown }).authType;
      return typeof value === 'string' ? value : null;
    }
  } catch {
    // Not JSON: treated as an unknown auth type below.
  }
  return null;
}

/**
 * Pick the cloud credential to copy, in order: an enabled platform GCP credential, a GCP
 * service-account-key credential of one of the primary's designated test accounts, then any
 * other enabled platform cloud credential.
 *
 * User credentials are considered only for `testAccountUserIds`: the accounts the primary's agent
 * sign-in trust already names as test targets. Any other person's credential is never copied
 * into a shared platform credential.
 *
 * GCP workload-identity credentials are skipped: Google trusts the primary installation's token
 * issuer (`https://api.<primary domain>`), which this installation cannot sign for. A row that
 * fails to decrypt is skipped and logged, never fatal on its own (rule 41).
 */
export async function selectSourceCloudCredential(
  source: D1Like,
  sourceKey: string,
  log: (message: string) => void,
  testAccountUserIds: string[] = []
): Promise<SelectedCloudCredential | null> {
  const platformRows = await source.all<EncryptedRow>(
    `SELECT id, provider, encrypted_token, iv FROM platform_credentials
     WHERE credential_type = 'cloud-provider' AND is_enabled = 1 AND provider IS NOT NULL
     ORDER BY CASE WHEN provider = 'gcp' THEN 0 ELSE 1 END, updated_at DESC, id`
  );
  const owners = testAccountUserIds.slice(0, MAX_TEST_ACCOUNT_OWNERS);
  const userGcpRows =
    owners.length === 0
      ? []
      : await source.all<EncryptedRow>(
          `SELECT id, provider, encrypted_token, iv FROM credentials
           WHERE credential_type = 'cloud-provider' AND provider = 'gcp' AND is_active = 1
             AND project_id IS NULL AND user_id IN (${owners.map(() => '?').join(', ')})
           ORDER BY updated_at DESC, id`,
          owners
        );

  const decryptOrSkip = async (row: EncryptedRow, table: string): Promise<string | null> => {
    try {
      return await decryptToken(row.encrypted_token, row.iv, sourceKey);
    } catch (error) {
      log(
        `skip ${table} ${row.id} (${row.provider ?? 'unknown'}): cannot decrypt (${error instanceof Error ? error.name : 'error'})`
      );
      return null;
    }
  };

  const usable = async (
    row: EncryptedRow,
    table: SelectedCloudCredential['sourceTable']
  ): Promise<SelectedCloudCredential | null> => {
    const plaintext = await decryptOrSkip(row, table);
    if (plaintext === null || !row.provider) return null;
    const authType = row.provider === 'gcp' ? gcpAuthType(plaintext) : null;
    if (row.provider === 'gcp' && authType !== 'service-account-key') {
      log(`skip ${table} ${row.id} (gcp): auth type ${authType ?? 'unknown'} is not portable`);
      return null;
    }
    return { provider: row.provider, plaintext, sourceTable: table, sourceId: row.id, authType };
  };

  for (const row of platformRows.filter((r) => r.provider === 'gcp')) {
    const picked = await usable(row, 'platform_credentials');
    if (picked) return picked;
  }
  for (const row of userGcpRows) {
    const picked = await usable(row, 'credentials');
    if (picked) return picked;
  }
  for (const row of platformRows.filter((r) => r.provider !== 'gcp')) {
    const picked = await usable(row, 'platform_credentials');
    if (picked) return picked;
  }
  return null;
}

export function bootstrapAgentKeyId(installation: string, agentType: string): string {
  return `${installation}-bootstrap-agent-${agentType}`;
}

/**
 * Copy every enabled platform API-key agent credential of the primary (one per agent type, newest
 * first), so sessions on this installation have an agent to talk to. OAuth kinds are skipped: a
 * rotating refresh token shared by two installations is revoked as a family when one of them
 * replays it. A disabled copy stays disabled; only its ciphertext follows the primary. A row that cannot be decrypted is
 * skipped and logged (rule 41); no key at all is not fatal, agents then need their own key.
 */
export async function copyPlatformAgentKeys(
  input: BootstrapInput,
  adminId: string,
  nowIso: string,
  log: (message: string) => void
): Promise<string[]> {
  const rows = await input.source.all<{
    id: string;
    agent_type: string | null;
    credential_kind: string;
    encrypted_token: string;
    iv: string;
  }>(
    `SELECT id, agent_type, credential_kind, encrypted_token, iv FROM platform_credentials
     WHERE credential_type = 'agent-api-key' AND is_enabled = 1 AND agent_type IS NOT NULL
       AND credential_kind = 'api-key'
     ORDER BY agent_type, updated_at DESC, id`
  );
  const copied: string[] = [];
  for (const row of rows) {
    const agentType = row.agent_type as string;
    if (copied.includes(agentType)) continue;
    if (!/^[a-z0-9-]{1,40}$/u.test(agentType)) {
      log(`skip agent key ${row.id}: unexpected agent type`);
      continue;
    }
    let plaintext: string;
    try {
      plaintext = await decryptToken(row.encrypted_token, row.iv, input.sourceCredentialKey);
    } catch (error) {
      log(
        `skip agent key ${row.id} (${agentType}): cannot decrypt (${error instanceof Error ? error.name : 'error'})`
      );
      continue;
    }
    const sealed = await encryptToken(plaintext, input.targetCredentialKey);
    await input.target.run(
      `INSERT INTO platform_credentials
         (id, credential_type, provider, agent_type, credential_kind, label, encrypted_token, iv,
          is_enabled, created_by, created_at, updated_by, updated_at)
       VALUES (?, 'agent-api-key', NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         credential_kind = excluded.credential_kind, encrypted_token = excluded.encrypted_token,
         iv = excluded.iv, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [
        bootstrapAgentKeyId(input.installation, agentType),
        agentType,
        row.credential_kind,
        `Copied from ${input.environment} by bootstrap (${agentType})`,
        sealed.ciphertext,
        sealed.iv,
        adminId,
        nowIso,
        adminId,
        nowIso,
      ]
    );
    copied.push(agentType);
    log(`platform agent key for ${agentType} copied from ${row.id}`);
  }
  return copied;
}
