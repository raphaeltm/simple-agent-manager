#!/usr/bin/env tsx
/**
 * Deploy (or upgrade) the SAM control plane onto a running celld node.
 *
 *   pnpm selfhost:deploy [--env-file deploy/selfhost/.env] [--state-dir <env dir>/.state]
 *                        [--secrets <state-dir>/secrets.env] [--web-dist DIR] [--dry-run] [--init]
 *                        [--skip-vm-agent]
 *
 * `--init` only generates the platform keys, `<state-dir>/gateway.env` (the shared secret
 * docker compose hands to frps and Caddy), and the celld egress fence files
 * (`egress-fence.nft`, `celld.env`); run it once before the first `docker compose up`.
 *
 * Re-runnable: platform keys are generated once and kept, the project directory is rebuilt,
 * D1 migrations are applied idempotently, and `celld deploy` publishes a new version that the
 * node adopts in place. celld has no secrets store for real nodes, so secrets are rendered
 * into `vars` for the deploy only; the config left on disk afterwards carries none.
 *
 * Nodes download the vm-agent from this install, so the deploy builds it (pinned Go image) and
 * publishes it into the fleet bucket the way the Cloudflare pipeline does, then pins
 * VM_AGENT_REQUIRED_VERSION to that release. `--skip-vm-agent` skips both and leaves the
 * version unpinned (nodes then use the legacy `agents/vm-agent-linux-<arch>` objects).
 *
 * Email (mail-settings.ts): the Worker gets SMTP settings from the .env, or points at the
 * `mail-collector` profile, whose UI password only `--init` generates; run `--init` again after
 * turning that profile on.
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
  assertPresignCredentialIsScoped,
  celldChildEnv,
  gatewayEnvAction,
  presignVars,
  redactSecrets,
  renderGatewayEnv,
  resolveTunnelSettings,
  tunnelWorkerVars,
} from './box-settings.js';
import { ensureCelldBinary, resolveEsbuild } from './celld-binary.js';
import {
  buildCelldConfig,
  type CelldWranglerConfig,
  OPERATOR_FORBIDDEN_VARS,
} from './celld-config.js';
import { ASSETS_DIR, prepareCelldProject, SOURCE_LINK, writeCelldConfig } from './celld-project.js';
import {
  assertContainerEngineReady,
  type EngineProbe,
  guidedLoginSettings,
} from './guided-login.js';
import { writeFenceFiles } from './fence-state.js';
import {
  ensureMailCollectorPassword,
  MAIL_COLLECTOR_PASSWORD_FILE,
  MAIL_COLLECTOR_UI_USER,
  mailCollectorHostLabel,
  smtpWorkerVars,
  writeMailCollectorFiles,
} from './mail-settings.js';
import { ensurePlatformKeys } from './platform-keys.js';
import {
  assertPrivateFile,
  ensurePrivateDir,
  parseDotenv,
  readSecretsFile,
  writePrivateFile,
} from './secret-files.js';
import {
  buildVmAgentBinaries,
  publishVmAgentArtifacts,
  removeVmAgentBuild,
  resolveVmAgentRelease,
} from './vm-agent-artifacts.js';

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

/**
 * celld bundles `apps/api/src` with its own esbuild, which resolves the workspace packages
 * (`shared`, `providers`, `cloud-init`) through their built `dist/` entry points. A fresh
 * checkout has none, so build the API's dependencies (not the API itself) first.
 */
function probeDockerRuntimes(): EngineProbe {
  const result = spawnSync('docker', ['info', '--format', '{{json .Runtimes}}'], {
    encoding: 'utf8',
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr ?? '').trim().slice(0, 300) };
  return { ok: true, runtimesJson: (result.stdout ?? '').trim() };
}

function buildApiDependencies(): void {
  log("building the API Worker's workspace dependencies");
  const result = spawnSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'build', '--filter=@simple-agent-manager/api^...'],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  if (result.status !== 0) throw new Error('building the API Worker dependencies failed');
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

/**
 * Write gateway.env (frps and Caddy read it via env_file) when it changed. Outside `--init` a
 * change stops the deploy before the Worker is updated: frps reads the file only when it starts,
 * so the Worker must not assume a heartbeat timeout or range the running frps is not enforcing.
 */
