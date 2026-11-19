/**
 * `pnpm selfhost:upgrade --to <ref>`: move a one-box install to another SAM git ref.
 *
 *  1. Refuse a checkout with uncommitted tracked changes; fetch; resolve the ref.
 *  2. Check out the ref (detached) and `pnpm install --frozen-lockfile`.
 *  3. `pnpm selfhost:deploy --init`: regenerates gateway.env and the other generated state for the
 *     new code. It never regenerates platform keys. Every deploy call gets this box's
 *     `--env-file` and `--state-dir` (and `--secrets` when given): without them the deploy would
 *     read the checkout's default .env and .state, a different box.
 *  4. Restart the stack (`docker compose up -d --build`) only when compose inputs changed: a
 *     non-README file under deploy/selfhost/, a compose file the box's COMPOSE_FILE selects, or a
 *     generated file in .state/ that step 3 changed.
 *     This must precede step 5: deploy refuses to update the Worker while gateway.env differs
 *     from what the running frps and Caddy read.
 *  5. `pnpm selfhost:deploy`: applies D1 migrations (celld d1 migrations apply) and publishes the
 *     Worker with `celld deploy`, which applies Durable Object migrations (celld accepts only
 *     `new_sqlite_classes`); it waits for /health itself.
 *  6. Verify /health once more, then print how to roll back.
 *
 * Before step 2 the upgrade records the ref it started from in `<state-dir>/upgrade-pending.json`
 * and removes the record only after step 6 passes. A failed upgrade leaves the checkout at the
 * target, so a retry with the same `--to` is not "already there": it resumes from the recorded
 * ref, runs every step again (restarting the stack, since the failed run may have got that far),
 * and its rollback still names the ref that was deployed before.
 *
 * The upgrade takes NO backup. Rollback depends on whether the upgrade carried a D1 migration:
 * without one, the previous ref redeploys over the same fleet; with one, an older Worker must not
 * run against the migrated data, so rollback needs the operator's own pre-upgrade copy of the
 * fleet bucket and .state, restored into an empty bucket.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { log, REPO_ROOT } from './deploy-steps.js';
import { assertPrivateFile, parseDotenv, replacePrivateFile } from './secret-files.js';

export const SELFHOST_DIR = join(REPO_ROOT, 'deploy/selfhost');

/** Suffix of the files under .state/ that docker compose services read (`env_file`). */
const GENERATED_STATE_FILE_SUFFIX = '.env';
const MIGRATIONS_DIR = 'apps/api/src/db/migrations/';
/** In the state dir while an upgrade has not finished: `{ "from": "<sha>" }`. */
export const UPGRADE_PENDING_FILE = 'upgrade-pending.json';

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a command. `env` is the child's environment (secrets go here, never in `args`). */
export type Runner = (command: string, args: string[], env?: NodeJS.ProcessEnv) => RunResult;

export interface BoxContext {
  /** Parsed deploy/selfhost/.env. */
  box: Readonly<Record<string, string>>;
  envFile: string;
  stateDir: string;
  /** The deploy's `--secrets` file, when not the default `<stateDir>/secrets.env`. */
  secretsFile?: string;
  /** Every compose file the box runs with, in order (composeFilesFor). */
  composeFiles: string[];
  run: Runner;
  log: (message: string) => void;
}

export interface UpgradeOptions {
  to: string;
  checkHealth: () => Promise<boolean>;
}

export interface UpgradeResult {
  from: string;
  to: string;
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

/**
 * The compose files a box runs with. `COMPOSE_FILE` in .env adds files to the stack, and docker
 * compose reads it only when no `-f` is given: an explicit `-f docker-compose.yml` silently drops
 * every other file, so a recreate loses what they add. Scripted compose calls must therefore pass
 * this whole list. Split on COMPOSE_PATH_SEPARATOR (default `:`, as compose does on Linux);
 * relative entries are resolved against `composeDir`, the directory holding the compose files.
 */
export function composeFilesFor(
  box: Readonly<Record<string, string>>,
  composeDir: string
): string[] {
  const separator = box.COMPOSE_PATH_SEPARATOR || ':';
  const listed = (box.COMPOSE_FILE ?? '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return (listed.length > 0 ? listed : ['docker-compose.yml']).map((entry) =>
    isAbsolute(entry) ? entry : resolve(composeDir, entry)
  );
}

/** `docker compose` arguments for this box: every compose file, then its .env, then `args`. */
function composeArgs(ctx: Pick<BoxContext, 'composeFiles' | 'envFile'>, args: string[]): string[] {
  return [
    'compose',
    ...ctx.composeFiles.flatMap((file) => ['-f', file]),
    '--env-file',
    ctx.envFile,
    ...args,
  ];
}

/** The box context from an .env file (which must exist and be private: it holds the bucket key). */
export function loadBox(
  envFile: string,
  stateDirOverride?: string,
  secretsFile?: string
): BoxContext {
  if (!existsSync(envFile)) throw new Error(`${envFile} does not exist`);
  assertPrivateFile(envFile);
  const box = parseDotenv(readFileSync(envFile, 'utf8'), envFile);
  if (!box.CELLD_BUCKET) throw new Error(`${envFile}: CELLD_BUCKET is required`);
  return {
    box,
    envFile,
    // Same default and base directory docker compose and deploy.ts use.
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
      `${what} failed (exit ${result.status}): ${result.stderr.trim().slice(0, 500)}`
    );
  }
  return result.stdout.trim();
}

