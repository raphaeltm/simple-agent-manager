/** Real CLI retry after retaining keys, and exact encrypted-backup receipt deletion boundaries. */
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

import { markRemoved, readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { encryptBackupTree } from './backup-encryption';
import { CHILD_TEST_TIMEOUT_MS, runTsx } from './deploy-harness';
import { recordBackup, recordInstall, recordPath } from './install-record';
import { boxItems, type TeardownContext } from './teardown-box';
import { execute } from './teardown-model';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });
const DOMAIN = 'retry.example.com';
const INSTALLATION = 'a'.repeat(32);
let root: string, state: string, envFile: string;
beforeEach(() => {
  for (const name of Object.keys(process.env))
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/teardown-retry-'));
  state = join(root, 'state');
  mkdirSync(state);
  envFile = join(root, 'box.env');
  writeFileSync(envFile, `SAM_DOMAIN=${DOMAIN}\n`, { mode: 0o600 });
  writeFileSync(
    join(state, 'platform-keys.json'),
    JSON.stringify({ SAM_INSTALLATION_ID: INSTALLATION }),
    { mode: 0o600 }
  );
  recordInstall(state, envFile, { SAM_DOMAIN: DOMAIN }, INSTALLATION);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('retains active ownership with kept keys, then completes --destroy-key through the real CLI', async () => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const docker = join(bin, 'docker');
  writeFileSync(docker, '#!/usr/bin/env node\nprocess.exit(0);\n');
  chmodSync(docker, 0o755);
  const args = [
    '--box-env',
    envFile,
    '--state-dir',
    state,
    '--remove-everything',
    '--confirm',
    DOMAIN,
  ];
  writeFileSync(join(state, 'payload'), 'owned payload');
  const first = await runTsx(resolve(import.meta.dirname, 'teardown.ts'), args, {
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(first.status, first.out).toBe(0);
  expect(existsSync(envFile)).toBe(false);
  expect(existsSync(join(state, 'platform-keys.json'))).toBe(true);
  expect(existsSync(join(state, 'payload'))).toBe(false);
  const ownership = readRecord(recordPath(state)).resources.filter((r) =>
    ['state-dir', 'installation'].includes(r.kind)
  );
  expect(ownership).toHaveLength(2);
  expect(ownership.every((r) => !r.removedAt)).toBe(true);
  const second = await runTsx(
    resolve(import.meta.dirname, 'teardown.ts'),
    [...args, '--destroy-key'],
    { PATH: `${bin}:${process.env.PATH}` }
  );
  expect(second.status, second.out).toBe(0);
  expect(existsSync(join(state, 'platform-keys.json'))).toBe(false);
  expect(
    readRecord(recordPath(state))
      .resources.filter((r) => ['state-dir', 'installation'].includes(r.kind))
      .every((r) => !!r.removedAt)
  ).toBe(true);
});

function context(): TeardownContext {
  return {
    box: { SAM_DOMAIN: DOMAIN },
    envFile,
    stateDir: state,
    composeFiles: [],
    now: Date.now,
    log: () => undefined,
    domain: DOMAIN,
    installationId: INSTALLATION,
    record: readRecord(recordPath(state)).resources,
    recordFile: recordPath(state),
    selfhostDir: join(root, 'checkout/deploy/selfhost'),
    options: { deleteBackups: true, destroyKey: false, adoptDiscovered: false, gcpProjects: [] },
    run: () => ({ status: 0, stdout: '', stderr: '' }),
  };
}
function backup(): string {
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'fixture'), 'private fixture', { mode: 0o600 });
  const key = join(root, 'backup.key');
  writeFileSync(key, Buffer.alloc(32, 17), { mode: 0o600 });
  const destination = join(root, 'backup');
  encryptBackupTree(source, destination, key);
  recordBackup(state, destination);
  return destination;
}
function backupItem() {
  return boxItems(context()).filter((item) => item.id.startsWith('box:backup:'));
}

it('removes an active exact recorded backup and tombstones its receipt', () => {
  const path = backup();
  expect(execute(backupItem(), 'remove-everything', recordPath(state))[0]?.status).toBe('removed');
  expect(existsSync(path)).toBe(false);
  expect(
    readRecord(recordPath(state)).resources.find((r) => r.kind === 'backup')?.removedAt
  ).toBeDefined();
});
it.each(['removed-receipt', 'replaced-directory', 'changed-inventory', 'legacy-receipt'])(
  'preserves %s backup paths before deletion',
  (defect) => {
    const path = backup();
    if (defect === 'removed-receipt') markRemoved(recordPath(state), 'box', 'backup', path);
    if (defect === 'replaced-directory' || defect === 'removed-receipt') {
      renameSync(path, join(root, 'original-backup'));
      encryptBackupTree(join(root, 'source'), path, join(root, 'backup.key'));
    }
    if (defect === 'changed-inventory')
      writeFileSync(
        join(path, '.sam-backup-manifest'),
        Buffer.concat([Buffer.from('SAMBAK01'), Buffer.alloc(64)])
      );
    if (defect === 'legacy-receipt') {
      const record = JSON.parse(readFileSync(recordPath(state), 'utf8'));
      record.resources.find((r: { kind: string }) => r.kind === 'backup').attributes = {};
      writeFileSync(recordPath(state), JSON.stringify(record));
    }
    expect(execute(backupItem(), 'remove-everything', recordPath(state))[0]?.status).toBe(
      'refused'
    );
    expect(existsSync(path)).toBe(true);
  }
);
it.each(['removed-receipt', 'replaced-directory', 'changed-inventory'])(
  'revalidates %s immediately before deleting an already-inventoried backup',
  (defect) => {
    const path = backup();
    const items = backupItem();
    if (defect === 'removed-receipt') markRemoved(recordPath(state), 'box', 'backup', path);
    if (defect === 'replaced-directory' || defect === 'removed-receipt') {
      renameSync(path, join(root, 'original-backup'));
      encryptBackupTree(join(root, 'source'), path, join(root, 'backup.key'));
    }
    if (defect === 'changed-inventory')
      writeFileSync(
        join(path, '.sam-backup-manifest'),
        Buffer.concat([Buffer.from('SAMBAK01'), Buffer.alloc(64)])
      );
    expect(execute(items, 'remove-everything', recordPath(state))[0]?.status).toBe('failed');
    expect(existsSync(path)).toBe(true);
  }
);

it('keeps unproved backups when deletion was not requested', () => {
  const path = backup();
  markRemoved(recordPath(state), 'box', 'backup', path);
  expect(execute(backupItem(), 'keep-data', recordPath(state))[0]?.status).toBe('kept');
  const ctx = context();
  ctx.options.deleteBackups = false;
  const items = boxItems(ctx).filter((item) => item.id.startsWith('box:backup:'));
  expect(execute(items, 'remove-everything', recordPath(state))[0]?.status).toBe('kept');
  expect(existsSync(path)).toBe(true);
});
