/**
 * selfhost:backup / selfhost:restore orchestration (backup-lib.ts) against a fake object store
 * that really copies files: an `mc mirror` or `gcloud storage rsync` invocation is interpreted
 * and executed against a directory standing in for the bucket. The real-store version of the
 * round trip is live/backup-restore.live.test.ts (pinned MinIO image, Docker).
 */
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WranglerToml } from '../deploy/types';
import { decryptBackupTree, encryptBackupTree } from './backup-encryption';
import {
  assertRollbackCacheReady,
  type BoxContext,
  MANIFEST_NAME,
  OBJECTSTORE_IMAGE,
  runBackup,
  runRestore,
  type RunResult,
  runRollback,
} from './backup-lib';
import { buildCelldConfig } from './celld-config';
import { prepareCelldProject, writeCelldConfig } from './celld-project';
import { composeProjectFor, expectedComposeProjectFor, recordInstall } from './install-record';

const PLATFORM_KEYS = JSON.stringify({ SAM_INSTALLATION_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
const SECRET = 'store-secret-value-123';
let root: string;
let calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }>;
let clock: number;
/** How many pulls after the live one fail (1: the delta copy; 2: the delta and the full copy). */
let failDeltaCopy: number;
let failLiveCopy: boolean;
let cacheProof:
  'owned' | 'foreign' | 'ambiguous' | 'changed' | 'replaced' | 'replaced-after-remove';
let cacheMount: 'canonical' | 'wrong' | 'duplicate' | 'bind' | 'changed';
let mountInspections: number;
let selectedProject: string;
let replaceStateOnPush: boolean;
let celldStopped: boolean;
let runningCelldIds: string;
let cacheInspections: number;
let targetContainers: string;
let occupiedProject: string | undefined;

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
  if (command === 'docker' && args[0] === 'compose') {
    if (args.includes('ps') && args.includes('--status'))
      return { ...ok, stdout: celldStopped ? '' : runningCelldIds };
    if (args.includes('ps') && args.includes('-q') && args.at(-1) === 'celld') {
      if (celldStopped && !args.includes('--all')) return ok;
      selectedProject = args[args.indexOf('--project-name') + 1] ?? '';
      return { ...ok, stdout: 'c'.repeat(64) };
    }
    if (args.at(-2) === 'stop') celldStopped = true;
    if (args.at(-2) === 'start') celldStopped = false;
    return ok;
  }
  if (command === 'docker' && args[0] === 'container' && args[1] === 'rm') return ok;
  if (command === 'docker' && args[0] === 'inspect') {
    mountInspections += 1;
    const name =
      cacheMount === 'wrong' || (cacheMount === 'changed' && mountInspections > 1)
        ? 'overlay-other-cache'
        : `${selectedProject}_celld-data`;
    const mount = {
      Destination: '/var/lib/celld',
      Type: cacheMount === 'bind' ? 'bind' : 'volume',
      Name: name,
    };
    return { ...ok, stdout: JSON.stringify(cacheMount === 'duplicate' ? [mount, mount] : [mount]) };
  }
  if (command === 'docker' && args[0] === 'ps')
    return {
      ...ok,
      stdout:
        !occupiedProject || args.includes(`label=com.docker.compose.project=${occupiedProject}`)
          ? targetContainers
          : '',
    };
  if (command === 'docker' && args[0] === 'volume') {
    if (args[1] === 'rm') return ok;
    if (args[1] === 'inspect') {
      cacheInspections += 1;
      const name = args[2] ?? '';
      const project = name.replace(/_celld-data$/, '');
      const foreign =
        cacheProof === 'foreign' || (cacheProof === 'changed' && cacheInspections > 1);
      const volume = {
        Name: name,
        CreatedAt:
          (cacheProof === 'replaced' && cacheInspections > 1) ||
          (cacheProof === 'replaced-after-remove' && cacheInspections > 2)
            ? '2026-11-19T02:00:00Z'
            : '2026-11-19T01:00:00Z',
        Labels: {
          'com.docker.compose.project': foreign ? 'another-installation' : project,
          'com.docker.compose.volume': 'celld-data',
        },
      };
      return {
        ...ok,
        stdout: JSON.stringify(cacheProof === 'ambiguous' ? [volume, volume] : [volume]),
      };
    }
  }

  if (command === 'gcloud' && args[0] === 'storage' && args[1] === 'rsync') {
    const [src, dst] = args.slice(-2) as [string, string];
    const from = src.startsWith('gs://') ? storePath(src.slice(5)) : src;
    const to = dst.startsWith('gs://') ? storePath(dst.slice(5)) : dst;
    if (args.includes('--delete-unmatched-destination-objects'))
      rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    cpSync(from, to, { recursive: true });
    if (replaceStateOnPush && dst.startsWith('gs://')) {
      const state = join(root, 'state');
      const previous = join(root, 'previous-state');
      renameSync(state, previous);
      mkdirSync(state);
      cpSync(join(previous, 'platform-keys.json'), join(state, 'platform-keys.json'));
      cpSync(join(previous, 'created-resources.json'), join(state, 'created-resources.json'));
      writeFileSync(join(state, 'foreign-marker'), 'must-survive');
    }
    return ok;
  }

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
        if (mc.includes('--remove')) rmSync(storePath(dst), { recursive: true, force: true });
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
      R2_S3_REGION: 'us-east-1',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      AWS_ACCESS_KEY_ID: 'sam-objectstore',
      AWS_SECRET_ACCESS_KEY: SECRET,
    },
    envFile: join(root, 'box.env'),
    stateDir,
    encryptionKeyFile: join(root, 'backup-key'),
    composeFiles: ['/x/docker-compose.yml'],
    run: fakeRun,
    now: () => clock,
    log: () => undefined,
  };
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/sam-backup-'));
  writeFileSync(join(root, 'backup-key'), randomBytes(32), { mode: 0o600 });
  calls = [];
  clock = 1_000_000;
  failDeltaCopy = 0;
  failLiveCopy = false;
  cacheProof = 'owned';
  cacheMount = 'canonical';
  mountInspections = 0;
  selectedProject = '';
  replaceStateOnPush = false;
  celldStopped = false;
  runningCelldIds = 'c'.repeat(64);
  cacheInspections = 0;
  targetContainers = '';
  occupiedProject = undefined;
  const fleet = join(root, 'store/fleet/celld');
  mkdirSync(join(fleet, 'd1'), { recursive: true });
  writeFileSync(join(fleet, 'd1/main.ltx'), 'rows');
  writeFileSync(join(fleet, 'current.json'), '{"v":3}');
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state/platform-keys.json'), PLATFORM_KEYS);
  writeFileSync(join(root, 'box.env'), `AWS_SECRET_ACCESS_KEY=${SECRET}\n`, { mode: 0o600 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function inspectBackup(dest: string, part: string): Record<string, string> {
  const plain = join(root, 'inspection');
  decryptBackupTree(dest, plain, join(root, 'backup-key'));
  try {
    return tree(join(plain, part));
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
}

describe('runBackup', () => {
  it.each(['', `${'c'.repeat(64)}\n${'d'.repeat(64)}`, 'short-id'])(
    'refuses missing or ambiguous running celld before any bucket copy (%s)',
    (ids) => {
      runningCelldIds = ids;
      const snapshot = join(root, 'unobserved-writer-backup');
      expect(() => runBackup(ctx('gs://fleet/celld', join(root, 'state')), snapshot)).toThrow(
        /exactly one running celld/
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toContain('--status');
      expect(calls.some((call) => call.command === 'gcloud')).toBe(false);
      expect(existsSync(snapshot)).toBe(false);
    }
  );

  it('backs up the real generated celld project while omitting its rebuildable source/migration symlinks', () => {
    const apiDir = resolve(import.meta.dirname, '../../apps/api');
    const source = TOML.parse(readFileSync(join(apiDir, 'wrangler.toml'), 'utf8')) as WranglerToml;
    const plan = buildCelldConfig(source, { main: 'src/index.ts', baseDomain: 'test.example.com' });
    const projectDir = join(root, 'state/project');
    prepareCelldProject({ apiDir, projectDir, plan });
    writeCelldConfig(projectDir, plan.config);
    expect(lstatSync(join(projectDir, 'src')).isSymbolicLink()).toBe(true);
    const migration = plan.migrationDirs[0]!;
    const migrationDir = join(projectDir, migration.projectRelativeDir);
    expect(lstatSync(join(migrationDir, readdirSync(migrationDir)[0]!)).isSymbolicLink()).toBe(
      true
    );
    const snapshot = join(root, 'generated-project-backup');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot);
    const state = inspectBackup(snapshot, 'state');
    expect(state['project/wrangler.json']).toBe(
      readFileSync(join(projectDir, 'wrangler.json'), 'utf8')
    );
    expect(Object.keys(state).some((name) => name.startsWith('project/src/'))).toBe(false);
    expect(Object.keys(state).some((name) => name.endsWith('.sql'))).toBe(false);
    runRestore(ctx('s3://fresh/celld', join(root, 'restored-generated-state')), snapshot);
    expect(readFileSync(join(root, 'restored-generated-state/project/wrangler.json'), 'utf8')).toBe(
      state['project/wrangler.json']
    );
    expect(existsSync(join(root, 'restored-generated-state/project/src'))).toBe(false);
  });

  it('refuses arbitrary state symlinks and cleans incomplete backups', () => {
    symlinkSync(join(root, 'box.env'), join(root, 'state/operator-secret-link'));
    const snapshot = join(root, 'invalid-state-backup');
    expect(() => runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot)).toThrow();
    expect(existsSync(snapshot)).toBe(false);
    expect(calls.at(-1)?.args.slice(-2)).toEqual(['start', 'celld']);
  });

  it('pre-copies live, stops celld only for the delta, restarts it, and records the downtime', () => {
    const dest = join(root, 'backups/b1');
    const manifest = runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest, 'a'.repeat(40));

    const sequence = calls
      .filter((c) => !c.args.includes('--status'))
      .map((c) =>
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
    expect(inspectBackup(dest, 'bucket')).toEqual({
      'd1/main.ltx': 'rows',
      'current.json': '{"v":3}',
    });
    expect(inspectBackup(dest, 'state')).toEqual({ 'platform-keys.json': PLATFORM_KEYS });
    expect(statSync(dest).mode & 0o777).toBe(0o700);

    // The store credential travels in the environment only, and never into the manifest.
    for (const call of calls) expect(call.args.join(' ')).not.toContain(SECRET);
    expect(calls.find((c) => c.args[0] === 'run')!.env?.MC_HOST_src).toContain(SECRET);
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
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest, 'a'.repeat(40));
    expect(inspectBackup(dest, 'state')).toEqual({
      'platform-keys.json': PLATFORM_KEYS,
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
    expect(inspectBackup(dest, 'bucket')).toEqual({
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
    expect(pulls.map((mount) => basename((mount ?? '').split(':')[0] ?? ''))).toEqual([
      '.bucket-live',
      'bucket',
      '.bucket-full',
    ]);
    expect(logs.some((l) => l.startsWith('delta copy failed'))).toBe(true);
    expect(manifest.objectCount).toBe(2);
    expect(readdirSync(dest).sort()).toEqual([
      '.sam-backup-manifest',
      'backup-manifest.json',
      'bucket',
      'env',
      'state',
    ]);
    expect(inspectBackup(dest, 'bucket')).toEqual({
      'd1/main.ltx': 'rows',
      'current.json': '{"v":3}',
    });
    // celld stays stopped through both copies, and the downtime records both.
    expect(
      calls
        .filter((c) => !c.args.includes('--status'))
        .map((c) => c.args.at(-1))
        .filter((a) => a === 'celld')
    ).toHaveLength(2);
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
    ).toThrow(/already exists/);
    expect(calls).toHaveLength(0);
  });

  it('recovers the BOX gcloud post-download POSIX ENOENT without retaining a partial node file', () => {
    let pulls = 0;
    let running = true;
    const run = (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === 'docker') {
        if (args.includes('--status')) return { status: 0, stdout: 'c'.repeat(64), stderr: '' };
        if (args.includes('stop')) running = false;
        if (args.includes('start')) running = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      const directory = args.at(-1)!;
      mkdirSync(join(directory, 'nodes'), { recursive: true });
      pulls++;
      if (pulls === 1) {
        writeFileSync(join(directory, 'nodes/stale.json_.gstmp'), 'partial download');
        return { status: 1, stdout: '', stderr: 'HTTP 404: live object generation vanished' };
      }
      expect(running).toBe(false);
      if (pulls === 2) {
        expect(existsSync(join(directory, 'nodes/stale.json_.gstmp'))).toBe(false);
        return {
          status: 1,
          stdout: '',
          stderr: 'FileNotFoundError: POSIX os.stat destination nodes/stale.json [Errno 2]',
        };
      }
      writeFileSync(join(directory, 'nodes/current.json'), 'consistent node data');
      return { status: 0, stdout: '', stderr: '' };
    };
    const dest = join(root, 'backups/gcloud-posix');
    const manifest = runBackup({ ...ctx('gs://fleet/celld', join(root, 'state')), run }, dest);
    expect(manifest.objectCount).toBe(1);
    expect(inspectBackup(dest, 'bucket')).toEqual({ 'nodes/current.json': 'consistent node data' });
    expect(running).toBe(true);
  });

  it('uses gcloud storage rsync for a gs:// bucket', () => {
    const run = (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: args.includes('--status') ? 'c'.repeat(64) : '', stderr: '' };
    };
    runBackup({ ...ctx('gs://my-bucket/celld', join(root, 'state')), run }, join(root, 'b3'));
    // live pass into its own directory; the delta pass into `bucket`, a path gcloud never wrote
    expect(basename(calls.filter((c) => c.command === 'gcloud')[1]?.args.at(-1) ?? '')).toBe(
      'bucket'
    );
    expect(calls.find((c) => c.command === 'gcloud')).toMatchObject({
      command: 'gcloud',
      args: [
        'storage',
        'rsync',
        '--recursive',
        '--delete-unmatched-destination-objects',
        'gs://my-bucket/celld',
        expect.stringMatching(/\/\.bucket-live$/),
      ],
    });
  });
});

describe('runRestore', () => {
  it('refuses containers under the final restored identity even when the pre-key project is empty', () => {
    const snapshot = join(root, 'post-restore-project-backup');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot);
    const target = ctx('s3://fresh/celld', join(root, 'new-state'));
    const preKey = composeProjectFor(target.box, target.stateDir);
    const finalProject = expectedComposeProjectFor(target.box, target.stateDir, 'a'.repeat(32));
    expect(finalProject).not.toBe(preKey);
    occupiedProject = finalProject;
    targetContainers = 'fixture-final-project-container\n';
    calls = [];
    expect(() => runRestore(target, snapshot)).toThrow(/already has containers/);
    expect(calls.filter((call) => call.args[0] === 'ps').map((call) => call.args.at(-1))).toEqual([
      `label=com.docker.compose.project=${preKey}`,
      `label=com.docker.compose.project=${finalProject}`,
    ]);
    expect(calls.some((call) => call.args.includes('mirror'))).toBe(false);
    expect(existsSync(target.stateDir)).toBe(false);
    expect(existsSync(join(root, 'store/fresh/celld'))).toBe(false);
  });

  it('refuses any existing target project containers before bucket or state writes', () => {
    const snapshot = join(root, 'occupied-target-backup');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot);
    targetContainers = 'fixture-existing-container\n';
    calls = [];
    expect(() => runRestore(ctx('s3://fresh/celld', join(root, 'new-state')), snapshot)).toThrow(
      /container|empty install/i
    );
    expect(calls.some((call) => call.args.includes('mirror'))).toBe(false);
    expect(calls.some((call) => call.args[0] === 'compose')).toBe(false);
    expect(existsSync(join(root, 'new-state'))).toBe(false);
    expect(existsSync(join(root, 'store/fresh/celld'))).toBe(false);
  });

  it.each(['createdAt', 'samCommit', 'objectCount', 'downtimeMs'] as const)(
    'refuses authenticated invalid %s manifest metadata before cloud operations',
    (field) => {
      const context = ctx('s3://fleet/celld', join(root, 'state'));
      const source = join(root, 'metadata-source');
      runBackup(context, source);
      const plain = join(root, 'metadata-plain');
      const altered = join(root, 'metadata-altered');
      decryptBackupTree(source, plain, context.encryptionKeyFile!);
      try {
        const manifest = JSON.parse(readFileSync(join(plain, MANIFEST_NAME), 'utf8')) as Record<
          string,
          unknown
        >;
        manifest[field] =
          field === 'createdAt' || field === 'samCommit'
            ? 'fixture-sensitive-metadata\nunsafe-output'
            : -1;
        writeFileSync(join(plain, MANIFEST_NAME), JSON.stringify(manifest));
        encryptBackupTree(plain, altered, context.encryptionKeyFile!);
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
      calls = [];
      let error: unknown;
      try {
        runRestore(ctx('s3://fresh/celld', join(root, 'new-state')), altered);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('fixture-sensitive-metadata');
      expect(calls).toHaveLength(0);
      expect(existsSync(join(root, 'new-state'))).toBe(false);
    }
  );

  it('refuses existing state without platform keys instead of overwriting its files', () => {
    const dest = join(root, 'backup-existing-state');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest);
    const state = join(root, 'existing-state');
    mkdirSync(state);
    writeFileSync(join(state, 'operator-file'), 'keep-this-file');
    calls = [];
    expect(() => runRestore(ctx('s3://fresh/celld', state), dest)).toThrow(/not empty/);
    expect(calls).toHaveLength(0);
    expect(tree(state)).toEqual({ 'operator-file': 'keep-this-file' });
  });

  it('authenticates all backup ciphertext before any store query or compose operation', () => {
    const dest = join(root, 'backup-auth');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest);
    writeFileSync(join(dest, 'env'), 'damaged ciphertext');
    calls = [];
    expect(() => runRestore(ctx('s3://fresh/celld', join(root, 'new-state')), dest)).toThrow(
      'authentication failed'
    );
    expect(calls).toHaveLength(0);
    expect(existsSync(join(root, 'new-state'))).toBe(false);
  });

  it('restores bucket and state into an empty install (round trip)', () => {
    const dest = join(root, 'backups/b1');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest);

    const newState = join(root, 'new-state');
    runRestore(ctx('s3://fresh/celld', newState), dest);

    expect(tree(join(root, 'store/fresh/celld'))).toEqual(tree(join(root, 'store/fleet/celld')));
    expect(tree(newState)).toEqual({ 'platform-keys.json': PLATFORM_KEYS });
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
      /not empty/
    );
  });
});

