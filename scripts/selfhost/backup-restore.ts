/** Restore into a fresh target, or resume only proven partial output from this exact snapshot. */
import { cpSync, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  type BackupManifest,
  type BoxContext,
  BUCKET_DIR,
  bucketIsEmpty,
  check,
  pullBucket,
  pushBucket,
  readManifest,
  STATE_DIR,
} from './backup-lib';
import { composeProjectFor, expectedComposeProjectFor } from './install-record';
import { assertOperatorExecution } from './operator-only';
import { assertRestoreSubset, restoreProgress } from './restore-progress';
import { ensurePrivateDir, readPrivateJson } from './secret-files';

function assertEmptyRuntime(ctx: BoxContext, from: string): void {
  const identity = readPrivateJson(join(from, STATE_DIR, 'platform-keys.json')).SAM_INSTALLATION_ID;
  if (typeof identity !== 'string' || !/^[a-f0-9]{32}$/.test(identity))
    throw new Error('Invalid backup installation identity');
  const projects = new Set([
    composeProjectFor(ctx.box, ctx.stateDir),
    expectedComposeProjectFor(ctx.box, ctx.stateDir, identity),
  ]);
  for (const project of projects) {
    const containers = check(
      ctx.run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]),
      'check empty restore runtime'
    );
    if (containers.stdout.trim())
      throw new Error('Restore target already has containers; use a fresh installation');
  }
}

export function restoreBackup(ctx: BoxContext, plain: string, encrypted: string): BackupManifest {
  assertOperatorExecution();
  const manifest = readManifest(plain);
  const progress = restoreProgress(ctx, encrypted);
  const state = lstatSync(ctx.stateDir, { throwIfNoEntry: false });
  if (state && process.getuid !== undefined && state.uid !== process.getuid())
    throw new Error('Restore target state is owned by another user');
  if (!progress.resume) {
    if (existsSync(ctx.stateDir) && readdirSync(ctx.stateDir).length > 0)
      throw new Error('Restore state is not empty: restore only into an empty install');
    if (!bucketIsEmpty(ctx))
      throw new Error('Restore bucket is not empty: restore only into an empty bucket');
  }
  // Inspect by labels: parsing Compose before gateway.env exists would reject a fresh install.
  assertEmptyRuntime(ctx, plain);
  if (progress.resume) {
    assertRestoreSubset(ctx.stateDir, join(plain, STATE_DIR));
    const current = join(plain, '.restore-current-bucket');
    pullBucket(ctx, current);
    assertRestoreSubset(current, join(plain, BUCKET_DIR));
  }
  // Durable ownership is recorded before the first target write. Failures retain it for retry.
  progress.begin();
  ctx.log(`copying ${manifest.objectCount} objects into ${ctx.box.CELLD_BUCKET}`);
  pushBucket(ctx, join(plain, BUCKET_DIR));
  ensurePrivateDir(ctx.stateDir);
  cpSync(join(plain, STATE_DIR), ctx.stateDir, { recursive: true, preserveTimestamps: true });
  rmSync(join(ctx.stateDir, 'created-resources.json'), { force: true });
  progress.finish();
  return manifest;
}
