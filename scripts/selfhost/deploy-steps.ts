/**
 * Small steps of `pnpm selfhost:deploy` (deploy.ts), kept apart so the orchestration stays short.
 */
import { existsSync, readFileSync } from 'node:fs';

import { gatewayEnvAction } from './box-settings.js';
import type { CelldWranglerConfig } from './celld-config.js';
import { writePrivateFile } from './secret-files.js';

function log(message: string): void {
  console.log(`[selfhost] ${message}`);
}

export function redact(config: CelldWranglerConfig, secretNames: Set<string>): CelldWranglerConfig {
  const vars = Object.fromEntries(
    Object.entries(config.vars).map(([key, value]) => [
      key,
      secretNames.has(key) ? '<redacted>' : value,
    ])
  );
  return { ...config, vars };
}

/**
 * Write gateway.env (frps and Caddy read it via env_file) when it changed. Outside `--init` a
 * change stops the deploy before the Worker is updated: frps reads the file only when it starts,
 * so the Worker must not assume a heartbeat timeout or range the running frps is not enforcing.
 */
export function syncGatewayEnv(path: string, content: string, init: boolean): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const action = gatewayEnvAction(existing, content, init);
  if (action === 'unchanged') return;
  writePrivateFile(path, content);
  log(`wrote ${path}; (re)start the stack: docker compose up -d`);
  if (action === 'write-then-restart') {
    throw new Error(
      `${path} changed. Restart frps and Caddy so they run it (docker compose up -d), ` +
        'then run pnpm selfhost:deploy again; the Worker is not updated before they agree.'
    );
  }
}

/** Runs a command with secret values scrubbed from its printed output (deploy.ts `run`). */
export type RunCommand = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => { status: number; output: string };

const NO_LEASES = /no node leases/i;

/** Attempts while the freshly deployed node takes its leases. */
export const DEFAULT_MIGRATION_ATTEMPTS = 20;
/** Attempts before the deploy; an upgraded fleet answers at once, a fresh one never does. */
export const DEFAULT_PREDEPLOY_MIGRATION_ATTEMPTS = 2;
const DEFAULT_MIGRATION_RETRY_DELAY_MS = 3000;
const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 2000;
/**
 * One health request's limit. Without it a request that celld dispatches to a stuck fresh isolate
 * waits out celld's 300 s handler budget, so a single probe outlives the whole deadline and the
 * deploy fails on a box that answered every other request (sam-box, 2026-11-12).
 */
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 10_000;

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export function bucketOf(env: NodeJS.ProcessEnv): string {
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
  run: RunCommand,
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

export async function applyAllMigrations(
  run: RunCommand,
  celld: string,
  databases: readonly string[],
  projectDir: string,
  env: NodeJS.ProcessEnv,
  attempts: number
): Promise<'applied' | 'no-leases'> {
  for (const name of databases) {
    if ((await applyMigrations(run, celld, name, projectDir, env, attempts)) === 'no-leases')
      return 'no-leases';
  }
  return 'applied';
}

export async function waitForHealth(port: string, baseDomain: string): Promise<void> {
  const deadline = Date.now() + intEnv('SELFHOST_HEALTH_TIMEOUT_MS', DEFAULT_HEALTH_TIMEOUT_MS);
  const requestTimeout = intEnv(
    'SELFHOST_HEALTH_REQUEST_TIMEOUT_MS',
    DEFAULT_HEALTH_REQUEST_TIMEOUT_MS
  );
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { host: `api.${baseDomain}`, 'x-forwarded-proto': 'https' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeout, deadline - Date.now()))),
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