describe('runRollback', () => {
  beforeEach(() => {
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    recordInstall(
      context.stateDir,
      context.envFile,
      context.box,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
  });

  it.each(['wrong', 'duplicate', 'bind'] as const)(
    'refuses a selected overlay with %s celld cache mount before rollback bucket writes',
    (mount) => {
      const context = ctx('gs://fleet/celld', join(root, 'state'));
      const snapshot = join(root, 'overlay-cache-snapshot');
      runBackup(context, snapshot);
      calls = [];
      cacheMount = mount;
      expect(() => assertRollbackCacheReady(context)).toThrow(/canonical owned volume/);
      expect(() => runRollback(context, snapshot)).toThrow(/canonical owned volume/);
      expect(calls.some((call) => call.command === 'gcloud')).toBe(false);
      expect(calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'rm')).toBe(false);
      expect(
        calls.some((call) => call.args.includes('stop') || call.args.includes('--force'))
      ).toBe(false);
    }
  );

  it.each(['mount', 'creation-time'] as const)(
    'refuses a changed cache %s between ownership checks',
    (changed) => {
      const context = ctx('gs://fleet/celld', join(root, 'state'));
      const snapshot = join(root, 'replaced-cache-snapshot');
      runBackup(context, snapshot);
      calls = [];
      if (changed === 'mount') cacheMount = 'changed';
      else cacheProof = 'replaced';
      expect(() => runRollback(context, snapshot)).toThrow(/cache mount|cache identity changed/);
      expect(calls.some((call) => call.command === 'gcloud')).toBe(false);
      expect(calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'rm')).toBe(false);
    }
  );

  it('refuses a same-label cache replaced after container removal, before deleting the new volume', () => {
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    const snapshot = join(root, 'post-remove-cache-snapshot');
    runBackup(context, snapshot);
    cacheProof = 'replaced-after-remove';
    calls = [];
    expect(() => runRollback(context, snapshot)).toThrow(/cache identity changed/);
    expect(cacheInspections).toBe(3);
    expect(calls.some((call) => call.args.includes('--force'))).toBe(true);
    expect(calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'rm')).toBe(false);
    expect(calls.some((call) => call.command === 'gcloud')).toBe(false);
  });

  it('rechecks the live state inode immediately before removal after the bucket copy', () => {
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    const snapshot = join(root, 'state-race-snapshot');
    runBackup(context, snapshot);
    replaceStateOnPush = true;
    expect(() => runRollback(context, snapshot)).toThrow(/state directory identity changed/);
    expect(readFileSync(join(context.stateDir, 'foreign-marker'), 'utf8')).toBe('must-survive');
  });

  it('refuses a live state receipt whose directory inode changed before any rollback operation', () => {
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    const snapshot = join(root, 'state-inode-snapshot');
    runBackup(context, snapshot);
    const path = join(context.stateDir, 'created-resources.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as {
      resources: Array<{ kind: string; attributes: Record<string, string> }>;
    };
    receipt.resources.find((resource) => resource.kind === 'state-dir')!.attributes.inode = '0';
    writeFileSync(path, JSON.stringify(receipt));
    calls = [];
    expect(() => runRollback(context, snapshot)).toThrow(/state directory identity changed/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['current', 'missing'],
    ['current', 'foreign'],
    ['current', 'ambiguous'],
    ['snapshot', 'missing'],
    ['snapshot', 'foreign'],
    ['snapshot', 'ambiguous'],
  ] as const)('refuses %s %s state ownership receipts before mutations', (location, defect) => {
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    const original = join(root, 'receipt-snapshot');
    runBackup(context, original);
    let snapshot = original;
    let state = context.stateDir;
    const plain = join(root, 'receipt-plain');
    if (location === 'snapshot') {
      decryptBackupTree(original, plain, context.encryptionKeyFile!);
      state = join(plain, 'state');
    }
    try {
      const file = join(state, 'created-resources.json');
      const receipt = JSON.parse(readFileSync(file, 'utf8')) as {
        resources: Array<{ kind: string; name: string }>;
      };
      const index = receipt.resources.findIndex((r) => r.kind === 'state-dir');
      const entry = receipt.resources[index]!;
      if (defect === 'missing') receipt.resources.splice(index, 1);
      else if (defect === 'foreign') entry.name = join(root, 'foreign-state');
      else receipt.resources.push({ ...entry, name: join(root, 'another-state') });
      writeFileSync(file, JSON.stringify(receipt));
      if (location === 'snapshot') {
        snapshot = join(root, 'altered-receipt-snapshot');
        encryptBackupTree(plain, snapshot, context.encryptionKeyFile!);
      }
    } finally {
      if (location === 'snapshot') rmSync(plain, { recursive: true, force: true });
    }
    calls = [];
    expect(() => runRollback(context, snapshot)).toThrow(/ownership/);
    expect(calls).toHaveLength(0);
  });

  it.each(['current', 'snapshot'])(
    'sanitizes malformed %s platform key JSON before any runner call',
    (location) => {
      const context = ctx('gs://fleet/celld', join(root, 'state'));
      let snapshot = join(root, 'malformed-identity-snapshot');
      const fragment = 'fixture-token-that-must-never-appear';
      runBackup(context, snapshot);
      if (location === 'snapshot') {
        const plain = join(root, 'malformed-identity-plain');
        decryptBackupTree(snapshot, plain, context.encryptionKeyFile!);
        try {
          writeFileSync(join(plain, 'state/platform-keys.json'), `{"ENCRYPTION_KEY":"${fragment}`);
          snapshot = join(root, 'malformed-identity-altered');
          encryptBackupTree(plain, snapshot, context.encryptionKeyFile!);
        } finally {
          rmSync(plain, { recursive: true, force: true });
        }
      } else {
        writeFileSync(
          join(context.stateDir, 'platform-keys.json'),
          `{"ENCRYPTION_KEY":"${fragment}`
        );
      }
      calls = [];
      let error: unknown;
      try {
        runRollback(context, snapshot);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Cannot verify rollback installation identity');
      expect(String(error)).not.toContain(fragment);
      expect(calls).toHaveLength(0);
    }
  );

  it.each(['foreign', 'ambiguous', 'changed'] as const)(
    'refuses %s cache ownership before deleting volumes or copying the rollback bucket',
    (proof) => {
      const dest = join(root, 'cache-snapshot');
      const context = ctx('gs://fleet/celld', join(root, 'state'));
      runBackup(context, dest);
      calls = [];
      cacheProof = proof;
      expect(() => runRollback(context, dest)).toThrow(/cache ownership|Foreign celld cache/);
      expect(cacheInspections).toBe(proof === 'changed' ? 2 : 1);
      expect(
        calls.some((c) => c.command === 'docker' && c.args[0] === 'volume' && c.args[1] === 'rm')
      ).toBe(false);
      expect(calls.some((c) => c.command === 'gcloud')).toBe(false);
      expect(readFileSync(join(root, 'state/platform-keys.json'), 'utf8')).toBe(PLATFORM_KEYS);
    }
  );

  it.each(['bucket', 'installation'])(
    'refuses rollback to a different %s before mutating resources',
    (kind) => {
      const dest = join(root, 'snapshot');
      runBackup(ctx('gs://fleet/celld', join(root, 'state')), dest);
      if (kind === 'installation')
        writeFileSync(
          join(root, 'state/platform-keys.json'),
          JSON.stringify({ SAM_INSTALLATION_ID: 'different-installation' })
        );
      calls = [];
      const target = ctx(
        kind === 'bucket' ? 'gs://other/celld' : 'gs://fleet/celld',
        join(root, 'state')
      );
      expect(() => runRollback(target, dest)).toThrow(`different ${kind}`);
      expect(calls).toHaveLength(0);
    }
  );

  it('restores the exact pre-upgrade GCS tree, removing newly written objects and state', () => {
    const dest = join(root, 'rollback-snapshot');
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    runBackup(context, dest);
    const expectedState = inspectBackup(dest, 'state');
    writeFileSync(join(root, 'store/fleet/celld/current.json'), 'upgraded');
    writeFileSync(join(root, 'store/fleet/celld/new-object'), 'introduced during failed upgrade');
    writeFileSync(join(root, 'state/new-state'), 'new state');
    writeFileSync(join(root, 'box.env'), 'changed after backup');
    calls = [];
    runRollback(context, dest);
    expect(tree(join(root, 'store/fleet/celld'))).toEqual({
      'current.json': '{"v":3}',
      'd1/main.ltx': 'rows',
    });
    const actualState = tree(join(root, 'state'));
    const restoredRecord = JSON.parse(actualState['created-resources.json']!) as {
      resources: Array<{ kind: string; attributes: Record<string, string> }>;
    };
    const stateReceipt = restoredRecord.resources.find((resource) => resource.kind === 'state-dir');
    expect(stateReceipt?.attributes.inode).toBe(String(statSync(join(root, 'state')).ino));
    delete actualState['created-resources.json'];
    delete expectedState['created-resources.json'];
    expect(actualState).toEqual(expectedState);
    expect(readFileSync(join(root, 'box.env'), 'utf8')).toBe(`AWS_SECRET_ACCESS_KEY=${SECRET}\n`);
    expect(calls.find((c) => c.command === 'gcloud')?.args).toContain(
      '--delete-unmatched-destination-objects'
    );
    expect(calls.some((c) => c.args.includes('stop'))).toBe(true);
    expect(cacheInspections).toBe(3);
    const volumeDelete = calls.find(
      (c) => c.command === 'docker' && c.args[0] === 'volume' && c.args[1] === 'rm'
    );
    expect(volumeDelete?.args[2]).toMatch(/^sam-selfhost-[a-f0-9]{12}_celld-data$/);
    expect(
      calls.find((c) => c.command === 'docker' && c.args.includes('--force'))?.args.slice(-4)
    ).toEqual(['container', 'rm', '--force', 'c'.repeat(64)]);
  });
});

