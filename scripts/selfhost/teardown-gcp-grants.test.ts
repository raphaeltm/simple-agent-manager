/** Lost IAM responses must settle exact absent grants, without deleting a reused identity. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { addResource, readRecord } from '../../deploy/selfhost/created-resources.mjs';
import type { TeardownContext } from './teardown-box';
import { bootstrapItems } from './teardown-gcp-bootstrap';
import { execute } from './teardown-model';
let root: string;
beforeEach(() => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/teardown-iam-retry-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it.each(['iam-binding', 'service-account-iam-binding'])(
  'settles %s after removal succeeded but its response was lost',
  (kind) => {
    const file = join(root, 'record.json'),
      installation = 'a'.repeat(32),
      domain = 'iam.example.com';
    const identity = 'projects/123/locations/global/workloadIdentityPools/pool';
    const attrs = {
      installation,
      environment: 'selfhost',
      install: `https://api.${domain}`,
      project: 'sam-test',
      pool: 'pool',
    };
    addResource(file, {
      cloud: 'gcp',
      kind: 'workload-identity-pool',
      name: 'pool',
      action: 'created',
      createdBy: 'gcp-bootstrap',
      attributes: { ...attrs, identity },
    });
    const role =
      kind === 'iam-binding' ? 'roles/compute.securityAdmin' : 'roles/iam.workloadIdentityUser';
    const member =
      kind === 'iam-binding'
        ? 'serviceAccount:acct'
        : `principalSet://iam.googleapis.com/${identity}/*`;
    addResource(file, {
      cloud: 'gcp',
      kind,
      name: 'grant',
      action: 'created',
      createdBy: 'gcp-bootstrap',
      attributes: { ...attrs, identity: 'account-immutable-id', account: 'acct', role, member },
    });
    let present = true,
      removals = 0;
    const ctx: TeardownContext = {
      box: {},
      envFile: join(root, 'env'),
      stateDir: root,
      composeFiles: [],
      now: Date.now,
      log: () => undefined,
      selfhostDir: root,
      recordFile: file,
      record: readRecord(file).resources,
      domain,
      installationId: installation,
      options: { deleteBackups: false, destroyKey: false, adoptDiscovered: false, gcpProjects: [] },
      run: (_command, args) => {
        const cmd = args.join(' '),
          ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
        if (args.includes('remove-iam-policy-binding')) {
          present = false;
          removals++;
          return { status: 1, stdout: '', stderr: 'response lost' };
        }
        if (args.includes('get-iam-policy')) {
          const selected =
            kind === 'iam-binding'
              ? cmd.startsWith('projects')
              : cmd.startsWith('iam service-accounts');
          return ok({ bindings: selected && present ? [{ role, members: [member] }] : [] });
        }
        if (args.includes('describe'))
          return ok({
            uniqueId: 'account-immutable-id',
            description: `Creates and deletes SAM workspace VMs and their firewall rules for https://api.${domain}`,
          });
        if (args.includes('list')) return ok([]);
        throw Error('Unexpected destructive provider command');
      },
    };
    const items = () =>
      bootstrapItems({ ...ctx, record: readRecord(file).resources }, 'sam-test').filter(
        (i) => i.id === `gcp:${kind}:grant`
      );
    expect(execute(items(), 'keep-data', file)[0]?.status).toBe('kept');
    expect(removals).toBe(0);
    expect(execute(items(), 'remove-everything', file)[0]?.status).toBe('failed');
    expect(readRecord(file).resources.find((r) => r.kind === kind)?.removedAt).toBeUndefined();
    expect(execute(items(), 'remove-everything', file)[0]?.status).toBe('removed');
    expect(removals).toBe(1);
    expect(
      readRecord(file).resources.find((r) => r.kind === 'workload-identity-pool')?.removedAt
    ).toBeUndefined();
  }
);
