/** Restore an upgrade's authenticated snapshot to the same owned installation. */
import { cpSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { decryptBackupTree } from './backup-encryption';
import {
  assertBackupOutside,
  backupKey,
  backupScratch,
  type BoxContext,
  BUCKET_DIR,
  bucketPath,
  check,
  composeArgs,
  composeRunEnv,
  ENV_FILE,
  mcArgs,
  mcEnv,
  parseBucketUrl,
  readManifest,
  STATE_DIR,
} from './backup-lib';
import { composeProjectFor, recordInstall } from './install-record';
import { assertOperatorExecution } from './operator-only';
import { assertRollbackReady } from './upgrade-preflight';
function compose(ctx: BoxContext, args: string[]): void {
  check(
    ctx.run('docker', composeArgs(ctx, args), composeRunEnv(ctx)),
    'rollback compose operation'
  );
}
function readIdentity(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('Invalid rollback identity object');
    return value as Record<string, unknown>;
  } catch {
    throw new Error('Cannot verify rollback installation identity');
  }
}
function assertStateReceipt(path: string, expected: string, id: unknown, live = false): void {
  let record;
  try {
    record = readRecord(join(path, 'created-resources.json'));
  } catch {
    throw new Error('Cannot verify rollback state ownership');
  }
  const states = record.resources.filter(
    (r) => r.cloud === 'box' && r.kind === 'state-dir' && r.action === 'created' && !r.removedAt
  );
  const installs = record.resources.filter(
    (r) => r.cloud === 'box' && r.kind === 'installation' && r.action === 'created' && !r.removedAt
  );
  if (
    states.length !== 1 ||
    states[0]?.name !== expected ||
    installs.length !== 1 ||
    installs[0]?.name !== id
  ) {
    throw new Error('Rollback state directory has no exact installation ownership receipt');
  }
  const attributes = states[0]?.attributes;
  if (attributes?.installation !== id)
    throw new Error('Rollback state receipt has a foreign installation');
  if (live) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      attributes.device !== String(stat.dev) ||
      attributes.inode !== String(stat.ino)
    ) {
      throw new Error('Rollback state directory identity changed; refusing removal');
    }
  }
}

export interface RollbackCacheProof {
  name: string;
  createdAt: string;
  container: string;
}

function inspectCacheVolume(ctx: BoxContext): { name: string; createdAt: string } {
  const project = composeProjectFor(ctx.box, ctx.stateDir);
  const name = `${project}_celld-data`;
  const result = check(
    ctx.run('docker', ['volume', 'inspect', name]),
    'inspect celld cache ownership'
  );
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error('Cannot verify celld cache ownership');
  }
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error('Ambiguous celld cache ownership');
  const volume = value[0] as {
    Name?: unknown;
    Labels?: Record<string, unknown>;
    CreatedAt?: unknown;
  };
  if (
    volume?.Name !== name ||
    volume.Labels?.['com.docker.compose.project'] !== project ||
    volume.Labels?.['com.docker.compose.volume'] !== 'celld-data'
  )
    throw new Error('Foreign celld cache; refusing rollback cache removal');
  if (typeof volume.CreatedAt !== 'string' || !Number.isFinite(Date.parse(volume.CreatedAt)))
    throw new Error('Cannot verify celld cache creation identity');
  return { name, createdAt: volume.CreatedAt };
}

/** Prove the actual selected celld container uses the canonical owned cache before an upgrade. */
export function assertRollbackCacheReady(ctx: BoxContext): RollbackCacheProof {
  assertOperatorExecution();
  assertRollbackReady(ctx);
  const selected = check(
    ctx.run(
      'docker',
      composeArgs(ctx, ['ps', '--all', '--no-trunc', '-q', 'celld']),
      composeRunEnv(ctx)
    ),
    'inspect rollback celld container'
  )
    .stdout.trim()
    .split(/\s+/);
  if (selected.length !== 1 || !/^[a-f0-9]{64}$/.test(selected[0] ?? ''))
    throw new Error('Cannot verify one rollback celld container');
  const container = selected[0] ?? '';
  const result = check(
    ctx.run('docker', ['inspect', '--format', '{{json .Mounts}}', container]),
    'inspect rollback celld cache mount'
  );
  let mounts: unknown;
  try {
    mounts = JSON.parse(result.stdout);
  } catch {
    throw new Error('Cannot verify rollback celld cache mount');
  }
  if (!Array.isArray(mounts) || mounts.some((mount) => typeof mount !== 'object' || mount === null))
    throw new Error('Cannot verify rollback celld cache mount');
  const caches = mounts.filter((mount) => mount.Destination === '/var/lib/celld');
  const proof = inspectCacheVolume(ctx);
  if (caches.length !== 1 || caches[0]?.Type !== 'volume' || caches[0]?.Name !== proof.name)
    throw new Error('Selected celld cache mount is not the canonical owned volume');
  return { ...proof, container };
}