describe('operation path boundaries', () => {
  it.each(['backup', 'restore', 'rollback'] as const)(
    'rejects symlink state/env, keys under state and backup/state overlap for %s before any runner call',
    (operation) => {
      const context = ctx('gs://fleet/celld', join(root, 'state'));
      const snapshot = join(root, 'path-snapshot');
      runBackup(context, snapshot);
      const invoke = (candidate: BoxContext, path = snapshot): void => {
        if (operation === 'backup')
          runBackup(candidate, path === snapshot ? join(root, 'new-backup') : path);
        else if (operation === 'restore') runRestore(candidate, path);
        else runRollback(candidate, path);
      };
      symlinkSync(context.stateDir, join(root, 'linked-state'));
      symlinkSync(context.envFile, join(root, 'linked-env'));
      const nestedKey = join(context.stateDir, 'backup-key');
      writeFileSync(nestedKey, readFileSync(join(root, 'backup-key')), { mode: 0o600 });
      for (const candidate of [
        { ...context, stateDir: join(root, 'linked-state') },
        { ...context, envFile: join(root, 'linked-env') },
        { ...context, encryptionKeyFile: nestedKey },
      ]) {
        calls = [];
        expect(() => invoke(candidate)).toThrow(/symlinks|overlap/);
        expect(calls).toHaveLength(0);
      }
      calls = [];
      expect(() => invoke(context, join(context.stateDir, 'snapshot'))).toThrow(/overlap/);
      expect(calls).toHaveLength(0);
      expect(readFileSync(join(context.stateDir, 'platform-keys.json'), 'utf8')).toBe(
        PLATFORM_KEYS
      );
    }
  );
});
