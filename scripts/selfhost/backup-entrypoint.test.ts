/**
 * `pnpm selfhost:backup` then `pnpm selfhost:restore`, run as the real commands (tsx backup.ts,
 * tsx restore.ts) with fake `gcloud` and `docker` binaries first on PATH (testdata/). The fake
 * gcloud models generation churn and the confirmed box failure from PR #2675: SDK523 can
 * reach its POSIX-metadata stat after finalize_download returned false and no local file exists.
 * Destination-keyed partial-state isolation and a clean full-copy fallback are both exercised.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decryptBackupTree } from './backup-encryption';

const PLATFORM_KEYS = JSON.stringify({
  SAM_INSTALLATION_ID: 'a'.repeat(32),
  ENCRYPTION_KEY: 'fixture-encryption-key',
});
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
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/sam-backup-cli-'));
  writeFileSync(join(root, 'backup-key'), randomBytes(32), { mode: 0o600 });
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
  writeFileSync(join(root, 'state/platform-keys.json'), PLATFORM_KEYS);
  writeFileSync(join(root, 'box.env'), `CELLD_BUCKET=${FLEET}\n`, { mode: 0o600 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('selfhost:backup and selfhost:restore (real entry points, fake gcloud)', () => {
  it('reserves the authenticated final project without target state, bucket or runtime writes', () => {
    const dest = join(root, 'project-backup');
    expect(
      run('backup.ts', [
        '--to',
        dest,
        '--box-env',
        join(root, 'box.env'),
        '--state-dir',
        join(root, 'state'),
        '--encryption-key-file',
        join(root, 'backup-key'),
      ]).status
    ).toBe(0);
    writeFileSync(join(root, 'fresh.env'), 'CELLD_BUCKET=gs://fresh/celld\n', { mode: 0o600 });
    writeFileSync(join(root, 'fake/calls.log'), '');
    const args = [
      '--from',
      dest,
      '--print-project',
      '--box-env',
      join(root, 'fresh.env'),
      '--state-dir',
      join(root, 'fresh-state'),
      '--encryption-key-file',
      join(root, 'backup-key'),
    ];
    const output = run('restore.ts', args);
    expect(output.status).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.stdout).toMatch(/^sam-selfhost-[a-f0-9]{12}\n$/);
    expect(readFileSync(join(root, 'fake/calls.log'), 'utf8')).toBe('');
    expect(existsSync(join(root, 'fresh-state'))).toBe(false);
    expect(existsSync(join(root, 'gcs/fresh'))).toBe(false);
    const receipt = join(root, 'fresh-state.restore-progress.json');
    expect(existsSync(receipt)).toBe(true);
    expect(lstatSync(receipt).mode & 0o777).toBe(0o600);
    const reserved = readFileSync(receipt, 'utf8');
    const repeated = run('restore.ts', args);
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toBe(output.stdout);
    expect(readFileSync(receipt, 'utf8')).toBe(reserved);
    expect(readFileSync(join(root, 'fake/calls.log'), 'utf8')).toBe('');
    expect(existsSync(join(root, 'fresh-state'))).toBe(false);
    expect(existsSync(join(root, 'gcs/fresh'))).toBe(false);
  });
  it('uses a clean full copy after the stopped pass hits the confirmed POSIX stat of a missing finalized file', () => {
    writeFileSync(
      join(root, 'fake/posix-fail-once.json'),
      JSON.stringify({ key: 'nodes/node_live.json', metadata: { atime: '1', mtime: '2' } })
    );
    const dest = join(root, 'posix-fallback-backup');
    const result = run('backup.ts', [
      '--to',
      dest,
      '--box-env',
      join(root, 'box.env'),
      '--state-dir',
      join(root, 'state'),
      '--encryption-key-file',
      join(root, 'backup-key'),
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('delta copy failed');
    expect(result.stdout).not.toContain('set_posix_attributes');
    const calls = readFileSync(join(root, 'fake/calls.log'), 'utf8').trim().split('\n');
    expect(calls.filter((call) => call.startsWith('gcloud storage rsync'))).toHaveLength(3);
    const plain = join(root, 'posix-inspection');
    decryptBackupTree(dest, plain, join(root, 'backup-key'));
    try {
      expect(tree(join(plain, 'bucket'))).toEqual(tree(join(root, 'gcs/fleet/celld')));
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    expect(readFileSync(join(root, 'fake/celld'), 'utf8')).toBe('running');
  }, 60_000);

  it('backs up the actual legacy shell-selected project when its YAML has only a static name', () => {
    const compose = join(root, 'legacy-compose.yml');
    writeFileSync(compose, 'name: sam-selfhost\nservices:\n  celld:\n    image: fixture/celld\n');
    env.COMPOSE_FILE = compose;
    env.COMPOSE_PROJECT_NAME = 'sam-selfhost';
    env.FAKE_COMPOSE_PROJECT = 'sam-selfhost';
    const dest = join(root, 'legacy-project-backup');
    const result = run('backup.ts', [
      '--to',
      dest,
      '--box-env',
      join(root, 'box.env'),
      '--state-dir',
      join(root, 'state'),
      '--encryption-key-file',
      join(root, 'backup-key'),
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const calls = readFileSync(join(root, 'fake/calls.log'), 'utf8').trim().split('\n');
    const composeCalls = calls.filter((call) => call.startsWith('docker compose'));
    expect(composeCalls).toHaveLength(3);
    for (const call of composeCalls)
      expect(call).toContain(`--project-name sam-selfhost -f ${compose}`);
    expect(composeCalls[0]).toContain('ps --status running --quiet --no-trunc celld');
    expect(composeCalls[1]).toMatch(/stop celld$/);
    expect(composeCalls[2]).toMatch(/start celld$/);
    const plain = join(root, 'legacy-inspection');
    decryptBackupTree(dest, plain, join(root, 'backup-key'));
    try {
      expect(readFileSync(join(plain, 'bucket/nodes/node_live.json'), 'utf8')).toBe('{"lease":2}');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    expect(readFileSync(join(root, 'fake/celld'), 'utf8')).toBe('running');
  }, 60_000);

  it('uses shell bucket overrides and the explicit custom state directory through real child commands', () => {
    env.CELLD_BUCKET = 'gs://override/celld';
    env.SAM_SELFHOST_STATE_DIR = join(root, 'wrong-state');
    put(join(root, 'gcs/override/celld'), { 'd1/main.ltx': 'shell-override-rows' });
    const custom = join(root, 'custom-state');
    mkdirSync(custom);
    writeFileSync(
      join(custom, 'platform-keys.json'),
      JSON.stringify({ SAM_INSTALLATION_ID: 'a'.repeat(32) })
    );
    const dest = join(root, 'custom-backup');
    const result = run('backup.ts', [
      '--to',
      dest,
      '--box-env',
      join(root, 'box.env'),
      '--state-dir',
      custom,
      '--encryption-key-file',
      join(root, 'backup-key'),
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const plain = join(root, 'custom-inspection');
    decryptBackupTree(dest, plain, join(root, 'backup-key'));
    try {
      expect(tree(join(plain, 'bucket'))).toEqual({ 'd1/main.ltx': 'shell-override-rows' });
      expect(readFileSync(join(plain, 'state/platform-keys.json'), 'utf8')).toBe(
        readFileSync(join(custom, 'platform-keys.json'), 'utf8')
      );
      expect(JSON.parse(readFileSync(join(plain, 'backup-manifest.json'), 'utf8')).bucket).toBe(
        env.CELLD_BUCKET
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    expect(
      readFileSync(join(root, 'fake/compose-state-dirs.log'), 'utf8').trim().split('\n')
    ).toEqual([custom, custom, custom]);
  }, 60_000);

  // Runs the real backup and restore entry points as child processes: give them room under load.
  it(
    'backs up exactly the post-stop bucket when objects vanish between the passes, and restores it into an empty install',
    { timeout: 60_000 },
    () => {
      const dest = join(root, 'backups/b1');
      const backup = run('backup.ts', [
        '--to',
        dest,
        '--encryption-key-file',
        join(root, 'backup-key'),
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
      const inspection = join(root, 'inspection');
      decryptBackupTree(dest, inspection, join(root, 'backup-key'));
      expect(tree(join(inspection, 'bucket'))).toEqual(afterStop);
      expect(readdirSync(dest).sort()).toEqual(
        ['.sam-backup-manifest', 'backup-manifest.json', 'bucket', 'env', 'state'].sort()
      );

      const manifest = JSON.parse(readFileSync(join(inspection, 'backup-manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ version: 1, bucket: FLEET, objectCount: 5 });
      expect(typeof manifest.downtimeMs).toBe('number');
      expect(manifest.downtimeMs).toBeGreaterThanOrEqual(manifest.deltaCopyMs);

      rmSync(inspection, { recursive: true, force: true });
      const calls = readFileSync(join(root, 'fake/calls.log'), 'utf8').trim().split('\n');
      expect(calls[0]).toContain('ps --status running --quiet --no-trunc celld');
      const operations = calls.filter((call) => !call.includes(' ps --status running '));
      expect(operations.map((c) => c.split(' ').slice(0, 3).join(' '))).toEqual([
        'gcloud storage rsync', // live
        'docker compose --project-name',
        'gcloud storage rsync', // delta, celld stopped
        'docker compose --project-name',
      ]);
      expect(operations[1]).toMatch(/stop celld$/);
      expect(operations[3]).toMatch(/start celld$/);

      // Restore into an empty install: new bucket, no platform keys yet.
      writeFileSync(
        join(root, 'new.env'),
        'CELLD_BUCKET=gs://fresh/celld\nSAM_DOMAIN=restore.example.org\n',
        { mode: 0o600 }
      );
      delete env.SAM_DOMAIN; // The target domain exists only in its private .env.
      const restore = run('restore.ts', [
        '--from',
        dest,
        '--encryption-key-file',
        join(root, 'backup-key'),
        '--box-env',
        join(root, 'new.env'),
        '--state-dir',
        join(root, 'new-state'),
      ]);
      expect(restore.stderr).toBe('');
      expect(restore.status).toBe(0);
      expect(restore.stdout).toContain("curl -fsS 'https://api.restore.example.org/health'");
      expect(restore.stdout).not.toContain('$SAM_DOMAIN');
      expect(tree(join(root, 'gcs/fresh/celld'))).toEqual(afterStop);
      const restoredKeys = JSON.parse(tree(join(root, 'new-state'))['platform-keys.json']!);
      expect(restoredKeys).toEqual({
        ...JSON.parse(PLATFORM_KEYS),
        SAM_INSTALLATION_ID: expect.stringMatching(/^[a-f0-9]{32}$/),
      });
      expect(restoredKeys.SAM_INSTALLATION_ID).not.toBe(
        JSON.parse(PLATFORM_KEYS).SAM_INSTALLATION_ID
      );
    }
  );
});
