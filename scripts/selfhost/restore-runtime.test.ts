/** Discriminating store-only proof: no application, foreign config, image or mount may be admitted. */
import { dirname, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { type BoxContext, OBJECTSTORE_IMAGE } from './backup-lib';
import { expectedComposeProjectFor } from './install-record';
import { assertRestoreRuntime } from './restore-runtime';
const COMPOSE = resolve(import.meta.dirname, '../../deploy/selfhost/docker-compose.yml'),
  ID = 'a'.repeat(32),
  container = 'c'.repeat(64);
let context: BoxContext,
  project: string,
  item: Record<string, unknown>,
  volume: Record<string, unknown>;
beforeEach(() => {
  for (const n of Object.keys(process.env))
    if (n === 'CI' || n === 'GITHUB_ACTIONS' || n.startsWith('RUNNER_')) vi.stubEnv(n, undefined);
  context = {
    box: {
      SAM_DOMAIN: 'restore.example.com',
      COMPOSE_PROFILES: 'local-store',
      CELLD_BUCKET: 's3://restore/celld',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
    },
    stateDir: resolve('.tmp/runtime-not-created/state'),
    envFile: resolve('.tmp/runtime-not-created/env'),
    composeFiles: [COMPOSE],
    now: Date.now,
    log: () => {},
    run: (_c, args) => ({
      status: 0,
      stderr: '',
      stdout: args[0] === 'ps' ? container : JSON.stringify(args[0] === 'volume' ? volume : item),
    }),
  };
  project = expectedComposeProjectFor(context.box, context.stateDir, ID);
  context.box = { ...context.box, COMPOSE_PROJECT_NAME: project };
  item = {
    id: container,
    labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.service': 'objectstore',
      'com.docker.compose.project.config_files': COMPOSE,
      'com.docker.compose.project.working_dir': dirname(COMPOSE),
    },
    image: OBJECTSTORE_IMAGE,
    command: [
      'server',
      '/data',
      '--address',
      '127.0.0.1:9000',
      '--console-address',
      '127.0.0.1:9001',
    ],
    network: 'host',
    mounts: [
      { Type: 'volume', Destination: '/data', Name: `${project}_objectstore-data`, RW: true },
    ],
    state: { Running: true, Health: { Status: 'healthy' } },
  };
  volume = {
    name: `${project}_objectstore-data`,
    labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.volume': 'objectstore-data',
    },
  };
});
afterEach(() => vi.unstubAllEnvs());
it('permits only the verified pinned bundled store in its canonical target project', () =>
  expect(() => assertRestoreRuntime(context, ID)).not.toThrow());
it.each([
  'celld',
  'foreign-project',
  'foreign-config',
  'foreign-working-dir',
  'foreign-image',
  'foreign-network',
  'bind-data',
  'foreign-volume',
  'duplicate-mount',
  'unhealthy',
  'profile',
  'overlay',
  'foreign-volume-label',
] as const)('refuses %s', (defect) => {
  const labels = item.labels as Record<string, string>,
    mounts = item.mounts as Array<Record<string, unknown>>;
  if (defect === 'celld') labels['com.docker.compose.service'] = 'celld';
  else if (defect === 'foreign-project') labels['com.docker.compose.project'] = 'foreign';
  else if (defect === 'foreign-config')
    labels['com.docker.compose.project.config_files'] = '/foreign/compose.yml';
  else if (defect === 'foreign-working-dir')
    labels['com.docker.compose.project.working_dir'] = '/foreign';
  else if (defect === 'foreign-image') item.image = 'foreign:latest';
  else if (defect === 'foreign-network') item.network = 'bridge';
  else if (defect === 'bind-data') mounts[0] = { ...mounts[0], Type: 'bind' };
  else if (defect === 'foreign-volume') mounts[0] = { ...mounts[0], Name: 'foreign-data' };
  else if (defect === 'duplicate-mount') mounts.push({ ...mounts[0] });
  else if (defect === 'unhealthy') item.state = { Running: true, Health: { Status: 'starting' } };
  else if (defect === 'profile') context.box = { ...context.box, COMPOSE_PROFILES: 'tunnel' };
  else if (defect === 'overlay') context.composeFiles.push('/foreign/overlay.yml');
  else (volume.labels as Record<string, string>)['com.docker.compose.project'] = 'foreign';
  expect(() => assertRestoreRuntime(context, ID)).toThrow(/already has containers/);
});
