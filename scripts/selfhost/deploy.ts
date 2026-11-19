#!/usr/bin/env tsx
/**
 * Deploy (or upgrade) the SAM control plane onto a running celld node.
 *
 *   pnpm selfhost:deploy [--env-file deploy/selfhost/.env] [--state-dir <env dir>/.state]
 *                        [--secrets <state-dir>/secrets.env] [--web-dist DIR] [--dry-run] [--init]
 *                        [--skip-vm-agent]
 *
 * `--init` generates the platform keys (`<state-dir>/platform-keys.json`, platform-keys.ts), and
 * writes `<state-dir>/gateway.env` (the shared secret docker compose hands to frps and Caddy) and
 * the mail-collector files; run it once before the first `docker compose up`.
 *
 * Re-runnable: platform keys are generated once and kept, the project directory is rebuilt,
 * D1 migrations are applied idempotently, and `celld deploy` publishes a new version that the
 * node adopts in place. celld has no secrets store for real nodes: the platform keys and
 * secrets.env are rendered into the Worker's `vars`, which celld keeps in the fleet bucket. The
 * fleet bucket credential can therefore read every Worker secret.
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
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import * as TOML from '@iarna/toml';

import type { WranglerToml } from '../deploy/types.js';
import {
  assertPresignCredentialIsScoped,
  celldChildEnv,
  presignVars,
  redactSecrets,
  renderGatewayEnv,
  resolveTunnelSettings,
  tunnelWorkerVars,
} from './box-settings.js';
import { verifyNewVersionServes } from './celld-adopt.js';
import { ensureCelldBinary, resolveEsbuild } from './celld-binary.js';
import {
  assertOperatorSecretsAllowed,
  buildCelldConfig,
  type CelldWranglerConfig,
} from './celld-config.js';
import { ASSETS_DIR, CELLD_MAIN, prepareCelldProject, writeCelldConfig } from './celld-project.js';
import {
  applyAllMigrations,
  bucketOf,
  DEFAULT_MIGRATION_ATTEMPTS,
  DEFAULT_PREDEPLOY_MIGRATION_ATTEMPTS,
  intEnv,
  redact,
  syncGatewayEnv,
} from './deploy-steps.js';
import { inboundMailWorkerVars } from './inbound-mail-settings.js';
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

/** Upper bound on captured celld output (bundle reports are a few KiB). */
const CHILD_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_CELLD_PORT = '8080';

function log(message: string): void {
  console.log(`[selfhost] ${message}`);
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
function buildApiDependencies(): void {
  log("building the API Worker's workspace dependencies");
  const result = spawnSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'build', '--filter=@simple-agent-manager/api^...'],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  if (result.status !== 0) throw new Error('building the API Worker dependencies failed');
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

  const { keys, generated } = ensurePlatformKeys(stateDir);
  if (generated.length > 0) {
    log(`generated platform keys: ${generated.join(', ')} (back up ${stateDir})`);
  }
  // docker compose passes this file to frps and Caddy (env_file); rewritten only on change.
  // The port range and heartbeat timeout go to the Worker from the same resolved values
  // (below). Resolution fails the deploy on a range overlapping a box listener or too large.
  const tunnelSettings = resolveTunnelSettings(box);
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
  assertOperatorSecretsAllowed(operatorSecrets, secretsPath);
  assertPresignCredentialIsScoped(box, operatorSecrets);
  const { SAM_INSTALLATION_ID, ...platformSecrets } = keys;
  // What the Worker runs with, rendered into its `vars` below (secrets.env wins over the keys).
  const secrets: Record<string, string> = { ...platformSecrets, ...operatorSecrets };
  knownSecrets = Object.values(secrets);

  const smtpVars = smtpWorkerVars(box, secrets, baseDomain);
  const source = TOML.parse(readFileSync(join(API_DIR, 'wrangler.toml'), 'utf8')) as WranglerToml;
  const plan = buildCelldConfig(source, {
    main: CELLD_MAIN,
    baseDomain,
    assetsDirectory: ASSETS_DIR,
    vars: {
      SAM_INSTALLATION_ID,
      VAPID_SUBJECT: `https://app.${baseDomain}`,
      ...tunnelWorkerVars(tunnelSettings),
      ...smtpVars,
      ...inboundMailWorkerVars(box, smtpVars),
    },
  });
  const vmAgentRelease = values['skip-vm-agent'] ? null : resolveVmAgentRelease(REPO_ROOT);
  if (vmAgentRelease) plan.config.vars.VM_AGENT_REQUIRED_VERSION = vmAgentRelease.release;
  // Needs the R2 binding's final bucket name, so it is applied after translation.
  Object.assign(plan.config.vars, presignVars(box, plan.config.vars.R2_BUCKET_NAME ?? ''));
  for (const line of plan.report) log(line);
  // What `celld deploy` gets, and celld stores in the fleet bucket for this version. Only this
  // in-memory copy and a transient project file (below) carry the secrets.
  const withSecrets: CelldWranglerConfig = {
    ...plan.config,
    vars: { ...plan.config.vars, ...secrets },
  };

  if (values['dry-run']) {
    console.log(JSON.stringify(redact(withSecrets, new Set(Object.keys(secrets))), null, 2));
    return;
  }

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
    run,
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
      run,
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

  // celld reads deploy/current.json only every CELLD_DEPLOY_POLL_S (30 s); without this the
  // health check below passed on the previous version (box round R15, G3). celld-adopt.ts.
  await verifyNewVersionServes(
    box,
    {
      celldPort: box.CELLD_PORT || DEFAULT_CELLD_PORT,
      baseDomain,
      agentSignInConfigured: Boolean(secrets.AGENT_SIGN_IN_TRUST?.trim()),
    },
    log
  );
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
