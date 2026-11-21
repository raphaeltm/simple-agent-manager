#!/usr/bin/env tsx
/**
 * Deploy (or upgrade) the SAM control plane onto a running celld node.
 *
 *   pnpm selfhost:deploy [--env-file deploy/selfhost/.env] [--state-dir <env dir>/.state]
 *                        [--secrets <state-dir>/secrets.env] [--web-dist DIR] [--dry-run] [--init]
 *                        [--skip-vm-agent] [--key-provider NAME] [--seal] [--unset NAME ...]
 *
 * A box on plaintext deploy vars (no recorded key choice) stays on them unless `--seal` (secrets
 * migrate): an upgrader from before sealing passes no key flag (deploy-keys.ts holdsPlaintext).
 *
 * `--init` chooses the key provider that seals the Worker secrets when none is recorded
 * (key-choice.ts), generates the platform keys into the sealed bundle (key-service.ts; on a
 * `legacy-plaintext` box into `<state-dir>/platform-keys.json`, platform-keys.ts), and writes
 * `<state-dir>/gateway.env` (the shared secret docker compose hands to frps and Caddy), the key
 * agent's `agent.env` and the mail-collector files; run it once before the first
 * `docker compose up`. Only `--init` on a state dir with no trace of an earlier deploy creates
 * keys; otherwise missing keys stop the deploy (restore them from backup). A key added by a newer
 * version is likewise generated only by `--init`; a lost ENCRYPTION_KEY or SAM_INSTALLATION_ID
 * is never regenerated.
 *
 * `--dry-run` prints the config celld would get, secrets redacted, and writes nothing: no keys
 * (missing ones show as placeholders), no state dir, no gateway.env or mail-collector files.
 *
 * Re-runnable: platform keys are generated once and kept, the project directory is rebuilt,
 * D1 migrations are applied idempotently, and `celld deploy` publishes a new version that the
 * node adopts in place. celld has no secrets store for real nodes, and it keeps every deployed
 * version's `vars` in the fleet bucket, so the Worker gets its secrets at runtime from the box's
 * key agent and the vars carry none (runtime-secrets.ts). Only on a `legacy-plaintext` box are
 * the platform keys and secrets.env rendered into the vars, where the fleet bucket credential can
 * read them.
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
  loadBoxEnv,
  presignVars,
  redactSecrets,
  renderGatewayEnv,
  resolveTunnelSettings,
  STORAGE_SECRET_KEYS,
  type TunnelSettings,
  tunnelWorkerVars,
} from './box-settings.js';
import { verifyNewVersionServes } from './celld-adopt.js';
import { ensureCelldBinary, resolveEsbuild } from './celld-binary.js';
import {
  assertOperatorSecretsAllowed,
  buildCelldConfig,
  type CelldConfigPlan,
  type CelldWranglerConfig,
} from './celld-config.js';
import { ASSETS_DIR, CELLD_MAIN, prepareCelldProject, writeCelldConfig } from './celld-project.js';
import { buildApiDependencies, buildWeb, publishVmAgent } from './deploy-build.js';
import { writeAndReconcileFence } from './deploy-fence-reconcile.js';
import {
  refuseRootUnlessPlaintext,
  resolveBoxKeys,
  resolveDeployBox,
  sealedWorkerVars,
} from './deploy-keys.js';
import {
  applyAllMigrations,
  bucketOf,
  celldPort,
  DEFAULT_MIGRATION_ATTEMPTS,
  DEFAULT_PREDEPLOY_MIGRATION_ATTEMPTS,
  intEnv,
  log,
  redact,
  REPO_ROOT,
  SELFHOST_DIR,
  syncDnsEnv,
  syncGatewayEnv,
} from './deploy-steps.js';
import { boxDnsWorkerVars, DNS_ENV_FILE } from './dns-settings.js';
import { inboundMailWorkerVars } from './inbound-mail-settings.js';
import { expectedComposeProjectFor, recordInstall } from './install-record.js';
import { celldDeployConfig, unsetForThisRun } from './key-seal.js';
import { assertKeyAgentUp } from './key-service.js';
import {
  ensureMailCollectorPassword,
  MAIL_COLLECTOR_PASSWORD_FILE,
  MAIL_COLLECTOR_UI_USER,
  mailCollectorHostLabel,
  smtpWorkerVars,
  writeMailCollectorFiles,
} from './mail-settings.js';
import {
  assertSecretsKeepPlatformKeys,
  type PlatformKeysMode,
  type PlatformKeysResult,
} from './platform-keys.js';
import { assertPrivateFile, ensurePrivateDir, readSecretsFile } from './secret-files.js';
import {
  buildVmAgentBinaries,
  resolveVmAgentRelease,
  type VmAgentRelease,
} from './vm-agent-artifacts.js';

const API_DIR = join(REPO_ROOT, 'apps/api');

/** Upper bound on captured celld output (bundle reports are a few KiB). */
const CHILD_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

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

