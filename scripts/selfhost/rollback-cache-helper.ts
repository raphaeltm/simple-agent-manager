/** A one-shot cache owner still holds Docker's volume reference after exiting. */
import { dirname, resolve } from 'node:path';

import { type BoxContext, check } from './backup-lib';
import { composeProjectFor } from './install-record';
import { assertOperatorExecution } from './operator-only';
export interface CacheHelperProof {
  container: string;
  createdAt: string;
}
const failure = (): never => {
  throw new Error('Cannot verify rollback cache owner helper identity');
};
export function readCacheHelpers(ctx: BoxContext): CacheHelperProof[] {
  assertOperatorExecution();
  const project = composeProjectFor(ctx.box, ctx.stateDir),
    volume = `${project}_celld-data`;
  const ids = check(
    ctx.run('docker', [
      'ps',
      '--all',
      '--quiet',
      '--no-trunc',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--filter',
      'label=com.docker.compose.service=celld-data-owner',
    ]),
    'inspect cache owner helper inventory'
  )
    .stdout.trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length > 1 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) return failure();
  return ids.map((id) => {
    let item;
    try {
      item = JSON.parse(
        check(
          ctx.run('docker', [
            'container',
            'inspect',
            '--format',
            '{"id":{{json .Id}},"createdAt":{{json .Created}},"image":{{json .Config.Image}},"state":{"Running":{{json .State.Running}},"Status":{{json .State.Status}},"ExitCode":{{json .State.ExitCode}}},"labels":{{json .Config.Labels}},"entrypoint":{{json .Config.Entrypoint}},"mounts":{{json .Mounts}}}',
            id,
          ]),
          'inspect exact cache owner helper'
        ).stdout
      );
    } catch {
      return failure();
    }
    const labels = item?.labels,
      mounts = item?.mounts,
      uid = ctx.box.CELLD_UID || '7103';
    if (
      item?.id !== id ||
      item.image !== 'sam-selfhost-egress-fence:local' ||
      typeof item.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      labels?.['com.docker.compose.project'] !== project ||
      labels?.['com.docker.compose.service'] !== 'celld-data-owner' ||
      labels?.['com.docker.compose.project.config_files'] !==
        ctx.composeFiles.map((p) => resolve(p)).join(',') ||
      labels?.['com.docker.compose.project.working_dir'] !==
        dirname(resolve(ctx.composeFiles[0] ?? '')) ||
      JSON.stringify(item.entrypoint) !==
        JSON.stringify(['chown', '-R', `${uid}:${uid}`, '/var/lib/celld']) ||
      !Array.isArray(mounts) ||
      mounts.length !== 1
    )
      return failure();
    const caches = mounts.filter(
      (m: { Destination?: unknown } | null) => m?.Destination === '/var/lib/celld'
    );
    if (
      caches.length !== 1 ||
      caches[0]?.Type !== 'volume' ||
      caches[0]?.Name !== volume ||
      caches[0]?.RW !== true
    )
      return failure();
    return { container: id, createdAt: item.createdAt };
  });
}
export function parseCacheHelpers(value: unknown): CacheHelperProof[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1) return failure();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.container !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.container) ||
      typeof item.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(item.createdAt))
    )
      return failure();
    return { container: item.container, createdAt: item.createdAt };
  });
}
export function assertCacheHelpers(
  ctx: BoxContext,
  expected: CacheHelperProof[]
): CacheHelperProof[] {
  assertOperatorExecution();
  const current = readCacheHelpers(ctx);
  if (
    current.some(
      (item) =>
        !expected.some(
          (old) => old.container === item.container && old.createdAt === item.createdAt
        )
    )
  )
    return failure();
  return current;
}
export function removeCacheHelpers(ctx: BoxContext, expected: CacheHelperProof[]): void {
  assertOperatorExecution();
  const current = assertCacheHelpers(ctx, expected);
  for (const helper of current) {
    assertCacheHelpers(ctx, expected);
    check(
      ctx.run('docker', ['container', 'rm', '--force', helper.container]),
      'remove exact cache owner helper'
    );
  }
  assertCacheHelpers(ctx, []);
}
