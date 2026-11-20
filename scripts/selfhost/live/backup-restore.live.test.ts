/**
 * selfhost:backup -> selfhost:restore against the box's own object store: the MinIO image pinned
 * in docker-compose.yml, run on loopback in Docker, driven by the real `mc mirror` commands in
 * backup-lib.ts. Compose celld lifecycle and inventory are stubbed (there is no celld here).
 * Round trip: seed a fleet bucket, back it up, restore into a second empty bucket, pull that
 * bucket back and compare every object. Also proves restore refuses a non-empty bucket.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  type BoxContext,
  OBJECTSTORE_IMAGE,
  pullBucket,
  pushBucket,
  runBackup,
  runRestore,
  type RunResult,
} from '../backup-lib';
import { FENCE_RULES_FILE, FENCE_RULES_MODE } from '../fence-state';
import { DEFAULT_ADOPTION_HELPER_IMAGE } from '../legacy-adoption-volumes';
import { freePort, LIVE_TMP } from './harness';

const PLATFORM_KEYS = JSON.stringify({
  SAM_INSTALLATION_ID: 'a'.repeat(32),
  ENCRYPTION_KEY: 'fixture-encryption-key',
});
const KEY = 'sam-live-backup';
const SECRET = 'live-backup-secret-0123456789';
const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;

let port = 0;
let container = '';
let root = '';
const composeCalls: string[] = [];

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  if (command === 'docker' && args[0] === 'compose') {
    if (args.includes('ps')) return { status: 0, stdout: 'c'.repeat(64), stderr: '' };
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
      R2_S3_REGION: 'us-east-1',
      S3_ENDPOINT: `http://127.0.0.1:${port}`,
      AWS_ACCESS_KEY_ID: KEY,
      AWS_SECRET_ACCESS_KEY: SECRET,
    },
    envFile: join(root, 'box.env'),
    stateDir,
    encryptionKeyFile: join(root, 'backup-key'),
    composeFiles: ['/unused/docker-compose.yml'],
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
      for (const name of Object.keys(process.env)) {
        if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
          vi.stubEnv(name, undefined);
      }
      writeFileSync(join(root, 'backup-key'), randomBytes(32), { mode: 0o600 });
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
          'src/retry',
          'src/fencesrc',
          'src/fencedst',
        ],
        env
      );
      expect(mb.status, mb.stderr).toBe(0);
    }, 300_000);

    afterAll(() => {
      vi.unstubAllEnvs();
      if (container) run('docker', ['rm', '-f', container]);
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it('retries after a real partial MinIO upload without deleting the partial target', () => {
      const seed = join(root, 'retry-seed');
      mkdirSync(join(seed, 'data'), { recursive: true });
      writeFileSync(join(seed, 'current.json'), '{"v":1}');
      writeFileSync(join(seed, 'data/second.bin'), Buffer.from([0, 1, 2, 255]));
      pushBucket(ctx('s3://fleet/celld-retry', join(root, 'retry-unused')), seed);
      const state = join(root, 'retry-source-state');
      mkdirSync(state, { mode: 0o700 });
      writeFileSync(join(state, 'platform-keys.json'), PLATFORM_KEYS, { mode: 0o600 });
      writeFileSync(join(root, 'box.env'), 'CELLD_BUCKET=s3://fleet/celld-retry\n', {
        mode: 0o600,
      });
      const snapshot = join(root, 'retry-backup');
      runBackup(ctx('s3://fleet/celld-retry', state), snapshot);
      const target = ctx('s3://retry/celld', join(root, 'retry-state'));
      let fail = true;
      const partial: BoxContext = {
        ...target,
        run(command, args, env) {
          if (
            fail &&
            command === 'docker' &&
            args.includes('mirror') &&
            args.at(-2) === '/backup' &&
            args.at(-1) === 'src/retry/celld'
          ) {
            fail = false;
            const image = args.indexOf(OBJECTSTORE_IMAGE);
            const result = run(
              command,
              [
                ...args.slice(0, image + 1),
                'cp',
                '--quiet',
                '/backup/current.json',
                'src/retry/celld/current.json',
              ],
              env
            );
            if (result.status !== 0) return result;
            return {
              status: 1,
              stdout: '',
              stderr: 'injected network failure after one actual upload',
            };
          }
          return run(command, args, env);
        },
      };
      expect(() => runRestore(partial, snapshot)).toThrow(/mc mirror/);
      const first = join(root, 'retry-partial-check');
      pullBucket(target, first);
      expect(tree(first)).toEqual({ 'current.json': '{"v":1}' });
      expect(existsSync(`${target.stateDir}.restore-progress.json`)).toBe(true);
      runRestore(partial, snapshot);
      const complete = join(root, 'retry-complete-check');
      pullBucket(target, complete);
      expect(tree(complete)).toEqual(tree(seed));
      const restoredKeys = JSON.parse(tree(target.stateDir)['platform-keys.json']!);
      expect(restoredKeys).toEqual({
        ...JSON.parse(PLATFORM_KEYS),
        SAM_INSTALLATION_ID: expect.stringMatching(/^[a-f0-9]{32}$/),
      });
      expect(restoredKeys.SAM_INSTALLATION_ID).not.toBe(
        JSON.parse(PLATFORM_KEYS).SAM_INSTALLATION_ID
      );
      expect(existsSync(`${target.stateDir}.restore-progress.json`)).toBe(false);
    });

    it('restores the fence rules readable by the fence container (root without capabilities)', () => {
      const seed = join(root, 'fence-seed');
      mkdirSync(seed, { recursive: true });
      writeFileSync(join(seed, 'current.json'), '{"v":1}');
      pushBucket(ctx('s3://fencesrc/celld', join(root, 'fence-unused')), seed);
      const state = join(root, 'fence-source-state');
      mkdirSync(state, { mode: 0o700 });
      writeFileSync(join(state, 'platform-keys.json'), PLATFORM_KEYS, { mode: 0o600 });
      // As deploy writes it (fence-state.ts): not secret, read by the fence container's root.
      const rules = 'table inet sam_egress_fence {}\n';
      writeFileSync(join(state, FENCE_RULES_FILE), rules, { mode: FENCE_RULES_MODE });
      chmodSync(join(state, FENCE_RULES_FILE), FENCE_RULES_MODE);
      writeFileSync(join(root, 'box.env'), 'CELLD_BUCKET=s3://fencesrc/celld\n', { mode: 0o600 });
      const snapshot = join(root, 'fence-backup');
      runBackup(ctx('s3://fencesrc/celld', state), snapshot);

      const restored = join(root, 'fence-restored-state');
      runRestore(ctx('s3://fencedst/celld', restored), snapshot);
      // The fence service mounts the rules read-only and reads them as root with no
      // DAC_OVERRIDE (docker-compose.yml egress-fence). On main the restore left them 0600 and
      // this read failed with "Permission denied", exactly as on the box.
      const read = run('docker', [
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '-v',
        `${join(restored, FENCE_RULES_FILE)}:/etc/sam/egress-fence.nft:ro`,
        DEFAULT_ADOPTION_HELPER_IMAGE,
        'cat',
        '/etc/sam/egress-fence.nft',
      ]);
      // A cold cache writes pull progress to stderr; only the read failure matters.
      expect(read.stderr).not.toMatch(/Permission denied/);
      expect(read.status).toBe(0);
      expect(read.stdout).toBe(rules);
      // Control: secret-bearing state stays private.
      expect(statSync(join(restored, 'platform-keys.json')).mode & 0o777).toBe(0o600);
    });

    it('round-trips the fleet bucket and box state into an empty install', () => {
      composeCalls.length = 0;
      // Seed the "fleet" through the same push path restore uses.
      const seed = join(root, 'seed');
      mkdirSync(join(seed, 'd1/main'), { recursive: true });
      writeFileSync(join(seed, 'd1/main/000001.ltx'), 'ltx-bytes');
      writeFileSync(join(seed, 'deploy-current.json'), '{"version":"v7"}');
      pushBucket(ctx('s3://fleet/celld', join(root, 'unused')), seed);

      const state = join(root, 'state');
      mkdirSync(state);
      writeFileSync(join(state, 'platform-keys.json'), PLATFORM_KEYS);
      writeFileSync(join(root, 'box.env'), 'CELLD_BUCKET=s3://fleet/celld\n', { mode: 0o600 });

      const dest = join(root, 'backup');
      const manifest = runBackup(ctx('s3://fleet/celld', state), dest, 'a'.repeat(40));
      expect(composeCalls).toEqual(['stop celld', 'start celld']);
      expect(manifest.objectCount).toBe(2);
      expect(manifest.downtimeMs).toBeGreaterThan(0);

      const newState = join(root, 'new-state');
      runRestore(ctx('s3://fresh/celld', newState), dest);
      const check = join(root, 'check');
      pullBucket(ctx('s3://fresh/celld', newState), check);
      expect(tree(check)).toEqual(tree(seed));
      const restoredKeys = JSON.parse(tree(newState)['platform-keys.json']!);
      expect(restoredKeys).toEqual({
        ...JSON.parse(PLATFORM_KEYS),
        SAM_INSTALLATION_ID: expect.stringMatching(/^[a-f0-9]{32}$/),
      });
      expect(restoredKeys.SAM_INSTALLATION_ID).not.toBe(
        JSON.parse(PLATFORM_KEYS).SAM_INSTALLATION_ID
      );

      // A second restore into the now non-empty bucket is refused.
      expect(() => runRestore(ctx('s3://fresh/celld', join(root, 'other-state')), dest)).toThrow(
        /not empty/
      );
    });
  }
);
