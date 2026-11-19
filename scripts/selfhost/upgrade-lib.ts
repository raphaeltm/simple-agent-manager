/**
 * `pnpm selfhost:upgrade --to <ref>`: move a one-box install to another SAM git ref.
 *
 *  1. Refuse a checkout with uncommitted tracked changes; fetch; resolve the ref.
 *  2. Check out the ref (detached) and `pnpm install --frozen-lockfile`.
 *  3. `pnpm selfhost:deploy --init`: regenerates gateway.env and the other generated state for the
 *     new code. It never regenerates platform keys. Every deploy call gets this box's
 *     `--env-file` and `--state-dir` (and `--secrets` when given): without them the deploy would
 *     read the checkout's default .env and .state, a different box.
 *  4. Rebuild a locally built image (caddy, sam-mx) only when its build inputs changed
 *     (imageRebuilds: its build section in docker-compose.yml or a file in its build context),
 *     with an explicit `docker compose build <service>`; then restart the stack
 *     (`docker compose up -d`, never `--build`) only when compose inputs changed: a non-README file
 *     under deploy/selfhost/, or a generated file in .state/ that step 3 changed. This must
 *     precede step 5: deploy refuses to update the Worker while gateway.env differs from what the
 *     running frps and Caddy read.
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
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { withComposePortOverrides } from './box-settings.js';
import { log, REPO_ROOT } from './deploy-steps.js';
import { assertPrivateFile, parseDotenv } from './secret-files.js';

export const SELFHOST_DIR = join(REPO_ROOT, 'deploy/selfhost');

/** Files under .state/ that docker compose services read (`env_file`). */
const GENERATED_STATE_FILE = /\.env$/;
const MIGRATIONS_DIR = 'apps/api/src/db/migrations/';
/** The compose file, relative to the repository root (what `git show <ref>:<path>` reads). */
const COMPOSE_PATH = 'deploy/selfhost/docker-compose.yml';

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
  // Ports as docker compose runs them (a shell override beats the .env), as deploy.ts reads them.
  const { box } = withComposePortOverrides(
    parseDotenv(readFileSync(envFile, 'utf8'), envFile),
    process.env
  );
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
function deployBoxArgs(ctx: Pick<BoxContext, 'envFile' | 'stateDir' | 'secretsFile'>): string[] {
  return [
    '--env-file',
    ctx.envFile,
    '--state-dir',
    ctx.stateDir,
    ...(ctx.secretsFile ? ['--secrets', ctx.secretsFile] : []),
  ];
}

interface ComposeBuildService {
  build?: string | { context?: string; dockerfile?: string; args?: unknown };
}

/** Each locally built service's build section, from a docker-compose.yml text (null: none). */
function buildSections(compose: string | null): Map<string, ComposeBuildService['build']> {
  const sections = new Map<string, ComposeBuildService['build']>();
  if (compose === null) return sections;
  const parsed = parseYaml(compose) as { services?: Record<string, ComposeBuildService> } | null;
  for (const [name, service] of Object.entries(parsed?.services ?? {})) {
    if (service?.build !== undefined) sections.set(name, service.build);
  }
  return sections;
}