interface DeployInputs {
  envFile: string;
  box: Record<string, string>;
  stateDir: string;
  secretsPath: string;
  projectDir: string;
  baseDomain: string;
  dryRun: boolean;
  init: boolean;
  skipVmAgent: boolean;
  webDist: string | undefined;
  unset: string[];
}

/** Parses the CLI flags and the box .env, and creates the state dir unless this is a dry run. */
async function readDeployInputs(): Promise<DeployInputs> {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      'state-dir': { type: 'string' },
      secrets: { type: 'string' },
      'web-dist': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      init: { type: 'boolean', default: false },
      'skip-vm-agent': { type: 'boolean', default: false },
      'key-provider': { type: 'string' },
      seal: { type: 'boolean', default: false },
      // Remove a sealed value whose secrets.env line was deleted (key-service.ts assertUnsettable).
      unset: { type: 'string', multiple: true },
    },
  });
  const envFile = resolve(values['env-file'] ?? join(SELFHOST_DIR, '.env'));
  // The .env holds the bucket credential, which can read every deployed secret.
  assertPrivateFile(envFile);
  // The box as docker compose will run it (a shell variable any compose file interpolates beats
  // the .env, F21 L5), its ports checked against the lease range before anything is written.
  const envBox = loadBoxEnv(envFile, SELFHOST_DIR, process.env, (name) =>
    log(`${name} from the shell environment overrides ${envFile}`)
  );
  // Same default and base directory docker compose uses for SAM_SELFHOST_STATE_DIR.
  const stateDir = resolve(
    dirname(envFile),
    values['state-dir'] ?? envBox.SAM_SELFHOST_STATE_DIR ?? '.state'
  );
  const dryRun = values['dry-run'] ?? false;
  const keys = { box: envBox, stateDir, keyProvider: values['key-provider'], seal: values.seal };
  // A dry run writes nothing, not even the state dir; root is refused before the first write.
  if (!dryRun) refuseRootUnlessPlaintext(keys);
  if (!dryRun) ensurePrivateDir(stateDir);
  // Which key provider seals the secrets (key-choice.ts): `--init` chooses when none is recorded.
  const box = await resolveDeployBox({ ...keys, init: values.init ?? false, dryRun, log });
  const secretsPath = resolve(values.secrets ?? join(stateDir, 'secrets.env'));
  const baseDomain = box.SAM_DOMAIN;
  if (!baseDomain) throw new Error(`${envFile}: SAM_DOMAIN is required`);
  if (!box.CELLD_BUCKET) throw new Error(`${envFile}: CELLD_BUCKET is required`);
  return {
    envFile,
    box,
    stateDir,
    secretsPath,
    projectDir: join(stateDir, 'project'),
    baseDomain,
    dryRun,
    init: values.init ?? false,
    skipVmAgent: values['skip-vm-agent'] ?? false,
    webDist: values['web-dist'],
    unset: values.unset ?? [],
  };
}

function platformKeysMode(inputs: DeployInputs): PlatformKeysMode {
  if (inputs.dryRun) return 'dry-run';
  return inputs.init ? 'init' : 'deploy';
}

