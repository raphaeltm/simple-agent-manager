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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import * as TOML from '@iarna/toml';

import type { WranglerToml } from '../deploy/types.js';
import { ensureCelldBinary, resolveEsbuild } from './celld-binary.js';
import { buildCelldConfig, type CelldWranglerConfig } from './celld-config.js';
import { ASSETS_DIR, prepareCelldProject, SOURCE_LINK, writeCelldConfig } from './celld-project.js';
import { ensurePlatformKeys, GATEWAY_KEY_NAMES } from './platform-keys.js';
import { assertPrivateFile, parseDotenv, readSecretsFile, writePrivateFile } from './secret-files.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const API_DIR = join(REPO_ROOT, 'apps/api');
const WEB_DIR = join(REPO_ROOT, 'apps/web');

const DEFAULT_MIGRATION_ATTEMPTS = 10;
const DEFAULT_MIGRATION_RETRY_DELAY_MS = 3000;
const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_CELLD_PORT = '8080';

/** Box settings `celld` needs on the deploying machine, read from the compose .env file. */
const STORAGE_ENV_KEYS = ['CELLD_BUCKET', 'S3_ENDPOINT', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const;

/**
 * Box settings frps also reads from the compose .env; the Worker must see the same values or
 * the leased ports and frps's allowPorts fence disagree. Passed as Worker vars when set.
 */
const SHARED_BOX_VARS = ['REVERSE_TUNNEL_PORT_RANGE_START', 'REVERSE_TUNNEL_PORT_RANGE_END'] as const;

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

/** Runs a command with output streamed to the console and also captured. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO_ROOT): RunResult {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output };
}

function buildWeb(baseDomain: string): string {
  log(`building apps/web for https://api.${baseDomain}`);
  const env = { ...process.env, VITE_API_URL: `https://api.${baseDomain}` };
  const result = spawnSync('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@simple-agent-manager/web'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('apps/web build failed');
  return join(WEB_DIR, 'dist');
}

/** `celld d1 migrations apply` needs a node holding a lease; right after boot it may not yet. */
async function applyMigrations(celld: string, databaseName: string, projectDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const attempts = intEnv('SELFHOST_MIGRATION_ATTEMPTS', DEFAULT_MIGRATION_ATTEMPTS);
  const delay = intEnv('SELFHOST_MIGRATION_RETRY_DELAY_MS', DEFAULT_MIGRATION_RETRY_DELAY_MS);
  for (let attempt = 1; ; attempt += 1) {
    log(`applying D1 migrations: ${databaseName} (attempt ${attempt}/${attempts})`);
    const result = run(celld, ['d1', 'migrations', 'apply', databaseName, projectDir, '--bucket', env.CELLD_BUCKET!], env);
    if (result.status === 0) return;
    if (attempt >= attempts || !/no node leases/i.test(result.output)) {
      throw new Error(`celld d1 migrations apply ${databaseName} failed (exit ${result.status})`);
    }
    log('no celld node holds a lease yet; is `docker compose up -d` running? retrying');
    await sleep(delay);
  }
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
    await sleep(2000);
  }
  throw new Error(`API Worker did not become healthy on 127.0.0.1:${port}: ${last}`);
}

