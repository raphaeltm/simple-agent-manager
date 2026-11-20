/** Real encrypted restore with a filesystem-backed fake GCS; inject each completion boundary. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { encryptBackupTree } from './backup-encryption';
import { type BoxContext, runRestore } from './backup-lib';
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
let root: string, context: BoxContext, snapshot: string;
beforeEach(() => {
  for (const n of Object.keys(process.env))
    if (n === 'CI' || n === 'GITHUB_ACTIONS' || n.startsWith('RUNNER_')) vi.stubEnv(n, undefined);
  fs.mkdirSync(resolve('.tmp'), { recursive: true });
  root = fs.mkdtempSync(resolve('.tmp/restore-complete-'));
  const plain = join(root, 'plain');
  snapshot = join(root, 'snapshot');
  fs.mkdirSync(join(plain, 'state'), { recursive: true });
  fs.mkdirSync(join(plain, 'bucket/data'), { recursive: true });
  fs.mkdirSync(join(root, 'fake'));
  fs.writeFileSync(join(root, 'fake/celld'), 'running');
  fs.writeFileSync(join(root, 'key'), randomBytes(32), { mode: 0o600 });
  fs.writeFileSync(join(root, 'target.env'), 'CELLD_BUCKET=gs://fresh/celld\n', { mode: 0o600 });
  fs.writeFileSync(
    join(plain, 'state/platform-keys.json'),
    JSON.stringify({ SAM_INSTALLATION_ID: 'a'.repeat(32), ENCRYPTION_KEY: 'retained' }),
    { mode: 0o600 }
  );
  fs.writeFileSync(join(plain, 'bucket/data/value'), 'actual bytes');
  fs.writeFileSync(
    join(plain, 'backup-manifest.json'),
    JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      bucket: 'gs://source/celld',
      samCommit: null,
      precopyMs: 0,
      downtimeMs: 0,
      deltaCopyMs: 0,
      objectCount: 1,
    })
  );
  encryptBackupTree(plain, snapshot, join(root, 'key'));
  context = {
    box: { CELLD_BUCKET: 'gs://fresh/celld' },
    stateDir: join(root, 'state'),
    envFile: join(root, 'target.env'),
    encryptionKeyFile: join(root, 'key'),
    composeFiles: [],
    now: Date.now,
    log: () => {},
    run: (command, args) => {
      if (command === 'docker') return { status: 0, stdout: '', stderr: '' };
      const r = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, 'testdata/fake-gcloud.mjs'), ...args],
        {
          env: {
            ...process.env,
            FAKE_STATE: join(root, 'fake'),
            FAKE_GCS_ROOT: join(root, 'store'),
          },
          encoding: 'utf8',
        }
      );
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it.each(['write', 'file-sync', 'parent-sync'] as const)(
  'retries initial journal %s failure only after reestablishing durability before target writes',
  (boundary) => {
    const progress = `${context.stateDir}.restore-progress.json`;
    let failed = false;
    const originalWrite = fs.writeSync,
      originalSync = fs.fsyncSync;
    vi.spyOn(fs, 'writeSync').mockImplementation((...args: Parameters<typeof fs.writeSync>) => {
      if (!failed && boundary === 'write' && fs.existsSync(progress)) {
        failed = true;
        originalWrite(args[0], Buffer.from('partial'));
        throw Error('Injected initial journal write');
      }
      return Reflect.apply(originalWrite, fs, args);
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (
        !failed &&
        fs.existsSync(progress) &&
        (fs.fstatSync(fd).isDirectory() ? boundary === 'parent-sync' : boundary === 'file-sync')
      ) {
        failed = true;
        throw Error('Injected initial journal sync');
      }
      return originalSync(fd);
    });
    expect(() => runRestore(context, snapshot)).toThrow(/Injected initial journal/);
    expect(failed).toBe(true);
    expect(fs.existsSync(context.stateDir)).toBe(false);
    expect(fs.existsSync(join(root, 'store/fresh/celld/data/value'))).toBe(false);
    vi.restoreAllMocks();
    let fileSynced = false,
      parentSynced = false;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (fs.existsSync(progress)) {
        if (fs.fstatSync(fd).isDirectory()) parentSynced = true;
        else fileSynced = true;
      }
      return originalSync(fd);
    });
    const originalRun = context.run;
    context.run = (command, args, env) => {
      if (command === 'gcloud' && args[1] === 'rsync' && !args.at(-2)?.startsWith('gs://')) {
        expect(fileSynced).toBe(true);
        expect(parentSynced).toBe(true);
      }
      return originalRun(command, args, env);
    };
    runRestore(context, snapshot);
    expect(fs.readFileSync(join(root, 'store/fresh/celld/data/value'), 'utf8')).toBe(
      'actual bytes'
    );
  }
);
it.each(['link', 'before-unlink-fsync', 'unlink', 'after-unlink-fsync'] as const)(
  'retries safely after actual completion %s boundary failure',
  (boundary) => {
    const progress = `${context.stateDir}.restore-progress.json`,
      complete = `${context.stateDir}.restore-complete.json`;
    let failed = false;
    const originalLink = fs.linkSync,
      originalRm = fs.rmSync,
      originalSync = fs.fsyncSync;
    vi.spyOn(fs, 'linkSync').mockImplementation((a, b) => {
      if (!failed && boundary === 'link' && String(b) === complete) {
        failed = true;
        throw Error('Injected link failure');
      }
      return originalLink(a, b);
    });
    vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
      if (!failed && boundary === 'unlink' && String(p) === progress) {
        failed = true;
        throw Error('Injected unlink failure');
      }
      return originalRm(p, o);
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (
        !failed &&
        fs.fstatSync(fd).isDirectory() &&
        fs.existsSync(complete) &&
        ((boundary === 'before-unlink-fsync' && fs.existsSync(progress)) ||
          (boundary === 'after-unlink-fsync' && !fs.existsSync(progress)))
      ) {
        failed = true;
        throw Error('Injected parent sync failure');
      }
      return originalSync(fd);
    });
    expect(() => runRestore(context, snapshot)).toThrow(/Injected/);
    expect(failed).toBe(true);
    expect(fs.readFileSync(join(root, 'store/fresh/celld/data/value'), 'utf8')).toBe(
      'actual bytes'
    );
    expect(fs.existsSync(progress) || fs.existsSync(complete)).toBe(true);
    vi.restoreAllMocks();
    runRestore(context, snapshot);
    expect(fs.existsSync(progress)).toBe(false);
    expect(fs.existsSync(complete)).toBe(true);
    expect(fs.readFileSync(join(root, 'store/fresh/celld/data/value'), 'utf8')).toBe(
      'actual bytes'
    );
    runRestore(context, snapshot); // a completed retry is idempotent while target output is unchanged
  }
);
it('completed ownership never permits changed output, a different target, or a running application', () => {
  runRestore(context, snapshot);
  fs.writeFileSync(join(root, 'store/fresh/celld/data/value'), 'foreign changed bytes');
  expect(() => runRestore(context, snapshot)).toThrow(/changed or unsafe/);
  expect(fs.readFileSync(join(root, 'store/fresh/celld/data/value'), 'utf8')).toBe(
    'foreign changed bytes'
  );
  expect(() =>
    runRestore({ ...context, box: { CELLD_BUCKET: 'gs://other/celld' } }, snapshot)
  ).toThrow(/Cannot verify restore retry ownership/);
  expect(() =>
    runRestore(
      {
        ...context,
        run: (cmd, args, env) =>
          cmd === 'docker'
            ? { status: 0, stdout: 'c'.repeat(64), stderr: '' }
            : context.run(cmd, args, env),
      },
      snapshot
    )
  ).toThrow(/already has containers/);
});

it.each([0, 7, -1])(
  'recovers actual torn state output of %s bytes only when it matches the authenticated prefix',
  (length) => {
    const copy = fs.cpSync;
    let failed = false;
    vi.spyOn(fs, 'cpSync').mockImplementation((source, destination, options) => {
      if (!failed && String(destination) === context.stateDir) {
        failed = true;
        fs.mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
        const sourceBytes = fs.readFileSync(join(String(source), 'platform-keys.json'));
        fs.writeFileSync(
          join(context.stateDir, 'platform-keys.json'),
          length < 0 ? 'foreign-prefix' : sourceBytes.subarray(0, length),
          { mode: 0o600 }
        );
        throw Error('Injected partial state copy');
      }
      return copy(source, destination, options);
    });
    expect(() => runRestore(context, snapshot)).toThrow('Injected partial state copy');
    vi.restoreAllMocks();
    if (length < 0) {
      expect(() => runRestore(context, snapshot)).toThrow(/changed or unsafe/);
      expect(fs.readFileSync(join(context.stateDir, 'platform-keys.json'), 'utf8')).toBe(
        'foreign-prefix'
      );
    } else {
      runRestore(context, snapshot);
      const keys = JSON.parse(
        fs.readFileSync(join(context.stateDir, 'platform-keys.json'), 'utf8')
      );
      expect(keys.ENCRYPTION_KEY).toBe('retained');
      expect(keys.SAM_INSTALLATION_ID).not.toBe('a'.repeat(32));
      expect(fs.existsSync(`${context.stateDir}.restore-complete.json`)).toBe(true);
    }
  }
);