function stateFingerprint(stateDir: string): string {
  const hash = createHash('sha256');
  if (!existsSync(stateDir)) return '';
  for (const name of readdirSync(stateDir).sort()) {
    if (!name.endsWith(GENERATED_STATE_FILE_SUFFIX)) continue;
    try {
      hash.update(name).update(readFileSync(join(stateDir, name)));
    } catch {
      // a directory or unreadable entry is not a compose input
    }
  }
  return hash.digest('hex');
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

/** `value` as one POSIX shell word, for the printed rollback commands. */
function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Rollback steps, printed for the operator. Their compose commands select the same box as the
 * upgrade's own (`composeArgs`: every compose file and the box's .env), so a custom `--box-env`
 * is rolled back, not the default stack.
 */
function rollbackSteps(
  ctx: Pick<BoxContext, 'composeFiles' | 'envFile'>,
  from: string,
  migrationsChanged: boolean,
  composeChanged: boolean,
  boxArgs: readonly string[] = []
): string[] {
  const compose = (args: string[]) =>
    ['docker', ...composeArgs(ctx, args)].map(shellWord).join(' ');
  const deploy = ['pnpm selfhost:deploy', ...boxArgs.map(shellWord)].join(' ');
  if (!migrationsChanged) {
    return [
      `git checkout ${from}`,
      'pnpm install --frozen-lockfile',
      ...(composeChanged ? [`${deploy} --init`, compose(['up', '-d', '--build'])] : []),
      deploy,
    ];
  }
  return [
    '# This upgrade applied D1 migrations: do NOT redeploy the old Worker over the migrated fleet.',
    '# The upgrade took no backup. Rolling back needs your own copy of the fleet bucket and',
    '# .state from before the upgrade:',
    compose(['down']),
    `# Point CELLD_BUCKET in ${ctx.envFile} at a new, empty bucket, copy your pre-upgrade`,
    '# bucket contents into it, put your pre-upgrade .state back, then:',
    `git checkout ${from}`,
    'pnpm install --frozen-lockfile',
    compose(['up', '-d']),
  ];
}

/**
 * True when the diff touches a compose input: a non-README file under deploy/selfhost/, or any
 * compose file the box selects (COMPOSE_FILE may list one elsewhere in the repository).
 */
export function composeInputsChanged(changed: readonly string[], composeFiles: readonly string[]) {
  const selected = new Set(composeFiles.map((file) => relative(REPO_ROOT, resolve(file))));
  return changed.some(
    (f) => (f.startsWith('deploy/selfhost/') && !f.endsWith('.md')) || selected.has(f)
  );
}

/** The ref an unfinished upgrade started from (`UPGRADE_PENDING_FILE`), or null. */
function readPendingFrom(stateDir: string): string | null {
  const path = join(stateDir, UPGRADE_PENDING_FILE);
  if (!existsSync(path)) return null;
  let from: unknown;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof record === 'object' && record !== null && 'from' in record) from = record.from;
  } catch {
    from = undefined;
  }
  if (typeof from !== 'string' || !/^[0-9a-f]{40}$/.test(from)) {
    throw new Error(
      `${path} is not a record this upgrade wrote; check which ref the box last deployed ` +
        'successfully, check it out, and delete the file'
    );
  }
  return from;
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

/**
 * Checks out `to`, runs `--init` (it may rewrite generated compose inputs), restarts the stack
 * when its inputs changed, deploys and checks health. Returns whether the stack was restarted.
 * Sets `progress.stateChanged` as soon as it knows, so a failure later can still say so.
 */
