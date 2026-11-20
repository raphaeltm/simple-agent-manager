/** Upgrade a one-box install, checking DO history against active state and taking an encrypted
 * snapshot before changes. Failures restore that snapshot and the previous ref automatically.
 * Selective builds, compose overlays and explicit box/state/secrets selection remain shared
 * with the normal deploy path. An interrupted recovery retains its snapshot in the pending
 * record; retry recovers the old installation first, then starts a fresh upgrade.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  assertRollbackCacheReady,
  beginRollbackCacheStart,
  type BoxContext as BackupContext,
  composeArgs,
  composeRunEnv,
  finishRollbackCache,
  refreshRollbackCacheReceipt,
  runBackup,
  runRollback,
} from './backup-lib.js';
import { loadBoxEnv } from './box-settings.js';
import { composeFilesFor } from './compose-env.js';
import { log, REPO_ROOT, SELFHOST_DIR } from './deploy-steps.js';
import { COMPOSE_PATH, imageRebuilds } from './image-rebuilds.js';
import { assertOperatorExecution } from './operator-only.js';
import { recoverRollbackState } from './rollback-state.js';
import { assertPrivateFile, replacePrivateFile } from './secret-files.js';
import {
  composeInputsChanged,
  composeOverlays,
  composeStateDirOverride,
  fenceState,
  recreateFence,
  restartReason,
  stateFingerprint,
} from './upgrade-compose.js';
import { rollbackSteps } from './upgrade-instructions.js';
import {
  clearUpgradeJournal,
  completeUpgradeJournal,
  readPendingFrom,
  UPGRADE_PENDING_FILE,
} from './upgrade-journal.js';
import {
  assertMigrationProgression,
  type DoMigration,
  installedMigrations,
  sourceMigrations,
} from './upgrade-migrations.js';
import { plaintextLeftNotice, upgradeKeyArgs } from './upgrade-sealing.js';

export { composeInputsChanged, composeOverlays } from './upgrade-compose.js';
import {
  assertPendingUpgradeTarget,
  assertRollbackReady,
  pendingBackupDirectory,
  pendingUpgradeTarget,
} from './upgrade-preflight.js';

const MIGRATIONS_DIR = 'apps/api/src/db/migrations/';
/** Pending original source/target SHAs and encrypted snapshot path, retained through recovery. */
export { UPGRADE_PENDING_FILE } from './upgrade-journal.js';

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[], env?: NodeJS.ProcessEnv) => RunResult;

export interface BoxContext {
  /** Parsed deploy/selfhost/.env. */
  box: Readonly<Record<string, string>>;
  envFile: string;
  stateDir: string;
  /** The deploy's `--secrets` file, when not the default `<stateDir>/secrets.env`. */
  secretsFile?: string;
  encryptionKeyFile?: string;
  /** Every compose file the box runs with, in order (composeFilesFor). */
  composeFiles: string[];
  run: Runner;
  log: (message: string) => void;
}

export interface UpgradeOptions {
  to: string;
  backupDir?: string | null;
  checkHealth: () => Promise<boolean>;
  /** Runs while the healthy upgrade's completed marker is durable, before it is cleared. */
  onCompleted?: () => void;
}