function syncGatewayEnv(path: string, content: string, init: boolean): void {
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      'state-dir': { type: 'string' },
      secrets: { type: 'string' },
      'web-dist': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      init: { type: 'boolean', default: false },
      'skip-vm-agent': { type: 'boolean', default: false },
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
  // The port range and heartbeat timeout go to the Worker from the same resolved values
  // (below). Resolution fails the deploy on a range overlapping a box listener or too large.
  const tunnelSettings = resolveTunnelSettings(box);
  // The celld egress fence and celld.env (scripts/selfhost/egress-fence.ts), written before the
  // gateway.env check so a restart it asks for also picks up a changed fence.
  const fence = await writeFenceFiles({ stateDir, box, leaseRange: tunnelSettings.range });
  for (const path of fence.changed) {
    log(
      path.endsWith('.nft')
        ? `wrote ${path}; the egress-fence service applies it within its recheck interval`
        : `wrote ${path}; (re)start the stack: docker compose up -d`
    );
  }
  syncGatewayEnv(
    join(stateDir, 'gateway.env'),
    renderGatewayEnv(keys.REVERSE_TUNNEL_GATEWAY_SECRET, tunnelSettings),
    values.init ?? false
  );
  // The collector's UI password (generated by --init only) and Caddy's view of the collector.
  const collectorPasswordPath = join(stateDir, MAIL_COLLECTOR_PASSWORD_FILE);
  const collectorPassword = ensureMailCollectorPassword(
    collectorPasswordPath,
    box,
    values.init ?? false
  );
  for (const path of writeMailCollectorFiles(stateDir, box, collectorPassword)) {
    log(`wrote ${path}; restart the stack so it applies: docker compose up -d`);
  }
  if (values.init) return;
  const operatorSecrets = readSecretsFile(secretsPath);
  // VM_AGENT_REQUIRED_VERSION must name the release this deploy published (or stay unset).
  for (const name of OPERATOR_FORBIDDEN_VARS) {
    if (name in operatorSecrets) throw new Error(`${secretsPath}: ${name} is generated; remove it`);
  }
  assertPresignCredentialIsScoped(box, operatorSecrets);
  const { SAM_INSTALLATION_ID, ...platformSecrets } = keys;
  const secrets: Record<string, string> = { ...platformSecrets, ...operatorSecrets };
  knownSecrets = Object.values(secrets);

  const source = TOML.parse(readFileSync(join(API_DIR, 'wrangler.toml'), 'utf8')) as WranglerToml;
  const guidedLogin = guidedLoginSettings(box);
  const plan = buildCelldConfig(source, {
    main: `${SOURCE_LINK}/index.ts`,
    baseDomain,
    assetsDirectory: ASSETS_DIR,
    guidedLogin,
    vars: {
      SAM_INSTALLATION_ID,
      VAPID_SUBJECT: `https://app.${baseDomain}`,
      ...tunnelWorkerVars(tunnelSettings),
      ...smtpWorkerVars(box, operatorSecrets, baseDomain),
    },
  });
  const vmAgentRelease = values['skip-vm-agent'] ? null : resolveVmAgentRelease(REPO_ROOT);
  if (vmAgentRelease) plan.config.vars.VM_AGENT_REQUIRED_VERSION = vmAgentRelease.release;
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

  // First, so a box without a working Docker fails before minutes of other builds.
  if (guidedLogin) assertContainerEngineReady(guidedLogin, probeDockerRuntimes());
  let vmAgentBinDir: string | null = null;
  if (vmAgentRelease) {
    log(`building vm-agent release ${vmAgentRelease.release}`);
    vmAgentBinDir = buildVmAgentBinaries(REPO_ROOT, join(stateDir, 'go-cache'), vmAgentRelease);
  }
  const webDist = values['web-dist'] ? resolve(values['web-dist']) : buildWeb(baseDomain);
  buildApiDependencies();
  prepareCelldProject({ apiDir: API_DIR, projectDir, plan, webDist });

  const celld = await ensureCelldBinary(join(stateDir, 'bin'));
  const env = celldChildEnv(process.env, box, resolveEsbuild(API_DIR));

  // Before the Worker that pins VM_AGENT_REQUIRED_VERSION is published, as on Cloudflare.
  if (vmAgentRelease && vmAgentBinDir) {
    const agentBucket = plan.config.r2_buckets.find((bucket) => bucket.binding === 'R2');
    if (!agentBucket) throw new Error('the Worker has no R2 binding to serve the vm-agent from');
    try {
      publishVmAgentArtifacts({
        celld,
        env,
        fleetBucket: bucketOf(env),
        r2BucketName: agentBucket.bucket_name,
        binDir: vmAgentBinDir,
        release: vmAgentRelease.release,
        redact: (text) => redactSecrets(text, knownSecrets),
        log,
      });
    } finally {
      removeVmAgentBuild(vmAgentBinDir);
    }
  }

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
  if (collectorPassword) {
    log(
      `mail collector: https://${mailCollectorHostLabel(box)}.${baseDomain} ` +
        `(user ${MAIL_COLLECTOR_UI_USER}, password in ${collectorPasswordPath})`
    );
  }
}

main().catch((error: unknown) => {
  console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