function redact(config: CelldWranglerConfig, secretNames: Set<string>): CelldWranglerConfig {
  const vars = Object.fromEntries(
    Object.entries(config.vars).map(([key, value]) => [key, secretNames.has(key) ? '<redacted>' : value])
  );
  return { ...config, vars };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string', default: join(REPO_ROOT, 'deploy/selfhost/.env') },
      'state-dir': { type: 'string' },
      secrets: { type: 'string' },
      'web-dist': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      init: { type: 'boolean', default: false },
    },
  });
  const envFile = resolve(values['env-file']!);
  // The .env holds the bucket credential, which can read every deployed secret.
  assertPrivateFile(envFile);
  const box = parseDotenv(readFileSync(envFile, 'utf8'), envFile);
  // Same default and base directory docker compose uses for SAM_SELFHOST_STATE_DIR.
  const stateDir = resolve(dirname(envFile), values['state-dir'] ?? box.SAM_SELFHOST_STATE_DIR ?? '.state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const secretsPath = resolve(values.secrets ?? join(stateDir, 'secrets.env'));
  const projectDir = join(stateDir, 'project');
  const baseDomain = box.SAM_DOMAIN;
  if (!baseDomain) throw new Error(`${envFile}: SAM_DOMAIN is required`);
  if (!box.CELLD_BUCKET) throw new Error(`${envFile}: CELLD_BUCKET is required`);

  const { keys, generated } = ensurePlatformKeys(join(stateDir, 'platform-keys.json'));
  if (generated.length > 0) log(`generated platform keys: ${generated.join(', ')} (back up ${stateDir})`);
  // docker compose passes this file to frps and Caddy (env_file); rewritten only on change.
  const gatewayEnv = GATEWAY_KEY_NAMES.map((name) => `${name}=${keys[name]}\n`).join('');
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

  const source = TOML.parse(readFileSync(join(API_DIR, 'wrangler.toml'), 'utf8')) as WranglerToml;
  const plan = buildCelldConfig(source, {
    main: `${SOURCE_LINK}/index.ts`,
    baseDomain,
    assetsDirectory: ASSETS_DIR,
    vars: {
      SAM_INSTALLATION_ID,
      VAPID_SUBJECT: `https://app.${baseDomain}`,
      ...Object.fromEntries(SHARED_BOX_VARS.filter((key) => box[key]).map((key) => [key, box[key]!])),
    },
  });
  for (const line of plan.report) log(line);
  const withSecrets: CelldWranglerConfig = { ...plan.config, vars: { ...plan.config.vars, ...secrets } };

  if (values['dry-run']) {
    console.log(JSON.stringify(redact(withSecrets, new Set(Object.keys(secrets))), null, 2));
    return;
  }

  const webDist = values['web-dist'] ? resolve(values['web-dist']) : buildWeb(baseDomain);
  prepareCelldProject({ apiDir: API_DIR, projectDir, plan, webDist });

  const celld = await ensureCelldBinary(join(stateDir, 'bin'));
  const env: NodeJS.ProcessEnv = { ...process.env, CELLD_ESBUILD: resolveEsbuild(API_DIR) };
  for (const key of STORAGE_ENV_KEYS) {
    if (box[key]) env[key] = box[key];
    else delete env[key];
  }

  // The secrets-free config is what stays on disk: migrations and operator `celld d1`/`kv`
  // commands read it. Migrations run before the new Worker version, as on Cloudflare.
  writeCelldConfig(projectDir, plan.config);
  for (const db of plan.config.d1_databases) await applyMigrations(celld, db.database_name, projectDir, env);

  // spawnSync blocks the event loop, so a Ctrl-C lands here after celld exits; `finally`
  // alone would not run on a signal.
  const scrub = (): void => {
    writeCelldConfig(projectDir, plan.config);
    process.exit(130);
  };
  process.once('SIGINT', scrub);
  process.once('SIGTERM', scrub);
  writeCelldConfig(projectDir, withSecrets);
  try {
    log(`celld deploy ${plan.config.name}`);
    const result = run(celld, ['deploy', projectDir, '--bucket', env.CELLD_BUCKET!], env);
    if (result.status !== 0) throw new Error(`celld deploy failed (exit ${result.status})`);
  } finally {
    writeCelldConfig(projectDir, plan.config);
    process.off('SIGINT', scrub);
    process.off('SIGTERM', scrub);
  }

  await waitForHealth(box.CELLD_PORT || DEFAULT_CELLD_PORT, baseDomain);
  log(`deployed: https://app.${baseDomain} (API https://api.${baseDomain})`);
}

main().catch((error: unknown) => {
  console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
