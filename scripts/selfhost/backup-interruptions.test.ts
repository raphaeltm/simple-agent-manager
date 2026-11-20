/** Backup failure boundaries operate on real files; the runner models only external commands. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { decryptBackupTree } from './backup-encryption';
import { type BoxContext, runBackup } from './backup-lib';
import { removePrivateTree } from './private-tree';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));

let root: string;
let ctx: BoxContext;
let stopped: boolean;
let starts: number;
let pulls: number;
let fail: 'none' | 'stop' | 'copy' | 'start';
let scratch: string;
const SECRET = 'synthetic-backup-interruption-secret';

beforeEach(() => {
  for (const name of Object.keys(process.env))
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  fs.mkdirSync(resolve('.tmp'), { recursive: true });
  root = fs.mkdtempSync(resolve('.tmp/backup-interruption-'));
  const stateDir = join(root, 'state');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.mkdirSync(join(root, 'store'));
  fs.writeFileSync(join(root, 'store', 'data'), 'original data');
  fs.writeFileSync(join(stateDir, 'secrets.env'), SECRET, { mode: 0o600 });
  const envFile = join(root, 'box.env');
  fs.writeFileSync(envFile, 'SAM_DOMAIN=backup.example.com\n', { mode: 0o600 });
  const encryptionKeyFile = join(root, 'backup.key');
  fs.writeFileSync(encryptionKeyFile, randomBytes(32), { mode: 0o600 });
  stopped = false;
  starts = 0;
  pulls = 0;
  scratch = '';
  fail = 'none';
  ctx = {
    box: { CELLD_BUCKET: 'gs://synthetic-bucket/backup', SAM_DOMAIN: 'backup.example.com' },
    envFile,
    stateDir,
    encryptionKeyFile,
    composeFiles: [],
    now: () => Date.now(),
    log: () => {},
    run(command, args) {
      const ok = { status: 0, stdout: '', stderr: '' };
      const bad = { status: 1, stdout: SECRET, stderr: SECRET };
      if (command === 'docker' && args.includes('ps'))
        return { ...ok, stdout: stopped ? '' : 'a'.repeat(64) };
      if (command === 'docker' && args.includes('stop')) {
        stopped = true;
        return fail === 'stop' ? bad : ok;
      }
      if (command === 'docker' && args.includes('start')) {
        starts++;
        stopped = false;
        return fail === 'start' ? bad : ok;
      }
      if (command === 'gcloud' && args[1] === 'rsync') {
        pulls++;
        const destination = args.at(-1)!;
        scratch = dirname(destination);
        if (fail === 'copy' && stopped) return bad;
        fs.cpSync(join(root, 'store'), destination, { recursive: true });
      }
      return ok;
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  if (scratch && fs.existsSync(scratch)) removePrivateTree(scratch);
  removePrivateTree(root);
  vi.unstubAllEnvs();
});

it('restarts the selected writer when stop reports failure after stopping it, then retries fresh', () => {
  fail = 'stop';
  expect(() => runBackup(ctx, join(root, 'failed'))).toThrow('compose stop celld failed');
  expect(stopped).toBe(false);
  expect(starts).toBe(1);
  expect(pulls).toBe(1); // No stopped copy ran after stop failed.
  expect(fs.existsSync(scratch)).toBe(false);
  expect(fs.existsSync(join(root, 'failed'))).toBe(false);
  fail = 'none';
  expect(runBackup(ctx, join(root, 'retry')).objectCount).toBe(1);
});

it.each(['copy', 'start'] as const)(
  'preserves restart and secret-free failure on %s, then retries',
  (boundary) => {
    fail = boundary;
    let message = '';
    try {
      runBackup(ctx, join(root, 'failed'));
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('failed');
    expect(message).not.toContain(SECRET);
    expect(stopped).toBe(false);
    expect(starts).toBe(1);
    expect(fs.existsSync(scratch)).toBe(false);
    fail = 'none';
    expect(runBackup(ctx, join(root, 'retry')).objectCount).toBe(1);
  }
);

it('cleans copied read-only secret directories after success and an encryption error', () => {
  const protectedDir = join(ctx.stateDir, 'private-read-only');
  fs.mkdirSync(protectedDir);
  fs.writeFileSync(join(protectedDir, 'secret'), SECRET, { mode: 0o400 });
  fs.chmodSync(protectedDir, 0o500);
  const first = join(root, 'first');
  runBackup(ctx, first);
  expect(fs.existsSync(scratch)).toBe(false);
  const restored = join(root, 'decrypted');
  decryptBackupTree(first, restored, ctx.encryptionKeyFile!);
  expect(fs.readFileSync(join(restored, 'state', 'private-read-only', 'secret'), 'utf8')).toBe(
    SECRET
  );
  const open = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).startsWith(join(root, 'failed-encryption'))) throw new Error(SECRET);
    return open(...args);
  });
  expect(() => runBackup(ctx, join(root, 'failed-encryption'))).toThrow('Backup encryption failed');
  expect(fs.existsSync(scratch)).toBe(false);
  expect(fs.existsSync(join(root, 'failed-encryption'))).toBe(false);
  expect(stopped).toBe(false);
});

it('never follows scratch symlinks or accepts a symlink root', () => {
  const outside = join(root, 'outside');
  const privateDir = join(root, 'scratch');
  fs.mkdirSync(outside);
  fs.mkdirSync(privateDir);
  fs.writeFileSync(join(outside, 'keep'), 'foreign data');
  fs.chmodSync(outside, 0o500);
  fs.symlinkSync(outside, join(privateDir, 'link'));
  removePrivateTree(privateDir);
  expect(fs.readFileSync(join(outside, 'keep'), 'utf8')).toBe('foreign data');
  expect(fs.statSync(outside).mode & 0o777).toBe(0o500);
  const link = join(root, 'link');
  fs.symlinkSync(outside, link);
  expect(() => removePrivateTree(link)).toThrow('original directory');
  expect(fs.existsSync(outside)).toBe(true);
});
