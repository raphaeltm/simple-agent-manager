import { assertOperatorExecution } from './operator-only';
/** Restore an upgrade's authenticated snapshot to the same owned installation. */
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decryptBackupTree } from './backup-encryption';
import {
  type BoxContext,
  assertBackupOutside,
  backupKey,
  backupScratch,
  BUCKET_DIR,
  STATE_DIR,
  ENV_FILE,
  readManifest,
  check,
  composeArgs,
  parseBucketUrl,
  bucketPath,
  mcArgs,
  mcEnv,
} from './backup-lib';
import { readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { assertRollbackReady } from './upgrade-preflight';
import { composeProjectFor } from './install-record';
function compose(ctx: BoxContext, args: string[]): void {
  check(ctx.run('docker', composeArgs(ctx, args)), 'rollback compose operation');
}
function readIdentity(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error('Cannot verify rollback installation identity');
  }
}
function assertStateReceipt(path: string, expected: string, id: unknown): void {
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
}

/** Drop only this compose project's disposable celld cache, never its fleet store. */
function discardCelldCache(ctx: BoxContext): void {
  const project = composeProjectFor(ctx.box, ctx.stateDir);
  assertRollbackReady(ctx);
  const name = `${project}_celld-data`;
  const inspect = () => {
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
    const volume = value[0] as { Name?: unknown; Labels?: Record<string, unknown> };
    if (
      volume?.Name !== name ||
      volume.Labels?.['com.docker.compose.project'] !== project ||
      volume.Labels?.['com.docker.compose.volume'] !== 'celld-data'
    ) {
      throw new Error('Foreign celld cache; refusing rollback cache removal');
    }
  };
  inspect();
  compose(ctx, ['rm', '--stop', '--force', 'celld']);
  inspect();
  check(ctx.run('docker', ['volume', 'rm', name]), 'remove owned celld cache');
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
    assertStateReceipt(ctx.stateDir, ctx.stateDir, currentKeys.SAM_INSTALLATION_ID);
    compose(ctx, ['stop', 'celld']);
    discardCelldCache(ctx);
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
    rmSync(ctx.stateDir, { recursive: true, force: true });
    cpSync(join(plain, STATE_DIR), ctx.stateDir, { recursive: true });
    cpSync(join(plain, ENV_FILE), ctx.envFile);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
