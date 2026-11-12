/**
 * selfhost:backup / selfhost:restore orchestration (backup-lib.ts) against a fake object store
 * that really copies files: an `mc mirror` or `gcloud storage rsync` invocation is interpreted
 * and executed against a directory standing in for the bucket. The real-store version of the
 * round trip is live/backup-restore.live.test.ts (pinned MinIO image, Docker).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type BoxContext,
  MANIFEST_NAME,
  OBJECTSTORE_IMAGE,
  runBackup,
  runRestore,
  type RunResult,
} from './backup-lib';

const SECRET = 'store-secret-value-123';
let root: string;
let calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }>;
let clock: number;
/** How many pulls after the live one fail (1: the delta copy; 2: the delta and the full copy). */
let failDeltaCopy: number;
let failLiveCopy: boolean;

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

/** Bucket "s3://fleet/celld" lives at <root>/store/fleet/celld. */
function storePath(spec: string): string {
  return join(root, 'store', spec.replace(/^src\//, ''));
}

function fakeRun(command: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  calls.push({ command, args, env });
  clock += 1000; // every command takes one second of fake time
  const ok = { status: 0, stdout: '', stderr: '' };
  if (command === 'docker' && args[0] === 'compose') return ok;
  if (command === 'docker' && args[0] === 'run') {
    const mount = args[args.indexOf('-v') + 1] ?? '';
    const hostDir = mount.split(':')[0] as string;
    const mc = args.slice(args.indexOf(OBJECTSTORE_IMAGE) + 1);
    if (mc[0] === 'ls') {
      const listed = Object.keys(tree(storePath(mc[2] as string)));
      return { ...ok, stdout: listed.map((k) => `[date] 1B ${k}`).join('\n') };
    }
    if (mc[0] === 'mirror') {
      const [src, dst] = mc.slice(-2) as [string, string];
      if (src.startsWith('src/')) {
        // bucket -> backup; the second (delta) pull can be made to fail
        const pulls = calls.filter((c) => c.args.includes('/backup') && c.args[0] === 'run');
        if (pulls.length >= 2 && pulls.length <= 1 + failDeltaCopy)
          return { status: 1, stdout: '', stderr: 'boom' };
        if (failLiveCopy && pulls.length === 1) {
          // a running node rewrote an object mid-copy: part of the bucket arrives, then 404
          mkdirSync(join(hostDir, 'd1'), { recursive: true });
          writeFileSync(join(hostDir, 'd1/main.ltx'), 'stale');
          return {
            status: 1,
            stdout: '',
            stderr: 'ERROR: gs://b/celld%2Fwake%2Fwaker.json#1 not found: 404.',
          };
        }
        rmSync(hostDir, { recursive: true, force: true });
        cpSync(storePath(src), hostDir, { recursive: true });
      } else {
        mkdirSync(storePath(dst), { recursive: true });
        cpSync(hostDir, storePath(dst), { recursive: true });
      }
      return ok;
    }
  }
  throw new Error(`unexpected command ${command} ${args.join(' ')}`);
}

function ctx(bucket: string, stateDir: string): BoxContext {
  return {
    box: {
      CELLD_BUCKET: bucket,
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      AWS_ACCESS_KEY_ID: 'sam-objectstore',
      AWS_SECRET_ACCESS_KEY: SECRET,
    },
    envFile: join(root, 'box.env'),
    stateDir,
    composeFiles: ['/x/docker-compose.yml'],
    run: fakeRun,
    now: () => clock,
    log: () => undefined,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-backup-'));
  calls = [];
  clock = 1_000_000;
  failDeltaCopy = 0;
  failLiveCopy = false;
  const fleet = join(root, 'store/fleet/celld');
  mkdirSync(join(fleet, 'd1'), { recursive: true });
  writeFileSync(join(fleet, 'd1/main.ltx'), 'rows');
  writeFileSync(join(fleet, 'current.json'), '{"v":3}');
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state/platform-keys.json'), '{"k":"v"}');
  writeFileSync(join(root, 'box.env'), `AWS_SECRET_ACCESS_KEY=${SECRET}\n`, { mode: 0o600 });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runBackup', () => {
  it('pre-copies live, stops celld only for the delta, restarts it, and records the downtime', () => {
    const dest = join(root, 'backups/b1');
    const manifest = runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest, 'abc123');

    const sequence = calls.map((c) =>
      c.args[0] === 'compose'
        ? `compose ${c.args.slice(-2).join(' ')}`
        : `${c.command} ${c.args[0]}`
    );
    expect(sequence).toEqual([
      'docker run', // live pre-copy
      'compose stop celld',
      'docker run', // delta
      'compose start celld',
    ]);
    // stop at t+2s, delta done t+3s, start at t+4s: 2 s of downtime on the fake clock.
    expect(manifest).toMatchObject({ downtimeMs: 2000, deltaCopyMs: 1000, objectCount: 2 });
    expect(tree(join(dest, 'bucket'))).toEqual({
      'd1/main.ltx': 'rows',
      'current.json': '{"v":3}',
    });
    expect(tree(join(dest, 'state'))).toEqual({ 'platform-keys.json': '{"k":"v"}' });
    expect(statSync(dest).mode & 0o777).toBe(0o700);

    // The store credential travels in the environment only, and never into the manifest.
    for (const call of calls) expect(call.args.join(' ')).not.toContain(SECRET);
    expect(calls[0]!.env?.MC_HOST_src).toContain(SECRET);
    expect(readFileSync(join(dest, MANIFEST_NAME), 'utf8')).not.toContain(SECRET);
  });

  it('leaves the rebuildable vm-agent build cache out of the state copy', () => {
    mkdirSync(join(root, 'state/go-cache/ab'), { recursive: true });
    writeFileSync(join(root, 'state/go-cache/ab/obj-d'), 'compiled');
    mkdirSync(join(root, 'state/project'), { recursive: true });
    writeFileSync(join(root, 'state/project/wrangler.json'), '{}');
    // A file whose name only starts like the cache is not the cache.
    writeFileSync(join(root, 'state/go-cache-notes'), 'kept');
    const dest = join(root, 'backups/b-cache');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest, 'abc123');
    expect(tree(join(dest, 'state'))).toEqual({
      'platform-keys.json': '{"k":"v"}',
      'project/wrangler.json': '{}',
      'go-cache-notes': 'kept',
    });
  });

  it('finishes the backup when the live pre-copy fails because objects changed mid-copy', () => {
    failLiveCopy = true;
    const logs: string[] = [];
    const dest = join(root, 'backups/b3');
    const manifest = runBackup(
      { ...ctx('s3://fleet/celld', join(root, 'state')), log: (m) => logs.push(m) },
      dest
    );
    expect(manifest.objectCount).toBe(2);
    // the delta copy with celld stopped replaced the stale partial copy
    expect(tree(join(dest, 'bucket'))).toEqual({
      'd1/main.ltx': 'rows',
      'current.json': '{"v":3}',
    });
    expect(logs.some((l) => l.startsWith('live pre-copy incomplete'))).toBe(true);
    expect(calls.at(-1)!.args.slice(-2)).toEqual(['start', 'celld']);
  });

  it('falls back to a whole copy into an untouched directory when the delta copy fails', () => {
    failDeltaCopy = 1;
    const logs: string[] = [];
    const dest = join(root, 'backups/b4');
    const manifest = runBackup(
      { ...ctx('s3://fleet/celld', join(root, 'state')), log: (m) => logs.push(m) },
      dest
    );
    const pulls = calls
      .filter((c) => c.args[0] === 'run')
      .map((c) => c.args[c.args.indexOf('-v') + 1]);
    expect(pulls).toEqual([
      `${join(dest, '.bucket-live')}:/backup`,
      `${join(dest, 'bucket')}:/backup`,
      `${join(dest, '.bucket-full')}:/backup`,
    ]);
    expect(logs.some((l) => l.startsWith('delta copy failed'))).toBe(true);
    expect(manifest.objectCount).toBe(2);
    expect(readdirSync(dest).sort()).toEqual(['backup-manifest.json', 'bucket', 'env', 'state']);
    expect(tree(join(dest, 'bucket'))).toEqual({
      'd1/main.ltx': 'rows',
      'current.json': '{"v":3}',
    });
    // celld stays stopped through both copies, and the downtime records both.
    expect(calls.map((c) => c.args.at(-1)).filter((a) => a === 'celld')).toHaveLength(2);
    expect(manifest.downtimeMs).toBe(3000); // stop t+2s, failed delta t+3s, whole copy t+4s, start t+5s
  });

  it('restarts celld when the delta copy and the whole copy both fail', () => {
    failDeltaCopy = 2;
    expect(() =>
      runBackup(ctx('s3://fleet/celld', join(root, 'state')), join(root, 'backups/b2'))
    ).toThrow(/mc mirror/);
    expect(calls.at(-1)!.args.slice(-2)).toEqual(['start', 'celld']);
  });

  it('refuses a non-empty destination', () => {
    mkdirSync(join(root, 'used'));
    writeFileSync(join(root, 'used/x'), '1');
    expect(() =>
      runBackup(ctx('s3://fleet/celld', join(root, 'state')), join(root, 'used'))
    ).toThrow(/not empty/);
    expect(calls).toHaveLength(0);
  });

  it('uses gcloud storage rsync for a gs:// bucket', () => {
    const run = (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    runBackup({ ...ctx('gs://my-bucket/celld', join(root, 'state')), run }, join(root, 'b3'));
    // live pass into its own directory; the delta pass into `bucket`, a path gcloud never wrote
    expect(calls[2]?.args.at(-1)).toBe(join(root, 'b3/bucket'));
    expect(calls[0]).toMatchObject({
      command: 'gcloud',
      args: [
        'storage',
        'rsync',
        '--recursive',
        '--delete-unmatched-destination-objects',
        'gs://my-bucket/celld',
        join(root, 'b3/.bucket-live'),
      ],
    });
  });
});

describe('runRestore', () => {
  it('restores bucket and state into an empty install (round trip)', () => {
    const dest = join(root, 'backups/b1');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest);

    const newState = join(root, 'new-state');
    runRestore(ctx('s3://fresh/celld', newState), dest);

    expect(tree(join(root, 'store/fresh/celld'))).toEqual(tree(join(root, 'store/fleet/celld')));
    expect(tree(newState)).toEqual({ 'platform-keys.json': '{"k":"v"}' });
  });

  it('refuses a bucket that already holds objects', () => {
    const dest = join(root, 'backups/b1');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest);
    calls = [];
    expect(() => runRestore(ctx('s3://fleet/celld', join(root, 'new-state')), dest)).toThrow(
      /not empty/
    );
    expect(calls.some((c) => c.args.includes('stop'))).toBe(false);
  });

  it('refuses a state directory that already has platform keys', () => {
    const dest = join(root, 'backups/b1');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest);
    expect(() => runRestore(ctx('s3://fresh/celld', join(root, 'state')), dest)).toThrow(
      /already holds platform keys/
    );
  });
});
