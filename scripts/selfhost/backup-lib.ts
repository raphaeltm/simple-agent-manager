/** Encrypted operator backups with a stopped-writer consistency boundary. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { prepareBackupParent } from './backup-destination';
import { decryptBackupTree, encryptBackupTree, readBackupKey } from './backup-encryption';
import { readManifest } from './backup-manifest';
import { assertBackupOutside, assertOperationPaths } from './backup-paths';
import { restoreBackup } from './backup-restore';
import { requireRunningCelld } from './backup-runtime';
import { composeProjectFor, expectedComposeProjectFor, recordBackup } from './install-record';
import { assertOperatorExecution } from './operator-only';
import { removePrivateTree } from './private-tree';
import { projectRestoreIdentity } from './restore-identity';
import { ensurePrivateDir } from './secret-files';

/**
 * Rebuildable caches under the state dir, left out of every backup. `go-cache` is the vm-agent
 * build cache (`pnpm selfhost:deploy` refills it); on the test box it was 1.6 GB of a 3.6 GB backup,
 * and the state copy runs while celld is stopped, so it also lengthened every backup's downtime.
 */
export const STATE_CACHE_EXCLUDES = ['go-cache'];

export function isRebuildableCachePath(stateDir: string, src: string): boolean {
  const rel = relative(stateDir, src);
  return STATE_CACHE_EXCLUDES.some((path) => rel === path || rel.startsWith(`${path}/`));
}

export const OBJECTSTORE_IMAGE =
  'pgsty/minio@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372';
export const MANIFEST_NAME = 'backup-manifest.json';
export const BUCKET_DIR = 'bucket';
/** Where the live pre-copy lands. It is renamed to BUCKET_DIR before the delta copy (runBackup). */
export const LIVE_DIR = '.bucket-live';
/** A from-scratch copy, used only when the delta copy fails (runBackup). */
export const FULL_DIR = '.bucket-full';
/** Suffix of gcloud's in-flight download files; one left by an aborted pass is not an object. */
const GCLOUD_TEMP_SUFFIX = '_.gstmp';
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
  /** Every compose file the box runs with, in order (composeFilesFor). */
  composeFiles: string[];
  run: Runner;
  now: () => number;
  log: (message: string) => void;
  /** uid:gid for files `mc` writes into a local directory. */
  user?: string;
  /** Separate operator-owned raw 32-byte encryption key, never backed up. */
  encryptionKeyFile?: string;
}

export interface BucketUrl {
  scheme: 'gs' | 's3';
  bucket: string;
  prefix: string;
}

export function parseBucketUrl(url: string): BucketUrl {
  const value = url.trim();
  let scheme: 'gs' | 's3';
  if (value.startsWith('gs://')) scheme = 'gs';
  else if (value.startsWith('s3://')) scheme = 's3';
  else throw new Error('CELLD_BUCKET must be gs://bucket[/prefix] or s3://bucket[/prefix]');
  if (/[\r\n\u2028\u2029]/.test(value))
    throw new Error('CELLD_BUCKET must be gs://bucket[/prefix] or s3://bucket[/prefix]');
  const rest = value.slice(5);
  const slash = rest.indexOf('/');
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  if (!bucket) throw new Error('CELLD_BUCKET must be gs://bucket[/prefix] or s3://bucket[/prefix]');
  const prefix = slash === -1 ? '' : rest.slice(slash + 1);
  let end = prefix.length;
  while (end > 0 && prefix[end - 1] === '/') end--;
  return { scheme, bucket, prefix: prefix.slice(0, end) };
}

export function check(result: RunResult, what: string): RunResult {
  if (result.status !== 0) {
    // Tool diagnostics may embed signed URLs or credentials. Never relay them.
    throw new Error(
      `${what} failed (exit ${result.status}); inspect the tool locally without sharing secret-bearing output`
    );
  }
  return result;
}

export function mcEnv(ctx: BoxContext): NodeJS.ProcessEnv {
  const endpoint = ctx.box.S3_ENDPOINT?.trim();
  const key = ctx.box.AWS_ACCESS_KEY_ID ?? '';
  const secret = ctx.box.AWS_SECRET_ACCESS_KEY ?? '';
  if (!endpoint) throw new Error('s3:// buckets need S3_ENDPOINT in .env');
  const url = new URL(endpoint);
  url.username = encodeURIComponent(key);
  url.password = encodeURIComponent(secret);
  return { ...process.env, MC_HOST_src: url.toString().replace(/\/$/, '') };
}