interface BoxState {
  keys: PlatformKeysResult['keys'];
  deployKeys: Awaited<ReturnType<typeof resolveBoxKeys>>;
  tunnelSettings: TunnelSettings;
  collectorPasswordPath: string;
  collectorPassword: string | null;
}

/** Platform keys, then the files docker compose hands to frps, Caddy and the mail collector. */
async function prepareBoxState(inputs: DeployInputs): Promise<BoxState> {
  const { box, stateDir, dryRun, init } = inputs;
  // Sealed secrets (key-service.ts): the platform keys and secrets.env go into a bundle only the
  // key agent can open, and no secret is passed to celld. legacy-plaintext: platform-keys.json.
  const deployKeys = await resolveBoxKeys({
    box,
    stateDir,
    secretsPath: inputs.secretsPath,
    mode: platformKeysMode(inputs),
    unset: unsetForThisRun(inputs.unset, dryRun, inputs.secretsPath, log),
    log,
  });
  const { keys, generated } = deployKeys;
  if (generated.length > 0) {
    log(
      dryRun
        ? `dry run: --init would generate platform keys: ${generated.join(', ')}`
        : `generated platform keys: ${generated.join(', ')} (back up ${stateDir})`
    );
  }
  // docker compose passes this file to frps and Caddy (env_file); rewritten only on change.
  // The port range and heartbeat timeout go to the Worker from the same resolved values
  // (planWorker). Resolution fails the deploy on a range overlapping a box listener or too large.
  const tunnelSettings = resolveTunnelSettings(box);
  const collectorPasswordPath = join(stateDir, MAIL_COLLECTOR_PASSWORD_FILE);
  if (dryRun) {
    log(
      `dry run: gateway.env and the mail-collector files in ${stateDir} are not written; ` +
        'a real run rewrites them only where they differ'
    );
    return { keys, deployKeys, tunnelSettings, collectorPasswordPath, collectorPassword: null };
  }
  recordInstall(stateDir, inputs.envFile, box, keys.SAM_INSTALLATION_ID);
  log(
    `Compose project: ${expectedComposeProjectFor(box, stateDir, keys.SAM_INSTALLATION_ID)} (set COMPOSE_PROJECT_NAME to this name before starting Docker Compose)`
  );
  syncGatewayEnv(
    join(stateDir, 'gateway.env'),
    renderGatewayEnv(keys.REVERSE_TUNNEL_GATEWAY_SECRET, tunnelSettings),
    init
  );
  syncDnsEnv(join(stateDir, DNS_ENV_FILE), box, keys.SAM_DNS_TSIG_SECRET);
  // The collector's UI password (generated by --init only) and Caddy's view of the collector.
  const collectorPassword = ensureMailCollectorPassword(collectorPasswordPath, box, init);
  for (const path of writeMailCollectorFiles(stateDir, box, collectorPassword)) {
    log(`wrote ${path}; restart the stack so it applies: docker compose up -d`);
  }
  return { keys, deployKeys, tunnelSettings, collectorPasswordPath, collectorPassword };
}

/** The Worker's secrets: platform keys plus secrets.env, which may not replace a key. */
function resolveWorkerSecrets(
  inputs: DeployInputs,
  { keys, deployKeys }: Pick<BoxState, 'keys' | 'deployKeys'>
): { installationId: string; secrets: Record<string, string> } {
  const { box, secretsPath } = inputs;
  const operatorSecrets = readSecretsFile(secretsPath);
  // VM_AGENT_REQUIRED_VERSION must name the release this deploy published (or stay unset).
  assertOperatorSecretsAllowed(operatorSecrets, secretsPath);
  // secrets.env is laid over the keys; it may not replace one.
  assertSecretsKeepPlatformKeys(operatorSecrets, keys, secretsPath);
  const sealed = deployKeys.sealed;
  assertPresignCredentialIsScoped(box, sealed ? sealed.secrets : operatorSecrets);
  const { SAM_INSTALLATION_ID, ...platformSecrets } = keys;
  // What the Worker runs with. Sealed: the bundle's secrets, which reach it from the key agent
  // (the installation id is a var, never in the agent's answer). Otherwise rendered into `vars`.
  const secrets: Record<string, string> = sealed
    ? Object.fromEntries(
        Object.entries(sealed.secrets).filter(([name]) => name !== 'SAM_INSTALLATION_ID')
      )
    : { ...platformSecrets, ...operatorSecrets };
  // The fleet bucket credential reaches celld's environment; scrub it from celld's output too.
  knownSecrets = [
    ...Object.values(secrets),
    ...STORAGE_SECRET_KEYS.map((name) => box[name] ?? ''),
  ].filter(Boolean);
  return { installationId: SAM_INSTALLATION_ID, secrets };
}

