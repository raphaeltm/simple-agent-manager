/** Adopt only resources created by an explicitly journaled recovery Compose start. */
import { dirname, resolve } from 'node:path';

import { type BoxContext, check, composeArgs, composeRunEnv } from './backup-lib';
import type { RollbackCacheProof } from './backup-recovery';
import { composeProjectFor } from './install-record';
import { assertOperatorExecution } from './operator-only';
import { assertRollbackReady } from './upgrade-preflight';

export interface CacheStartProof extends RollbackCacheProof {
  startingAt?: string;
}

function createdAfter(value: unknown, start: string): void {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    Date.parse(value) < Date.parse(start) ||
    Date.parse(value) > Date.now()
  )
    throw new Error('Replacement cache predates its authorized recovery start');
}

/** Docker volume creation time has second precision; intent rounds down on that same clock. */
export function cacheStartTime(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
}

function proveContainer(ctx: BoxContext, id: string, start: string): void {
  let value;
  try {
    value = JSON.parse(
      check(
        ctx.run('docker', [
          'inspect',
          '--format',
          '{"Id":{{json .Id}},"Created":{{json .Created}},"Config":{"Labels":{{json .Config.Labels}}}}',
          id,
        ]),
        'inspect replacement celld identity'
      ).stdout
    );
  } catch {
    throw new Error('Cannot verify replacement celld identity');
  }
  const labels = value?.Config?.Labels;
  if (
    value?.Id !== id ||
    labels?.['com.docker.compose.project'] !== composeProjectFor(ctx.box, ctx.stateDir) ||
    labels?.['com.docker.compose.service'] !== 'celld' ||
    labels?.['com.docker.compose.project.config_files'] !==
      ctx.composeFiles.map((p) => resolve(p)).join(',') ||
    labels?.['com.docker.compose.project.working_dir'] !==
      dirname(resolve(ctx.composeFiles[0] ?? ''))
  )
    throw new Error('Replacement celld has no exact Compose ownership proof');
  createdAfter(value.Created, start);
}

export function recoverCacheStart(
  ctx: BoxContext,
  pending: CacheStartProof,
  inspectVolume: (ctx: BoxContext) => { name: string; createdAt: string },
  inspectCache: (ctx: BoxContext) => RollbackCacheProof,
  requireContainer = false
): RollbackCacheProof {
  assertOperatorExecution();
  assertRollbackReady(ctx);
  const start = pending.startingAt;
  if (!start || !Number.isFinite(Date.parse(start)) || Date.parse(start) > Date.now())
    throw new Error('Missing authorized recovery start');
  const selected = check(
    ctx.run(
      'docker',
      composeArgs(ctx, ['ps', '--all', '--no-trunc', '-q', 'celld']),
      composeRunEnv(ctx)
    ),
    'inspect starting celld'
  ).stdout.trim();
  const volumes = check(
    ctx.run('docker', [
      'volume',
      'ls',
      '--filter',
      `name=^${pending.name}$`,
      '--format',
      '{{.Name}}',
    ]),
    'inspect starting cache'
  ).stdout.trim();
  if (requireContainer && !selected) throw new Error('Recovery start has no celld container');
  if (!selected && !volumes)
    return { name: pending.name, createdAt: pending.createdAt, container: pending.container };
  if (
    volumes !== pending.name ||
    (selected && (!/^[a-f0-9]{64}$/.test(selected) || selected === pending.container))
  )
    throw new Error('Ambiguous replacement cache identity');
  const volume = inspectVolume(ctx);
  createdAfter(volume.createdAt, start);
  if (!selected) return { ...volume, container: pending.container };
  proveContainer(ctx, selected, start);
  const proof = inspectCache(ctx);
  if (proof.container !== selected || proof.createdAt !== volume.createdAt)
    throw new Error('Replacement cache changed during ownership proof');
  return proof;
}