export function mcArgs(ctx: BoxContext, mounts: string[], mcCommand: string[]): string[] {
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

export function bucketPath(url: BucketUrl): string {
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

export { composeFilesFor } from './compose-env';

/** `docker compose` arguments for this box: every compose file, then its .env, then `args`. */
export function composeArgs(
  ctx: Pick<BoxContext, 'composeFiles' | 'envFile'> & Partial<Pick<BoxContext, 'box' | 'stateDir'>>,
  args: string[]
): string[] {
  return [
    'compose',
    '--project-name',
    composeProjectFor(ctx.box ?? {}, ctx.stateDir ?? resolve(dirname(ctx.envFile), '.state')),
    ...ctx.composeFiles.flatMap((file) => ['-f', file]),
    '--env-file',
    ctx.envFile,
    ...args,
  ];
}

export function composeRunEnv(ctx: Pick<BoxContext, 'stateDir'>): NodeJS.ProcessEnv {
  return { ...process.env, SAM_SELFHOST_STATE_DIR: resolve(ctx.stateDir) };
}

function compose(ctx: BoxContext, args: string[]): void {
  check(
    ctx.run('docker', composeArgs(ctx, args), composeRunEnv(ctx)),
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

function firstLine(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? '').slice(0, 200) : String(err);
}

/** Deletes gcloud download temporaries an aborted pass left behind (they are not bucket objects). */
function removeGcloudTemporaries(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) removeGcloudTemporaries(path);
    else if (entry.name.endsWith(GCLOUD_TEMP_SUFFIX)) rmSync(path, { force: true });
  }
}

/** Live pre-copy, short stop, delta, restart. Returns the manifest written into `dest`. */
function runPlainBackup(
  ctx: BoxContext,
  dest: string,
  samCommit: string | null = null
): BackupManifest {
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    throw new Error(`${dest} is not empty; choose a new backup directory`);
  }
  ensurePrivateDir(dest);
  const bucketDir = join(dest, BUCKET_DIR);

  const liveDir = join(dest, LIVE_DIR);
  const fullDir = join(dest, FULL_DIR);

  const precopyStart = ctx.now();
  ctx.log(`live pre-copy of ${ctx.box.CELLD_BUCKET} (celld keeps running)`);
  // Best effort: a running node rewrites its lease, waker and capacity objects every few seconds,
  // so `gcloud storage rsync` meets generations that vanished mid-copy (404) and exits non-zero.
  // The pre-copy only shortens the downtime; the delta copy below, with celld stopped, is the one
  // that must succeed, and it fails loudly if the store itself is unreachable.
  //
  // BOX's failed stopped pass reached gcloud's POSIX-metadata step with a missing local node
  // JSON file (SDK 523: finalize_download can return false, but its caller still stats the file).
  // Keep partial live downloads and their destination-keyed resumable state out of the stopped
  // pass: remove temporary files, move only completed bytes to fresh paths, and retain the
  // untouched-directory fallback if that pass still fails.
  try {
    pullBucket(ctx, liveDir);
  } catch (err) {
    // Box round R17: the 404 on a node lease read like a defect. It is the expected case.
    ctx.log(
      'live pre-copy incomplete (expected: celld rewrites its node lease, waker and capacity ' +
        'objects every few seconds, so a copy of the running bucket misses some, often with a ' +
        `404); the delta copy with celld stopped copies them: ${firstLine(err)}`
    );
  }
  const precopyMs = ctx.now() - precopyStart;
  if (existsSync(liveDir)) {
    removeGcloudTemporaries(liveDir);
    renameSync(liveDir, bucketDir);
  }

  ctx.log('stopping celld for the delta copy');
  let stoppedAt = ctx.now();
  let deltaCopyMs = 0;
  let startedAt = stoppedAt;
  try {
    compose(ctx, ['stop', 'celld']);
    stoppedAt = ctx.now();
    // With celld stopped the bucket is the consistent state. The mirror (with deletion) converges
    // the local tree on exactly that: objects celld removed after the pre-copy are deleted here.
    try {
      pullBucket(ctx, bucketDir);
    } catch (err) {
      // Whatever the local tree holds, a copy into a directory no pass has touched cannot meet it.
      // Costs a full copy of downtime, once, instead of leaving the operator without a backup.
      ctx.log(
        `delta copy failed, copying the whole bucket again with celld stopped: ${firstLine(err)}`
      );
      rmSync(fullDir, { recursive: true, force: true });
      pullBucket(ctx, fullDir);
      rmSync(bucketDir, { recursive: true, force: true });
      renameSync(fullDir, bucketDir);
    }
    deltaCopyMs = ctx.now() - stoppedAt;
    cpSync(ctx.stateDir, join(dest, STATE_DIR), {
      recursive: true,
      preserveTimestamps: true,
      filter: (src) => {
        if (isRebuildableCachePath(ctx.stateDir, src)) return false;
        if (!lstatSync(src).isSymbolicLink()) return true;
        // prepareCelldProject regenerates source/migration links from the recorded SAM ref.
        if (relative(ctx.stateDir, src).startsWith('project/')) return false;
        throw new Error('Installation state contains an unsupported symlink');
      },
    });
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
  // Listed for `pnpm selfhost:teardown`, which deletes a backup only with --delete-backups.
  ctx.log(
    `backup complete: ${manifest.objectCount} objects, celld down ${(manifest.downtimeMs / 1000).toFixed(1)} s -> ${dest}`
  );
  return manifest;
}

/** Backups are operator-only: no secret-bearing reads or decryptions in CI. */
export function backupKey(ctx: BoxContext): string {
  assertOperatorExecution();
  if (!ctx.encryptionKeyFile)
    throw new Error(
      '--encryption-key-file (or SAM_BACKUP_KEY_FILE) is required; keep this 32-byte key apart from backups'
    );
  readBackupKey(ctx.encryptionKeyFile).fill(0);
  assertOperationPaths(ctx);
  return ctx.encryptionKeyFile;
}

export function backupScratch(): string {
  const root = resolve(import.meta.dirname, '../../.tmp/selfhost-backups');
  let existing = root;
  while (!existsSync(existing)) existing = dirname(existing);
  if (realpathSync(existing) !== existing) throw new Error('Backup scratch must not use symlinks');
  ensurePrivateDir(root);
  if (realpathSync(root) !== root) throw new Error('Backup scratch must not use symlinks');
  return mkdtempSync(join(root, 'operation-'));
}

/** Persist only authenticated ciphertext. Temporary plaintext is private and always removed. */
export function runBackup(
  ctx: BoxContext,
  dest: string,
  samCommit: string | null = null
): BackupManifest {
  assertOperatorExecution();
  const key = backupKey(ctx);
  assertBackupOutside(ctx, dest);
  if (existsSync(dest)) throw new Error('Backup destination already exists; choose a fresh path');
  const keyPath = resolve(key);
  for (const dir of [ctx.stateDir, dest]) {
    const rel = relative(resolve(dir), keyPath);
    if (!rel.startsWith('..') && !rel.startsWith('/'))
      throw new Error('Keep the backup key outside installation state and backups');
  }
  prepareBackupParent(dest);
  requireRunningCelld(ctx);
  const temp = backupScratch();
  try {
    const plain = join(temp, 'plain');
    const manifest = runPlainBackup(ctx, plain, samCommit);
    encryptBackupTree(plain, dest, key);
    recordBackup(ctx.stateDir, dest);
    ctx.log(`encrypted backup complete -> ${dest}`);
    return manifest;
  } finally {
    removePrivateTree(temp);
  }
}

/** Authenticate every byte before any target bucket or compose operation. */
export function runRestore(ctx: BoxContext, from: string): BackupManifest;
export function runRestore(ctx: BoxContext, from: string, mode: 'project'): string;
export function runRestore(
  ctx: BoxContext,
  from: string,
  mode?: 'project'
): BackupManifest | string {
  assertOperatorExecution();
  const key = backupKey(ctx);
  assertBackupOutside(ctx, from);
  const temp = backupScratch();
  try {
    const plain = join(temp, 'plain');
    decryptBackupTree(from, plain, key);
    if (mode === 'project') {
      readManifest(plain);
      const identity = projectRestoreIdentity(ctx, join(plain, STATE_DIR));
      return expectedComposeProjectFor(ctx.box, ctx.stateDir, identity);
    }
    return restoreBackup(ctx, plain, from);
  } finally {
    removePrivateTree(temp);
  }
}

export { readManifest } from './backup-manifest';
export { assertBackupOutside } from './backup-paths';
export {
  assertRollbackCacheReady,
  beginRollbackCacheStart,
  finishRollbackCache,
  refreshRollbackCacheReceipt,
  runRollback,
} from './backup-recovery';
