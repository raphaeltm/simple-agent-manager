import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveResourceReservation } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { D1_MAX_BOUND_PARAMETERS } from '../../src/lib/d1-limits';
import { externalCapacitySourceCredentialId } from '../../src/services/default-capacity-pool-helpers';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import { NodeAllocationAuthorityChangedError } from '../../src/services/node-allocation-validation';
import { resolvePlacementAdmissionPolicy } from '../../src/services/node-lifetime-admission';
import {
  assertNodeAllocationPlanCurrent,
  assertPinnedNodeAllocationPlanCurrent,
  createNodeRecord,
} from '../../src/services/nodes';
import {
  capacityPlacementSnapshotForTaskStart,
  resolveTaskStartCapacityPoolSelection,
  resolveTaskStartPlacement,
} from '../../src/services/placement-resolver';
import { filterReusableNodesByCurrentAuthority } from '../../src/services/reusable-node-authority';
import { reserveWorkspacePlacement } from '../../src/services/workspace-placement';
import { offering } from '../helpers/capacity-pool-offerings';
import { pickStarterMachines } from '../helpers/capacity-pool-picks';
import { createSqliteD1WithBindLimit } from '../helpers/sqlite-d1';

const VERSION = 1_700_000_000_123;
const TIMESTAMP = new Date(VERSION).toISOString();
const EXTERNAL_REF = 'cc_attachments:attachment-1';
let template: Buffer;
const databases: Database.Database[] = [];

beforeAll(() => {
  const sqlite = new Database(':memory:');
  const directory = join(process.cwd(), 'src/db/migrations');
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(join(directory, file), 'utf8'));
  }
  template = sqlite.serialize();
  sqlite.close();
}, 30_000);

function migratedDatabase(): Database.Database {
  const sqlite = new Database(template);
  databases.push(sqlite);
  return sqlite;
}

afterEach(() => {
  databases.splice(0).forEach((sqlite) => sqlite.close());
});

