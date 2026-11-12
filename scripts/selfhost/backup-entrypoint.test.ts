/**
 * `pnpm selfhost:backup` then `pnpm selfhost:restore`, run as the real commands (tsx backup.ts,
 * tsx restore.ts) with fake `gcloud` and `docker` binaries first on PATH (testdata/). The fake
 * gcloud reproduces the box failure from PR #2675: objects celld rewrites while running vanish
 * mid-copy in the live pass, and the aborted pass leaves state that broke the delta pass with
 * `[Errno 2] No such file or directory: <backup>/bucket/nodes/node_<id>.json`.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');
let root: string;
let env: NodeJS.ProcessEnv;

function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, tree(path, base));
    else out[path.slice(base.length + 1)] = readFileSync(path, 'utf8');
  }
  return out;
}

function put(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
}

function run(script: string, args: string[]) {
  return spawnSync(TSX, [join(REPO, 'scripts/selfhost', script), ...args], {
    cwd: REPO,
    env,
    encoding: 'utf8',
  });
}

const FLEET = 'gs://fleet/celld';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-backup-cli-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const name of ['gcloud', 'docker']) {
    copyFileSync(join(import.meta.dirname, `testdata/fake-${name}.mjs`), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  const state = join(root, 'fake');
  mkdirSync(state);
  writeFileSync(join(state, 'celld'), 'running');
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_GCS_ROOT: join(root, 'gcs'),
    FAKE_STATE: state,
  };

  // The running fleet as the live pass sees it.
  put(join(root, 'gcs/fleet/celld'), {
    'd1/main.ltx': 'rows-v1',
    'current.json': '{"v":3}',
    'nodes/node_live.json': '{"lease":1}',
    'nodes/node_retired.json': '{"lease":7}',
    'fleet/capacity-v1.json': '{"free":2}',
  });
  // celld rewrites these every few seconds: the live pass meets vanished generations (404).
  writeFileSync(
    join(state, 'churn.json'),
    JSON.stringify(['nodes/node_live.json', 'fleet/capacity-v1.json'])
  );
  // What celld wrote between the live pass and its shutdown: a node row retired (present in the
  // live pass, absent in the delta pass), a new one, and fresh contents for churned objects.
  writeFileSync(
    join(state, 'on-stop.json'),
    JSON.stringify({
      bucketDir: join(root, 'gcs/fleet/celld'),
      remove: ['nodes/node_retired.json'],
      write: {
        'nodes/node_live.json': '{"lease":2}',
        'nodes/node_new.json': '{"lease":1}',
        'fleet/capacity-v1.json': '{"free":1}',
        'd1/main.ltx': 'rows-v2',
      },
    })
  );

  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state/platform-keys.json'), '{"k":"v"}');
  writeFileSync(join(root, 'box.env'), `CELLD_BUCKET=${FLEET}\n`, { mode: 0o600 });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('selfhost:backup and selfhost:restore (real entry points, fake gcloud)', () => {
  it('backs up exactly the post-stop bucket when objects vanish between the passes, and restores it into an empty install', () => {
    const dest = join(root, 'backups/b1');
    const backup = run('backup.ts', [
      '--to',
      dest,
      '--box-env',
      join(root, 'box.env'),
      '--state-dir',
      join(root, 'state'),
    ]);
    expect(backup.stderr).toBe('');
    expect(backup.status).toBe(0);
    expect(backup.stdout).toContain('live pre-copy incomplete');

    // What celld left when it stopped is the consistent state; the backup is exactly that.
    const afterStop = tree(join(root, 'gcs/fleet/celld'));
    expect(afterStop['nodes/node_retired.json']).toBeUndefined();
    expect(tree(join(dest, 'bucket'))).toEqual(afterStop);
    expect(readdirSync(dest).sort()).toEqual(
      ['backup-manifest.json', 'bucket', 'env', 'state'].sort()
    );

    const manifest = JSON.parse(readFileSync(join(dest, 'backup-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ version: 1, bucket: FLEET, objectCount: 5 });
    expect(typeof manifest.downtimeMs).toBe('number');
    expect(manifest.downtimeMs).toBeGreaterThanOrEqual(manifest.deltaCopyMs);

    const calls = readFileSync(join(root, 'fake/calls.log'), 'utf8').trim().split('\n');
    expect(calls.map((c) => c.split(' ').slice(0, 3).join(' '))).toEqual([
      'gcloud storage rsync', // live
      'docker compose -f',
      'gcloud storage rsync', // delta, celld stopped
      'docker compose -f',
    ]);
    expect(calls[1]).toMatch(/stop celld$/);
    expect(calls[3]).toMatch(/start celld$/);

    // Restore into an empty install: new bucket, no platform keys yet.
    writeFileSync(join(root, 'new.env'), 'CELLD_BUCKET=gs://fresh/celld\n', { mode: 0o600 });
    const restore = run('restore.ts', [
      '--from',
      dest,
      '--box-env',
      join(root, 'new.env'),
      '--state-dir',
      join(root, 'new-state'),
    ]);
    expect(restore.stderr).toBe('');
    expect(restore.status).toBe(0);
    expect(tree(join(root, 'gcs/fresh/celld'))).toEqual(afterStop);
    expect(tree(join(root, 'new-state'))).toEqual({ 'platform-keys.json': '{"k":"v"}' });
  });
});
