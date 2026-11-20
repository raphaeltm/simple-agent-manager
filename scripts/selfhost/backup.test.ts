/**
 * selfhost:backup / selfhost:restore orchestration (backup-lib.ts) against a fake object store
 * that really copies files: an `mc mirror` or `gcloud storage rsync` invocation is interpreted
 * and executed against a directory standing in for the bucket. The real-store version of the
 * round trip is live/backup-restore.live.test.ts (pinned MinIO image, Docker).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
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

import { addResource, markRemoved, readRecord } from '../../deploy/selfhost/created-resources.mjs';
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
import { finishRollbackCache, refreshRollbackCacheReceipt } from './backup-recovery';
import { buildCelldConfig } from './celld-config';
import { prepareCelldProject, writeCelldConfig } from './celld-project';
import { runDeploy, runTsx, writeBox } from './deploy-harness';
import { composeProjectFor, expectedComposeProjectFor, recordInstall } from './install-record';
import { restoredInstallationId } from './restore-identity';
import { recoverUpgrade } from './upgrade-lib';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

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
let failRestorePush: boolean;
let replaceRestoreJournalOnPull: boolean;
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
    if (args[1] === 'ls') return { ...ok, stdout: `${selectedProject}_celld-data` };
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
          (cacheProof === 'replaced-after-remove' &&
            calls.some((c) => c.args[0] === 'container' && c.args[1] === 'rm'))
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
        if (replaceRestoreJournalOnPull && src === 'src/fresh/celld') {
          const journal = join(root, 'new-state.restore-progress.json');
          writeFileSync(`${journal}.replacement`, readFileSync(journal), { mode: 0o600 });
          renameSync(`${journal}.replacement`, journal);
        }
      } else {
        if (mc.includes('--remove')) rmSync(storePath(dst), { recursive: true, force: true });
        mkdirSync(storePath(dst), { recursive: true });
        if (failRestorePush) {
          failRestorePush = false;
          replaceRestoreJournalOnPull = false;
          const first = Object.keys(tree(hostDir))[0]!;
          mkdirSync(join(storePath(dst), first, '..'), { recursive: true });
          cpSync(join(hostDir, first), join(storePath(dst), first));
          return { status: 1, stdout: '', stderr: 'fixture provider failure must not be echoed' };
        }
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
  failRestorePush = false;
  replaceRestoreJournalOnPull = false;
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
  it('preserves an operator parent mode1777 through the public backup entry', () => {
    const parent = join(root, 'operator-parent');
    mkdirSync(parent);
    chmodSync(parent, 0o1777);
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), join(parent, 'snapshot'));
    expect(statSync(parent).mode & 0o7777).toBe(0o1777);
  });
  it('refuses a symlink parent before copying or stopping anything and preserves its mode', () => {
    const parent = join(root, 'operator-parent');
    mkdirSync(parent, { mode: 0o755 });
    symlinkSync(parent, join(root, 'linked-parent'));
    expect(() =>
      runBackup(ctx('s3://fleet/celld', join(root, 'state')), join(root, 'linked-parent/snapshot'))
    ).toThrow(/without symlinks/);
    expect(calls).toHaveLength(0);
    expect(statSync(parent).mode & 0o777).toBe(0o755);
  });

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
  it('refuses a hard-linked partial state file before copying over an external inode', () => {
    const snapshot = join(root, 'retry-hardlink-snapshot');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot);
    const target = ctx('s3://fresh/celld', join(root, 'new-state'));
    failRestorePush = true;
    expect(() => runRestore(target, snapshot)).toThrow();
    mkdirSync(target.stateDir, { mode: 0o700 });
    const external = join(root, 'external-key-file');
    writeFileSync(external, PLATFORM_KEYS, { mode: 0o600 });
    linkSync(external, join(target.stateDir, 'platform-keys.json'));
    calls = [];
    expect(() => runRestore(target, snapshot)).toThrow(/unsafe data/);
    expect(readFileSync(external, 'utf8')).toBe(PLATFORM_KEYS);
    expect(statSync(external).nlink).toBe(2);
    expect(
      calls.some((call) => call.args.includes('mirror') && call.args.at(-2) === '/backup')
    ).toBe(false);
  });
  it('revalidates retry journal identity immediately before the resumed write phase', () => {
    const snapshot = join(root, 'retry-journal-race-snapshot');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot);
    const target = ctx('s3://fresh/celld', join(root, 'new-state'));
    failRestorePush = true;
    expect(() => runRestore(target, snapshot)).toThrow();
    replaceRestoreJournalOnPull = true;
    calls = [];
    expect(() => runRestore(target, snapshot)).toThrow('Restore retry ownership changed');
    expect(
      calls.some((call) => call.args.includes('mirror') && call.args.at(-2) === '/backup')
    ).toBe(false);
  });

  it('resumes a real partial bucket copy from the same authenticated backup without deleting data', () => {
    const snapshot = join(root, 'retry-snapshot');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot);
    const target = ctx('s3://fresh/celld', join(root, 'new-state'));
    failRestorePush = true;
    expect(() => runRestore(target, snapshot)).toThrow(/mc mirror/);
    expect(Object.keys(tree(join(root, 'store/fresh/celld')))).toHaveLength(1);
    expect(existsSync(`${target.stateDir}.restore-progress.json`)).toBe(true);
    // Simulate a prior interrupted state copy as an exact subset of the same authenticated state.
    mkdirSync(target.stateDir, { mode: 0o700 });
    writeFileSync(
      join(target.stateDir, 'platform-keys.json'),
      JSON.stringify({ SAM_INSTALLATION_ID: restoredInstallationId(target, 'a'.repeat(32)) }),
      { mode: 0o600 }
    );
    runRestore(target, snapshot);
    expect(tree(join(root, 'store/fresh/celld'))).toEqual(tree(join(root, 'store/fleet/celld')));
    expect(tree(target.stateDir)).toEqual({
      'platform-keys.json': JSON.stringify({
        SAM_INSTALLATION_ID: restoredInstallationId(target, 'a'.repeat(32)),
      }),
    });
    expect(existsSync(`${target.stateDir}.restore-progress.json`)).toBe(false);
  });

  it.each(['foreign-object', 'changed-object', 'foreign-state'] as const)(
    'refuses retry with %s and preserves it instead of overwriting or deleting',
    (defect) => {
      const snapshot = join(root, 'retry-refusal-snapshot');
      runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot);
      const target = ctx('s3://fresh/celld', join(root, 'new-state'));
      failRestorePush = true;
      expect(() => runRestore(target, snapshot)).toThrow(/mc mirror/);
      let path: string;
      if (defect === 'foreign-state') {
        mkdirSync(target.stateDir, { mode: 0o700 });
        path = join(target.stateDir, 'foreign-file');
      } else
        path = join(
          root,
          'store/fresh/celld',
          defect === 'changed-object'
            ? Object.keys(tree(join(root, 'store/fresh/celld')))[0]!
            : 'foreign-file'
        );
      writeFileSync(path, 'foreign-data-must-survive');
      calls = [];
      expect(() => runRestore(target, snapshot)).toThrow(/Restore retry contains/);
      expect(readFileSync(path, 'utf8')).toBe('foreign-data-must-survive');
      expect(
        calls.some((call) => call.args.includes('mirror') && call.args.at(-2) === '/backup')
      ).toBe(false);
      expect(existsSync(`${target.stateDir}.restore-progress.json`)).toBe(true);
    }
  );

  it('binds retry ownership to the exact target bucket before any runner call', () => {
    const snapshot = join(root, 'retry-target-snapshot');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot);
    const target = ctx('s3://fresh/celld', join(root, 'new-state'));
    failRestorePush = true;
    expect(() => runRestore(target, snapshot)).toThrow();
    calls = [];
    expect(() =>
      runRestore({ ...target, box: { ...target.box, CELLD_BUCKET: 's3://other/celld' } }, snapshot)
    ).toThrow('Cannot verify restore retry ownership');
    expect(calls).toHaveLength(0);
  });

  it('refuses containers under the final restored identity even when the pre-key project is empty', () => {
    const snapshot = join(root, 'post-restore-project-backup');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot);
    const target = ctx('s3://fresh/celld', join(root, 'new-state'));
    const preKey = composeProjectFor(target.box, target.stateDir);
    const finalProject = expectedComposeProjectFor(
      target.box,
      target.stateDir,
      restoredInstallationId(target, 'a'.repeat(32))
    );
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

  it.each(['box', 'shell', 'secrets'] as const)(
    'refuses a %s installation identity override before target writes',
    (kind) => {
      const snapshot = join(root, 'identity-override');
      runBackup(ctx('s3://fleet/celld', join(root, 'state')), snapshot);
      const target = ctx('s3://fresh/celld', join(root, 'new-state'));
      if (kind === 'box') target.box = { ...target.box, SAM_INSTALLATION_ID: 'a'.repeat(32) };
      else if (kind === 'shell') vi.stubEnv('SAM_INSTALLATION_ID', 'a'.repeat(32));
      else {
        const plain = join(root, 'override-plain');
        decryptBackupTree(snapshot, plain, join(root, 'backup-key'));
        writeFileSync(join(plain, 'state/secrets.env'), 'SAM_INSTALLATION_ID=' + 'a'.repeat(32), {
          mode: 0o600,
        });
        rmSync(snapshot, { recursive: true });
        encryptBackupTree(plain, snapshot, join(root, 'backup-key'));
      }
      calls = [];
      expect(() => runRestore(target, snapshot)).toThrow('explicit installation identity override');
      expect(calls).toHaveLength(0);
      expect(existsSync(target.stateDir)).toBe(false);
    }
  );

  it('fresh restore and real deploy init establish ownership that refuses the source VM at teardown', async () => {
    rmSync(join(root, 'state/platform-keys.json'));
    const sourceEnv = writeBox(root);
    const sourceInit = await runDeploy(sourceEnv, ['--init', '--state-dir', join(root, 'state')]);
    expect(sourceInit.status, sourceInit.out).toBe(0);
    const sourceKeys = JSON.parse(readFileSync(join(root, 'state/platform-keys.json'), 'utf8'));
    mkdirSync(join(root, 'store/fleet/celld/deploy/version'), { recursive: true });
    writeFileSync(
      join(root, 'store/fleet/celld/deploy/current.json'),
      JSON.stringify({ prefix: 'deploy/version' })
    );
    writeFileSync(
      join(root, 'store/fleet/celld/deploy/version/manifest.json'),
      JSON.stringify({ vars: { SAM_INSTALLATION_ID: sourceKeys.SAM_INSTALLATION_ID } })
    );
    mkdirSync(join(root, 'state/project'), { recursive: true });
    writeFileSync(
      join(root, 'state/project/wrangler.json'),
      JSON.stringify({
        vars: {
          SAM_INSTALLATION_ID: sourceKeys.SAM_INSTALLATION_ID,
          ENCRYPTION_KEY: sourceKeys.ENCRYPTION_KEY,
        },
      }),
      { mode: 0o600 }
    );
    const snapshot = join(root, 'clone-snapshot');
    runBackup({ ...ctx('s3://fleet/celld', join(root, 'state')), envFile: sourceEnv }, snapshot);
    const targetDir = join(root, 'clone');
    mkdirSync(targetDir);
    const targetEnv = writeBox(targetDir, [
      'GCP_PROJECT=sam-test-proj',
      'CELLD_BUCKET=s3://fresh/celld',
    ]);
    const targetState = join(targetDir, '.state');
    runRestore({ ...ctx('s3://fresh/celld', targetState), envFile: targetEnv }, snapshot);
    expect(existsSync(join(root, 'store/fresh/celld/deploy/current.json'))).toBe(false);
    expect(
      readFileSync(join(root, 'store/fresh/celld/deploy/version/manifest.json'), 'utf8')
    ).toContain(sourceKeys.SAM_INSTALLATION_ID);
    expect(inspectBackup(snapshot, 'bucket')).toHaveProperty('deploy/current.json');
    const cloneKeys = JSON.parse(readFileSync(join(targetState, 'platform-keys.json'), 'utf8'));
    expect(cloneKeys.SAM_INSTALLATION_ID).not.toBe(sourceKeys.SAM_INSTALLATION_ID);
    const projectedConfig = JSON.parse(
      readFileSync(join(targetState, 'project/wrangler.json'), 'utf8')
    );
    expect(projectedConfig.vars.SAM_INSTALLATION_ID).toBe(cloneKeys.SAM_INSTALLATION_ID);
    expect(projectedConfig.vars.ENCRYPTION_KEY).toBe(sourceKeys.ENCRYPTION_KEY);
    expect({ ...cloneKeys, SAM_INSTALLATION_ID: sourceKeys.SAM_INSTALLATION_ID }).toEqual(
      sourceKeys
    );
    const initialized = await runDeploy(targetEnv, ['--init']);
    expect(initialized.status, initialized.out).toBe(0);
    expect(
      readRecord(join(targetState, 'created-resources.json')).resources.find(
        (r) => r.kind === 'installation'
      )?.name
    ).toBe(cloneKeys.SAM_INSTALLATION_ID);
    const bin = join(root, 'clone-bin');
    mkdirSync(bin);
    const cloudCalls = join(root, 'clone-cloud-calls');
    const vm = {
      id: '123456',
      name: 'sam-source-node',
      zone: 'projects/sam-test-proj/zones/europe-west1-b',
      labels: {
        managed: 'simple-agent-manager',
        installation: sourceKeys.SAM_INSTALLATION_ID,
        env: 'selfhost',
        node: 'node-id',
      },
      disks: [],
      tags: { items: ['sam-agent'] },
      networkInterfaces: [{ network: 'x/networks/default' }],
    };
    writeFileSync(
      join(bin, 'gcloud'),
      `#!/usr/bin/env node
import fs from 'node:fs'; const a=process.argv.slice(2).join(' ');fs.appendFileSync(process.env.CLONE_CALLS,a+'\\n');if(a.startsWith('compute instances list'))console.log(process.env.SOURCE_VM);else if(a.includes('delete'))process.exit(99);else process.exit(98);`,
      { mode: 0o755 }
    );
    writeFileSync(join(bin, 'docker'), '#!/usr/bin/env node\n', { mode: 0o755 });
    const teardown = await runTsx(
      resolve(import.meta.dirname, 'teardown.ts'),
      [
        '--box-env',
        targetEnv,
        '--state-dir',
        targetState,
        '--keep-data',
        '--confirm',
        'sam.example.com',
      ],
      { PATH: `${bin}:${process.env.PATH}`, CLONE_CALLS: cloudCalls, SOURCE_VM: JSON.stringify(vm) }
    );
    expect(teardown.status, teardown.out).toBe(1);
    expect(teardown.out).toContain('installation');
    expect(existsSync(cloudCalls), teardown.out).toBe(true);
    expect(readFileSync(cloudCalls, 'utf8')).toContain('compute instances list');
    expect(readFileSync(cloudCalls, 'utf8')).not.toContain('delete');
    expect(readFileSync(join(root, 'state/platform-keys.json'), 'utf8')).toContain(
      sourceKeys.SAM_INSTALLATION_ID
    );
  }, 120_000);

  it('restores bucket and state into an empty install (round trip)', () => {
    const dest = join(root, 'backups/b1');
    runBackup(ctx('s3://fleet/celld', join(root, 'state')), dest);

    const newState = join(root, 'new-state');
    runRestore(ctx('s3://fresh/celld', newState), dest);

    expect(tree(join(root, 'store/fresh/celld'))).toEqual(tree(join(root, 'store/fleet/celld')));
    expect(tree(newState)).toEqual({
      'platform-keys.json': JSON.stringify({
        SAM_INSTALLATION_ID: restoredInstallationId(
          ctx('s3://fresh/celld', newState),
          'a'.repeat(32)
        ),
      }),
    });
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

  it.each(['replacement', 'volume-only', 'no-resources'])(
    'retries partial Compose %s creation after a failed start and ownership refresh',
    async (partial) => {
      const context = ctx('gs://fleet/celld', join(root, 'state'));
      const snapshot = join(root, 'partial-compose-snapshot');
      const source = 'a'.repeat(40);
      runBackup(context, snapshot, source);
      const invoke = context.run;
      let container = 'c'.repeat(64);
      let volume = true;
      let created = '2026-11-19T01:00:00Z';
      let starts = 0;
      let inspectFailure = partial === 'replacement';
      const deleted: string[] = [];
      context.run = (command, args, env) => {
        if (command === 'git' || command === 'pnpm') return { status: 0, stdout: '', stderr: '' };
        const result = invoke(command, args, env);
        if (command !== 'docker') return result;
        if (args.includes('up')) {
          starts++;
          container = (starts === 1 ? 'd' : 'e').repeat(64);
          created = new Date().toISOString();
          volume = true;
          if (starts === 1 && partial !== 'replacement') container = '';
          if (starts === 1 && partial === 'no-resources') volume = false;
          return { ...result, status: starts === 1 ? 1 : 0 };
        }
        if (args[0] === 'compose' && args.includes('ps')) return { ...result, stdout: container };
        if (args[0] === 'container' && args[1] === 'rm') {
          deleted.push(args[3]!);
          container = '';
        }
        if (args[0] === 'volume' && args[1] === 'rm') volume = false;
        if (args[0] === 'volume' && args[1] === 'ls')
          return { ...result, stdout: volume ? `${selectedProject}_celld-data` : '' };
        if (args[0] === 'volume' && args[1] === 'inspect') {
          const value = JSON.parse(result.stdout);
          value[0].CreatedAt = created;
          return { ...result, stdout: JSON.stringify(value) };
        }
        if (args[0] === 'inspect' && args[2]?.includes('{{json .Id}}')) {
          if (inspectFailure) {
            inspectFailure = false;
            return { ...result, status: 1 };
          }
          return {
            ...result,
            stdout: JSON.stringify({
              Id: container,
              Created: created,
              Config: {
                Labels: {
                  'com.docker.compose.project': selectedProject,
                  'com.docker.compose.service': 'celld',
                  'com.docker.compose.project.config_files': context.composeFiles
                    .map((p) => resolve(p))
                    .join(','),
                  'com.docker.compose.project.working_dir': resolve(context.composeFiles[0]!, '..'),
                },
              },
            }),
          };
        }
        return result;
      };
      const upgradeContext = { ...context, composeFiles: context.composeFiles };
      const health = vi.fn(async () => true);
      await expect(
        recoverUpgrade(upgradeContext, source, snapshot, [], { to: source, checkHealth: health })
      ).rejects.toThrow(/restore previous stack failed/);
      const receipt = join(context.stateDir, 'rollback-cache-pending.json');
      const authorized = readFileSync(receipt, 'utf8');
      const unstarted = JSON.parse(authorized);
      expect(unstarted.startingAt).toBeTruthy();
      expect(health).not.toHaveBeenCalled();
      // Negative control: without durable start authorization the replacement must remain foreign.
      if (partial !== 'no-resources') {
        delete unstarted.startingAt;
        writeFileSync(receipt, JSON.stringify(unstarted));
        await expect(
          recoverUpgrade(upgradeContext, source, snapshot, [], { to: source, checkHealth: health })
        ).rejects.toThrow(/cache identity changed/);
        expect(deleted).toEqual(['c'.repeat(64)]);
        writeFileSync(receipt, authorized);
      }
      await recoverUpgrade(upgradeContext, source, snapshot, [], {
        to: source,
        checkHealth: health,
      });
      expect(starts).toBe(2);
      expect(deleted).toEqual(
        partial === 'replacement' ? ['c'.repeat(64), 'd'.repeat(64)] : ['c'.repeat(64)]
      );
      expect(health).toHaveBeenCalledOnce();
      expect(existsSync(receipt)).toBe(false);
    }
  );

  it('retains current backup/cloud receipts and removal markers instead of reviving snapshot history', () => {
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    const ledger = join(context.stateDir, 'created-resources.json');
    const cloud = (name: string, action: 'created' | 'reused' = 'created') => ({
      cloud: 'gcp',
      kind: 'firewall',
      name,
      action,
      createdBy: 'gcp-bootstrap',
      attributes: { installation: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', identity: name + '-id' },
    });
    addResource(ledger, cloud('removed-after-snapshot'));
    addResource(ledger, cloud('replaced-after-snapshot'));
    const snapshot = join(root, 'ledger-snapshot');
    runBackup(context, snapshot);
    markRemoved(ledger, 'gcp', 'firewall', 'removed-after-snapshot');
    markRemoved(ledger, 'gcp', 'firewall', 'replaced-after-snapshot');
    addResource(ledger, cloud('replaced-after-snapshot', 'reused'));
    addResource(ledger, cloud('created-after-snapshot'));
    const before = readRecord(ledger);
    runRollback(context, snapshot);
    const after = readRecord(ledger);
    expect(after.resources.filter((r) => r.cloud === 'gcp')).toEqual(
      before.resources.filter((r) => r.cloud === 'gcp')
    );
    expect(after.resources.find((r) => r.kind === 'backup' && r.name === snapshot)).toEqual(
      before.resources.find((r) => r.kind === 'backup' && r.name === snapshot)
    );
    expect(
      after.resources.find((r) => r.name === 'removed-after-snapshot')?.removedAt
    ).toBeTruthy();
    expect(after.resources.find((r) => r.name === 'replaced-after-snapshot')?.action).toBe(
      'reused'
    );
    expect(after.resources.find((r) => r.kind === 'state-dir')?.attributes?.inode).toBe(
      String(statSync(context.stateDir).ino)
    );
  });

  it.each(['domain', 'environment', 'composeProject'])(
    'refuses a foreign current ledger %s before mutation',
    (field) => {
      const context = ctx('gs://fleet/celld', join(root, 'state'));
      const snapshot = join(root, 'foreign-ledger');
      runBackup(context, snapshot);
      const ledger = join(context.stateDir, 'created-resources.json');
      const record = readRecord(ledger);
      const installation = record.resources.find((r) => r.kind === 'installation');
      installation!.attributes![field] = 'foreign';
      writeFileSync(ledger, JSON.stringify(record));
      calls = [];
      expect(() => runRollback(context, snapshot)).toThrow(/different installation scope/);
      expect(calls).toEqual([]);
    }
  );

  it('restores after a real Go module cache made read-only directories in the old state', () => {
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    const cache = join(context.stateDir, 'go-cache/module/pkg');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'module.go'), 'rebuildable cache', { mode: 0o444 });
    chmodSync(cache, 0o555);
    const snapshot = join(root, 'readonly-go-cache');
    runBackup(context, snapshot);
    expect(() => runRollback(context, snapshot)).not.toThrow();
    expect(existsSync(join(context.stateDir, 'go-cache'))).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith('.rollback-state-'))).toBe(false);
  });

  it('keeps completed cache progress until recovered code is healthy and refreshes a recreated cache', () => {
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    const snapshot = join(root, 'post-data-retry');
    runBackup(context, snapshot);
    runRollback(context, snapshot);
    const journal = join(context.stateDir, 'rollback-cache-pending.json');
    expect(existsSync(journal)).toBe(true);
    const invoke = context.run;
    context.run = (command, args, env) => {
      if (
        command === 'docker' &&
        args[0] === 'compose' &&
        args.includes('ps') &&
        args.includes('-q')
      )
        return { status: 0, stdout: '', stderr: '' };
      if (command === 'docker' && args[0] === 'volume' && args[1] === 'ls')
        return { status: 0, stdout: '', stderr: '' };
      return invoke(command, args, env);
    };
    expect(() => runRollback(context, snapshot)).not.toThrow();
    context.run = invoke;
    expect(() => refreshRollbackCacheReceipt(context, snapshot)).not.toThrow();
    expect(JSON.parse(readFileSync(journal, 'utf8')).container).toBe('c'.repeat(64));
    finishRollbackCache(context);
    expect(existsSync(journal)).toBe(false);
  });

  it('binds a manual rollback to the authenticated source commit before mutation', () => {
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    const snapshot = join(root, 'wrong-code-snapshot');
    runBackup(context, snapshot);
    calls = [];
    expect(() => runRollback(context, snapshot, 'f'.repeat(40))).toThrow(/different code revision/);
    expect(calls).toHaveLength(0);
  });

  it('retains original owned state and cache when staging restored files fails, then retries', () => {
    const context = ctx('gs://fleet/celld', join(root, 'state'));
    const snapshot = join(root, 'retry-state-copy');
    runBackup(context, snapshot);
    writeFileSync(join(context.stateDir, 'retained-until-swap'), 'original');
    const original = fs.cpSync;
    const copy = vi.spyOn(fs, 'cpSync').mockImplementation((source, destination, options) => {
      if (String(destination).includes('.rollback-state-'))
        throw new Error('transient state copy failure');
      return original(source, destination, options);
    });
    calls = [];
    expect(() => runRollback(context, snapshot)).toThrow(/transient state copy failure/);
    copy.mockRestore();
    expect(readFileSync(join(context.stateDir, 'retained-until-swap'), 'utf8')).toBe('original');
    expect(calls.some((call) => call.args[0] === 'container' && call.args[1] === 'rm')).toBe(false);
    expect(() => runRollback(context, snapshot)).not.toThrow();
    expect(existsSync(join(context.stateDir, 'retained-until-swap'))).toBe(false);
  });

  it.each(['bucket', 'volume'] as const)(
    'retries recovery after a transient %s failure',
    (phase) => {
      const context = ctx('gs://fleet/celld', join(root, 'state'));
      const snapshot = join(root, `retry-${phase}`);
      runBackup(context, snapshot);
      writeFileSync(join(root, 'store/fleet/celld/current.json'), 'new data');
      writeFileSync(
        join(context.stateDir, 'upgrade-pending.json'),
        JSON.stringify({ from: 'a'.repeat(40), backupDir: snapshot }),
        { mode: 0o600 }
      );
      let containerRemoved = false;
      let failed = false;
      context.run = (command, args, env) => {
        if (
          command === 'docker' &&
          args[0] === 'compose' &&
          args.includes('ps') &&
          args.includes('-q') &&
          containerRemoved
        )
          return { status: 0, stdout: '', stderr: '' };
        const bucket =
          command === 'gcloud' && args.includes('--delete-unmatched-destination-objects');
        const volume = command === 'docker' && args[0] === 'volume' && args[1] === 'rm';
        if (!failed && ((phase === 'bucket' && bucket) || (phase === 'volume' && volume))) {
          failed = true;
          return { status: 1, stdout: '', stderr: 'transient failure' };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'rm')
          containerRemoved = true;
        return fakeRun(command, args, env);
      };
      expect(() => runRollback(context, snapshot)).toThrow(
        /restore pre-upgrade bucket|remove owned celld cache/
      );
      expect(containerRemoved).toBe(phase === 'volume');
      expect(
        JSON.parse(readFileSync(join(context.stateDir, 'upgrade-pending.json'), 'utf8')).backupDir
      ).toBe(snapshot);
      expect(existsSync(join(context.stateDir, 'platform-keys.json'))).toBe(true);
      expect(() => runRollback(context, snapshot)).not.toThrow();
      expect(failed).toBe(true);
      expect(readFileSync(join(root, 'store/fleet/celld/current.json'), 'utf8')).toBe('{"v":3}');
      expect(existsSync(join(context.stateDir, 'rollback-cache-pending.json'))).toBe(true);
      finishRollbackCache(context);
      expect(existsSync(join(context.stateDir, 'rollback-cache-pending.json'))).toBe(false);
    }
  );

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
    expect(cacheInspections).toBe(5);
    expect(calls.some((call) => call.args.includes('--force'))).toBe(true);
    expect(calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'rm')).toBe(false);
    expect(calls.some((call) => call.command === 'gcloud')).toBe(true);
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
    expect(actualState['rollback-cache-pending.json']).toBeDefined();
    delete actualState['rollback-cache-pending.json'];
    delete actualState['created-resources.json'];
    delete expectedState['created-resources.json'];
    expect(actualState).toEqual(expectedState);
    expect(readFileSync(join(root, 'box.env'), 'utf8')).toBe(`AWS_SECRET_ACCESS_KEY=${SECRET}\n`);
    expect(calls.find((c) => c.command === 'gcloud')?.args).toContain(
      '--delete-unmatched-destination-objects'
    );
    expect(calls.some((c) => c.args.includes('stop'))).toBe(true);
    expect(cacheInspections).toBe(5);
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
