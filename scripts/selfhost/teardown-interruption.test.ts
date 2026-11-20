/** Operator entrypoint fault injection: interruption must retain ownership and allow exact retry. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { encryptBackupTree } from './backup-encryption';
import { CHILD_TEST_TIMEOUT_MS, runTsx } from './deploy-harness';
import { recordBackup, recordInstall, recordPath } from './install-record';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });
let root: string, state: string, env: string, hook: string, bin: string;
const domain = 'interrupt.example.com';
beforeEach(() => {
  for (const name of Object.keys(process.env))
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/teardown-interrupt-'));
  state = join(root, 'state');
  mkdirSync(state);
  env = join(root, 'box.env');
  writeFileSync(env, `SAM_DOMAIN=${domain}\n`, { mode: 0o600 });
  writeFileSync(
    join(state, 'platform-keys.json'),
    JSON.stringify({ SAM_INSTALLATION_ID: 'c'.repeat(32) }),
    { mode: 0o600 }
  );
  recordInstall(state, env, { SAM_DOMAIN: domain }, 'c'.repeat(32));
  bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  chmodSync(join(bin, 'docker'), 0o755);
  hook = join(root, 'fault.mjs');
  writeFileSync(
    hook,
    `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const rename=fs.renameSync, rm=fs.rmSync;
fs.renameSync=function(a,b){
 if(process.env.FAULT==='state-ledger'&&b===process.env.LEDGER&&!fs.existsSync(process.env.KEY)) throw Error('injected ledger failure');
 if(process.env.FAULT==='backup-ledger'&&b===process.env.LEDGER&&!fs.existsSync(process.env.BACKUP)) throw Error('injected ledger failure');
 return rename(a,b);
};
fs.rmSync=function(p,o){
 if(process.env.FAULT==='backup-partial'&&p===process.env.BACKUP){ fs.unlinkSync(p+'/.sam-backup-manifest'); throw Error('injected partial removal'); }
 if(process.env.FAULT==='env'&&p===process.env.ENVFILE) throw Error('injected env failure');
 return rm(p,o);
}; syncBuiltinESMExports();`
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function run(fault = '', extra: string[] = [], backup = '') {
  return runTsx(
    resolve(import.meta.dirname, 'teardown.ts'),
    [
      '--box-env',
      env,
      '--state-dir',
      state,
      '--remove-everything',
      '--destroy-key',
      '--confirm',
      domain,
      ...extra,
    ],
    {
      PATH: `${bin}:${process.env.PATH}`,
      NODE_OPTIONS: `--import=${hook}`,
      FAULT: fault,
      KEY: join(state, 'platform-keys.json'),
      LEDGER: recordPath(state),
      ENVFILE: env,
      BACKUP: backup,
    }
  );
}
it.each(['state-ledger', 'env'])('retries after %s failure after keys are gone', async (fault) => {
  const first = await run(fault);
  expect(first.status, first.out).not.toBe(0);
  expect(existsSync(join(state, 'platform-keys.json'))).toBe(false);
  expect(existsSync(env)).toBe(true);
  if (fault === 'state-ledger') {
    const receipts = readRecord(recordPath(state)).resources.filter((r) =>
      ['state-dir', 'installation'].includes(r.kind)
    );
    expect(receipts.every((r) => !r.removedAt)).toBe(true);
  }
  const retry = await run();
  expect(retry.status, retry.out).toBe(0);
  expect(existsSync(env)).toBe(false);
  expect(
    readRecord(recordPath(state))
      .resources.filter((r) => ['state-dir', 'installation'].includes(r.kind))
      .every((r) => !!r.removedAt)
  ).toBe(true);
});
it.each(['backup-partial', 'backup-ledger', 'backup-replaced'])(
  'resumes %s with durable exact backup proof',
  async (fault) => {
    const source = join(root, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'fixture'), 'fixture');
    const key = join(root, 'key');
    writeFileSync(key, Buffer.alloc(32, 11), { mode: 0o600 });
    const backup = join(root, 'backup');
    encryptBackupTree(source, backup, key);
    recordBackup(state, backup);
    const first = await run(
      fault === 'backup-replaced' ? 'backup-partial' : fault,
      ['--delete-backups'],
      backup
    );
    expect(first.status, first.out).not.toBe(0);
    const receipt = readRecord(recordPath(state)).resources.find((r) => r.kind === 'backup');
    expect(receipt?.removedAt).toBeUndefined();
    expect(receipt?.attributes?.removalAuthorized).toBe(receipt?.attributes?.identity);
    if (fault === 'backup-partial') expect(existsSync(backup)).toBe(true);
    if (fault === 'backup-replaced') {
      renameSync(backup, join(root, 'original-backup'));
      mkdirSync(backup);
      writeFileSync(join(backup, 'foreign'), 'foreign');
      const refused = await run('', ['--delete-backups'], backup);
      expect(refused.status, refused.out).not.toBe(0);
      expect(readFileSync(join(backup, 'foreign'), 'utf8')).toBe('foreign');
      return;
    }
    const retry = await run('', ['--delete-backups'], backup);
    expect(retry.status, retry.out).toBe(0);
    expect(existsSync(backup)).toBe(false);
    expect(
      readRecord(recordPath(state)).resources.find((r) => r.kind === 'backup')?.removedAt
    ).toBeDefined();
    expect(readFileSync(key)).toEqual(Buffer.alloc(32, 11));
  }
);
