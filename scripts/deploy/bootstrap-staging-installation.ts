/**
 * Idempotent bootstrap for a secondary staging installation (see staging-installations.mjs).
 *
 * A fresh secondary installation has an empty database. Agents need, with no human clicks:
 *   1. an admin and a non-admin test user (fixed IDs, so the sign-in trust can name them);
 *   2. a platform cloud credential so VMs can be provisioned, copied from the primary
 *      installation of the same credential environment (preferring GCP over Hetzner);
 *   3. the staging smoke token, so the deploy's smoke tests also run against this installation,
 *      and the primary's enabled platform agent keys, so sessions have an agent to run;
 *   4. an agent sign-in trust naming the two users (`derive-trust` mode, set as a Worker secret);
 *   5. machines in the shared compute pool (bootstrap-installation-pool.ts), via the admin API.
 *
 * Every write is keyed on a fixed ID and safe to repeat. The script refuses to run unless the
 * installation is a registered secondary installation of the given non-production environment.
 * Secret values are never printed: logs carry IDs, providers and auth types only.
 *
 * Usage (from the deploy workflow):
 *   pnpm tsx scripts/deploy/bootstrap-staging-installation.ts derive-trust
 *   pnpm tsx scripts/deploy/bootstrap-staging-installation.ts bootstrap
 */
import { appendFileSync, writeFileSync } from 'node:fs';

import {
  copyPlatformAgentKeys,
  encryptToken,
  hmacApiToken,
  type SelectedCloudCredential,
  selectSourceCloudCredential,
} from './bootstrap-installation-credentials';
import {
  readPrimaryPoolPicks,
  safeForWorkflowLog,
  seedInstallationPool,
} from './bootstrap-installation-pool';
import {
  SECONDARY_CREDENTIAL_ENVIRONMENTS,
  SECONDARY_INSTALLATIONS,
} from './staging-installations.mjs';

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
  if (
    /prod/iu.test(environment) ||
    /prod/iu.test(installation) ||
    !SECONDARY_CREDENTIAL_ENVIRONMENTS.includes(environment)
  ) {
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

/** Account IDs (not emails, not "*") named as targets by the primary's agent sign-in trust. */
export function primaryTestAccountIds(sourceJson: string | undefined): string[] {
  const raw = (sourceJson ?? '').trim();
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const targets = (parsed as { allowedTargets?: unknown }).allowedTargets;
    if (!Array.isArray(targets)) return [];
    return targets.filter(
      (t): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(t)
    );
  } catch {
    return [];
  }
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
  /** Account IDs the primary's agent sign-in trust names; only their own credentials may be copied. */
  primaryTestAccountIds?: string[];
  now?: Date;
  log?: (message: string) => void;
}

export interface BootstrapReport {
  users: string[];
  cloudCredential: Omit<SelectedCloudCredential, 'plaintext'> & { targetId: string };
  smokeToken: 'registered' | 'skipped';
  /** Agent types whose platform agent key was copied. */
  agentKeys: string[];
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