async function applyUpgrade(
  ctx: BoxContext,
  opts: UpgradeOptions,
  git: Git,
  to: string,
  composeFilesChanged: boolean,
  boxArgs: string[],
  progress: { stateChanged: boolean }
): Promise<boolean> {
  const pnpm = (args: string[]) => check(ctx.run('pnpm', args), `pnpm ${args.join(' ')}`);
  git(['checkout', '--detach', to]);
  pnpm(['install', '--frozen-lockfile']);
  const before = stateFingerprint(ctx.stateDir);
  pnpm(['selfhost:deploy', '--init', ...boxArgs]);
  const stateChanged = stateFingerprint(ctx.stateDir) !== before;
  progress.stateChanged = stateChanged;
  let composeRestarted = false;
  if (composeFilesChanged || stateChanged) {
    ctx.log(
      `restarting the stack (${composeFilesChanged ? 'compose files' : 'generated state'} changed)`
    );
    check(
      ctx.run('docker', composeArgs(ctx, ['up', '-d', '--build'])),
      'docker compose up -d --build'
    );
    composeRestarted = true;
  } else {
    ctx.log('compose inputs unchanged; the stack keeps running');
  }
  pnpm(['selfhost:deploy', ...boxArgs]);
  if (!(await opts.checkHealth())) throw new Error('the API is not healthy after the upgrade');
  return composeRestarted;
}

export async function runUpgrade(ctx: BoxContext, opts: UpgradeOptions): Promise<UpgradeResult> {
  const git: Git = (args, what = `git ${args.join(' ')}`) => check(ctx.run('git', args), what);

  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error(
      'the checkout has uncommitted changes to tracked files; commit or stash them first'
    );
  }
  git(['fetch', '--tags', 'origin']);
  const head = git(['rev-parse', 'HEAD']);
  const pendingFrom = readPendingFrom(ctx.stateDir);
  // A pending record means the checkout may be ahead of what is deployed: start from the record.
  const from = pendingFrom ?? head;
  const to = resolveUpgradeTarget(git, opts.to);
  if (pendingFrom === null && head === to) {
    ctx.log('already at that ref; nothing to do');
    return { from, to, composeRestarted: false, migrationsChanged: false, rollback: [] };
  }
  const changed = git(['diff', '--name-only', from, to]).split('\n').filter(Boolean);
  // Resuming: the failed run may have restarted the stack on files this diff no longer shows.
  const composeFilesChanged =
    pendingFrom !== null || composeInputsChanged(changed, ctx.composeFiles);
  const migrationsChanged = changed.some((f) => f.startsWith(MIGRATIONS_DIR));
  if (pendingFrom !== null) {
    ctx.log(`resuming an unfinished upgrade that started from ${pendingFrom.slice(0, 12)}`);
  }
  ctx.log(
    `upgrade ${from.slice(0, 12)} -> ${to.slice(0, 12)}: ${changed.length} files, ` +
      `compose inputs ${composeFilesChanged ? 'changed' : 'unchanged'}, ` +
      `D1 migrations ${migrationsChanged ? 'included' : 'none'}`
  );
  ctx.log('no backup is taken: keep your own copy of the fleet bucket and .state before upgrading');

  const boxArgs = deployBoxArgs(ctx);
  const pendingPath = join(ctx.stateDir, UPGRADE_PENDING_FILE);
  if (pendingFrom === null) {
    mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
    replacePrivateFile(pendingPath, `${JSON.stringify({ from })}\n`);
  }
  const progress = { stateChanged: false };
  let composeRestarted: boolean;
  try {
    composeRestarted = await applyUpgrade(
      ctx,
      opts,
      git,
      to,
      composeFilesChanged,
      boxArgs,
      progress
    );
  } catch (error) {
    ctx.log(`upgrade FAILED: ${error instanceof Error ? error.message : String(error)}`);
    ctx.log('to retry, run the same selfhost:upgrade again; to roll back:');
    const rollback = rollbackSteps(
      ctx,
      from,
      migrationsChanged,
      composeFilesChanged || progress.stateChanged,
      boxArgs
    );
    for (const step of rollback) ctx.log(`  ${step}`);
    throw error;
  }
  rmSync(pendingPath, { force: true });

  const rollback = rollbackSteps(ctx, from, migrationsChanged, composeRestarted, boxArgs);
  ctx.log(`upgraded to ${to}; healthy. To roll back:`);
  for (const step of rollback) ctx.log(`  ${step}`);
  return { from, to, composeRestarted, migrationsChanged, rollback };
}