/** Real reconciliation writes the anchor; real pool editing, selection and node creation pin it. */
async function fixture(
  scope: 'user' | 'project' = 'project',
  kind: 'composable' | 'legacy' | 'platform' = 'composable'
) {
  const sqlite = migratedDatabase();
  const env = { DATABASE: createSqliteD1WithBindLimit(sqlite, D1_MAX_BOUND_PARAMETERS) } as Env;
  const db = drizzle(env.DATABASE, { schema });
  sqlite.exec(`
    INSERT INTO users (id, email, role, status) VALUES
      ('user-1', 'owner@example.com', 'user', 'active'),
      ('user-2', 'foreign@example.com', 'user', 'active');
    INSERT INTO github_installations (id, user_id, installation_id, account_type, account_name)
      VALUES ('installation-1', 'user-1', '123', 'Organization', 'acme');
    INSERT INTO projects (id, user_id, name, normalized_name, installation_id, repository, created_by)
      VALUES ('project-1', 'user-1', 'Anchor', 'anchor', 'installation-1', 'acme/anchor', 'user-1'),
             ('project-2', 'user-2', 'Foreign', 'foreign', 'installation-1', 'acme/foreign', 'user-2');
    INSERT INTO project_members (project_id, user_id, role, status)
      VALUES ('project-1', 'user-1', 'owner', 'active');
  `);
  if (kind === 'composable') {
    await db.insert(schema.ccCredentials).values({
      id: 'credential-1',
      ownerId: 'user-1',
      name: 'Compute',
      kind: 'cloud-provider',
      encryptedToken: 'fixture-ciphertext',
      iv: 'fixture-iv',
      isActive: true,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    await db.insert(schema.ccConfigurations).values({
      id: 'configuration-1',
      ownerId: 'user-1',
      name: 'Compute',
      consumerKind: 'compute',
      consumerTarget: 'hetzner',
      credentialId: 'credential-1',
      isActive: true,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    await db.insert(schema.ccAttachments).values({
      id: 'attachment-1',
      configurationId: 'configuration-1',
      consumerKind: 'compute',
      consumerTarget: 'hetzner',
      userId: 'user-1',
      projectId: scope === 'project' ? 'project-1' : null,
      isActive: true,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
  } else if (kind === 'legacy') {
    await db.insert(schema.credentials).values({
      id: 'legacy-1',
      userId: 'user-1',
      projectId: scope === 'project' ? 'project-1' : null,
      provider: 'hetzner',
      credentialType: 'cloud-provider',
      encryptedToken: 'fixture-ciphertext',
      iv: 'fixture-iv',
      isActive: true,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
  } else {
    await db.insert(schema.platformCredentials).values({
      id: 'platform-1',
      createdBy: 'user-1',
      label: 'Compute',
      provider: 'hetzner',
      credentialType: 'cloud-provider',
      encryptedToken: 'fixture-ciphertext',
      iv: 'fixture-iv',
      isEnabled: true,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
  }
  await ensureDefaultCapacityPoolsForExistingCredentials(db, {
    userId: 'user-1',
    projectId: 'project-1',
    includeInstallation: kind === 'platform',
    offeringResolver: async () => [offering('hetzner', 'fsn1', 'cx23')],
  });
  await pickStarterMachines(db);
  const selection = await resolveTaskStartCapacityPoolSelection(
    db,
    resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'task-1',
      userId: 'user-1',
      projectId: 'project-1',
      project: { id: 'project-1', defaultVmSize: 'small' },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
    }),
    { ensure: false, failOpen: false, env }
  );
  expect(selection?.candidates).toHaveLength(1);
  const snapshot = capacityPlacementSnapshotForTaskStart(selection);
  if (!snapshot) throw new Error('Expected reconciled capacity snapshot');
  const node = await createNodeRecord(env, {
    userId: 'user-1',
    name: 'anchor-node',
    vmSize: 'small',
    vmLocation: 'fsn1',
    cloudProvider: 'hetzner',
    heartbeatStaleAfterSeconds: 180,
    capacityPlacementSnapshot: snapshot,
  });
  return { sqlite, env, snapshot, nodeId: node.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function validate(f: Fixture): Promise<void> {
  await assertNodeAllocationPlanCurrent(f.env, f.nodeId, 'user-1', 'project-1');
}

function makeRunning(f: Fixture): void {
  f.sqlite
    .prepare(
      `UPDATE nodes SET status = 'running', provider_instance_id = 'provider-vm',
    observed_hardware_source = 'observed', observed_provider_instance_vcpu_count = 4,
    observed_provider_instance_memory_mb = 16384, observed_provider_instance_disk_gb = 50
    WHERE id = ?`
    )
    .run(f.nodeId);
}

async function reusable(f: Fixture, count = 1): Promise<Set<string>> {
  return filterReusableNodesByCurrentAuthority(f.env.DATABASE, {
    userId: 'user-1',
    projectId: 'project-1',
    selections: Array.from({ length: count }, () => ({
      nodeId: f.nodeId,
      capacityPlacementSnapshot: f.snapshot,
    })),
  });
}

describe('composable allocation authority after real pool reconciliation (#2843)', () => {
  it.each(['user', 'project'] as const)(
    'accepts the exact secret-free %s anchor and final workspace reservation',
    async (scope) => {
      const f = await fixture(scope);
      expect(
        f.sqlite
          .prepare('SELECT credential_id FROM capacity_sources WHERE id = ?')
          .get(f.snapshot.capacitySourceId)
      ).toEqual({
        credential_id: externalCapacitySourceCredentialId(EXTERNAL_REF, VERSION),
      });
      expect(
        f.sqlite
          .prepare('SELECT credential_type, encrypted_token, iv FROM credentials WHERE id = ?')
          .get(externalCapacitySourceCredentialId(EXTERNAL_REF, VERSION))
      ).toEqual({
        credential_type: 'capacity-source-external-ref',
        encrypted_token: '',
        iv: '',
      });
      await validate(f);
      makeRunning(f);
      // Force reuse to split at the D1 bind ceiling even when snapshots are identical.
      expect(await reusable(f, D1_MAX_BOUND_PARAMETERS + 1)).toEqual(new Set([f.nodeId]));
      const result = await reserveWorkspacePlacement(
        f.env.DATABASE,
        {
          id: 'workspace-1',
          nodeId: f.nodeId,
          projectId: 'project-1',
          userId: 'user-1',
          installationId: 'installation-1',
          name: 'anchor',
          displayName: 'Anchor',
          normalizedDisplayName: 'anchor',
          repository: 'acme/anchor',
          branch: 'main',
          vmSize: 'small',
          vmLocation: 'fsn1',
          workspaceProfile: 'full',
          devcontainerConfigName: null,
          agentProfileHint: null,
          capacityPlacementSnapshot: f.snapshot,
          resolvedReservation: resolveResourceReservation(
            {},
            { projectId: 'project-1', userId: 'user-1' }
          ),
          createdAt: new Date().toISOString(),
        },
        await resolvePlacementAdmissionPolicy(f.env)
      );
      expect(result).toBe(true);
      expect(
        f.sqlite.prepare('SELECT node_id FROM workspaces WHERE id = ?').get('workspace-1')
      ).toEqual({ node_id: f.nodeId });
    }
  );

  const mutations = [
    [
      'unrelated legacy credential anchor',
      "UPDATE capacity_sources SET credential_id = 'unrelated'",
    ],
    ['foreign attachment anchor', 'foreign-anchor'],
    ['stale anchor version', 'stale-anchor'],
    ['rotated credential', `UPDATE cc_credentials SET updated_at = '2024-01-01T00:00:00.000Z'`],
    ['inactive credential', 'UPDATE cc_credentials SET is_active = 0'],
    ['inactive configuration', 'UPDATE cc_configurations SET is_active = 0'],
    ['revoked attachment', 'UPDATE cc_attachments SET is_active = 0'],
    ['detached attachment', 'DELETE FROM cc_attachments'],
    ['unlinked configuration', 'UPDATE cc_configurations SET credential_id = NULL'],
    ['foreign credential owner', "UPDATE cc_credentials SET owner_id = 'user-2'"],
    ['foreign configuration owner', "UPDATE cc_configurations SET owner_id = 'user-2'"],
    ['foreign attachment owner', "UPDATE cc_attachments SET user_id = 'user-2'"],
    ['foreign attachment project', "UPDATE cc_attachments SET project_id = 'project-2'"],
    ['revoked membership', "UPDATE project_members SET status = 'removed'"],
    ['removed membership', `UPDATE project_members SET removed_at = '${TIMESTAMP}'`],
    ['insufficient membership', "UPDATE project_members SET role = 'viewer'"],
    ['foreign source project', "UPDATE capacity_sources SET owner_project_id = 'project-2'"],
    ['foreign pool project', "UPDATE capacity_pools SET owner_project_id = 'project-2'"],
    ['inactive pool', "UPDATE capacity_pools SET status = 'disabled'"],
    ['inactive source', "UPDATE capacity_sources SET status = 'disabled'"],
    [
      'excluded source',
      'UPDATE capacity_pools SET excluded_source_ids_json = (SELECT json_array(id) FROM capacity_sources LIMIT 1)',
    ],
    ['inactive candidate', "UPDATE capacity_pool_candidates SET status = 'disabled'"],
    [
      'unavailable candidate',
      "UPDATE capacity_pool_candidates SET catalog_availability = 'last-known-unavailable'",
    ],
    [
      'source version drift',
      'UPDATE capacity_sources SET credential_version = credential_version + 1',
    ],
    [
      'source generation drift',
      'UPDATE capacity_sources SET authority_generation = authority_generation + 1',
    ],
    [
      'candidate hardware drift',
      'UPDATE capacity_pool_candidates SET provider_instance_memory_mb = 32768',
    ],
    ['configuration provider drift', "UPDATE cc_configurations SET consumer_target = 'vultr'"],
    ['attachment provider drift', "UPDATE cc_attachments SET consumer_target = 'vultr'"],
  ] as const;

  it.each(mutations)('still rejects %s for allocation and reuse', async (_name, mutation) => {
    const f = await fixture();
    // An owner-path control makes each rejection discriminate against a working plan.
    await validate(f);
    makeRunning(f);
    expect(await reusable(f)).toEqual(new Set([f.nodeId]));
    if (mutation.endsWith('-anchor') || mutation.includes('unrelated')) {
      const id =
        mutation === 'foreign-anchor'
          ? externalCapacitySourceCredentialId('cc_attachments:foreign-attachment', VERSION)
          : mutation === 'stale-anchor'
            ? externalCapacitySourceCredentialId(EXTERNAL_REF, VERSION - 1)
            : 'unrelated';
      await drizzle(f.env.DATABASE, { schema }).insert(schema.credentials).values({
        id,
        userId: 'user-2',
        provider: 'hetzner',
        credentialType: 'capacity-source-external-ref',
        encryptedToken: '',
        iv: '',
      });
      f.sqlite.prepare('UPDATE capacity_sources SET credential_id = ?').run(id);
    } else {
      f.sqlite.exec(mutation);
    }
    await expect(validate(f)).rejects.toThrow('Node allocation plan is no longer current');
    expect(await reusable(f)).toEqual(new Set());
  });

  it('keeps allocation revision-fenced while reuse checks current authority', async () => {
    const f = await fixture();
    await validate(f);
    makeRunning(f);
    f.sqlite.exec('UPDATE capacity_pools SET revision = revision + 1');
    await expect(validate(f)).rejects.toThrow('Node allocation plan is no longer current');
    expect(await reusable(f)).toEqual(new Set([f.nodeId]));
    f.sqlite.exec('UPDATE cc_credentials SET is_active = 0');
    expect(await reusable(f)).toEqual(new Set());
  });

  it('preserves the older null-anchor shape without allowing it in the current schema', async () => {
    const f = await fixture();
    await validate(f);
    expect(() => f.sqlite.exec('UPDATE capacity_sources SET credential_id = NULL')).toThrow(
      /CHECK/
    );
    // Only this compatibility control bypasses the shipped CHECK. Every other test uses it.
    f.sqlite.pragma('ignore_check_constraints = ON');
    f.sqlite.exec('UPDATE capacity_sources SET credential_id = NULL');
    f.sqlite.pragma('ignore_check_constraints = OFF');
    await validate(f);
    f.sqlite.exec('UPDATE cc_credentials SET is_active = 0');
    await expect(validate(f)).rejects.toThrow('Node allocation plan is no longer current');
  });

  it.each([
    "UPDATE cc_credentials SET owner_id = 'user-2'; UPDATE cc_configurations SET owner_id = 'user-2'; UPDATE cc_attachments SET user_id = 'user-2'",
    "UPDATE cc_attachments SET project_id = 'project-2'",
    "UPDATE capacity_sources SET owner_user_id = 'user-2'",
    "UPDATE capacity_pools SET owner_user_id = 'user-2'",
  ])('rejects foreign user-scope authority: %s', async (mutation) => {
    const f = await fixture('user');
    await validate(f);
    f.sqlite.exec(mutation);
    await expect(validate(f)).rejects.toThrow('Node allocation plan is no longer current');
    makeRunning(f);
    expect(await reusable(f)).toEqual(new Set());
  });

  it.each(['user', 'project'] as const)(
    'does not grant %s credential authority to the anchor itself',
    async (scope) => {
      const f = await fixture(scope);
      await validate(f);
      const ref = `credentials:${externalCapacitySourceCredentialId(EXTERNAL_REF, VERSION)}`;
      f.sqlite.prepare('UPDATE capacity_sources SET credential_reference = ?').run(ref);
      f.sqlite.prepare('UPDATE nodes SET placement_credential_reference = ?').run(ref);
      await expect(validate(f)).rejects.toThrow('Node allocation plan is no longer current');
    }
  );

  it.each(['legacy', 'platform'] as const)('preserves %s credential controls', async (kind) => {
    const f = await fixture('user', kind);
    await validate(f);
    makeRunning(f);
    expect(await reusable(f)).toEqual(new Set([f.nodeId]));
    f.sqlite.exec(
      kind === 'legacy'
        ? 'UPDATE credentials SET is_active = 0'
        : 'UPDATE platform_credentials SET is_enabled = 0'
    );
    await expect(validate(f)).rejects.toThrow('Node allocation plan is no longer current');
    expect(await reusable(f)).toEqual(new Set());
  });
});

describe('pinned workspace requests refuse authority drift as a designed conflict', () => {
  const EXCLUDE_SOURCE =
    'UPDATE capacity_pools SET excluded_source_ids_json = (SELECT json_array(id) FROM capacity_sources LIMIT 1)';

  it('admits the current plan and answers an excluded source with 409, not a server fault', async () => {
    const f = await fixture();
    // Owner-path control: the same pinned check passes while the source is current.
    await expect(
      assertPinnedNodeAllocationPlanCurrent(f.env, f.nodeId, 'user-1', 'project-1')
    ).resolves.toBeUndefined();
    f.sqlite.exec(EXCLUDE_SOURCE);
    // Background callers keep the same Error subclass and message.
    await expect(validate(f)).rejects.toBeInstanceOf(NodeAllocationAuthorityChangedError);
    await expect(
      assertPinnedNodeAllocationPlanCurrent(f.env, f.nodeId, 'user-1', 'project-1')
    ).rejects.toMatchObject({
      statusCode: 409,
      error: 'CONFLICT',
      message: 'Node allocation plan is no longer current. Choose another node or omit nodeId.',
    });
  });

  it('keeps an unavailable database a server fault', async () => {
    const f = await fixture();
    const error = await assertPinnedNodeAllocationPlanCurrent(
      { ...f.env, DATABASE: undefined } as unknown as Env,
      f.nodeId,
      'user-1',
      'project-1'
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NodeAllocationAuthorityChangedError);
    expect(error).not.toHaveProperty('statusCode');
  });
});
