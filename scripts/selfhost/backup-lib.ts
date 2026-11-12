/**
 * Backup and restore for a one-box install (`pnpm selfhost:backup`, `pnpm selfhost:restore`).
 *
 * What is backed up, and why only this: the fleet bucket (`CELLD_BUCKET`) is celld's durable
 * state, holding every D1 database, Durable Object, R2 object and deployed Worker version; the
 * `celld-data` volume is a cache of it (docker-compose.yml). The box's own state is `.state/`
 * (platform keys, gateway and fence files, operator secrets) and `.env` (domain, bucket and its
 * credential). A backup is those three, nothing else.
 *
 * Consistency: a live copy of a running fleet is not guaranteed consistent by celld. So, as the
 * box agents did by hand: copy the bucket live (long, no downtime), stop celld, copy again (only
 * the delta moves), copy `.state/` and `.env`, start celld. Downtime is the delta copy only and is
 * recorded in the backup's manifest. celld is restarted even when the delta copy fails.
 *
 * Restore goes into an EMPTY install only: an empty target bucket and no platform keys in the
 * target `.state/`. Restoring over a live fleet, or starting an older Worker against a fleet a
 * newer one migrated, is how data is lost; both are refused rather than offered with a flag.
 *
 * The bucket copy is delegated to the tool each store already has on a box: `gcloud storage
 * rsync` for gs://, and `mc mirror` from the objectstore image pinned in docker-compose.yml for
 * s3:// (the bundled store or any S3 endpoint). Credentials reach `mc` through the environment
 * (`-e MC_HOST_src` names the variable; its value never appears on a command line or in a log).
 *
 * A backup contains every Worker secret in plaintext (bucket `deploy/` manifests, `.state/`,
 * `.env`). The backup directory is created mode 0700; keep copies where only the operator can
 * read them.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ensurePrivateDir } from './secret-files';

/** The objectstore image docker-compose.yml pins; `mc` ships in it. */
export const OBJECTSTORE_IMAGE =
  'pgsty/minio@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372';
export const MANIFEST_NAME = 'backup-manifest.json';
export const BUCKET_DIR = 'bucket';
export const STATE_DIR = 'state';
export const ENV_FILE = 'env';

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
  composeFile: string;
  run: Runner;
  now: () => number;
  log: (message: string) => void;
  /** uid:gid for files `mc` writes into a local directory. */
  user?: string;
}

interface BucketUrl {
  scheme: 'gs' | 's3';
  bucket: string;
  prefix: string;
}

export function parseBucketUrl(url: string): BucketUrl {
  const match = /^(gs|s3):\/\/([^/]+)\/?(.*)$/.exec(url.trim());
  if (!match) throw new Error(`CELLD_BUCKET must be gs://bucket[/prefix] or s3://bucket[/prefix]`);
  return {
    scheme: match[1] as 'gs' | 's3',
    bucket: match[2] as string,
    prefix: (match[3] ?? '').replace(/\/+$/, ''),
  };
}

function check(result: RunResult, what: string): RunResult {
  if (result.status !== 0) {
    // stderr of gcloud/mc/docker carries no secret (credentials travel in the environment).
    throw new Error(
      `${what} failed (exit ${result.status}): ${result.stderr.trim().slice(0, 500)}`
    );
  }
  return result;
}

function mcEnv(ctx: BoxContext): NodeJS.ProcessEnv {
  const endpoint = ctx.box.S3_ENDPOINT?.trim();
  const key = ctx.box.AWS_ACCESS_KEY_ID ?? '';
  const secret = ctx.box.AWS_SECRET_ACCESS_KEY ?? '';
  if (!endpoint) throw new Error('s3:// buckets need S3_ENDPOINT in .env');
  const url = new URL(endpoint);
  url.username = encodeURIComponent(key);
  url.password = encodeURIComponent(secret);
  return { ...process.env, MC_HOST_src: url.toString().replace(/\/$/, '') };
}