export interface UpgradeResult {
  from: string;
  to: string;
  backupDir: string | null;
  /** Locally built services this upgrade rebuilt (explicitly, before the restart). */
  imagesRebuilt: string[];
  composeRestarted: boolean;
  migrationsChanged: boolean;
  rollback: string[];
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** The box context from an .env file (which must exist and be private: it holds the bucket key). */
export function loadBox(
  envFile: string,
  stateDirOverride?: string,
  secretsFile?: string,
  encryptionKeyFile?: string
): BoxContext {
  assertOperatorExecution();
  if (!existsSync(envFile)) throw new Error(`${envFile} does not exist`);
  assertPrivateFile(envFile);
  // The box as docker compose runs it (a shell variable any compose file interpolates beats the
  // .env), as deploy.ts reads it, its ports checked against the lease range before the upgrade
  // touches the checkout or the stack.
  const box = loadBoxEnv(envFile, SELFHOST_DIR);
  if (!box.CELLD_BUCKET) throw new Error(`${envFile}: CELLD_BUCKET is required`);
  return {
    box,
    envFile,
    encryptionKeyFile: encryptionKeyFile ?? box.SAM_BACKUP_KEY_FILE,
    // Same default and base directory deploy.ts uses; compose is pointed at it (composeStateDirOverride).
    stateDir: resolve(dirname(envFile), stateDirOverride ?? box.SAM_SELFHOST_STATE_DIR ?? '.state'),
    ...(secretsFile ? { secretsFile: resolve(secretsFile) } : {}),
    composeFiles: composeFilesFor(box, SELFHOST_DIR),
    run: runCommand,
    log,
  };
}

function check(result: RunResult, what: string): string {
  if (result.status !== 0) {
    throw new Error(
      `${what} failed (exit ${result.status}); command output withheld because it may contain secrets`
    );
  }
  return result.stdout.trim();
}

/** The `pnpm selfhost:deploy` arguments that select this box (env file, state dir, secrets). */
function deployBoxArgs(ctx: Pick<BoxContext, 'envFile' | 'stateDir' | 'secretsFile'>): string[] {
  return [
    '--env-file',
    ctx.envFile,
    '--state-dir',
    ctx.stateDir,
    ...(ctx.secretsFile ? ['--secrets', ctx.secretsFile] : []),
  ];
}

function backupContext(ctx: BoxContext): BackupContext {
  return {
    ...ctx,
    now: () => Date.now(),
    user: process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined,
  };
}

/** Restore before starting old code: even a failed deployment can already have migrated data. */
export async function recoverUpgrade(
  ctx: BoxContext,
  from: string,
  backupDir: string,
  rebuilds: readonly string[],
  opts: UpgradeOptions
): Promise<void> {
  assertOperatorExecution();
  recoverRollbackState(ctx);
  const pendingPath = join(ctx.stateDir, UPGRADE_PENDING_FILE);
  const to = existsSync(pendingPath)
    ? pendingUpgradeTarget(JSON.parse(readFileSync(pendingPath, 'utf8')))
    : null;
  runRollback(backupContext(ctx), backupDir, from);
  replacePrivateFile(
    join(ctx.stateDir, UPGRADE_PENDING_FILE),
    `${JSON.stringify({ from, backupDir, ...(to ? { to } : {}) })}\n`
  );
  check(ctx.run('git', ['checkout', '--detach', from]), 'restore previous checkout');
  check(ctx.run('pnpm', ['install', '--frozen-lockfile']), 'restore previous dependencies');
  const stateDir = composeStateDirOverride(ctx);
  const env = stateDir === null ? undefined : { ...process.env, SAM_SELFHOST_STATE_DIR: stateDir };
  if (rebuilds.length) {
    const active = new Set(
      check(
        ctx.run('docker', composeArgs(ctx, ['config', '--services']), env),
        'read previous active services'
      ).split('\n')
    );
    const selected = rebuilds.filter((service) => active.has(service));
    if (selected.length)
      check(
        ctx.run('docker', composeArgs(ctx, ['build', ...selected]), env),
        'rebuild previous images'
      );
  }
  startRecoveredStack(ctx, backupDir, env);
  replacePrivateFile(
    pendingPath,
    JSON.stringify({ from, ...(to ? { to } : {}), backupDir, phase: 'verifying' })
  );
  if (!(await opts.checkHealth())) throw new Error('previous version health check failed');
  finishRollbackCache(backupContext(ctx));
  completeUpgradeJournal(ctx.stateDir, { from, to: from, backupDir });
}

function startRecoveredStack(ctx: BoxContext, backupDir: string, env?: NodeJS.ProcessEnv): void {
  beginRollbackCacheStart(backupContext(ctx), backupDir);
  try {
    recreateFence(ctx.stateDir, undefined, (args) =>
      check(ctx.run('docker', composeArgs(ctx, args), env), 'restore previous fence')
    );
    check(ctx.run('docker', composeArgs(ctx, ['up', '-d']), env), 'restore previous stack');
  } catch (error) {
    try {
      refreshRollbackCacheReceipt(backupContext(ctx), backupDir);
    } catch {
      // Preserve the original start error when no replacement cache can yet be proven.
    }
    throw error;
  }
  refreshRollbackCacheReceipt(backupContext(ctx), backupDir);
}

type Git = (args: string[], what?: string) => string;

/** `origin/<ref>` after the fetch, else `<ref>` as given (a tag or a commit). */
function resolveUpgradeTarget(git: Git, ref: string): string {
  try {
    return git(['rev-parse', '--verify', `origin/${ref}^{commit}`]);
  } catch {
    return git(['rev-parse', '--verify', `${ref}^{commit}`], `resolve ${ref}`);
  }
}

/** What an upgrade between two refs must do, decided before the checkout. */
interface UpgradePlan {
  to: string;
  composeFilesChanged: boolean;
  /** Locally built services whose build inputs changed (imageRebuilds). */
  rebuilds: string[];
  boxArgs: string[];
  installed: DoMigration[];
}

interface UpgradeProgress {
  deploymentStarted: boolean;
  stateChanged: boolean;
  imagesRebuilt: string[];
}

/**
 * Checks out `to`, runs `--init` (it may rewrite generated compose inputs), rebuilds the images
 * whose build inputs changed, restarts the stack when its inputs changed, deploys and checks
 * health. Returns whether the stack was restarted. Records in `progress` what it has done as soon
 * as it knows, so a failure later can still say so.
 */
async function applyUpgrade(
  ctx: BoxContext,
  opts: UpgradeOptions,
  git: Git,
  plan: UpgradePlan,
  progress: UpgradeProgress
): Promise<boolean> {
  const pnpm = (args: string[]) => check(ctx.run('pnpm', args), `pnpm ${args.join(' ')}`);
  const stateDir = composeStateDirOverride(ctx);
  const composeEnv =
    stateDir === null ? undefined : { ...process.env, SAM_SELFHOST_STATE_DIR: stateDir };
  const docker = (args: string[]) =>
    check(
      ctx.run('docker', composeArgs(ctx, args), composeEnv),
      `docker compose ${args.join(' ')}`
    );
  git(['checkout', '--detach', plan.to]);
  pnpm(['install', '--frozen-lockfile']);
  assertMigrationProgression(plan.installed, sourceMigrations(backupContext(ctx)));
  ctx.log('DO migration preflight passed against the active deployment and target checkout');
  const before = stateFingerprint(ctx.stateDir);
  const fenceBefore = fenceState(ctx.stateDir);
  progress.deploymentStarted = true;
  pnpm(['selfhost:deploy', '--init', ...plan.boxArgs]);
  const stateChanged = stateFingerprint(ctx.stateDir) !== before;
  progress.stateChanged = stateChanged;
  if (plan.rebuilds.length > 0) {
    // Only services the box runs (its COMPOSE_PROFILES): sam-mx is not built on a box without
    // inbound mail.
    const active = new Set(docker(['config', '--services']).split('\n').filter(Boolean));
    progress.imagesRebuilt = plan.rebuilds.filter((service) => active.has(service));
    if (progress.imagesRebuilt.length > 0) {
      ctx.log(`rebuilding ${progress.imagesRebuilt.join(', ')} (build inputs changed)`);
      docker(['build', ...progress.imagesRebuilt]);
    }
  }
  recreateFence(ctx.stateDir, fenceBefore, docker);
  let composeRestarted = false;
  if (plan.composeFilesChanged || stateChanged || progress.imagesRebuilt.length > 0) {
    ctx.log(
      `restarting the stack (${restartReason(plan.composeFilesChanged, stateChanged)} changed)`
    );
    docker(['up', '-d']);
    composeRestarted = true;
  } else {
    ctx.log('compose inputs unchanged; the stack keeps running');
  }
  pnpm(['selfhost:deploy', ...plan.boxArgs]);
  // A killed health check may already have admitted writes: never infer rollback is safe.
  const pendingPath = join(ctx.stateDir, UPGRADE_PENDING_FILE);
  const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
  replacePrivateFile(pendingPath, JSON.stringify({ ...pending, phase: 'verifying' }));
  if (!(await opts.checkHealth())) throw new Error('the API is not healthy after the upgrade');
  return composeRestarted;
}

/** Resume from the original snapshot, never from a new snapshot of partially migrated data. */
async function recoverPendingUpgrade(
  ctx: BoxContext,
  opts: UpgradeOptions,
  from: string,
  rebuilds: string[]
): Promise<void> {
  const pendingPath = join(ctx.stateDir, UPGRADE_PENDING_FILE);
  const pending: unknown = JSON.parse(readFileSync(pendingPath, 'utf8'));
  const backupDir = pendingBackupDirectory(pending);
  try {
    await recoverUpgrade(ctx, from, backupDir, rebuilds, opts);
  } catch {
    stopCelldAfterFailure(ctx);
    throw new Error(
      'unfinished upgrade recovery failed; keep celld stopped, inspect the journal and live data before explicit recovery'
    );
  }
}

function stopCelldAfterFailure(ctx: BoxContext): void {
  const env = composeRunEnv(ctx);
  try {
    ctx.run('docker', composeArgs(ctx, ['stop', 'celld']), env);
  } catch {
    /* best effort */
  }
}

async function rollbackFailedUpgrade(
  ctx: BoxContext,
  opts: UpgradeOptions,
  git: Git,
  from: string,
  backupDir: string,
  progress: UpgradeProgress
): Promise<void> {
  ctx.log('upgrade failed; automatically restoring the previous version');
  try {
    if (progress.deploymentStarted) {
      await recoverUpgrade(ctx, from, backupDir, progress.imagesRebuilt, opts);
    } else {
      git(['checkout', '--detach', from]);
      check(ctx.run('pnpm', ['install', '--frozen-lockfile']), 'restore previous dependencies');
      clearUpgradeJournal(ctx.stateDir);
    }
    ctx.log('automatic rollback completed');
  } catch {
    if (progress.deploymentStarted) stopCelldAfterFailure(ctx);
    throw new Error(
      'upgrade failed and automatic rollback did not complete; keep celld stopped, inspect the journal and live data before explicit recovery'
    );
  }
}

export async function runUpgrade(ctx: BoxContext, opts: UpgradeOptions): Promise<UpgradeResult> {
  assertOperatorExecution();
  recoverRollbackState(ctx);
  assertRollbackReady(ctx);
  const git: Git = (args, what = `git ${args.join(' ')}`) => check(ctx.run('git', args), what);

  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error(
      'the checkout has uncommitted changes to tracked files; commit or stash them first'
    );
  }
  git(['fetch', '--tags', 'origin']);
  const head = git(['rev-parse', 'HEAD']);
  const pendingFrom = readPendingFrom(ctx.stateDir, head);
  // A pending record means the checkout may be ahead of what is deployed: start from the record.
  const from = pendingFrom ?? head;
  const to = resolveUpgradeTarget(git, opts.to);
  if (pendingFrom !== null)
    assertPendingUpgradeTarget(
      JSON.parse(readFileSync(join(ctx.stateDir, UPGRADE_PENDING_FILE), 'utf8')),
      to
    );
  if (pendingFrom === null && head === to) {
    ctx.log('already at that ref; nothing to do');
    return {
      from,
      to,
      imagesRebuilt: [],
      backupDir: null,
      composeRestarted: false,
      migrationsChanged: false,
      rollback: [],
    };
  }
  const changed = git(['diff', '--name-only', from, to]).split('\n').filter(Boolean);
  // Resuming: the failed run may have restarted the stack on files this diff no longer shows.
  const composeFilesChanged =
    pendingFrom !== null || composeInputsChanged(changed, ctx.composeFiles);
  const migrationsChanged = changed.some((f) => f.startsWith(MIGRATIONS_DIR));
  const fileAt = (ref: string, path = COMPOSE_PATH): string | null => {
    const shown = ctx.run('git', ['show', `${ref}:${path}`]);
    return shown.status === 0 ? shown.stdout : null;
  };
  const composeTo = fileAt(to);
  if (composeTo === null) throw new Error(`${to} has no ${COMPOSE_PATH}`);
  const rebuilds = imageRebuilds(
    changed,
    fileAt(from),
    composeTo,
    (path) => fileAt(to, path),
    composeOverlays(ctx.composeFiles, from, to, fileAt)
  );
  if (pendingFrom !== null) {
    ctx.log(`resuming an unfinished upgrade that started from ${pendingFrom.slice(0, 12)}`);
  }
  ctx.log(
    `upgrade ${from.slice(0, 12)} -> ${to.slice(0, 12)}: ${changed.length} files, ` +
      `compose inputs ${composeFilesChanged ? 'changed' : 'unchanged'}, ` +
      `D1 migrations ${migrationsChanged ? 'included' : 'none'}`
  );
  const backupDir =
    opts.backupDir === undefined
      ? join(
          dirname(ctx.stateDir),
          'backups',
          `pre-upgrade-${new Date().toISOString().replace(/[:.]/g, '-')}`
        )
      : opts.backupDir;
  if (!backupDir)
    throw new Error(
      'automatic rollback requires a fresh backup; --skip-backup is no longer supported'
    );
  if (pendingFrom !== null) {
    await recoverPendingUpgrade(ctx, opts, pendingFrom, rebuilds);
    return runUpgrade(ctx, opts);
  }
  assertRollbackCacheReady(backupContext(ctx));
  const installed = installedMigrations(backupContext(ctx));
  runBackup(backupContext(ctx), backupDir, from);