  // Created once; an admin who later demotes or suspends one of them is not overridden.
  for (const user of users) {
    await input.target.run(
      `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [user.id, user.email, user.name, user.role, nowMs, nowMs]
    );
    log(`user ${user.id} (${user.role}) present`);
  }

  const selected = await selectSourceCloudCredential(
    input.source,
    input.sourceCredentialKey,
    log,
    input.primaryTestAccountIds ?? []
  );
  if (!selected) {
    throw new Error(
      'No portable cloud credential found on the primary installation: VMs could not be provisioned.'
    );
  }
  const encrypted = await encryptToken(selected.plaintext, input.targetCredentialKey);
  const credentialId = bootstrapCloudCredentialId(input.installation);
  // One bootstrap-owned row whose ciphertext follows the primary's credential on every run. An
  // admin who disables it keeps it disabled; rows an admin adds by hand are left alone.
  await input.target.run(
    `INSERT INTO platform_credentials
       (id, credential_type, provider, agent_type, credential_kind, label, encrypted_token, iv,
        is_enabled, created_by, created_at, updated_by, updated_at)
     VALUES (?, 'cloud-provider', ?, NULL, 'api-key', ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider = excluded.provider, label = excluded.label,
       encrypted_token = excluded.encrypted_token, iv = excluded.iv,
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
       ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, token_hash = excluded.token_hash`,
      [bootstrapSmokeTokenId(input.installation), admin.id, tokenHash, 'Staging smoke tests', nowMs]
    );
    // The staging smoke token belongs to staging's superadmin test account, so mapping it to this
    // installation's admin grants its holders nothing they do not already have on staging. A
    // revocation here survives later deploys (revoked_at is never cleared).
    smokeToken = 'registered';
    log(`smoke token registered for ${admin.id}`);
  }

  const agentKeys = await copyPlatformAgentKeys(input, admin.id, nowIso, log);
  // A platform agent key is never handed to a workspace: it is used only through SAM's AI proxy,
  // which each user opts into per agent (providerMode 'sam'). Opt the test users in for every
  // agent whose key was copied, once; a setting a user later changes is left alone.
  for (const agentType of agentKeys) {
    for (const user of users) {
      await input.target.run(
        `INSERT INTO agent_settings (id, user_id, agent_type, provider_mode, created_at, updated_at)
         SELECT ?, ?, ?, 'sam', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM agent_settings WHERE user_id = ? AND agent_type = ?)`,
        [`${user.id}-${agentType}`, user.id, agentType, nowMs, nowMs, user.id, agentType]
      );
    }
    log(`test users use the SAM AI proxy for ${agentType}`);
  }

  return {
    users: users.map((user) => user.id),
    agentKeys,
    // Never the plaintext: the report is printed.
    cloudCredential: {
      provider: selected.provider,
      sourceTable: selected.sourceTable,
      sourceId: selected.sourceId,
      authType: selected.authType,
      targetId: credentialId,
    },
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

/** Refuse to write to a database that is not the installation's own (by its registered name). */
async function assertDatabaseName(
  accountId: string,
  apiToken: string,
  databaseId: string,
  expectedName: string
): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`,
    { headers: { Authorization: `Bearer ${apiToken}` } }
  );
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    result?: { name?: string };
  } | null;
  if (!response.ok || !body?.success || body.result?.name !== expectedName) {
    throw new Error(`Target D1 database is not ${expectedName}; refusing to bootstrap.`);
  }
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
    // A file, not a step output: the value never reaches the log or the run's outputs, and an
    // empty derivation cannot fall back to the primary's trust in the workflow expression.
    console.log(`::add-mask::${trust}`);
    writeFileSync(requireEnv('AGENT_SIGN_IN_TRUST_FILE'), trust, { mode: 0o600 });
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
    const entry = SECONDARY_INSTALLATIONS[installation];
    await assertDatabaseName(
      accountId,
      apiToken,
      targetDatabaseId,
      `${entry.resourcePrefix}-${entry.stack}`
    );
    const targetEncryptionKey = requireEnv('TARGET_ENCRYPTION_KEY');
    const sourceEncryptionKey = requireEnv('SOURCE_ENCRYPTION_KEY');
    const source = cloudflareD1({ accountId, apiToken, databaseId: sourceDatabaseId });
    const report = await bootstrapInstallation({
      installation,
      environment,
      baseDomain,
      target: cloudflareD1({ accountId, apiToken, databaseId: targetDatabaseId }),
      source,
      targetEncryptionKey,
      targetCredentialKey:
        process.env.TARGET_CREDENTIAL_ENCRYPTION_KEY?.trim() || targetEncryptionKey,
      sourceCredentialKey:
        process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY?.trim() || sourceEncryptionKey,
      smokeTestToken: process.env.SMOKE_TEST_TOKEN,
      primaryTestAccountIds: primaryTestAccountIds(process.env.SOURCE_AGENT_SIGN_IN_TRUST),
    });
    // The pool is seeded through the admin API as the bootstrap admin, which signs in with the
    // smoke token registered above. Without that token the pool stays empty: VM work cannot run.
    const smokeTestToken = process.env.SMOKE_TEST_TOKEN?.trim();
    let pool = 'not seeded (no SMOKE_TEST_TOKEN)';
    if (smokeTestToken) {
      const seeded = await seedInstallationPool({
        apiBaseUrl: `https://api.${baseDomain}`,
        appOrigin: `https://app.${baseDomain}`,
        smokeTestToken,
        primaryPicks: await readPrimaryPoolPicks(source),
        credentialId: report.cloudCredential.targetId,
      });
      pool = `${seeded.activated} activated, ${seeded.alreadyActive} already active`;
    } else {
      console.log('::warning::SMOKE_TEST_TOKEN is not set; the installation pool was not seeded.');
    }
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      appendFileSync(
        summary,
        [
          `### Bootstrap of ${installation}`,
          `- Users: ${report.users.join(', ')}`,
          `- Platform cloud credential: ${report.cloudCredential.provider} from ${report.cloudCredential.sourceTable} ${report.cloudCredential.sourceId}`,
          `- Smoke token: ${report.smokeToken}`,
          `- Platform agent keys: ${report.agentKeys.join(', ') || 'none'}`,
          `- Installation pool: ${pool}`,
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
    // Messages can carry text from remote responses; never let it form a workflow command.
    const message = safeForWorkflowLog(error instanceof Error ? error.message : String(error));
    console.error(`::error::${message}`);
    process.exit(1);
  });
}
