/** Actual bootstrap must distinguish unconditional project grants from conditional siblings. */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { readRecord } from '../../deploy/selfhost/created-resources.mjs';
import type { TeardownContext } from './teardown-box';
import { bootstrapItems } from './teardown-gcp-bootstrap';
import { execute } from './teardown-model';
const script = resolve(import.meta.dirname, '../../deploy/selfhost/gcp-bootstrap.sh');
const fake = resolve(import.meta.dirname, 'testdata/fake-gcloud-iam.mjs');
const domain = 'grants.example.com',
  issuer = `https://api.${domain}`,
  project = 'sam-vm-test';
const account = `sam-nodes@${project}.iam.gserviceaccount.com`;
const role = 'roles/compute.instanceAdmin.v1',
  member = `serviceAccount:${account}`;
const conditional = {
  role,
  members: [member],
  condition: { title: 'existing', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' },
};
let root: string, bin: string, ledger: string;
beforeEach(() => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/bootstrap-project-grants-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
  ledger = join(root, 'receipts');
  writeFileSync(join(bin, 'gcloud'), `#!/usr/bin/env bash\nexec node '${fake}' "$@"\n`);
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash\nprintf '%s' '{"issuer":"${issuer}","jwks_uri":"${issuer}/.well-known/jwks.json"}'\n`
  );
  chmodSync(join(bin, 'gcloud'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(receipts: boolean, extra: NodeJS.ProcessEnv = {}) {
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
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE: root, ...extra },
    }
  );
}
function seed(conditionalOnly: boolean) {
  expect(run(false).status).toBe(0);
  const db = JSON.parse(readFileSync(join(root, 'gcp.json'), 'utf8'));
  if (conditionalOnly) {
    db.bindings = db.bindings.filter((x: string) => x !== `project:${project} ${role} ${member}`);
    db.projectExtraBindings = [conditional];
  }
  writeFileSync(join(root, 'gcp.json'), JSON.stringify(db));
}
it.each([true, false])(
  'records conditional-only=%s as created, unconditional as reused, and retries without losing proof',
  (conditionalOnly) => {
    seed(conditionalOnly);
    const first = run(true);
    expect(first.status, first.stderr).toBe(0);
    const grant = () =>
      readRecord(join(ledger, 'created-resources.json')).resources.find(
        (r) => r.kind === 'iam-binding' && r.attributes?.role === role
      );
    expect(grant()?.action).toBe(conditionalOnly ? 'created' : 'reused');
    expect(run(true).status).toBe(0);
    expect(grant()?.action).toBe(conditionalOnly ? 'created' : 'reused');
    if (!conditionalOnly) return;
    let present = true,
      removes = 0;
    let invalidPolicy: unknown;
    const ctx: TeardownContext = {
      box: {},
      stateDir: ledger,
      recordFile: join(ledger, 'created-resources.json'),
      record: readRecord(join(ledger, 'created-resources.json')).resources,
      envFile: join(root, 'env'),
      composeFiles: [],
      selfhostDir: root,
      domain,
      installationId: 'a'.repeat(32),
      now: Date.now,
      log: () => undefined,
      options: { destroyKey: false, deleteBackups: false, adoptDiscovered: false, gcpProjects: [] },
      run: (_command, args) => {
        const command = args.join(' '),
          ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
        if (command.startsWith('projects get-iam-policy'))
          return ok(
            invalidPolicy === undefined
              ? { bindings: [conditional, ...(present ? [{ role, members: [member] }] : [])] }
              : invalidPolicy
          );
        if (command.startsWith('projects remove-iam-policy-binding')) {
          expect(args).toContain('--condition=None');
          present = false;
          removes++;
          return ok({});
        }
        if (args.includes('describe'))
          return ok({
            uniqueId: '123456789',
            description: `Creates and deletes SAM workspace VMs and their firewall rules for ${issuer}`,
          });
        if (command.startsWith('iam service-accounts get-iam-policy')) return ok({});
        if (args.includes('list')) return ok([]);
        throw Error('Unexpected provider deletion');
      },
    };
    const item = bootstrapItems(ctx, project).filter(
      (i) => i.record && !Array.isArray(i.record) && i.record.name === grant()?.name
    );
    for (const policy of [
      { bindings: null },
      { bindings: 'bad' },
      ...[null, false, 'bad', []].map((condition) => ({
        bindings: [{ role, members: [member], condition }],
      })),
    ]) {
      invalidPolicy = policy;
      expect(execute(item, 'remove-everything', ctx.recordFile)[0]?.status).toBe('failed');
      expect(removes).toBe(0);
      expect(grant()?.removedAt).toBeUndefined();
    }
    invalidPolicy = undefined;
    expect(execute(item, 'remove-everything', ctx.recordFile)[0]?.status).toBe('removed');
    expect(removes).toBe(1);
    expect(conditional.condition.expression).toContain('request.time');
    // A lost-success receipt retry sees only the foreign conditional sibling: no second remove.
    expect(
      execute([{ ...item[0]!, removedAt: undefined }], 'remove-everything', ctx.recordFile)[0]
        ?.status
    ).toBe('removed');
    expect(removes).toBe(1);
  }
);
it.each([
  'not-json',
  '[]',
  '{"bindings":"bad"}',
  '{"bindings":null}',
  '{"bindings":[null]}',
  '{"bindings":[{"role":"roles/x","members":"bad"}]}',
  '{"bindings":[{"role":"roles/x","members":[],"condition":null}]}',
])('fails closed before project grants for malformed policy %s', (policy) => {
  seed(false);
  const before = readFileSync(join(root, 'calls'), 'utf8').length;
  const result = run(true, { FAKE_GCLOUD_PROJECT_POLICY_RAW: policy });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('cannot parse project IAM policy');
  const calls = readFileSync(join(root, 'calls'), 'utf8').slice(before);
  expect(calls).not.toContain('projects add-iam-policy-binding');
  expect(
    readRecord(join(ledger, 'created-resources.json')).resources.some(
      (r) => r.kind === 'iam-binding'
    )
  ).toBe(false);
});
