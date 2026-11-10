#!/usr/bin/env tsx
/**
 * Deploy (or upgrade) the SAM control plane onto a running celld node.
 *
 *   pnpm selfhost:deploy [--env-file deploy/selfhost/.env] [--state-dir <env dir>/.state]
 *                        [--secrets <state-dir>/secrets.env] [--web-dist DIR] [--dry-run] [--init]
 *
 * `--init` only generates the platform keys and `<state-dir>/gateway.env`, the shared secret
 * docker compose hands to frps and Caddy; run it once before the first `docker compose up`.
 *
 * Re-runnable: platform keys are generated once and kept, the project directory is rebuilt,
 * D1 migrations are applied idempotently, and `celld deploy` publishes a new version that the
 * node adopts in place. celld has no secrets store for real nodes, so secrets are rendered
 * into `vars` for the deploy only; the config left on disk afterwards carries none.
 *
 * The Cloudflare pipeline never runs this script.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import * as TOML from '@iarna/toml';

import type { WranglerToml } from '../deploy/types.js';
import {
  celldChildEnv,
  presignVars,
  redactSecrets,
  renderGatewayEnv,
  resolveTunnelPortRange,
  tunnelRangeVars,
} from './box-settings.js';
import { ensureCelldBinary, resolveEsbuild } from './celld-binary.js';
import { buildCelldConfig, type CelldWranglerConfig } from './celld-config.js';
import { ASSETS_DIR, prepareCelldProject, SOURCE_LINK, writeCelldConfig } from './celld-project.js';
import { ensurePlatformKeys } from './platform-keys.js';
import {
  assertPrivateFile,
  ensurePrivateDir,
  parseDotenv,
  readSecretsFile,
  writePrivateFile,
} from './secret-files.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const API_DIR = join(REPO_ROOT, 'apps/api');
const WEB_DIR = join(REPO_ROOT, 'apps/web');

/** Attempts while the freshly deployed node takes its leases. */
const DEFAULT_MIGRATION_ATTEMPTS = 20;
/** Attempts before the deploy; an upgraded fleet answers at once, a fresh one never does. */
const DEFAULT_PREDEPLOY_MIGRATION_ATTEMPTS = 2;
const DEFAULT_MIGRATION_RETRY_DELAY_MS = 3000;
const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 2000;
/** Upper bound on captured celld output (bundle reports are a few KiB). */
const CHILD_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_CELLD_PORT = '8080';

function log(message: string): void {
  console.log(`[selfhost] ${message}`);
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

interface RunResult {
  status: number;
  output: string;
}

/** Secret values scrubbed from any child output before it is printed. */
let knownSecrets: string[] = [];

/** Runs a command, printing its output (with secret values scrubbed) and capturing it. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO_ROOT): RunResult {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: CHILD_OUTPUT_MAX_BYTES,
  });
  const output = redactSecrets(`${result.stdout ?? ''}${result.stderr ?? ''}`, knownSecrets);
  process.stdout.write(output);
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output };
}

function buildWeb(baseDomain: string): string {
  log(`building apps/web for https://api.${baseDomain}`);
  const env = { ...process.env, VITE_API_URL: `https://api.${baseDomain}` };
  const result = spawnSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'build', '--filter=@simple-agent-manager/web'],
    {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    }
  );
  if (result.status !== 0) throw new Error('apps/web build failed');
  return join(WEB_DIR, 'dist');
}

const NO_LEASES = /no node leases/i;

function bucketOf(env: NodeJS.ProcessEnv): string {
  const bucket = env.CELLD_BUCKET;
  if (!bucket) throw new Error('CELLD_BUCKET is not set');
  return bucket;
}

/**
 * Applies one database's migrations. `celld d1` talks to a node holding a lease, and a node
 * takes leases only once a Worker is deployed, so on a fresh fleet this reports `no-leases`
 * instead of failing; the caller deploys and retries. Other failures throw.
 */
async function applyMigrations(
  celld: string,
  databaseName: string,
  projectDir: string,
  env: NodeJS.ProcessEnv,
  attempts: number
): Promise<'applied' | 'no-leases'> {
  const delay = intEnv('SELFHOST_MIGRATION_RETRY_DELAY_MS', DEFAULT_MIGRATION_RETRY_DELAY_MS);
  for (let attempt = 1; ; attempt += 1) {
    log(`applying D1 migrations: ${databaseName} (attempt ${attempt}/${attempts})`);
    const result = run(
      celld,
      ['d1', 'migrations', 'apply', databaseName, projectDir, '--bucket', bucketOf(env)],
      env
    );
    if (result.status === 0) return 'applied';
    if (!NO_LEASES.test(result.output)) {
      throw new Error(`celld d1 migrations apply ${databaseName} failed (exit ${result.status})`);
    }
    if (attempt >= attempts) return 'no-leases';
    await sleep(delay);
  }
}

async function applyAllMigrations(
  celld: string,
  databases: readonly string[],
  projectDir: string,
  env: NodeJS.ProcessEnv,
  attempts: number
): Promise<'applied' | 'no-leases'> {
  for (const name of databases) {
    if ((await applyMigrations(celld, name, projectDir, env, attempts)) === 'no-leases')
      return 'no-leases';
  }
  return 'applied';
}

async function waitForHealth(port: string, baseDomain: string): Promise<void> {
  const deadline = Date.now() + intEnv('SELFHOST_HEALTH_TIMEOUT_MS', DEFAULT_HEALTH_TIMEOUT_MS);
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { host: `api.${baseDomain}`, 'x-forwarded-proto': 'https' },
      });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(intEnv('SELFHOST_HEALTH_POLL_INTERVAL_MS', DEFAULT_HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`API Worker did not become healthy on 127.0.0.1:${port}: ${last}`);
}

