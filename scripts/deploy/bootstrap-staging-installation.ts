/**
 * Idempotent bootstrap for a secondary staging installation (see staging-installations.mjs).
 *
 * A fresh secondary installation has an empty database. Agents need, with no human clicks:
 *   1. an admin and a non-admin test user (fixed IDs, so the sign-in trust can name them);
 *   2. a platform cloud credential so VMs can be provisioned, copied from the primary
 *      installation of the same credential environment (preferring GCP over Hetzner);
 *   3. the staging smoke token, so the deploy's smoke tests also run against this installation;
 *   4. an agent sign-in trust naming the two users (`derive-trust` mode, set as a Worker secret).
 *
 * Every write is keyed on a fixed ID and safe to repeat. The script refuses to run unless the
 * installation is a registered secondary installation of the given non-production environment.
 * Secret values are never printed: logs carry IDs, providers and auth types only.
 *
 * Usage (from the deploy workflow):
 *   pnpm tsx scripts/deploy/bootstrap-staging-installation.ts derive-trust
 *   pnpm tsx scripts/deploy/bootstrap-staging-installation.ts bootstrap
 */
import { appendFileSync } from 'node:fs';

import { SECONDARY_INSTALLATIONS } from './staging-installations.mjs';

/** The two statements the bootstrap needs from a D1 database. */
export interface D1Like {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
}

export interface BootstrapUser {
  id: string;
  email: string;
  name: string;
  role: 'superadmin' | 'user';
}

export function bootstrapUsers(installation: string, baseDomain: string): BootstrapUser[] {
  return [
    {
      id: `${installation}-agent-admin`,
      email: `agent-admin@${baseDomain}`,
      name: `${installation} agent admin`,
      role: 'superadmin',
    },
    {
      id: `${installation}-agent-user`,
      email: `agent-user@${baseDomain}`,
      name: `${installation} agent user`,
      role: 'user',
    },
  ];
}

/**
 * Fail closed unless `installation` is a registered secondary installation of the given
 * non-production environment, deployed at its registered domain.
 */
export function assertSecondaryInstallation(input: {
  installation: string;
  environment: string;
  baseDomain: string;
}): void {
  const { installation, environment, baseDomain } = input;
  if (/prod/iu.test(environment) || /prod/iu.test(installation)) {
    throw new Error('The staging bootstrap never runs against production.');
  }
  if (!Object.hasOwn(SECONDARY_INSTALLATIONS, installation)) {
    throw new Error(`'${installation}' is not a registered secondary installation.`);
  }
  const entry = SECONDARY_INSTALLATIONS[installation];
  if (entry.credentialEnvironment !== environment) {
    throw new Error(
      `'${installation}' belongs to the '${entry.credentialEnvironment}' environment, not '${environment}'.`
    );
  }
  if (entry.baseDomain !== baseDomain) {
    throw new Error(`'${installation}' is registered at ${entry.baseDomain}, not ${baseDomain}.`);
  }
}

/**
 * The primary installation's agent sign-in trust, retargeted at this installation's users.
 * Issuer, allowed sources and limits are kept; only `allowedTargets` changes. Returns null when
 * the primary has no trust configured (the feature then stays off here too).
 */
export function deriveAgentSignInTrust(
  sourceJson: string | undefined,
  targetUserIds: string[]
): string | null {
  const raw = (sourceJson ?? '').trim();
  if (raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The primary AGENT_SIGN_IN_TRUST is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The primary AGENT_SIGN_IN_TRUST is not a JSON object.');
  }
  if (targetUserIds.length === 0) {
    throw new Error('At least one sign-in target is required.');
  }
  return JSON.stringify({ ...(parsed as Record<string, unknown>), allowedTargets: targetUserIds });
}

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

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapInput {
  installation: string;
  environment: string;
  baseDomain: string;
  target: D1Like;
  source: D1Like;
  /** The key this installation's Worker decrypts credentials with. */
  targetCredentialKey: string;
  /** The key this installation's Worker hashes API tokens with (ENCRYPTION_KEY). */
  targetEncryptionKey: string;
  /** The key the primary installation's Worker decrypts credentials with. */
  sourceCredentialKey: string;
  smokeTestToken?: string;
  now?: Date;
  log?: (message: string) => void;
}

export interface BootstrapReport {
  users: string[];
  cloudCredential: Omit<SelectedCloudCredential, 'plaintext'> & { targetId: string };
  smokeToken: 'registered' | 'skipped';
}

export function bootstrapCloudCredentialId(installation: string): string {
  return `${installation}-bootstrap-cloud`;
}

export function bootstrapSmokeTokenId(installation: string): string {
  return `${installation}-bootstrap-smoke-token`;
}