function mcArgs(ctx: BoxContext, mounts: string[], mcCommand: string[]): string[] {
  return [
    'run',
    '--rm',
    '--network',
    'host',
    ...(ctx.user ? ['--user', ctx.user] : []),
    '-e',
    'MC_HOST_src',
    '-e',
    'MC_CONFIG_DIR=/tmp/mc',
    ...mounts.flatMap((m) => ['-v', m]),
    '--entrypoint',
    'mc',
    OBJECTSTORE_IMAGE,
    ...mcCommand,
  ];
}

function bucketPath(url: BucketUrl): string {
  return url.prefix ? `${url.bucket}/${url.prefix}` : url.bucket;
}

/** Copy the fleet bucket into `dir`, deleting files no longer in the bucket (a mirror). */
export function pullBucket(ctx: BoxContext, dir: string): void {
  const url = parseBucketUrl(ctx.box.CELLD_BUCKET ?? '');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (url.scheme === 'gs') {
    check(
      ctx.run('gcloud', [
        'storage',
        'rsync',
        '--recursive',
        '--delete-unmatched-destination-objects',
        `gs://${bucketPath(url)}`,
        dir,
      ]),
      'gcloud storage rsync (bucket -> backup)'
    );
    return;
  }
  check(
    ctx.run(
      'docker',
      mcArgs(
        ctx,
        [`${resolve(dir)}:/backup`],
        ['mirror', '--overwrite', '--remove', '--quiet', `src/${bucketPath(url)}`, '/backup']
      ),
      mcEnv(ctx)
    ),
    'mc mirror (bucket -> backup)'
  );
}

/** Copy `dir` into the (empty) fleet bucket. */
export function pushBucket(ctx: BoxContext, dir: string): void {
  const url = parseBucketUrl(ctx.box.CELLD_BUCKET ?? '');
  if (url.scheme === 'gs') {
    check(
      ctx.run('gcloud', ['storage', 'rsync', '--recursive', dir, `gs://${bucketPath(url)}`]),
      'gcloud storage rsync (backup -> bucket)'
    );
    return;
  }
  check(
    ctx.run(
      'docker',
      mcArgs(
        ctx,
        [`${resolve(dir)}:/backup:ro`],
        ['mirror', '--quiet', '/backup', `src/${bucketPath(url)}`]
      ),
      mcEnv(ctx)
    ),
    'mc mirror (backup -> bucket)'
  );
}

/** Whether the fleet bucket (under its prefix) holds no objects. */
export function bucketIsEmpty(ctx: BoxContext): boolean {
  const url = parseBucketUrl(ctx.box.CELLD_BUCKET ?? '');
  if (url.scheme === 'gs') {
    const result = ctx.run('gcloud', ['storage', 'ls', `gs://${bucketPath(url)}/**`]);
    if (result.status !== 0 && /matched no objects/i.test(result.stderr)) return true;
    return check(result, 'gcloud storage ls').stdout.trim() === '';
  }
  const result = check(
    ctx.run('docker', mcArgs(ctx, [], ['ls', '--recursive', `src/${bucketPath(url)}`]), mcEnv(ctx)),
    'mc ls'
  );
  return result.stdout.trim() === '';
}

function compose(ctx: BoxContext, args: string[]): void {
  check(
    ctx.run('docker', ['compose', '-f', ctx.composeFile, '--env-file', ctx.envFile, ...args]),
    `docker compose ${args.join(' ')}`
  );
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  /** The bucket URL only; credentials are never written here. */
  bucket: string;
  samCommit: string | null;
  precopyMs: number;
  /** celld stopped -> celld started again. */
  downtimeMs: number;
  deltaCopyMs: number;
  objectCount: number;
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return count;
}