function redact(config: CelldWranglerConfig, secretNames: Set<string>): CelldWranglerConfig {
  const vars = Object.fromEntries(
    Object.entries(config.vars).map(([key, value]) => [
      key,
      secretNames.has(key) ? '<redacted>' : value,
    ])
  );
  return { ...config, vars };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      'state-dir': { type: 'string' },
      secrets: { type: 'string' },
      'web-dist': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      init: { type: 'boolean', default: false },
    },
  });
  const envFile = resolve(values['env-file'] ?? join(REPO_ROOT, 'deploy/selfhost/.env'));
  // The .env holds the bucket credential, which can read every deployed secret.
  assertPrivateFile(envFile);
  const box = parseDotenv(readFileSync(envFile, 'utf8'), envFile);
  // Same default and base directory docker compose uses for SAM_SELFHOST_STATE_DIR.
  const stateDir = resolve(
    dirname(envFile),
    values['state-dir'] ?? box.SAM_SELFHOST_STATE_DIR ?? '.state'
  );
  ensurePrivateDir(stateDir);
  const secretsPath = resolve(values.secrets ?? join(stateDir, 'secrets.env'));
  const projectDir = join(stateDir, 'project');
  const baseDomain = box.SAM_DOMAIN;
  if (!baseDomain) throw new Error(`${envFile}: SAM_DOMAIN is required`);
  if (!box.CELLD_BUCKET) throw new Error(`${envFile}: CELLD_BUCKET is required`);

  const { keys, generated } = ensurePlatformKeys(join(stateDir, 'platform-keys.json'));
  if (generated.length > 0)
    log(`generated platform keys: ${generated.join(', ')} (back up ${stateDir})`);
  // docker compose passes this file to frps and Caddy (env_file); rewritten only on change.
  // The port range goes to the Worker from the same resolved value (below).
  const tunnelRange = resolveTunnelPortRange(box);
  const gatewayEnv = renderGatewayEnv(keys.REVERSE_TUNNEL_GATEWAY_SECRET, tunnelRange);
  const gatewayEnvPath = join(stateDir, 'gateway.env');
  if (!existsSync(gatewayEnvPath) || readFileSync(gatewayEnvPath, 'utf8') !== gatewayEnv) {
    writePrivateFile(gatewayEnvPath, gatewayEnv);
    log(`wrote ${gatewayEnvPath}; (re)start the stack: docker compose up -d`);
  }
  if (values.init) return;
  const operatorSecrets = readSecretsFile(secretsPath);
  for (const name of ['BASE_DOMAIN', 'R2_BUCKET_NAME']) {
    if (name in operatorSecrets) throw new Error(`${secretsPath}: ${name} is generated; remove it`);
  }
  const { SAM_INSTALLATION_ID, ...platformSecrets } = keys;
  const secrets: Record<string, string> = { ...platformSecrets, ...operatorSecrets };
  knownSecrets = Object.values(secrets);

  const source = TOML.parse(readFileSync(join(API_DIR, 'wrangler.toml'), 'utf8')) as WranglerToml;
  const plan = buildCelldConfig(source, {
    main: `${SOURCE_LINK}/index.ts`,
    baseDomain,
    assetsDirectory: ASSETS_DIR,
    vars: {
      SAM_INSTALLATION_ID,
      VAPID_SUBJECT: `https://app.${baseDomain}`,
      ...tunnelRangeVars(tunnelRange),
    },
  });
  // Needs the R2 binding's final bucket name, so it is applied after translation.
  Object.assign(plan.config.vars, presignVars(box, plan.config.vars.R2_BUCKET_NAME ?? ''));
  for (const line of plan.report) log(line);
  const withSecrets: CelldWranglerConfig = {
    ...plan.config,
    vars: { ...plan.config.vars, ...secrets },
  };

  if (values['dry-run']) {
    console.log(JSON.stringify(redact(withSecrets, new Set(Object.keys(secrets))), null, 2));
    return;
  }

  const webDist = values['web-dist'] ? resolve(values['web-dist']) : buildWeb(baseDomain);
  prepareCelldProject({ apiDir: API_DIR, projectDir, plan, webDist });

  const celld = await ensureCelldBinary(join(stateDir, 'bin'));
  const env = celldChildEnv(process.env, box, resolveEsbuild(API_DIR));

  // The secrets-free config is what stays on disk: migrations and operator `celld d1`/`kv`
  // commands read it. On an upgrade, migrations run before the new Worker version, as on
  // Cloudflare. A fresh fleet has no leases until its first deploy, so it migrates after.
  writeCelldConfig(projectDir, plan.config);
  const databases = plan.config.d1_databases.map((db) => db.database_name);
  const preDeploy = await applyAllMigrations(
    celld,
    databases,
    projectDir,
    env,
    intEnv('SELFHOST_PREDEPLOY_MIGRATION_ATTEMPTS', DEFAULT_PREDEPLOY_MIGRATION_ATTEMPTS)
  );
  if (preDeploy === 'no-leases')
    log('no node holds a lease yet (first deploy?); deploying before migrating');

  // spawnSync blocks the event loop, so a signal lands here after celld exits; `finally`
  // alone would not run on one. A SIGKILL or power loss can still leave the secrets-bearing
  // file until the next run rewrites it; it is 0600 in the 0700 state dir, which already holds
  // the same values in platform-keys.json and secrets.env.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
  const scrub = (): void => {
    try {
      writeCelldConfig(projectDir, plan.config);
    } catch (error) {
      console.error(`[selfhost] could not scrub ${projectDir}/wrangler.json: ${String(error)}`);
    }
    process.exit(130);
  };
  for (const signal of signals) process.once(signal, scrub);
  writeCelldConfig(projectDir, withSecrets);
  try {
    log(`celld deploy ${plan.config.name}`);
    const result = run(celld, ['deploy', projectDir, '--bucket', bucketOf(env)], env);
    if (result.status !== 0) throw new Error(`celld deploy failed (exit ${result.status})`);
  } finally {
    writeCelldConfig(projectDir, plan.config);
    for (const signal of signals) process.off(signal, scrub);
  }

  if (preDeploy === 'no-leases') {
    const migrated = await applyAllMigrations(
      celld,
      databases,
      projectDir,
      env,
      intEnv('SELFHOST_MIGRATION_ATTEMPTS', DEFAULT_MIGRATION_ATTEMPTS)
    );
    if (migrated === 'no-leases') {
      throw new Error('no celld node holds a lease; is the stack running (docker compose ps)?');
    }
  }

  await waitForHealth(box.CELLD_PORT || DEFAULT_CELLD_PORT, baseDomain);
  log(`deployed: https://app.${baseDomain} (API https://api.${baseDomain})`);
}

main().catch((error: unknown) => {
  console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
