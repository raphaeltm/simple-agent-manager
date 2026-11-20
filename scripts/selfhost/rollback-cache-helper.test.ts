import { dirname, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { BoxContext } from './backup-lib';
import { readCacheHelpers, removeCacheHelpers } from './rollback-cache-helper';
const ID = 'a'.repeat(64),
  REPLACEMENT = 'b'.repeat(64),
  CREATED = '2026-11-01T00:00:00Z';
let ctx: BoxContext, selected: string, metadata: Record<string, unknown>, removed: string[];
beforeEach(() => {
  for (const n of Object.keys(process.env))
    if (n === 'CI' || n === 'GITHUB_ACTIONS' || n.startsWith('RUNNER_')) vi.stubEnv(n, undefined);
  selected = ID;
  removed = [];
  const file = resolve('deploy/selfhost/docker-compose.yml');
  metadata = {
    id: ID,
    image: 'sam-selfhost-egress-fence:local',
    state: { Running: false, Status: 'exited', ExitCode: 0 },
    createdAt: CREATED,
    labels: {
      'com.docker.compose.project': 'owned',
      'com.docker.compose.service': 'celld-data-owner',
      'com.docker.compose.project.config_files': file,
      'com.docker.compose.project.working_dir': dirname(file),
    },
    entrypoint: ['chown', '-R', '7103:7103', '/var/lib/celld'],
    mounts: [{ Destination: '/var/lib/celld', Type: 'volume', Name: 'owned_celld-data', RW: true }],
  };
  ctx = {
    box: { COMPOSE_PROJECT_NAME: 'owned' },
    stateDir: '/unused/state',
    envFile: '/unused/env',
    composeFiles: [file],
    now: Date.now,
    log: () => {},
    run: (_c, args) => {
      if (args[0] === 'ps') return { status: 0, stdout: selected, stderr: '' };
      if (args[1] === 'rm') {
        removed.push(args.at(-1) ?? '');
        selected = '';
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify(metadata), stderr: '' };
    },
  };
});
afterEach(() => vi.unstubAllEnvs());
it('proves the exact helper and removes that id, retaining retryability after its removal', () => {
  const proof = readCacheHelpers(ctx);
  expect(proof).toEqual([{ container: ID, createdAt: CREATED }]);
  removeCacheHelpers(ctx, proof);
  expect(removed).toEqual([ID]);
  removeCacheHelpers(ctx, proof);
  expect(removed).toEqual([ID]);
});
it('supports legacy installs with no cache owner helper', () => {
  selected = '';
  expect(readCacheHelpers(ctx)).toEqual([]);
  removeCacheHelpers(ctx, []);
  expect(removed).toEqual([]);
});
it.each(['created', 'running', 'exited-failed'] as const)(
  'removes an exact owned helper after partial lifecycle %s',
  (state) => {
    metadata.state = {
      Running: state === 'running',
      Status: state === 'exited-failed' ? 'exited' : state,
      ExitCode: state === 'exited-failed' ? 1 : 0,
    };
    const proof = readCacheHelpers(ctx);
    removeCacheHelpers(ctx, proof);
    expect(removed).toEqual([ID]);
  }
);
it.each([
  'project',
  'service',
  'project.config_files',
  'project.working_dir',
  'mount',
  'duplicate-mount',
  'entrypoint',
  'createdAt',
  'ambiguous',
  'replacement',
  'image',
] as const)('refuses %s before helper removal', (defect) => {
  const original = readCacheHelpers(ctx);
  if (defect === 'mount')
    metadata.mounts = [
      { Destination: '/var/lib/celld', Type: 'volume', Name: 'foreign-data', RW: true },
    ];
  else if (defect === 'duplicate-mount')
    metadata.mounts = [...(metadata.mounts as unknown[]), ...(metadata.mounts as unknown[])];
  else if (defect === 'entrypoint') metadata.entrypoint = ['sh', '-c', 'foreign'];
  else if (defect === 'createdAt') metadata.createdAt = '2026-11-02T00:00:00Z';
  else if (defect === 'ambiguous') selected += '\n' + REPLACEMENT;
  else if (defect === 'replacement') {
    selected = REPLACEMENT;
    metadata.id = REPLACEMENT;
  } else if (defect === 'image') metadata.image = 'foreign:latest';
  else (metadata.labels as Record<string, string>)[`com.docker.compose.${defect}`] = 'foreign';
  expect(() => removeCacheHelpers(ctx, original)).toThrow(/helper identity/);
  expect(removed).toEqual([]);
});
