/**
 * The shared placement-authority predicate on Cloudflare's own D1 engine (#2843).
 *
 * D1 caps SQLite expression depth at 100, and SQLite nests an AND chain one level per term.
 * The composable-credential branch pushed the final workspace admission statement to depth 102,
 * so on staging every composable workspace stayed unlinked while its node came up
 * (`Expression tree is too large (maximum depth 100)`). better-sqlite3 allows depth 1000, so the
 * unit suite could not see it; Miniflare's D1 enforces the production limit.
 */
import { resolveResourceReservation } from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import { resolvePlacementAdmissionPolicy } from '../../src/services/node-lifetime-admission';
import { assertNodeAllocationPlanCurrent, createNodeRecord } from '../../src/services/nodes';
import {
  capacityPlacementSnapshotForTaskStart,
  resolveTaskStartCapacityPoolSelection,
  resolveTaskStartPlacement,
} from '../../src/services/placement-resolver';
import { filterReusableNodesByCurrentAuthority } from '../../src/services/reusable-node-authority';
import {
  attachPrecreatedWorkspacePlacement,
  reserveWorkspacePlacement,
  type WorkspacePlacementInput,
} from '../../src/services/workspace-placement';
import { offering } from '../helpers/capacity-pool-offerings';
import { pickStarterMachines } from '../helpers/capacity-pool-picks';

const TIMESTAMP = new Date(1_700_000_000_123).toISOString();
const testEnv = env as unknown as Env;
let sequence = 0;

type Kind = 'composable' | 'legacy' | 'platform';