/** Whether a .dockerignore sends nothing to the build: its only pattern is `*`. */
function ignoresEverything(dockerignore: string | null): boolean {
  const patterns = (dockerignore ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return patterns.length === 1 && patterns[0] === '*';
}

/**
 * The locally built services whose image this upgrade must rebuild, from the files that changed
 * between the two refs and docker-compose.yml at each: a service is rebuilt when its build section
 * changed (context, Dockerfile, build args such as the pinned Caddy module versions) or a file in
 * its build context did. A context whose .dockerignore is exactly `*` sends nothing to the build
 * (caddy/), so only its Dockerfile and .dockerignore count; README files never do.
 *
 * Every other upgrade leaves the images alone (F11): a build fetches base images and modules from
 * the network, so it runs only when the image it would produce differs.
 */
export function imageRebuilds(
  changed: readonly string[],
  composeFrom: string | null,
  composeTo: string,
  readFileAtTo: (path: string) => string | null = () => null
): string[] {
  const before = buildSections(composeFrom);
  const rebuilds: string[] = [];
  for (const [service, build] of buildSections(composeTo)) {
    if (JSON.stringify(before.get(service)) !== JSON.stringify(build)) {
      rebuilds.push(service);
      continue;
    }
    const contextRel = typeof build === 'string' ? build : (build?.context ?? '.');
    const context = posix.join(posix.dirname(COMPOSE_PATH), contextRel);
    const dockerfileName =
      (typeof build === 'object' ? build?.dockerfile : undefined) ?? 'Dockerfile';
    const dockerfile = posix.join(context, dockerfileName);
    const ignore = posix.join(context, '.dockerignore');
    const emptyContext = ignoresEverything(readFileAtTo(ignore));
    const touched = changed.some(
      (file) =>
        file === dockerfile ||
        file === ignore ||
        (!emptyContext && file.startsWith(`${context}/`) && !file.endsWith('.md'))
    );
    if (touched) rebuilds.push(service);
  }
  return rebuilds;
}

/**
 * Rollback steps run compose from deploy/selfhost with no `-f`, so it reads .env there and honours
 * its COMPOSE_FILE (an explicit `-f docker-compose.yml` would drop every other listed file).
 */
const composeInBoxDir = (args: string) => `(cd deploy/selfhost && docker compose ${args})`;

function rollbackSteps(
  from: string,
  migrationsChanged: boolean,
  composeChanged: boolean,
  boxArgs: readonly string[] = [],
  imagesChanged: readonly string[] = []
): string[] {
  const deploy = ['pnpm selfhost:deploy', ...boxArgs].join(' ');
  const rebuild =
    imagesChanged.length > 0 ? [composeInBoxDir(`build ${imagesChanged.join(' ')}`)] : [];
  if (!migrationsChanged) {
    return [
      `git checkout ${from}`,
      'pnpm install --frozen-lockfile',
      ...(composeChanged || rebuild.length > 0
        ? [`${deploy} --init`, ...rebuild, composeInBoxDir('up -d')]
        : []),
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
    ...rebuild,
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
    return {
      from,
      to,
      imagesRebuilt: [],
      composeRestarted: false,
      migrationsChanged: false,
      rollback: [],
    };
  }
  const fileAt = (ref: string, path = COMPOSE_PATH): string | null => {
    const shown = ctx.run('git', ['show', `${ref}:${path}`]);
    return shown.status === 0 ? shown.stdout : null;
  };
  const composeTo = fileAt(to);
  if (composeTo === null) throw new Error(`${to} has no ${COMPOSE_PATH}`);
  const rebuilds = imageRebuilds(changed, fileAt(from), composeTo, (path) => fileAt(to, path));
  ctx.log('no backup is taken: keep your own copy of the fleet bucket and .state before upgrading');

  let composeRestarted = false;
  let imagesRebuilt: string[] = [];
  const boxArgs = deployBoxArgs(ctx);
  const docker = (args: string[]) =>
    check(ctx.run('docker', composeArgs(ctx, args)), `docker compose ${args.join(' ')}`);
  const pnpm = (args: string[]) => check(ctx.run('pnpm', args), `pnpm ${args.join(' ')}`);
  try {
    git(['checkout', '--detach', to]);
    pnpm(['install', '--frozen-lockfile']);
    const before = stateFingerprint(ctx.stateDir);
    pnpm(['selfhost:deploy', '--init', ...boxArgs]);
    const stateChanged = stateFingerprint(ctx.stateDir) !== before;
    if (rebuilds.length > 0) {
      // Only services the box runs (its COMPOSE_PROFILES): sam-mx is not built on a box without
      // inbound mail.
      const active = new Set(docker(['config', '--services']).split('\n').filter(Boolean));
      imagesRebuilt = rebuilds.filter((service) => active.has(service));
      if (imagesRebuilt.length > 0) {
        ctx.log(`rebuilding ${imagesRebuilt.join(', ')} (build inputs changed)`);
        docker(['build', ...imagesRebuilt]);
      }
    }
    if (composeFilesChanged || stateChanged || imagesRebuilt.length > 0) {
      const why = composeFilesChanged
        ? 'compose files'
        : stateChanged
          ? 'generated state'
          : 'images';
      ctx.log(`restarting the stack (${why} changed)`);
      docker(['up', '-d']);
      composeRestarted = true;
    } else {
      ctx.log('compose inputs unchanged; the stack keeps running');
    }
    pnpm(['selfhost:deploy', ...boxArgs]);
    if (!(await opts.checkHealth())) throw new Error('the API is not healthy after the upgrade');
  } catch (error) {
    const steps = rollbackSteps(
      from,
      migrationsChanged,
      composeFilesChanged,
      boxArgs,
      imagesRebuilt
    );
    ctx.log(`upgrade FAILED: ${error instanceof Error ? error.message : String(error)}`);
    ctx.log('to roll back:');
    for (const step of steps) ctx.log(`  ${step}`);
    throw error;
  }

  const rollback = rollbackSteps(
    from,
    migrationsChanged,
    composeFilesChanged,
    boxArgs,
    imagesRebuilt
  );
  ctx.log(`upgraded to ${to}; healthy. To roll back:`);
  for (const step of rollback) ctx.log(`  ${step}`);
  return { from, to, imagesRebuilt, composeRestarted, migrationsChanged, rollback };
}
