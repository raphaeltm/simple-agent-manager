/** Actual bash interruption after IAM side effects must retain pre-mutation creation proof. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { grantIntent, readRecord } from '../../deploy/selfhost/created-resources.mjs';
import type { TeardownContext } from './teardown-box';
import { bootstrapItems } from './teardown-gcp-bootstrap';
import { execute } from './teardown-model';
const script = resolve(import.meta.dirname, '../../deploy/selfhost/gcp-bootstrap.sh');
const fake = resolve(import.meta.dirname, 'testdata/fake-gcloud-iam.mjs');
const issuer = 'https://api.intent.example.com',
  project = 'sam-vm-test';
const account = `sam-nodes@${project}.iam.gserviceaccount.com`;
let root: string, bin: string, ledger: string, hook: string;
vi.setConfig({ testTimeout: 60_000 });
beforeEach(() => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/bootstrap-intent-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
  ledger = join(root, 'receipts');
  hook = join(root, 'fault.mjs');
  writeFileSync(join(bin, 'gcloud'), `#!/usr/bin/env bash\nexec node '${fake}' "$@"\n`);
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash\nprintf '%s' '{"issuer":"${issuer}","jwks_uri":"${issuer}/.well-known/jwks.json"}'\n`
  );
  chmodSync(join(bin, 'gcloud'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  writeFileSync(
    hook,
    `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const rename=fs.renameSync,sync=fs.fsyncSync;
fs.renameSync=function(a,b){if(process.argv[2]==='add'&&process.argv[5]===process.env.FAULT_KIND&&process.env.FAULT==='receipt')throw Error('Injected final receipt failure');return rename(a,b)};
fs.fsyncSync=function(fd){if(process.argv[2]==='grant-intent'&&process.argv[5]===process.env.FAULT_KIND&&((process.env.FAULT==='file-sync'&&fs.fstatSync(fd).isFile())||(process.env.FAULT==='parent-sync'&&fs.fstatSync(fd).isDirectory())))throw Error('Injected intent sync failure');return sync(fd)};
syncBuiltinESMExports();`
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(extra: NodeJS.ProcessEnv = {}, receipts = true) {
  return spawnSync(
    'bash',
    [
      script,
      '--project',
      project,
      '--api-url',
      issuer,
      ...(receipts ? ['--installation-id', 'a'.repeat(32), '--state-dir', ledger] : []),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STATE: root,
        GCP_BOOTSTRAP_RETRY_SECONDS: '0',
        ...extra,
      },
    }
  );
}
function seed(kind: string, absent = true) {
  expect(run({}, false).status).toBe(0);
  const db = JSON.parse(readFileSync(join(root, 'gcp.json'), 'utf8'));
  if (absent) {
    if (kind === 'iam-binding') db.bindings = [];
    else db.saBindings = {};
  }
  writeFileSync(join(root, 'gcp.json'), JSON.stringify(db));
}
function grant(kind: string) {
  return readRecord(join(ledger, 'created-resources.json')).resources.find((r) => r.kind === kind);
}
function prefix(kind: string) {
  return kind === 'iam-binding'
    ? 'projects add-iam-policy-binding'
    : 'iam service-accounts add-iam-policy-binding';
}
it.each(['iam-binding', 'service-account-iam-binding'])(
  'retains %s after killed grant or failed final receipt and reconciles retries',
  (kind) => {
    for (const fault of ['kill', 'receipt']) {
      if (existsSync(join(root, 'gcp.json'))) {
        rmSync(join(root, 'gcp.json'));
        rmSync(ledger, { recursive: true, force: true });
        rmSync(join(root, 'grant-effect'), { force: true });
      }
      seed(kind);
      const first = run(
        fault === 'kill'
          ? { FAKE_GCLOUD_AFTER_GRANT: prefix(kind), FAKE_GCLOUD_GRANT_FAILURE: 'kill' }
          : { NODE_OPTIONS: `--import=${hook}`, FAULT: fault, FAULT_KIND: kind }
      );
      expect(first.status, first.stderr).not.toBe(0);
      expect(grant(kind)?.action).toBe('created');
      expect(grant(kind)?.attributes?.grantPending).toBe('unconditional-grant/1');
      const retried = run();
      expect(retried.status, retried.stderr).toBe(0);
      expect(grant(kind)?.action).toBe('created');
      expect(grant(kind)?.attributes?.grantPending).toBe('');
    }
  }
);
it.each(['iam-binding', 'service-account-iam-binding'])(
  'persists %s intent before mutation and refuses invalid retry scope',
  (kind) => {
    seed(kind);
    const first = run({ FAKE_GCLOUD_AFTER_GRANT: prefix(kind), FAKE_GCLOUD_GRANT_FAILURE: 'kill' });
    expect(first.status).not.toBe(0);
    const file = join(ledger, 'created-resources.json'),
      original = readFileSync(file, 'utf8');
    for (const field of [
      'identity',
      'installation',
      'project',
      'member',
      'role',
      'condition',
      'grantPending',
    ]) {
      const record = JSON.parse(original);
      record.resources.find((r: { kind: string }) => r.kind === kind).attributes[field] = 'foreign';
      writeFileSync(file, JSON.stringify(record));
      const before = readFileSync(join(root, 'calls'), 'utf8').length;
      const rejected = run();
      expect(rejected.status, rejected.stderr).not.toBe(0);
      expect(readFileSync(join(root, 'calls'), 'utf8').slice(before)).not.toContain(prefix(kind));
    }
    writeFileSync(file, original);
    const db = JSON.parse(readFileSync(join(root, 'gcp.json'), 'utf8'));
    db.accounts[account].uniqueId = 'replacement';
    writeFileSync(join(root, 'gcp.json'), JSON.stringify(db));
    expect(run().status).not.toBe(0);
  }
);
it.each(['file-sync', 'parent-sync'])(
  'failed %s prevents the project mutation; exact retry succeeds',
  (fault) => {
    seed('iam-binding');
    const before = readFileSync(join(root, 'calls'), 'utf8').length;
    const failed = run({
      NODE_OPTIONS: `--import=${hook}`,
      FAULT: fault,
      FAULT_KIND: 'iam-binding',
    });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(join(root, 'calls'), 'utf8').slice(before)).not.toContain(
      prefix('iam-binding')
    );
    expect(run().status).toBe(0);
    expect(grant('iam-binding')?.action).toBe('created');
  }
);
it.each(['iam-binding', 'service-account-iam-binding'])(
  'never adopts a preexisting %s and tolerates a lost success response',
  (kind) => {
    seed(kind, false);
    const result = run({ FAKE_GCLOUD_AFTER_GRANT: prefix(kind) });
    expect(result.status, result.stderr).toBe(0);
    expect(grant(kind)?.action).toBe('reused');
    expect(run().status).toBe(0);
    expect(grant(kind)?.action).toBe('reused');
    const db = JSON.parse(readFileSync(join(root, 'gcp.json'), 'utf8'));
    if (kind === 'iam-binding') db.bindings = [];
    else db.saBindings = {};
    writeFileSync(join(root, 'gcp.json'), JSON.stringify(db));
    expect(run().status).toBe(0);
    expect(grant(kind)?.action).toBe('created'); // A later observed absence permits a fresh owned creation.
  }
);

it('rejects unsupported direct grant actions before persisting an intent', () => {
  const entry = {
    cloud: 'gcp',
    kind: 'iam-binding',
    name: 'grant',
    action: 'invalid',
    createdBy: 'gcp-bootstrap',
    attributes: {
      project,
      install: issuer,
      identity: '123456789',
      pool: 'pool',
      environment: 'selfhost',
      installation: 'a'.repeat(32),
      account,
      member: `serviceAccount:${account}`,
      role: 'roles/compute.securityAdmin',
      condition: 'None',
    },
  };
  expect(() =>
    Reflect.apply(grantIntent, undefined, [join(ledger, 'created-resources.json'), entry])
  ).toThrow(/Incomplete/);
  expect(existsSync(join(ledger, 'created-resources.json'))).toBe(false);
});
it.each(['iam-binding', 'service-account-iam-binding'])(
  'refuses an explicit conditional %s receipt before provider access',
  (kind) => {
    seed(kind);
    expect(run().status).toBe(0);
    const file = join(ledger, 'created-resources.json');
    const record = readRecord(file);
    const receipt = record.resources.find((r) => r.kind === kind)!;
    receipt.attributes = { ...receipt.attributes, condition: 'request.time < timestamp(...)' };
    const provider = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const ctx: TeardownContext = {
      box: {},
      stateDir: ledger,
      envFile: join(root, 'env'),
      composeFiles: [],
      recordFile: file,
      record: record.resources,
      selfhostDir: root,
      domain: 'intent.example.com',
      installationId: 'a'.repeat(32),
      now: Date.now,
      log: () => undefined,
      options: { destroyKey: false, deleteBackups: false, adoptDiscovered: false, gcpProjects: [] },
      run: provider,
    };
    const items = bootstrapItems(ctx, project).filter(
      (item) => item.id === `gcp:${kind}:${receipt.name}`
    );
    expect(execute(items, 'remove-everything', file)[0]?.status).toBe('failed');
    expect(provider).not.toHaveBeenCalled();
  }
);

it.each(['iam-binding', 'service-account-iam-binding'])(
  'teardown settles a durable but absent %s intent without deleting its conditional sibling',
  (kind) => {
    seed(kind);
    const interrupted = run({
      NODE_OPTIONS: `--import=${hook}`,
      FAULT: 'parent-sync',
      FAULT_KIND: kind,
    });
    expect(interrupted.status).not.toBe(0);
    const file = join(ledger, 'created-resources.json');
    const record = readRecord(file),
      receipt = record.resources.find((r) => r.kind === kind)!;
    expect(receipt.attributes?.grantPending).toBe('unconditional-grant/1');
    const provider = vi.fn((_command: string, args: string[]) => ({
      status: 0,
      stderr: '',
      stdout: JSON.stringify(
        args.includes('describe')
          ? { uniqueId: receipt.attributes?.identity }
          : {
              bindings: [
                {
                  role: receipt.attributes?.role,
                  members: [receipt.attributes?.member],
                  condition: { expression: 'true' },
                },
              ],
            }
      ),
    }));
    const ctx: TeardownContext = {
      box: {},
      stateDir: ledger,
      envFile: join(root, 'env'),
      composeFiles: [],
      recordFile: file,
      record: record.resources,
      selfhostDir: root,
      domain: 'intent.example.com',
      installationId: 'a'.repeat(32),
      now: Date.now,
      log: () => undefined,
      options: { destroyKey: false, deleteBackups: false, adoptDiscovered: false, gcpProjects: [] },
      run: provider,
    };
    const items = bootstrapItems(ctx, project).filter(
      (item) => item.id === `gcp:${kind}:${receipt.name}`
    );
    expect(execute(items, 'remove-everything', file)[0]?.status).toBe('removed');
    expect(provider.mock.calls.some(([, args]) => args.includes('remove-iam-policy-binding'))).toBe(
      false
    );
    expect(
      readRecord(file).resources.find((r) => r.name === receipt.name)?.removedAt
    ).toBeDefined();
  }
);
