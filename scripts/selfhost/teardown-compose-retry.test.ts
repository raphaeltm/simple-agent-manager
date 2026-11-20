/** Real adapter retry boundaries keep the first exact Docker identities across invocations. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { expectedComposeProjectFor, recordInstall, recordPath } from './install-record';
import { boxItems, type TeardownContext } from './teardown-box';
import { execute } from './teardown-model';
let root: string, ctx: TeardownContext, project: string;
let containers: string[],
  volumes: { name: string; createdAt: string }[],
  calls: string[][],
  failure: string;
const id = 'd'.repeat(64),
  second = 'e'.repeat(64);
beforeEach(() => {
  for (const name of Object.keys(process.env))
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/teardown-compose-retry-'));
  const state = join(root, 'state');
  mkdirSync(state);
  const envFile = join(root, '.env');
  writeFileSync(envFile, '', { mode: 0o600 });
  writeFileSync(
    join(state, 'platform-keys.json'),
    JSON.stringify({ SAM_INSTALLATION_ID: 'a'.repeat(32) }),
    { mode: 0o600 }
  );
  const box = { SAM_DOMAIN: 'docker.example.com' };
  recordInstall(state, envFile, box, 'a'.repeat(32));
  project = expectedComposeProjectFor(box, state);
  const composeFiles = [join(root, 'compose.yml')];
  containers = [id, second];
  volumes = [{ name: `${project}_cache`, createdAt: '2026-01-01T00:00:00Z' }];
  calls = [];
  failure = '';
  ctx = {
    box,
    stateDir: state,
    envFile,
    composeFiles,
    domain: box.SAM_DOMAIN,
    installationId: 'a'.repeat(32),
    now: Date.now,
    log: () => undefined,
    recordFile: recordPath(state),
    record: readRecord(recordPath(state)).resources,
    selfhostDir: join(root, 'repo/deploy/selfhost'),
    mode: 'remove-everything',
    options: { deleteBackups: false, destroyKey: false, adoptDiscovered: false, gcpProjects: [] },
    run: (_command, args) => {
      calls.push(args);
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (args[0] === 'container' && args[1] === 'ls') return ok(containers.join('\n'));
      if (args[0] === 'volume' && args[1] === 'ls')
        return ok(volumes.map((v) => v.name).join('\n'));
      if (args[1] === 'inspect') {
        if (args[0] === 'container')
          return ok(
            JSON.stringify({
              id: args.at(-1),
              labels: {
                'com.docker.compose.project': project,
                'com.docker.compose.service': 'celld',
                'com.docker.compose.project.working_dir': dirname(composeFiles[0]!),
                'com.docker.compose.project.config_files': composeFiles.join(','),
              },
            })
          );
        return ok(
          JSON.stringify({
            ...volumes.find((v) => v.name === args.at(-1)),
            labels: {
              'com.docker.compose.project': project,
              'com.docker.compose.volume': 'cache',
            },
          })
        );
      }
      if (args[0] === 'container' && args[1] === 'rm') {
        containers = containers.filter((value) => value !== args[3]);
        if (failure === 'container') {
          failure = '';
          return { status: 1, stdout: '', stderr: 'injected partial removal' };
        }
        containers = [];
      }
      if (args[0] === 'volume' && args[1] === 'rm') {
        if (failure === 'volume') {
          failure = '';
          return { status: 1, stdout: '', stderr: 'injected volume failure' };
        }
        volumes = volumes.filter((v) => v.name !== args[2]);
      }
      return ok();
    },
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function run(mode: 'keep-data' | 'remove-everything' = 'remove-everything') {
  const fresh = { ...ctx, mode, record: readRecord(ctx.recordFile).resources };
  return execute(
    boxItems(fresh).filter(
      (item) =>
        ['box:stop', 'box:containers'].includes(item.id) || item.id.startsWith('box:volume:')
    ),
    mode,
    ctx.recordFile
  );
}
it.each(['container', 'volume'])(
  'retries exact surviving resources after partial %s failure',
  (fault) => {
    failure = fault;
    expect(run().some((o) => o.status === 'failed')).toBe(true);
    expect(run().every((o) => ['removed', 'already removed'].includes(o.status))).toBe(true);
    expect(containers).toEqual([]);
    expect(volumes).toEqual([]);
  }
);
it.each(['container', 'volume'])('refuses replacement %s on the next invocation', (resource) => {
  failure = 'volume';
  expect(run().some((o) => o.status === 'failed')).toBe(true);
  if (resource === 'container') containers = ['f'.repeat(64)];
  else volumes[0]!.createdAt = '2026-02-01T00:00:00Z';
  calls = [];
  expect(run().some((o) => o.status === 'failed')).toBe(true);
  expect(calls.some((args) => ['stop', 'rm'].includes(args[1] ?? ''))).toBe(false);
});
it('allows disappeared resources to settle without selecting replacements', () => {
  failure = 'volume';
  run();
  containers = [];
  volumes = [];
  expect(run().every((o) => ['removed', 'already removed'].includes(o.status))).toBe(true);
});
it('clears completed keep-data intent so a legitimate restart can be stopped later', () => {
  expect(run('keep-data').every((o) => ['removed', 'kept'].includes(o.status))).toBe(true);
  containers = ['f'.repeat(64)];
  expect(run('keep-data').every((o) => ['removed', 'kept'].includes(o.status))).toBe(true);
  expect(volumes).toHaveLength(1);
});