  const boxArgs = [...deployBoxArgs(ctx), ...upgradeKeyArgs(ctx, ctx.log)];
  const pendingPath = join(ctx.stateDir, UPGRADE_PENDING_FILE);
  if (pendingFrom === null) {
    mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
    replacePrivateFile(pendingPath, `${JSON.stringify({ from, backupDir, to })}\n`);
  }
  const progress: UpgradeProgress = {
    deploymentStarted: false,
    stateChanged: false,
    imagesRebuilt: [],
  };
  let composeRestarted: boolean;
  try {
    composeRestarted = await applyUpgrade(
      ctx,
      opts,
      git,
      { to, composeFilesChanged, rebuilds, boxArgs, installed },
      progress
    );
  } catch (error) {
    await rollbackFailedUpgrade(ctx, opts, git, from, backupDir, progress);
    throw error;
  }

  // Completion/cleanup failure must never enter automatic rollback after health succeeded.
  completeUpgradeJournal(ctx.stateDir, { from, to, backupDir }, opts.onCompleted);

  const { imagesRebuilt } = progress;
  const rollback = rollbackSteps(ctx, from, backupDir, imagesRebuilt);
  const plaintextLeft = plaintextLeftNotice(ctx);
  if (plaintextLeft) ctx.log(plaintextLeft);
  ctx.log(`upgraded to ${to}; healthy. To roll back:`);
  for (const step of rollback) ctx.log(`  ${step}`);
  return { from, to, backupDir, imagesRebuilt, composeRestarted, migrationsChanged, rollback };
}
