/**
 * Credential handling for the secondary-installation bootstrap: AES-GCM and HMAC helpers that are
 * byte-compatible with the API Worker, and the choice of which primary cloud credential to copy.
 */
import type { D1Like } from './bootstrap-staging-installation';

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
 * Pick the cloud credential to copy, in order: an enabled platform GCP credential, a user GCP
 * service-account-key credential, then any other enabled platform cloud credential.
 *
 * GCP workload-identity credentials are skipped: Google trusts the primary installation's token
 * issuer (`https://api.<primary domain>`), which this installation cannot sign for. A row that
 * fails to decrypt is skipped and logged, never fatal on its own (rule 41).
 */
export async function selectSourceCloudCredential(
  source: D1Like,
  sourceKey: string,
  log: (message: string) => void
): Promise<SelectedCloudCredential | null> {
  const platformRows = await source.all<EncryptedRow>(
    `SELECT id, provider, encrypted_token, iv FROM platform_credentials
     WHERE credential_type = 'cloud-provider' AND is_enabled = 1 AND provider IS NOT NULL
     ORDER BY CASE WHEN provider = 'gcp' THEN 0 ELSE 1 END, updated_at DESC, id`
  );
  const userGcpRows = await source.all<EncryptedRow>(
    `SELECT id, provider, encrypted_token, iv FROM credentials
     WHERE credential_type = 'cloud-provider' AND provider = 'gcp' AND is_active = 1
       AND project_id IS NULL
     ORDER BY updated_at DESC, id`
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