export async function bootstrapInstallation(input: BootstrapInput): Promise<BootstrapReport> {
  const log = input.log ?? ((message: string) => console.log(message));
  assertSecondaryInstallation(input);
  const nowMs = (input.now ?? new Date()).getTime();
  const nowIso = new Date(nowMs).toISOString();
  const users = bootstrapUsers(input.installation, input.baseDomain);
  const admin = users[0];

  for (const user of users) {
    await input.target.run(
      `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, 'active', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email, name = excluded.name, role = excluded.role,
         status = 'active', updated_at = excluded.updated_at`,
      [user.id, user.email, user.name, user.role, nowMs, nowMs]
    );
    log(`user ${user.id} (${user.role}) ready`);
  }

  const selected = await selectSourceCloudCredential(input.source, input.sourceCredentialKey, log);
  if (!selected) {
    throw new Error(
      'No portable cloud credential found on the primary installation: VMs could not be provisioned.'
    );
  }
  const encrypted = await encryptToken(selected.plaintext, input.targetCredentialKey);
  const credentialId = bootstrapCloudCredentialId(input.installation);
  // One bootstrap-owned row, rewritten on every run so it follows the primary's credential.
  // Rows an admin adds by hand are left alone.
  await input.target.run(
    `INSERT INTO platform_credentials
       (id, credential_type, provider, agent_type, credential_kind, label, encrypted_token, iv,
        is_enabled, created_by, created_at, updated_by, updated_at)
     VALUES (?, 'cloud-provider', ?, NULL, 'api-key', ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider = excluded.provider, label = excluded.label,
       encrypted_token = excluded.encrypted_token, iv = excluded.iv, is_enabled = 1,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [
      credentialId,
      selected.provider,
      `Copied from ${input.environment} by bootstrap (${selected.provider})`,
      encrypted.ciphertext,
      encrypted.iv,
      admin.id,
      nowIso,
      admin.id,
      nowIso,
    ]
  );
  log(
    `platform cloud credential ${credentialId}: ${selected.provider}${selected.authType ? ` (${selected.authType})` : ''} from ${selected.sourceTable} ${selected.sourceId}`
  );

  let smokeToken: BootstrapReport['smokeToken'] = 'skipped';
  const rawSmokeToken = input.smokeTestToken?.trim();
  if (rawSmokeToken) {
    const tokenHash = await hmacApiToken(rawSmokeToken, input.targetEncryptionKey);
    await input.target.run(
      `INSERT INTO smoke_test_tokens (id, user_id, token_hash, name, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id, token_hash = excluded.token_hash, revoked_at = NULL`,
      [bootstrapSmokeTokenId(input.installation), admin.id, tokenHash, 'Staging smoke tests', nowMs]
    );
    smokeToken = 'registered';
    log(`smoke token registered for ${admin.id}`);
  }

  const { plaintext: _plaintext, ...cloudCredential } = selected;
  return {
    users: users.map((user) => user.id),
    cloudCredential: { ...cloudCredential, targetId: credentialId },
    smokeToken,
  };
}

// ---------------------------------------------------------------------------
// Cloudflare D1 HTTP client and CLI
// ---------------------------------------------------------------------------

export function cloudflareD1(input: {
  accountId: string;
  apiToken: string;
  databaseId: string;
  fetchImpl?: typeof fetch;
}): D1Like {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/d1/database/${encodeURIComponent(input.databaseId)}/query`;
  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: Array<{ results?: T[]; success?: boolean }>;
    } | null;
    if (!response.ok || !body?.success || body.result?.[0]?.success === false) {
      const message = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`;
      throw new Error(`D1 query failed: ${message}`);
    }
    return body.result?.[0]?.results ?? [];
  };
  return {
    all: query,
    run: async (sql, params) => {
      await query(sql, params);
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const installation = requireEnv('INSTALLATION');
  const environment = requireEnv('DEPLOY_ENVIRONMENT');
  const baseDomain = requireEnv('BASE_DOMAIN');
  assertSecondaryInstallation({ installation, environment, baseDomain });

  if (mode === 'derive-trust') {
    const ids = bootstrapUsers(installation, baseDomain).map((user) => user.id);
    const trust = deriveAgentSignInTrust(process.env.SOURCE_AGENT_SIGN_IN_TRUST, ids);
    if (!trust) {
      console.log(
        '::warning::The primary installation has no AGENT_SIGN_IN_TRUST; agent sign-in stays off.'
      );
      return;
    }
    const outputPath = requireEnv('GITHUB_OUTPUT');
    appendFileSync(outputPath, `value=${trust}\n`);
    console.log(`Agent sign-in trust targets: ${ids.join(', ')}`);
    return;
  }

  if (mode === 'bootstrap') {
    const accountId = requireEnv('CF_ACCOUNT_ID');
    const apiToken = requireEnv('CF_API_TOKEN');
    const targetDatabaseId = requireEnv('TARGET_D1_ID');
    const sourceDatabaseId = requireEnv('SOURCE_D1_ID');
    if (targetDatabaseId === sourceDatabaseId) {
      throw new Error('Target and source D1 databases are the same; refusing to bootstrap.');
    }
    const targetEncryptionKey = requireEnv('TARGET_ENCRYPTION_KEY');
    const sourceEncryptionKey = requireEnv('SOURCE_ENCRYPTION_KEY');
    const report = await bootstrapInstallation({
      installation,
      environment,
      baseDomain,
      target: cloudflareD1({ accountId, apiToken, databaseId: targetDatabaseId }),
      source: cloudflareD1({ accountId, apiToken, databaseId: sourceDatabaseId }),
      targetEncryptionKey,
      targetCredentialKey:
        process.env.TARGET_CREDENTIAL_ENCRYPTION_KEY?.trim() || targetEncryptionKey,
      sourceCredentialKey:
        process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY?.trim() || sourceEncryptionKey,
      smokeTestToken: process.env.SMOKE_TEST_TOKEN,
    });
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      appendFileSync(
        summary,
        [
          `### Bootstrap of ${installation}`,
          `- Users: ${report.users.join(', ')}`,
          `- Platform cloud credential: ${report.cloudCredential.provider} from ${report.cloudCredential.sourceTable} ${report.cloudCredential.sourceId}`,
          `- Smoke token: ${report.smokeToken}`,
          '',
        ].join('\n')
      );
    }
    return;
  }

  throw new Error('Usage: bootstrap-staging-installation.ts <derive-trust|bootstrap>');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