/** Re-prove the active mount and immutable volume creation identity immediately before removal. */
function discardCelldCache(ctx: BoxContext, expected: RollbackCacheProof): void {
  const current = assertRollbackCacheReady(ctx);
  if (
    current.name !== expected.name ||
    current.createdAt !== expected.createdAt ||
    current.container !== expected.container
  )
    throw new Error('Rollback celld cache identity changed; refusing removal');
  check(
    ctx.run('docker', ['container', 'rm', '--force', expected.container]),
    'remove exact rollback celld container'
  );
  const after = inspectCacheVolume(ctx);
  if (after.name !== expected.name || after.createdAt !== expected.createdAt)
    throw new Error('Rollback celld cache identity changed; refusing removal');
  check(ctx.run('docker', ['volume', 'rm', expected.name]), 'remove owned celld cache');
}

/**
 * Compensate only an upgrade of this exact install using its own pre-upgrade snapshot.
 * The target is the original scoped bucket, never an arbitrary restore destination.
 */
export function runRollback(ctx: BoxContext, from: string): void {
  assertOperatorExecution();
  const key = backupKey(ctx);
  assertBackupOutside(ctx, from);
  const temp = backupScratch();
  try {
    const plain = join(temp, 'plain');
    decryptBackupTree(from, plain, key);
    const manifest = readManifest(plain);
    if (manifest.bucket !== ctx.box.CELLD_BUCKET)
      throw new Error('Rollback snapshot belongs to a different bucket');
    const oldKeys = readIdentity(join(plain, STATE_DIR, 'platform-keys.json'));
    const currentKeys = readIdentity(join(ctx.stateDir, 'platform-keys.json'));
    if (
      typeof oldKeys.SAM_INSTALLATION_ID !== 'string' ||
      oldKeys.SAM_INSTALLATION_ID !== currentKeys.SAM_INSTALLATION_ID
    ) {
      throw new Error('Rollback snapshot belongs to a different installation');
    }
    assertStateReceipt(join(plain, STATE_DIR), ctx.stateDir, oldKeys.SAM_INSTALLATION_ID);
    assertStateReceipt(ctx.stateDir, ctx.stateDir, currentKeys.SAM_INSTALLATION_ID, true);
    const cache = assertRollbackCacheReady(ctx);
    compose(ctx, ['stop', 'celld']);
    discardCelldCache(ctx, cache);
    const url = parseBucketUrl(ctx.box.CELLD_BUCKET ?? '');
    const source = join(plain, BUCKET_DIR);
    if (url.scheme === 'gs') {
      check(
        ctx.run('gcloud', [
          'storage',
          'rsync',
          '--recursive',
          '--delete-unmatched-destination-objects',
          source,
          `gs://${bucketPath(url)}`,
        ]),
        'restore pre-upgrade bucket'
      );
    } else {
      check(
        ctx.run(
          'docker',
          mcArgs(
            ctx,
            [`${resolve(source)}:/backup:ro`],
            ['mirror', '--overwrite', '--remove', '--quiet', '/backup', `src/${bucketPath(url)}`]
          ),
          mcEnv(ctx)
        ),
        'restore pre-upgrade bucket'
      );
    }
    // State may hold new generated files: replace it, retaining the source ownership receipts.
    assertStateReceipt(ctx.stateDir, ctx.stateDir, currentKeys.SAM_INSTALLATION_ID, true);
    rmSync(ctx.stateDir, { recursive: true, force: true });
    cpSync(join(plain, STATE_DIR), ctx.stateDir, { recursive: true });
    cpSync(join(plain, ENV_FILE), ctx.envFile);
    recordInstall(ctx.stateDir, ctx.envFile, ctx.box, oldKeys.SAM_INSTALLATION_ID as string);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
