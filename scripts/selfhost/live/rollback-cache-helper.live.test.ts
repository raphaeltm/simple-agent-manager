/** Docker refuses a cache volume referenced by an exited owner; only exact proven helpers may go. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { type BoxContext, composeArgs, composeRunEnv } from '../backup-lib';
import { composeProjectFor, recordInstall } from '../install-record';
import { readCacheHelpers, removeCacheHelpers } from '../rollback-cache-helper';
import { LIVE_TMP, skipWithoutDocker } from './harness';
let root = '',
  ctx: BoxContext,
  createdImage = false;
const IMAGE = 'sam-selfhost-egress-fence:local';
const run: BoxContext['run'] = (command, args, env) => {
  const r = spawnSync(command, args, { env: env ?? process.env, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const compose = (args: string[]) => run('docker', composeArgs(ctx, args), composeRunEnv(ctx));
beforeAll(() => {
  if (skipWithoutDocker) return;
  for (const n of Object.keys(process.env))
    if (n === 'CI' || n === 'GITHUB_ACTIONS' || n.startsWith('RUNNER_')) vi.stubEnv(n, undefined);
  mkdirSync(LIVE_TMP, { recursive: true });
  root = mkdtempSync(join(LIVE_TMP, 'cache-owner-'));
  const state = join(root, 'state');
  mkdirSync(state);
  const env = join(root, 'box.env');
  writeFileSync(env, 'CELLD_BUCKET=gs://unused/cache\n', { mode: 0o600 });
  writeFileSync(
    join(state, 'platform-keys.json'),
    JSON.stringify({ SAM_INSTALLATION_ID: 'a'.repeat(32) }),
    { mode: 0o600 }
  );
  const file = join(root, 'compose.yml');
  writeFileSync(
    file,
    `services:\n  celld-data-owner:\n    image: ${IMAGE}\n    network_mode: none\n    entrypoint: [chown, -R, '7103:7103', /var/lib/celld]\n    volumes:\n      - celld-data:/var/lib/celld\nvolumes:\n  celld-data: {}\n`
  );
  ctx = {
    box: { CELLD_BUCKET: 'gs://unused/cache' },
    stateDir: state,
    envFile: env,
    composeFiles: [file],
    run,
    now: Date.now,
    log: () => {},
  };
  recordInstall(state, env, ctx.box, 'a'.repeat(32));
  if (run('docker', ['image', 'inspect', IMAGE]).status !== 0) {
    const built = run('docker', [
      'build',
      '-t',
      IMAGE,
      resolve(import.meta.dirname, '../../../deploy/selfhost/egress-fence'),
    ]);
    expect(built.status, 'Build canonical helper image').toBe(0);
    createdImage = true;
  }
}, 300_000);
afterAll(() => {
  if (root) {
    compose(['down', '--volumes', '--remove-orphans']);
    rmSync(root, { recursive: true, force: true });
  }
  if (createdImage) run('docker', ['image', 'rm', IMAGE]);
  vi.unstubAllEnvs();
});
it.skipIf(skipWithoutDocker)(
  'proves exited-helper volume refusal, exact helper removal, retry, and replacement refusal',
  () => {
    expect(
      compose(['up', '--abort-on-container-exit', '--exit-code-from', 'celld-data-owner']).status
    ).toBe(0);
    const project = composeProjectFor(ctx.box, ctx.stateDir),
      volume = `${project}_celld-data`,
      proof = readCacheHelpers(ctx);
    expect(proof).toHaveLength(1);
    expect(run('docker', ['volume', 'rm', volume]).status).not.toBe(0); // actual Docker reference, even after exit
    removeCacheHelpers(ctx, proof);
    removeCacheHelpers(ctx, proof); // retry after partial cache cleanup
    expect(
      compose(['up', '--abort-on-container-exit', '--exit-code-from', 'celld-data-owner']).status
    ).toBe(0);
    const replacement = readCacheHelpers(ctx);
    expect(replacement[0]?.container).not.toBe(proof[0]?.container);
    expect(() => removeCacheHelpers(ctx, proof)).toThrow(/helper identity/);
    expect(readCacheHelpers(ctx)).toEqual(replacement);
    removeCacheHelpers(ctx, replacement);
    expect(run('docker', ['volume', 'rm', volume]).status).toBe(0);
  },
  120_000
);