/** Real reconciliation, pool editing, selection and node creation, as in the unit fixture. */
async function fixture(scope: 'user' | 'project', kind: Kind) {
  sequence += 1;
  const id = (label: string) => `depth-${label}-${Date.now()}-${sequence}`;
  const ids = {
    user: id('user'),
    installation: id('installation'),
    project: id('project'),
    credential: id('credential'),
    configuration: id('configuration'),
  };
  const db = drizzle(testEnv.DATABASE, { schema });
  await testEnv.DATABASE.batch([
    testEnv.DATABASE.prepare(
      `INSERT INTO users (id, email, role, status) VALUES (?, ?, 'user', 'active')`
    ).bind(ids.user, `${ids.user}@example.com`),
    testEnv.DATABASE.prepare(
      `INSERT INTO github_installations (id, user_id, installation_id, account_type, account_name)
       VALUES (?, ?, ?, 'Organization', 'acme')`
    ).bind(ids.installation, ids.user, ids.installation),
    testEnv.DATABASE.prepare(
      `INSERT INTO projects (id, user_id, name, normalized_name, installation_id, repository, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      ids.project,
      ids.user,
      ids.project,
      ids.project,
      ids.installation,
      `acme/${ids.project}`,
      ids.user
    ),
    testEnv.DATABASE.prepare(
      `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')`
    ).bind(ids.project, ids.user),
  ]);
  const secret = {
    encryptedToken: 'fixture-ciphertext',
    iv: 'fixture-iv',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  if (kind === 'composable') {
    await db.insert(schema.ccCredentials).values({
      id: ids.credential,
      ownerId: ids.user,
      name: 'Compute',
      kind: 'cloud-provider',
      isActive: true,
      ...secret,
    });
    await db.insert(schema.ccConfigurations).values({
      id: ids.configuration,
      ownerId: ids.user,
      name: 'Compute',
      consumerKind: 'compute',
      consumerTarget: 'hetzner',
      credentialId: ids.credential,
      isActive: true,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    await db.insert(schema.ccAttachments).values({
      id: id('attachment'),
      configurationId: ids.configuration,
      consumerKind: 'compute',
      consumerTarget: 'hetzner',
      userId: ids.user,
      projectId: scope === 'project' ? ids.project : null,
      isActive: true,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
  } else if (kind === 'legacy') {
    await db.insert(schema.credentials).values({
      id: ids.credential,
      userId: ids.user,
      projectId: scope === 'project' ? ids.project : null,
      provider: 'hetzner',
      credentialType: 'cloud-provider',
      isActive: true,
      ...secret,
    });
  } else {
    await db.insert(schema.platformCredentials).values({
      id: ids.credential,
      createdBy: ids.user,
      label: 'Compute',
      provider: 'hetzner',
      credentialType: 'cloud-provider',
      isEnabled: true,
      ...secret,
    });
  }
  await ensureDefaultCapacityPoolsForExistingCredentials(db, {
    userId: ids.user,
    projectId: ids.project,
    includeInstallation: kind === 'platform',
    offeringResolver: async () => [offering('hetzner', 'fsn1', 'cx23')],
  });
  await pickStarterMachines(db);
  const selection = await resolveTaskStartCapacityPoolSelection(
    db,
    resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: id('task'),
      userId: ids.user,
      projectId: ids.project,
      project: { id: ids.project, defaultVmSize: 'small' },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
    }),
    { ensure: false, failOpen: false, env: testEnv }
  );
  const snapshot = capacityPlacementSnapshotForTaskStart(selection);
  if (!snapshot) throw new Error('Expected reconciled capacity snapshot');
  expect(snapshot.capacityPoolScope).toBe(kind === 'platform' ? 'installation' : scope);
  const node = await createNodeRecord(testEnv, {
    userId: ids.user,
    name: id('node'),
    vmSize: 'small',
    vmLocation: 'fsn1',
    cloudProvider: 'hetzner',
    heartbeatStaleAfterSeconds: 180,
    capacityPlacementSnapshot: snapshot,
  });
  return { ids, snapshot, nodeId: node.id };
}

const cases: Array<[string, 'user' | 'project', Kind]> = [
  ['composable project-scoped', 'project', 'composable'],
  ['composable user-scoped', 'user', 'composable'],
  ['legacy project credential (control)', 'project', 'legacy'],
  ['platform credential (control)', 'project', 'platform'],
];

/** A reconciled node that passed the plan guard, is running, and current authority still reuses. */
async function runningFixture(scope: 'user' | 'project', kind: Kind) {
  const f = await fixture(scope, kind);
  await assertNodeAllocationPlanCurrent(testEnv, f.nodeId, f.ids.user, f.ids.project);
  await testEnv.DATABASE.prepare(
    `UPDATE nodes SET status = 'running', provider_instance_id = 'provider-vm',
       observed_hardware_source = 'observed', observed_provider_instance_vcpu_count = 4,
       observed_provider_instance_memory_mb = 16384, observed_provider_instance_disk_gb = 50
     WHERE id = ?`
  )
    .bind(f.nodeId)
    .run();
  const reusable = await filterReusableNodesByCurrentAuthority(testEnv.DATABASE, {
    userId: f.ids.user,
    projectId: f.ids.project,
    selections: [{ nodeId: f.nodeId, capacityPlacementSnapshot: f.snapshot }],
  });
  expect(reusable).toEqual(new Set([f.nodeId]));
  const placement = (id: string): WorkspacePlacementInput => ({
    id,
    nodeId: f.nodeId,
    projectId: f.ids.project,
    userId: f.ids.user,
    installationId: f.ids.installation,
    name: id,
    displayName: id,
    normalizedDisplayName: id,
    repository: `acme/${f.ids.project}`,
    branch: 'main',
    vmSize: 'small',
    vmLocation: 'fsn1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    agentProfileHint: null,
    capacityPlacementSnapshot: f.snapshot,
    resolvedReservation: resolveResourceReservation(
      {},
      { projectId: f.ids.project, userId: f.ids.user }
    ),
    createdAt: new Date().toISOString(),
  });
  return { ...f, placement, policy: await resolvePlacementAdmissionPolicy(testEnv) };
}

function nodeOf(workspaceId: string) {
  return testEnv.DATABASE.prepare('SELECT node_id FROM workspaces WHERE id = ?')
    .bind(workspaceId)
    .first<{ node_id: string | null }>();
}

describe('placement authority statements stay within D1 expression depth (#2843)', () => {
  // Fresh allocation, the staging failure: POST /api/workspaces stores a node-less placeholder,
  // then the provisioning alarm attaches it once the new node is running.
  it.each(cases)(
    '%s: a fresh node attaches its precreated workspace on D1',
    async (_label, scope, kind) => {
      const f = await runningFixture(scope, kind);
      const placeholder = `depth-placeholder-${f.nodeId}`;
      await testEnv.DATABASE.prepare(
        `INSERT INTO workspaces (id, node_id, project_id, user_id, installation_id, name, display_name,
         normalized_display_name, repository, branch, status, vm_size, vm_location, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'main', 'creating', 'small', 'fsn1', ?, ?)`
      )
        .bind(
          placeholder,
          f.ids.project,
          f.ids.user,
          f.ids.installation,
          placeholder,
          placeholder,
          placeholder,
          `acme/${f.ids.project}`,
          TIMESTAMP,
          TIMESTAMP
        )
        .run();
      expect(await nodeOf(placeholder)).toEqual({ node_id: null });
      expect(
        await attachPrecreatedWorkspacePlacement(
          testEnv.DATABASE,
          f.placement(placeholder),
          f.policy
        )
      ).toBe(true);
      expect(await nodeOf(placeholder)).toEqual({ node_id: f.nodeId });
    }
  );

  it.each(cases)('%s: a reused node admits a new workspace on D1', async (_label, scope, kind) => {
    const f = await runningFixture(scope, kind);
    const workspaceId = `depth-reserved-${f.nodeId}`;
    expect(
      await reserveWorkspacePlacement(testEnv.DATABASE, f.placement(workspaceId), f.policy)
    ).toBe(true);
    expect(await nodeOf(workspaceId)).toEqual({ node_id: f.nodeId });
  });
});
