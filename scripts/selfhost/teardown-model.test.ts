/** Stop on the real identity adapter's failed grant before removing its dependent account. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { addResource, readRecord } from '../../deploy/selfhost/created-resources.mjs';
import type { TeardownContext } from './teardown-box';
import { bootstrapItems } from './teardown-gcp-bootstrap';
import { both, execute, type Item, STEPS } from './teardown-model';

let root: string;
beforeEach(() => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(resolve('.tmp/teardown-order-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('preserves provider, pool and account after a failed binding, then completes cleanup on retry', () => {
  const file = join(root, 'created-resources.json');
  const installation = 'a'.repeat(32);
  const issuer = 'https://api.sam.example.com';
  const poolIdentity = 'projects/123/locations/global/workloadIdentityPools/pool';
  const resources = [
    { kind: 'service-account', name: 'acct', identity: 'acct-id' },
    { kind: 'workload-identity-pool', name: 'pool', identity: poolIdentity },
    {
      kind: 'workload-identity-provider',
      name: 'provider',
      identity: `${poolIdentity}/providers/provider`,
    },
    { kind: 'iam-binding', name: 'grant', identity: 'acct-id' },
  ];
  for (const resource of resources)
    addResource(file, {
      cloud: 'gcp',
      kind: resource.kind,
      name: resource.name,
      action: 'created',
      createdBy: 'gcp-bootstrap',
      attributes: {
        identity: resource.identity,
        installation,
        install: issuer,
        project: 'sam-test-proj',
        environment: 'selfhost',
        pool: 'pool',
        account: 'acct',
        member: 'serviceAccount:acct',
        role: 'roles/compute.securityAdmin',
      },
    });
  let failBinding = true;
  const deleted: string[] = [];
  const context: TeardownContext = {
    box: {},
    envFile: join(root, 'box.env'),
    stateDir: root,
    composeFiles: [],
    now: Date.now,
    log: () => undefined,
    selfhostDir: root,
    recordFile: file,
    options: {
      deleteBackups: false,
      destroyKey: false,
      adoptDiscovered: false,
      gcpProjects: ['sam-test-proj'],
    },
    domain: 'sam.example.com',
    installationId: installation,
    record: readRecord(file).resources,
    run: (_command: string, args: string[]) => {
      const cmd = args.join(' ');
      const ok = (value: unknown = {}) => ({
        status: 0,
        stdout: JSON.stringify(value),
        stderr: '',
      });
      if (cmd.startsWith('projects get-iam-policy'))
        return ok({
          bindings: [{ role: 'roles/compute.securityAdmin', members: ['serviceAccount:acct'] }],
        });
      if (cmd.startsWith('projects remove-iam-policy-binding')) {
        if (failBinding) {
          failBinding = false;
          return { status: 1, stdout: '', stderr: 'permission denied' };
        }
        deleted.push('binding');
        return ok();
      }
      if (args.includes('delete')) {
        deleted.push(args[args.indexOf('delete') + 1]!);
        return ok();
      }
      if (cmd.startsWith('iam service-accounts get-iam-policy')) return ok({});
      if (cmd.startsWith('iam service-accounts keys list')) return ok([]);
      if (cmd.startsWith('iam workload-identity-pools providers list')) return ok([]);
      if (cmd.startsWith('iam service-accounts describe'))
        return ok({
          uniqueId: 'acct-id',
          description: `Creates and deletes SAM workspace VMs and their firewall rules for ${issuer}`,
        });
      if (cmd.startsWith('iam workload-identity-pools providers describe'))
        return ok({ name: `${poolIdentity}/providers/provider`, oidc: { issuerUri: issuer } });
      if (cmd.startsWith('iam workload-identity-pools describe'))
        return ok({
          name: poolIdentity,
          description: `Dedicated to the SAM install whose token issuer is ${issuer}`,
        });
      throw new Error('Unexpected test provider command');
    },
  };
  const first = execute(bootstrapItems(context, 'sam-test-proj'), 'remove-everything', file);
  expect(first.map((outcome) => outcome.status)).toEqual([
    'failed',
    'not attempted',
    'not attempted',
    'not attempted',
  ]);
  expect(deleted).toEqual([]);
  expect(readRecord(file).resources.every((resource) => !resource.removedAt)).toBe(true);
  context.record = readRecord(file).resources;
  const retried = execute(bootstrapItems(context, 'sam-test-proj'), 'remove-everything', file);
  expect(retried.every((outcome) => outcome.status === 'removed')).toBe(true);
  expect(deleted).toEqual(['binding', 'provider', 'pool', 'acct']);
  expect(readRecord(file).resources.every((resource) => !!resource.removedAt)).toBe(true);
});

it('settles effects of an already-run failed group without starting another action', () => {
  let actions = 0;
  const item = (id: string): Item => ({
    id,
    place: 'on the box',
    what: id,
    provenance: 'recorded',
    how: 'test boundary',
    step: STEPS.state,
    plan: both({ act: 'remove' }),
  });
  const items: Item[] = [
    {
      ...item('cache'),
      runKey: 'state',
      run: () => {
        actions++;
        throw new Error('cache removal failed');
      },
    },
    { ...item('key'), runKey: 'state', goneDespiteGroupFailure: () => true },
    {
      ...item('later'),
      run: () => {
        actions++;
      },
    },
  ];
  expect(
    execute(items, 'remove-everything', join(root, 'record.json')).map((outcome) => outcome.status)
  ).toEqual(['failed', 'removed', 'not attempted']);
  expect(actions).toBe(1);
});
