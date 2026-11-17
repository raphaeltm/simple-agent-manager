/**
 * Idempotent bootstrap for a secondary staging installation (see staging-installations.mjs).
 *
 * It seeds what needs no secret value: an admin and a non-admin test user (fixed IDs, so an agent
 * sign-in trust can name them), both opted into the SAM AI proxy for Claude Code. Nothing else.
 *
 * It never reads a secret out of Pulumi, never decrypts or copies a stored credential, and never
 * derives a secret from another installation's (policy 795e72a6,
 * `.claude/rules/83-no-secret-readback-in-ci.md`). An admin adds the installation's platform
 * cloud credential and agent key by hand in Admin → Credentials and picks machines in Admin →
 * Infrastructure; the agent sign-in trust comes from the installation's own GitHub secret
 * (`AGENT_SIGN_IN_TRUST_<INSTALLATION>`, see configure-secrets.sh). The manual steps are in
 * `.agent-instructions/reference/rules/13-staging-verification-full.md`, "Two Staging
 * Installations".
 *
 * Every write is keyed on a fixed ID and safe to repeat. The script refuses to run unless the
 * installation is a registered secondary installation of the given non-production environment,
 * and it writes only to the D1 database carrying that installation's registered name.
 *
 * Usage (from the deploy workflow):
 *   pnpm tsx scripts/deploy/bootstrap-staging-installation.ts
 */
import { appendFileSync } from 'node:fs';

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

/**
 * Agents the test users reach through the SAM AI proxy (providerMode 'sam'), the only way a
 * platform agent key is used. The key itself is added by an admin; until then sessions with
 * these agents fail with a missing-key error.
 */
export const BOOTSTRAP_PROXY_AGENT_TYPES: readonly string[] = ['claude-code'];

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

/** The D1 database name a secondary installation's deploy creates (`<prefix>-<stack>`). */
export function installationDatabaseName(installation: string): string {
  const entry = SECONDARY_INSTALLATIONS[installation];
  if (!entry) throw new Error(`'${installation}' is not a registered secondary installation.`);
  return `${entry.resourcePrefix}-${entry.stack}`;
}

export interface BootstrapInput {
  installation: string;
  environment: string;
  baseDomain: string;
  target: D1Like;
  now?: Date;
  log?: (message: string) => void;
}

export interface BootstrapReport {
  users: string[];
  /** Agent types the test users reach through the SAM AI proxy. */
  proxyAgents: string[];
}

export async function bootstrapInstallation(input: BootstrapInput): Promise<BootstrapReport> {
  const log = input.log ?? ((message: string) => console.log(message));
  assertSecondaryInstallation(input);
  const nowMs = (input.now ?? new Date()).getTime();
  const users = bootstrapUsers(input.installation, input.baseDomain);

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

  // Once per user and agent; a setting a user later changes is left alone.
  for (const agentType of BOOTSTRAP_PROXY_AGENT_TYPES) {
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

  return { users: users.map((user) => user.id), proxyAgents: [...BOOTSTRAP_PROXY_AGENT_TYPES] };
}

// ---------------------------------------------------------------------------
// Cloudflare D1 HTTP client and CLI
// ---------------------------------------------------------------------------

/** Remote text must never form a GitHub workflow command: drop control characters and `::`. */
export function safeForWorkflowLog(text: string): string {
  return Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : ch;
  })
    .join('')
    .replaceAll('::', ': :');
}

function cloudflareAccountUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
}

export function cloudflareD1(input: {
  accountId: string;
  apiToken: string;
  databaseId: string;
  fetchImpl?: typeof fetch;
}): D1Like {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${cloudflareAccountUrl(input.accountId)}/d1/database/${encodeURIComponent(input.databaseId)}/query`;
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

/** The ID of the one D1 database with exactly this name; fails closed on none or several. */
export async function findDatabaseIdByName(input: {
  accountId: string;
  apiToken: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${cloudflareAccountUrl(input.accountId)}/d1/database?name=${encodeURIComponent(input.name)}`,
    { headers: { Authorization: `Bearer ${input.apiToken}` } }
  );
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    result?: Array<{ uuid?: string; name?: string }>;
  } | null;
  if (!response.ok || !body?.success) {
    throw new Error(`Could not list D1 databases named ${input.name} (HTTP ${response.status}).`);
  }
  // The name filter is a match, not an equality: keep exact names only.
  const exact = (body.result ?? []).filter((db) => db.name === input.name && db.uuid);
  if (exact.length !== 1) {
    throw new Error(
      `Expected exactly one D1 database named ${input.name}, found ${exact.length}; refusing to bootstrap.`
    );
  }
  return exact[0].uuid as string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const installation = requireEnv('INSTALLATION');
  const environment = requireEnv('DEPLOY_ENVIRONMENT');
  const baseDomain = requireEnv('BASE_DOMAIN');
  assertSecondaryInstallation({ installation, environment, baseDomain });
  const accountId = requireEnv('CF_ACCOUNT_ID');
  const apiToken = requireEnv('CF_API_TOKEN');
  const databaseName = installationDatabaseName(installation);
  const databaseId = await findDatabaseIdByName({ accountId, apiToken, name: databaseName });
  const report = await bootstrapInstallation({
    installation,
    environment,
    baseDomain,
    target: cloudflareD1({ accountId, apiToken, databaseId }),
  });
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(
      summary,
      [
        `### Bootstrap of ${installation}`,
        `- Database: ${databaseName}`,
        `- Users: ${report.users.join(', ')}`,
        `- SAM AI proxy opt-in: ${report.proxyAgents.join(', ')}`,
        '- Platform credentials, agent keys, pool machines and the agent sign-in trust are set up by hand (see "Two Staging Installations").',
        '',
      ].join('\n')
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    // Messages can carry text from remote responses; never let it form a workflow command.
    const message = safeForWorkflowLog(error instanceof Error ? error.message : String(error));
    console.error(`::error::${message}`);
    process.exit(1);
  });
}
