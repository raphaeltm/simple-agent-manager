/**
 * selfhost:backup -> selfhost:restore against the box's own object store: the MinIO image pinned
 * in docker-compose.yml, run on loopback in Docker, driven by the real `mc mirror` commands in
 * backup-lib.ts. Only `docker compose stop/start celld` is stubbed (there is no celld here).
 * Round trip: seed a fleet bucket, back it up, restore into a second empty bucket, pull that
 * bucket back and compare every object. Also proves restore refuses a non-empty bucket.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type BoxContext,
  OBJECTSTORE_IMAGE,
  pullBucket,
  pushBucket,
  runBackup,
  runRestore,
  type RunResult,
} from '../backup-lib';
import { freePort, LIVE_TMP } from './harness';

const KEY = 'sam-live-backup';
const SECRET = 'live-backup-secret-0123456789';
const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;

let port = 0;
let container = '';
let root = '';
const composeCalls: string[] = [];

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  if (command === 'docker' && args[0] === 'compose') {
    composeCalls.push(args.slice(-2).join(' '));
    return { status: 0, stdout: '', stderr: '' };
  }
  const r = spawnSync(command, args, { env: env ?? process.env, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ctx(bucket: string, stateDir: string): BoxContext {
  return {
    box: {
      CELLD_BUCKET: bucket,
      S3_ENDPOINT: `http://127.0.0.1:${port}`,
      AWS_ACCESS_KEY_ID: KEY,
      AWS_SECRET_ACCESS_KEY: SECRET,
    },
    envFile: join(root, 'box.env'),
    stateDir,
    composeFile: '/unused/docker-compose.yml',
    run,
    now: () => Date.now(),
    log: () => undefined,
    user: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
  };
}

function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, tree(path, base));
    else out[path.slice(base.length + 1)] = readFileSync(path, 'utf8');
  }
  return out;
}

describe.skipIf(!hasDocker && !process.env.CI)(
  'backup and restore on the bundled object store',
  () => {
    beforeAll(async () => {
      port = await freePort();
      const consolePort = await freePort();
      mkdirSync(LIVE_TMP, { recursive: true });
      root = mkdtempSync(join(LIVE_TMP, 'backup-'));
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
          'src/fresh',
        ],
        env
      );
      expect(mb.status, mb.stderr).toBe(0);
    }, 300_000);

    afterAll(() => {
      if (container) run('docker', ['rm', '-f', container]);
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it('round-trips the fleet bucket and box state into an empty install', () => {
      // Seed the "fleet" through the same push path restore uses.
      const seed = join(root, 'seed');
      mkdirSync(join(seed, 'd1/main'), { recursive: true });
      writeFileSync(join(seed, 'd1/main/000001.ltx'), 'ltx-bytes');
      writeFileSync(join(seed, 'deploy-current.json'), '{"version":"v7"}');
      pushBucket(ctx('s3://fleet/celld', join(root, 'unused')), seed);

      const state = join(root, 'state');
      mkdirSync(state);
      writeFileSync(join(state, 'platform-keys.json'), '{"k":1}');
      writeFileSync(join(root, 'box.env'), 'CELLD_BUCKET=s3://fleet/celld\n', { mode: 0o600 });

      const dest = join(root, 'backup');
      const manifest = runBackup(ctx('s3://fleet/celld', state), dest, 'live');
      expect(composeCalls).toEqual(['stop celld', 'start celld']);
      expect(manifest.objectCount).toBe(2);
      expect(manifest.downtimeMs).toBeGreaterThan(0);

      const newState = join(root, 'new-state');
      runRestore(ctx('s3://fresh/celld', newState), dest);
      const check = join(root, 'check');
      pullBucket(ctx('s3://fresh/celld', newState), check);
      expect(tree(check)).toEqual(tree(seed));
      expect(tree(newState)).toEqual({ 'platform-keys.json': '{"k":1}' });

      // A second restore into the now non-empty bucket is refused.
      expect(() => runRestore(ctx('s3://fresh/celld', join(root, 'other-state')), dest)).toThrow(
        /not empty/
      );
    });
  }
);
