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
 *     non-README file under deploy/selfhost/, or a generated file in .state/ that step 3 changed.
 *     This must precede step 5: deploy refuses to update the Worker while gateway.env differs
 *     from what the running frps and Caddy read.
 *  5. `pnpm selfhost:deploy`: applies D1 migrations (celld d1 migrations apply) and publishes the
 *     Worker with `celld deploy`, which applies Durable Object migrations (celld accepts only
 *     `new_sqlite_classes`); it waits for /health itself.
 *  6. Verify /health once more, then print how to roll back.
 *
 * The upgrade takes NO backup. Rollback depends on whether the upgrade carried a D1 migration:
 * without one, the previous ref redeploys over the same fleet; with one, an older Worker must not
 * run against the migrated data, so rollback needs the operator's own pre-upgrade copy of the
 * fleet bucket and .state, restored into an empty bucket.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { assertPrivateFile, parseDotenv } from './secret-files.js';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');
export const SELFHOST_DIR = join(REPO_ROOT, 'deploy/selfhost');

/** Files under .state/ that docker compose services read (`env_file`). */
const GENERATED_STATE_FILE = /\.env$/;
const MIGRATIONS_DIR = 'apps/api/src/db/migrations/';

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
    log: (message) => process.stdout.write(`[selfhost] ${message}\n`),
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
    if (!GENERATED_STATE_FILE.test(name)) continue;
    try {
      hash.update(name).update(readFileSync(join(stateDir, name)));
    } catch {
      // a directory or unreadable entry is not a compose input
    }
  }
  return hash.digest('hex');
}

/** The `pnpm selfhost:deploy` arguments that select this box (env file, state dir, secrets). */
export function deployBoxArgs(
  ctx: Pick<BoxContext, 'envFile' | 'stateDir' | 'secretsFile'>
): string[] {
  return [
    '--env-file',
    ctx.envFile,
    '--state-dir',
    ctx.stateDir,
    ...(ctx.secretsFile ? ['--secrets', ctx.secretsFile] : []),
  ];
}

/**
 * Rollback steps run compose from deploy/selfhost with no `-f`, so it reads .env there and honours
 * its COMPOSE_FILE (an explicit `-f docker-compose.yml` would drop every other listed file).
 */
const composeInBoxDir = (args: string) => `(cd deploy/selfhost && docker compose ${args})`;

export function rollbackSteps(
  from: string,
  migrationsChanged: boolean,
  composeChanged: boolean,
  boxArgs: readonly string[] = []
): string[] {
  const deploy = ['pnpm selfhost:deploy', ...boxArgs].join(' ');
  if (!migrationsChanged) {
    return [
      `git checkout ${from}`,
      'pnpm install --frozen-lockfile',
      ...(composeChanged ? [`${deploy} --init`, composeInBoxDir('up -d --build')] : []),
      deploy,
    ];
  }
  return [
    '# This upgrade applied D1 migrations: do NOT redeploy the old Worker over the migrated fleet.',
    '# The upgrade took no backup. Rolling back needs your own copy of the fleet bucket and',
    '# .state from before the upgrade:',
    composeInBoxDir('down'),
    '# Point CELLD_BUCKET in deploy/selfhost/.env at a new, empty bucket, copy your pre-upgrade',
    '# bucket contents into it, put your pre-upgrade .state back, then:',
    `git checkout ${from}`,
    'pnpm install --frozen-lockfile',
    composeInBoxDir('up -d'),
  ];
}

export async function runUpgrade(ctx: BoxContext, opts: UpgradeOptions): Promise<UpgradeResult> {
  const git = (args: string[], what = `git ${args.join(' ')}`) => check(ctx.run('git', args), what);

  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error(
      'the checkout has uncommitted changes to tracked files; commit or stash them first'
    );
  }
  git(['fetch', '--tags', 'origin']);
  const from = git(['rev-parse', 'HEAD']);
  let to: string;
  try {
    to = git(['rev-parse', '--verify', `origin/${opts.to}^{commit}`]);
  } catch {
    to = git(['rev-parse', '--verify', `${opts.to}^{commit}`], `resolve ${opts.to}`);
  }
  const changed = git(['diff', '--name-only', from, to]).split('\n').filter(Boolean);
  const composeFilesChanged = changed.some(
    (f) => f.startsWith('deploy/selfhost/') && !f.endsWith('.md')
  );
  const migrationsChanged = changed.some((f) => f.startsWith(MIGRATIONS_DIR));
  ctx.log(
    `upgrade ${from.slice(0, 12)} -> ${to.slice(0, 12)}: ${changed.length} files, ` +
      `compose inputs ${composeFilesChanged ? 'changed' : 'unchanged'}, ` +
      `D1 migrations ${migrationsChanged ? 'included' : 'none'}`
  );
  if (from === to) {
    ctx.log('already at that ref; nothing to do');
    return { from, to, composeRestarted: false, migrationsChanged: false, rollback: [] };
  }
  ctx.log('no backup is taken: keep your own copy of the fleet bucket and .state before upgrading');

  let composeRestarted = false;
  const boxArgs = deployBoxArgs(ctx);
  const pnpm = (args: string[]) => check(ctx.run('pnpm', args), `pnpm ${args.join(' ')}`);
  try {
    git(['checkout', '--detach', to]);
    pnpm(['install', '--frozen-lockfile']);
    const before = stateFingerprint(ctx.stateDir);
    pnpm(['selfhost:deploy', '--init', ...boxArgs]);
    const stateChanged = stateFingerprint(ctx.stateDir) !== before;
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
  } catch (error) {
    const steps = rollbackSteps(from, migrationsChanged, composeFilesChanged, boxArgs);
    ctx.log(`upgrade FAILED: ${error instanceof Error ? error.message : String(error)}`);
    ctx.log('to roll back:');
    for (const step of steps) ctx.log(`  ${step}`);
    throw error;
  }

  const rollback = rollbackSteps(from, migrationsChanged, composeFilesChanged, boxArgs);
  ctx.log(`upgraded to ${to}; healthy. To roll back:`);
  for (const step of rollback) ctx.log(`  ${step}`);
  return { from, to, composeRestarted, migrationsChanged, rollback };
}
