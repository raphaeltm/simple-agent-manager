/**
 * `pnpm selfhost:upgrade --to <ref>`: move a one-box install to another SAM git ref.
 *
 *  1. Refuse a checkout with uncommitted tracked changes; fetch; resolve the ref.
 *  2. Back up (backup-lib.ts runBackup) unless --skip-backup.
 *  3. Check out the ref (detached) and `pnpm install --frozen-lockfile`.
 *  4. `pnpm selfhost:deploy --init`: regenerates gateway.env, the egress-fence files and the
 *     other generated state for the new code. It never regenerates platform keys.
 *  5. Restart the stack (`docker compose up -d --build`) only when compose inputs changed: a
 *     non-README file under deploy/selfhost/, or a generated file in .state/ that step 4 changed.
 *     This must precede step 6: deploy refuses to update the Worker while gateway.env differs
 *     from what the running frps and Caddy read.
 *  6. `pnpm selfhost:deploy`: applies D1 migrations (celld d1 migrations apply) and publishes the
 *     Worker with `celld deploy`, which applies Durable Object migrations (celld accepts only
 *     `new_sqlite_classes`); it waits for /health itself.
 *  7. Verify /health once more, then print how to roll back.
 *
 * Rollback depends on whether the upgrade carried a D1 migration: without one, the previous ref
 * redeploys over the same fleet; with one, an older Worker must not run against the migrated
 * data, so rollback is a restore of the step-2 backup into an empty bucket.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type BoxContext, runBackup, type RunResult } from './backup-lib';

/** Files under .state/ that docker compose services read (env_file, mounts). */
const GENERATED_STATE_FILE = /\.(env|nft|caddy|toml|json)$/;
/** Generated files in subdirectories of .state/ that a compose service reads. */
const GENERATED_NESTED_FILES = ['key-agent/agent.env'];
const MIGRATIONS_DIR = 'apps/api/src/db/migrations/';

export interface UpgradeOptions {
  to: string;
  backupDir: string | null;
  checkHealth: () => Promise<boolean>;
}

export interface UpgradeResult {
  from: string;
  to: string;
  backupDir: string | null;
  composeRestarted: boolean;
  migrationsChanged: boolean;
  rollback: string[];
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
    if (!GENERATED_STATE_FILE.test(name) || name === 'platform-keys.json') continue;
    const path = join(stateDir, name);
    try {
      hash.update(name).update(readFileSync(path));
    } catch {
      // a directory or unreadable entry is not a compose input
    }
  }
  for (const name of GENERATED_NESTED_FILES) {
    const path = join(stateDir, name);
    if (existsSync(path)) hash.update(name).update(readFileSync(path));
  }
  return hash.digest('hex');
}

/**
 * A plaintext box (platform-keys.json present) with no recorded key provider and no
 * SAM_KEY_PROVIDER in .env: one the upgrade must not switch to sealed secrets by itself.
 */
export function holdOnPlaintext(ctx: Pick<BoxContext, 'box' | 'stateDir'>): boolean {
  return (
    existsSync(join(ctx.stateDir, 'platform-keys.json')) &&
    !existsSync(join(ctx.stateDir, 'key-agent', 'choice.json')) &&
    !ctx.box.SAM_KEY_PROVIDER?.trim()
  );
}

export function rollbackSteps(
  from: string,
  migrationsChanged: boolean,
  composeChanged: boolean,
  backupDir: string | null
): string[] {
  if (!migrationsChanged) {
    return [
      `git checkout ${from}`,
      'pnpm install --frozen-lockfile',
      ...(composeChanged
        ? [
            'pnpm selfhost:deploy --init',
            'docker compose -f deploy/selfhost/docker-compose.yml up -d --build',
          ]
        : []),
      'pnpm selfhost:deploy',
    ];
  }
  return [
    '# This upgrade applied D1 migrations: do NOT redeploy the old Worker over the migrated fleet.',
    'docker compose -f deploy/selfhost/docker-compose.yml down',
    '# Point CELLD_BUCKET in deploy/selfhost/.env at a new, empty bucket (or empty the old one),',
    '# move deploy/selfhost/.state aside, then:',
    `git checkout ${from}`,
    'pnpm install --frozen-lockfile',
    backupDir
      ? `pnpm selfhost:restore --from ${backupDir}`
      : '# no backup was taken (--skip-backup): restore your most recent pnpm selfhost:backup',
    'docker compose -f deploy/selfhost/docker-compose.yml up -d',
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
      backupDir: null,
      composeRestarted: false,
      migrationsChanged: false,
      rollback: [],
    };
  }

  if (opts.backupDir) runBackup(ctx, opts.backupDir, from);

  let composeRestarted = false;
  const pnpm = (args: string[]) => check(ctx.run('pnpm', args), `pnpm ${args.join(' ')}`);
  try {
    git(['checkout', '--detach', to]);
    pnpm(['install', '--frozen-lockfile']);
    const before = stateFingerprint(ctx.stateDir);
    // A box that still runs on plaintext files stays on them: switching to sealed secrets is
    // `pnpm selfhost:secrets migrate`, which checks the chain first and rolls back on failure.
    const hold = holdOnPlaintext(ctx);
    if (hold) {
      ctx.log(
        'this box still has its plaintext secret files: the upgrade keeps it on plaintext deploy ' +
          'vars; afterwards, `pnpm selfhost:secrets migrate` seals it safely'
      );
    }
    const keyArgs = hold ? ['--key-provider', 'legacy-plaintext'] : [];
    pnpm(['selfhost:deploy', '--init', ...keyArgs]);
    const stateChanged = stateFingerprint(ctx.stateDir) !== before;
    if (composeFilesChanged || stateChanged) {
      ctx.log(
        `restarting the stack (${composeFilesChanged ? 'compose files' : 'generated state'} changed)`
      );
      check(
        ctx.run('docker', [
          'compose',
          '-f',
          ctx.composeFile,
          '--env-file',
          ctx.envFile,
          'up',
          '-d',
          '--build',
        ]),
        'docker compose up -d --build'
      );
      composeRestarted = true;
    } else {
      ctx.log('compose inputs unchanged; the stack keeps running');
    }
    pnpm(['selfhost:deploy', ...keyArgs]);
    if (!(await opts.checkHealth())) throw new Error('the API is not healthy after the upgrade');
  } catch (error) {
    const steps = rollbackSteps(from, migrationsChanged, composeFilesChanged, opts.backupDir);
    ctx.log(`upgrade FAILED: ${error instanceof Error ? error.message : String(error)}`);
    ctx.log('to roll back:');
    for (const step of steps) ctx.log(`  ${step}`);
    throw error;
  }

  const rollback = rollbackSteps(from, migrationsChanged, composeFilesChanged, opts.backupDir);
  // A box held on plaintext above, or one sealed whose plaintext files remain: migrate finishes it.
  if (
    existsSync(join(ctx.stateDir, 'platform-keys.json')) &&
    ctx.box.SAM_KEY_PROVIDER?.trim() !== 'legacy-plaintext'
  ) {
    ctx.log(
      'plaintext secrets are still on this box (.state/platform-keys.json, secrets.env): run ' +
        '`pnpm selfhost:secrets migrate` to seal (or verify) and remove them, then ' +
        '`pnpm selfhost:secrets plaintext` for the old copies in the bucket and backups'
    );
  }
  ctx.log(`upgraded to ${to}; healthy. To roll back:`);
  for (const step of rollback) ctx.log(`  ${step}`);
  return { from, to, backupDir: opts.backupDir, composeRestarted, migrationsChanged, rollback };
}