/** Translates wrangler.toml into celld's config, with the box's vars and the vm-agent pin. */
function planWorker(
  inputs: DeployInputs,
  tunnelSettings: TunnelSettings,
  installationId: string,
  secrets: Record<string, string>,
  sealedVars: Record<string, string>
): { plan: CelldConfigPlan; vmAgentRelease: VmAgentRelease | null } {
  const { box, baseDomain } = inputs;
  const smtpVars = smtpWorkerVars(box, secrets, baseDomain);
  const source = TOML.parse(readFileSync(join(API_DIR, 'wrangler.toml'), 'utf8')) as WranglerToml;
  const plan = buildCelldConfig(source, {
    main: CELLD_MAIN,
    baseDomain,
    assetsDirectory: ASSETS_DIR,
    vars: {
      SAM_INSTALLATION_ID: installationId,
      VAPID_SUBJECT: `https://app.${baseDomain}`,
      ...tunnelWorkerVars(tunnelSettings),
      ...smtpVars,
      ...inboundMailWorkerVars(box, smtpVars),
      ...boxDnsWorkerVars(box),
      // Sealed: where the key agent is, which bundle, and the agent's verify key (no secret).
      ...sealedVars,
    },
  });
  const vmAgentRelease = inputs.skipVmAgent ? null : resolveVmAgentRelease(REPO_ROOT);
  if (vmAgentRelease) plan.config.vars.VM_AGENT_REQUIRED_VERSION = vmAgentRelease.release;
  // Needs the R2 binding's final bucket name, so it is applied after translation.
  Object.assign(plan.config.vars, presignVars(box, plan.config.vars.R2_BUCKET_NAME ?? ''));
  for (const line of plan.report) log(line);
  return { plan, vmAgentRelease };
}

/**
 * Runs `celld deploy` with the secrets-bearing config on disk, and puts the secrets-free config
 * back afterwards, on a signal too.
 */
function celldDeploy(
  celld: string,
  projectDir: string,
  config: CelldWranglerConfig,
  withSecrets: CelldWranglerConfig,
  env: NodeJS.ProcessEnv
): void {
  // spawnSync blocks the event loop, so a signal lands here after celld exits; `finally`
  // alone would not run on one. A SIGKILL or power loss can still leave the secrets-bearing
  // file until the next run rewrites it; it is 0600 in the 0700 state dir, which already holds
  // the same values in platform-keys.json and secrets.env.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
  const scrub = (): void => {
    try {
      writeCelldConfig(projectDir, config);
    } catch (error) {
      console.error(`[selfhost] could not scrub ${projectDir}/wrangler.json: ${String(error)}`);
    }
    process.exit(130);
  };
  for (const signal of signals) process.once(signal, scrub);
  writeCelldConfig(projectDir, withSecrets);
  try {
    log(`celld deploy ${config.name}`);
    const result = run(celld, ['deploy', projectDir, '--bucket', bucketOf(env)], env);
    if (result.status !== 0) throw new Error(`celld deploy failed (exit ${result.status})`);
  } finally {
    writeCelldConfig(projectDir, config);
    for (const signal of signals) process.off(signal, scrub);
  }
}