/** Live pre-copy, short stop, delta, restart. Returns the manifest written into `dest`. */
export function runBackup(
  ctx: BoxContext,
  dest: string,
  samCommit: string | null = null
): BackupManifest {
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    throw new Error(`${dest} is not empty; choose a new backup directory`);
  }
  ensurePrivateDir(dest);
  const bucketDir = join(dest, BUCKET_DIR);

  const precopyStart = ctx.now();
  ctx.log(`live pre-copy of ${ctx.box.CELLD_BUCKET} (celld keeps running)`);
  // Best effort: a running node rewrites its lease, waker and capacity objects every few seconds,
  // so `gcloud storage rsync` meets generations that vanished mid-copy (404) and exits non-zero.
  // The pre-copy only shortens the downtime; the delta copy below, with celld stopped, is the one
  // that must succeed, and it fails loudly if the store itself is unreachable.
  try {
    pullBucket(ctx, bucketDir);
  } catch (err) {
    ctx.log(
      `live pre-copy incomplete, the delta copy with celld stopped will finish it: ${
        err instanceof Error ? err.message.split('\n')[0]?.slice(0, 200) : String(err)
      }`
    );
  }
  const precopyMs = ctx.now() - precopyStart;

  ctx.log('stopping celld for the delta copy');
  compose(ctx, ['stop', 'celld']);
  const stoppedAt = ctx.now();
  let deltaCopyMs = 0;
  let startedAt = stoppedAt;
  try {
    pullBucket(ctx, bucketDir);
    deltaCopyMs = ctx.now() - stoppedAt;
    cpSync(ctx.stateDir, join(dest, STATE_DIR), { recursive: true, preserveTimestamps: true });
    cpSync(ctx.envFile, join(dest, ENV_FILE), { preserveTimestamps: true });
  } finally {
    ctx.log('starting celld');
    compose(ctx, ['start', 'celld']);
    startedAt = ctx.now();
  }

  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date(stoppedAt).toISOString(),
    bucket: ctx.box.CELLD_BUCKET ?? '',
    samCommit,
    precopyMs,
    downtimeMs: startedAt - stoppedAt,
    deltaCopyMs,
    objectCount: countFiles(bucketDir),
  };
  writeFileSync(join(dest, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  ctx.log(
    `backup complete: ${manifest.objectCount} objects, celld down ${(manifest.downtimeMs / 1000).toFixed(1)} s -> ${dest}`
  );
  return manifest;
}

export function readManifest(dir: string): BackupManifest {
  const path = join(dir, MANIFEST_NAME);
  if (!existsSync(path)) throw new Error(`${dir} has no ${MANIFEST_NAME}; not a backup`);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { objectCount?: unknown }).objectCount !== 'number'
  ) {
    throw new Error(`${path} is not a version 1 backup manifest`);
  }
  return parsed as BackupManifest;
}

/**
 * Restore `from` into an empty install: the target bucket (the CELLD_BUCKET in ctx.box) must be
 * empty and the target `.state/` must have no platform keys. celld stays stopped; the caller
 * prints how to start the stack.
 */
export function runRestore(ctx: BoxContext, from: string): BackupManifest {
  const manifest = readManifest(from);
  if (existsSync(join(ctx.stateDir, 'platform-keys.json'))) {
    throw new Error(
      `${ctx.stateDir} already holds platform keys: restore only into an empty install`
    );
  }
  if (!bucketIsEmpty(ctx)) {
    throw new Error(`${ctx.box.CELLD_BUCKET} is not empty: restore only into an empty bucket`);
  }
  // Harmless when the stack is not up; required so no celld writes while the bucket fills.
  compose(ctx, ['stop', 'celld']);
  ctx.log(`copying ${manifest.objectCount} objects into ${ctx.box.CELLD_BUCKET}`);
  pushBucket(ctx, join(from, BUCKET_DIR));
  ensurePrivateDir(ctx.stateDir);
  cpSync(join(from, STATE_DIR), ctx.stateDir, { recursive: true, preserveTimestamps: true });
  return manifest;
}
