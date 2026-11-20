/** Restore into a fresh target, or resume only proven partial output from this exact snapshot. */
import { cpSync, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  type BackupManifest,
  type BoxContext,
  BUCKET_DIR,
  bucketIsEmpty,
  pullBucket,
  pushBucket,
  readManifest,
  STATE_DIR,
} from './backup-lib';
import { repairFenceRulesMode } from './fence-state';
import { assertOperatorExecution } from './operator-only';
import { projectRestoreIdentity, restoreSourceInstallationId } from './restore-identity';
import { assertRestoreSubset, restoreProgress } from './restore-progress';
import { assertRestoreRuntime } from './restore-runtime';
import { ensurePrivateDir } from './secret-files';

export function restoreBackup(ctx: BoxContext, plain: string, encrypted: string): BackupManifest {
  assertOperatorExecution();
  const manifest = readManifest(plain);
  const progress = restoreProgress(
    ctx,
    encrypted,
    restoreSourceInstallationId(ctx, join(plain, STATE_DIR))
  );
  const identity = projectRestoreIdentity(ctx, join(plain, STATE_DIR), progress.installationId);
  // No source Worker (including its Durable Object alarms) may run before a fresh target deploy.
  rmSync(join(plain, BUCKET_DIR, 'deploy', 'current.json'), { force: true });
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
  assertRestoreRuntime(ctx, identity);
  if (progress.resume) {
    assertRestoreSubset(ctx.stateDir, join(plain, STATE_DIR), true);
    const current = join(plain, '.restore-current-bucket');
    pullBucket(ctx, current);
    assertRestoreSubset(current, join(plain, BUCKET_DIR));
  }
  // Durable ownership is recorded before the first target write. Failures retain it for retry.
  progress.begin();
  ctx.log(
    `copying restored data without the source active deployment into ${ctx.box.CELLD_BUCKET}`
  );
  pushBucket(ctx, join(plain, BUCKET_DIR));
  ensurePrivateDir(ctx.stateDir);
  cpSync(join(plain, STATE_DIR), ctx.stateDir, { recursive: true, preserveTimestamps: true });
  rmSync(join(ctx.stateDir, 'created-resources.json'), { force: true });
  // The snapshot keeps only the exec bit: files a container reads as another user need their mode.
  repairFenceRulesMode(ctx.stateDir);
  progress.finish();
  return manifest;
}