async function main(): Promise<void> {
  const inputs = await readDeployInputs();
  const { box, stateDir, projectDir, baseDomain } = inputs;
  const state = await prepareBoxState(inputs);
  const { tunnelSettings, collectorPasswordPath, collectorPassword } = state;
  const { keyService, sealed } = state.deployKeys;
  if (!inputs.dryRun) {
    await writeAndReconcileFence({
      stateDir,
      box,
      envFile: inputs.envFile,
      leaseRange: tunnelSettings.range,
    });
  }
  if (inputs.init) return;
  const { installationId, secrets } = resolveWorkerSecrets(inputs, state);
  const { plan, vmAgentRelease } = planWorker(
    inputs,
    tunnelSettings,
    installationId,
    secrets,
    sealedWorkerVars(keyService, sealed, box)
  );
  // What `celld deploy` gets, and celld stores in the fleet bucket for this version. Sealed: no
  // secret at all. legacy-plaintext: only this in-memory copy and a transient project file
  // (celldDeploy) carry the secrets.
  const withSecrets: CelldWranglerConfig = celldDeployConfig(plan.config, secrets, Boolean(sealed));

  if (inputs.dryRun) {
    console.log(JSON.stringify(redact(withSecrets, new Set(Object.keys(secrets))), null, 2));
    return;
  }

  let vmAgentBinDir: string | null = null;
  if (vmAgentRelease) {
    log(`building vm-agent release ${vmAgentRelease.release}`);
    vmAgentBinDir = buildVmAgentBinaries(REPO_ROOT, join(stateDir, 'go-cache'), vmAgentRelease);
  }
  const webDist = inputs.webDist ? resolve(inputs.webDist) : buildWeb(baseDomain);
  buildApiDependencies();
  prepareCelldProject({
    apiDir: API_DIR,
    projectDir,
    plan,
    webDist,
    runtimeSecrets: Boolean(sealed),
  });

  const celld = await ensureCelldBinary(join(stateDir, 'bin'));
  const env = celldChildEnv(process.env, box, resolveEsbuild(API_DIR));

  // Before the Worker that pins VM_AGENT_REQUIRED_VERSION is published, as on Cloudflare.
  if (vmAgentRelease && vmAgentBinDir) {
    publishVmAgent(plan.config, celld, env, vmAgentBinDir, vmAgentRelease.release, (text) =>
      redactSecrets(text, knownSecrets)
    );
  }

  // The secrets-free config is what stays on disk: migrations and operator `celld d1`/`kv`
  // commands read it. On an upgrade, migrations run before the new Worker version, as on
  // Cloudflare. A fresh fleet has no leases until its first deploy, so it migrates after.
  writeCelldConfig(projectDir, plan.config);
  const databases = plan.config.d1_databases.map((db) => db.database_name);
  const migrate = (attemptsVar: string, defaultAttempts: number) =>
    applyAllMigrations(
      run,
      celld,
      databases,
      projectDir,
      env,
      intEnv(attemptsVar, defaultAttempts)
    );
  const preDeploy = await migrate(
    'SELFHOST_PREDEPLOY_MIGRATION_ATTEMPTS',
    DEFAULT_PREDEPLOY_MIGRATION_ATTEMPTS
  );
  if (preDeploy === 'no-leases')
    log('no node holds a lease yet (first deploy?); deploying before migrating');

  // A Worker without its key agent answers 503 to everything; say why before deploying.
  if (keyService) await assertKeyAgentUp(keyService.port);
  celldDeploy(celld, projectDir, plan.config, withSecrets, env);

  if (preDeploy === 'no-leases') {
    const migrated = await migrate('SELFHOST_MIGRATION_ATTEMPTS', DEFAULT_MIGRATION_ATTEMPTS);
    if (migrated === 'no-leases') {
      throw new Error('no celld node holds a lease; is the stack running (docker compose ps)?');
    }
  }

  // celld reads deploy/current.json only every CELLD_DEPLOY_POLL_S (30 s); without this the
  // health check below would pass on the previous version (celld-adopt.ts).
  await verifyNewVersionServes(
    box,
    {
      celldPort: celldPort(box),
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

try {
  await main();
} catch (error: unknown) {
  console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
