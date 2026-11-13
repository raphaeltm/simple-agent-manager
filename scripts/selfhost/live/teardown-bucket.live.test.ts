/**
 * Teardown's bucket step (teardown-box.ts emptyBucket) against the pinned objectstore image that
 * docker-compose.yml runs, through the same `mc` path backup and the plaintext purge use. It must
 * delete every object under the install's prefix, nothing outside it, and refuse a bucket that
 * holds no celld deploy/ tree.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BoxContext, OBJECTSTORE_IMAGE, pushBucket, type RunResult } from '../backup-lib';
import { listObjects } from '../bucket-objects';
import { emptyBucket } from '../teardown-box';
import { freePort, LIVE_TMP } from './harness';

const KEY = 'sam-live-teardown';
const SECRET = 'live-teardown-secret-0123456789';
const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;

let port = 0;
let container = '';
let root = '';

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  const r = spawnSync(command, args, { env: env ?? process.env, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ctx(bucket: string): BoxContext {
  return {
    box: {
      CELLD_BUCKET: bucket,
      S3_ENDPOINT: `http://127.0.0.1:${port}`,
      AWS_ACCESS_KEY_ID: KEY,
      AWS_SECRET_ACCESS_KEY: SECRET,
    },
    envFile: join(root, 'box.env'),
    stateDir: join(root, 'state'),
    composeFiles: ['/unused/docker-compose.yml'],
    run,
    now: () => Date.now(),
    log: () => undefined,
    user: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
  };
}

function seed(bucket: string, files: Record<string, string>): void {
  const dir = mkdtempSync(join(root, 'seed-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  pushBucket(ctx(bucket), dir);
}

describe.skipIf(!hasDocker && !process.env.CI)('teardown empties the fleet bucket', () => {
  beforeAll(async () => {
    port = await freePort();
    const consolePort = await freePort();
    mkdirSync(LIVE_TMP, { recursive: true });
    root = mkdtempSync(join(LIVE_TMP, 'teardown-'));
    const started = run('docker', [
      'run',
      '-d',
      '--rm',
      '--network',
      'host',
      '-e',
      `MINIO_ROOT_USER=${KEY}`,
      '-e',
      `MINIO_ROOT_PASSWORD=${SECRET}`,
      '--entrypoint',
      'minio',
      OBJECTSTORE_IMAGE,
      'server',
      '/data',
      '--address',
      `127.0.0.1:${port}`,
      '--console-address',
      `127.0.0.1:${consolePort}`,
    ]);
    expect(started.status, started.stderr).toBe(0);
    container = started.stdout.trim();
    for (let i = 0; i < 60; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/minio/health/live`).catch(() => null);
      if (res?.ok) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const env = { ...process.env, MC_HOST_src: `http://${KEY}:${SECRET}@127.0.0.1:${port}` };
    const mb = run(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        '-e',
        'MC_HOST_src',
        '-e',
        'MC_CONFIG_DIR=/tmp/mc',
        '--entrypoint',
        'mc',
        OBJECTSTORE_IMAGE,
        'mb',
        'src/fleet',
        'src/foreign',
      ],
      env
    );
    expect(mb.status, mb.stderr).toBe(0);
  }, 300_000);

  afterAll(() => {
    if (container) run('docker', ['rm', '-f', container]);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('deletes every object under the prefix and nothing outside it', () => {
    const files: Record<string, string> = { 'deploy/current.json': '{"version":"v1"}' };
    // More objects than one delete batch (500), so batching and the final re-list both run.
    for (let i = 0; i < 1201; i += 1)
      files[`d1/main/${String(i).padStart(6, '0')}.ltx`] = `ltx-${i}`;
    seed('s3://fleet/celld', files);
    seed('s3://fleet/other', { 'keep.txt': 'not this install' });
    expect(listObjects(ctx('s3://fleet/celld'), '')).toHaveLength(1202);

    emptyBucket(ctx('s3://fleet/celld'), 's3://fleet/celld');

    expect(listObjects(ctx('s3://fleet/celld'), '')).toEqual([]);
    expect(listObjects(ctx('s3://fleet/other'), '').map((o) => o.key)).toEqual(['keep.txt']);
  }, 300_000);

  it('refuses a bucket that holds objects but no celld deploy/ tree', () => {
    seed('s3://foreign', { 'photos/cat.jpg': 'meow' });
    expect(() => emptyBucket(ctx('s3://foreign'), 's3://foreign')).toThrow(
      /not proven this install's fleet bucket/
    );
    expect(listObjects(ctx('s3://foreign'), '').map((o) => o.key)).toEqual(['photos/cat.jpg']);
  }, 120_000);
});
