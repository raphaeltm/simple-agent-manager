/** Authorized creation intent never substitutes a name for live immutable ownership metadata. */
import { dirname, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it, type Mock, vi } from 'vitest';

import type { BoxContext } from './backup-lib';
import { type CacheStartProof, recoverCacheStart } from './rollback-cache-transition';

vi.mock('./upgrade-preflight', () => ({ assertRollbackReady: vi.fn() }));
const original = 'a'.repeat(64);
const replacement = 'b'.repeat(64);
let proof: CacheStartProof;
let ctx: BoxContext;
let selected: string;
let volume: string;
let metadata: { Id: string; Created: string; Config: { Labels: Record<string, string> } };
let volumeCreated: string;
let inspectVolume: Mock<(ctx: BoxContext) => { name: string; createdAt: string }>;
let inspectCache: Mock<(ctx: BoxContext) => { name: string; createdAt: string; container: string }>;
beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
  const now = Date.now();
  proof = {
    name: 'owned_celld-data',
    createdAt: new Date(now - 60_000).toISOString(),
    container: original,
    startingAt: new Date(now - 1000).toISOString(),
  };
  selected = replacement;
  volume = proof.name;
  volumeCreated = new Date(now - 500).toISOString();
  ctx = {
    box: { COMPOSE_PROJECT_NAME: 'owned' },
    stateDir: '/fixture/state',
    envFile: '/fixture/env',
    composeFiles: [resolve('deploy/selfhost/docker-compose.yml')],
    log: vi.fn(),
    now: () => now,
    run: (_command, args) => ({
      status: 0,
      stderr: '',
      stdout: args.includes('ps')
        ? selected
        : args.includes('ls')
          ? volume
          : JSON.stringify(metadata),
    }),
  };
  metadata = {
    Id: replacement,
    Created: volumeCreated,
    Config: {
      Labels: {
        'com.docker.compose.project': 'owned',
        'com.docker.compose.service': 'celld',
        'com.docker.compose.project.config_files': ctx.composeFiles.join(','),
        'com.docker.compose.project.working_dir': dirname(ctx.composeFiles[0]!),
      },
    },
  };
  inspectVolume = vi.fn(() => ({ name: proof.name, createdAt: volumeCreated }));
  inspectCache = vi.fn(() => ({
    name: proof.name,
    createdAt: volumeCreated,
    container: replacement,
  }));
});
afterEach(() => vi.unstubAllEnvs());
const recover = (requireContainer = false) =>
  recoverCacheStart(ctx, proof, inspectVolume, inspectCache, requireContainer);

it('binds a newly created canonical container and volume only after exact scope and mount proof', () => {
  expect(recover()).toEqual({ name: proof.name, createdAt: volumeCreated, container: replacement });
  expect(inspectCache).toHaveBeenCalledOnce();
});
it.each([undefined, '', 'not-a-time', new Date(Date.now() + 60_000).toISOString()])(
  'refuses invalid creation intent %s before runner calls',
  (startingAt) => {
    proof.startingAt = startingAt;
    const run = vi.fn(ctx.run);
    ctx.run = run;
    expect(recover).toThrow(/Missing authorized/);
    expect(run).not.toHaveBeenCalled();
  }
);
it.each(['project', 'service', 'project.config_files', 'project.working_dir'])(
  'refuses a replacement with foreign Compose %s',
  (field) => {
    metadata.Config.Labels[`com.docker.compose.${field}`] = 'foreign';
    expect(recover).toThrow(/ownership proof/);
    expect(inspectCache).not.toHaveBeenCalled();
  }
);
it.each([
  'ambiguous',
  'old',
  'short',
  'wrong-volume',
  'no-volume',
  'old-container-time',
  'old-volume-time',
  'future-time',
  'wrong-inspect-id',
  'malformed',
])('refuses %s without adopting the replacement', (defect) => {
  if (defect === 'ambiguous') selected += '\n' + 'd'.repeat(64);
  if (defect === 'old') selected = original;
  if (defect === 'short') selected = 'short';
  if (defect === 'wrong-volume') volume = 'foreign';
  if (defect === 'no-volume') volume = '';
  if (defect === 'old-container-time') metadata.Created = proof.createdAt;
  if (defect === 'old-volume-time') volumeCreated = proof.createdAt;
  if (defect === 'future-time') metadata.Created = new Date(Date.now() + 60_000).toISOString();
  if (defect === 'wrong-inspect-id') metadata.Id = original;
  if (defect === 'malformed') ctx.run = () => ({ status: 0, stdout: 'not-json', stderr: '' });
  expect(recover).toThrow();
  expect(inspectCache).not.toHaveBeenCalled();
});
it('refuses ambiguous mount proof or a cache replaced during observation', () => {
  inspectCache.mockImplementationOnce(() => {
    throw new Error('ambiguous cache mount');
  });
  expect(recover).toThrow(/ambiguous cache mount/);
  inspectCache.mockImplementationOnce(() => ({
    name: proof.name,
    createdAt: proof.createdAt,
    container: replacement,
  }));
  expect(recover).toThrow(/changed during/);
});
it('can retry an intent interrupted before resource creation, but cannot declare startup successful', () => {
  selected = '';
  volume = '';
  expect(recover()).toEqual({ name: proof.name, createdAt: proof.createdAt, container: original });
  expect(() => recover(true)).toThrow(/no celld container/);
});
it('handles a volume-only partial creation using exact scope/time proof, without inventing a container', () => {
  selected = '';
  expect(recover()).toEqual({ name: proof.name, createdAt: volumeCreated, container: original });
  expect(inspectCache).not.toHaveBeenCalled();
  expect(() => recover(true)).toThrow(/no celld container/);
});
it.each(['CI', 'GITHUB_ACTIONS', 'RUNNER_TEMP'])(
  'refuses %s before inspecting anything',
  (signal) => {
    vi.stubEnv(signal, '');
    const run = vi.fn(ctx.run);
    ctx.run = run;
    expect(recover).toThrow(/forbidden in CI/);
    expect(run).not.toHaveBeenCalled();
  }
);
