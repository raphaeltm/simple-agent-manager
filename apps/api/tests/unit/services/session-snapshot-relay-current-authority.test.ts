import { resolveWorkspaceAdmissionPolicy } from '@simple-agent-manager/scheduler-core';
import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  ensureSessionSnapshotUploadRelay,
  findSessionSnapshotUploadRelay,
  verifySessionSnapshotRelayAuthorization,
} from '../../../src/services/session-snapshot-upload-relay';
import { reserveWorkspacePlacement } from '../../../src/services/workspace-placement';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  allocation: vi.fn(),
  createNodeRecord: vi.fn(),
  provisionNode: vi.fn(),
}));
vi.mock('../../../src/services/canonical-vm-allocation', () => ({
  placementProjectDefaultsFromRow: (row: unknown) => row,
  resolveCanonicalVmAllocationPlan: mocks.allocation,
}));
vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: mocks.createNodeRecord,
  provisionNode: mocks.provisionNode,
}));
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: async () => ({ workspace: 'relay', type: 'callback', scope: 'node' }),
}));

const VERSION = 1_700_000_000_000;
const TS = new Date(VERSION).toISOString();
let sqlite: Database.Database;
let env: Env;
let snapshot: CapacityPlacementSnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`
    INSERT INTO users (id,email,name) VALUES ('owner','owner@example.test','Owner');
    INSERT INTO projects (id, user_id, name, normalized_name, repository, default_branch,
      created_at, updated_at) VALUES ('project', 'owner', 'Project', 'project', 'org/repo', 'main',
      '${TS}', '${TS}');
    INSERT INTO project_members (project_id,user_id,role,status,removed_at,created_at,updated_at)
      VALUES ('project','owner','owner','active',NULL,'${TS}','${TS}');
    INSERT INTO credentials (id,user_id,provider,credential_type,is_active,encrypted_token,iv,
      created_at,updated_at)
      VALUES ('credential','owner','hetzner','cloud-provider',1,'enc','iv','${TS}','${TS}');
    INSERT INTO capacity_pools (id,scope,owner_user_id,name,is_default,revision,status,
      configuration_state,strategy,deployment_strategy,exhaustion_policy,migration_state,
      catalog_published_at,created_at,updated_at)
      VALUES ('pool','user','owner','Mine',1,4,'active','configured-ready','balanced',
      'smallest-fit','queue','complete','${TS}','${TS}','${TS}');
    INSERT INTO capacity_sources (id,scope,owner_user_id,source_kind,provider,credential_source,
      credential_id,credential_reference,credential_version,status,authority_generation,
      source_generation,created_at,updated_at)
      VALUES ('source','user','owner','cloud-provider-credential','hetzner','user','credential',
      'credentials:credential',${VERSION},'active',${VERSION},1,'${TS}','${TS}');
    INSERT INTO capacity_pool_candidates (id,pool_id,capacity_source_id,provider,location,
      workload_role,provider_instance_type,provider_instance_vcpu_count,
      provider_instance_memory_mb,provider_instance_disk_gb,catalog_availability,status,
      created_at,updated_at)
      VALUES ('candidate','pool','source','hetzner','fsn1','workspace','cx42',8,16384,240,
      'available','active','${TS}','${TS}');
  `);
  snapshot = {
    capacityPoolId: 'pool',
    capacityPoolScope: 'user',
    capacityPoolRevision: 5,
    capacitySourceId: 'source',
    capacitySourceGeneration: VERSION,
    capacitySourceExternalRef: null,
    capacityPoolCandidateId: 'candidate',
    capacityPoolProjectId: null,
    placementCredentialSource: 'user',
    placementCredentialReference: 'credentials:credential',
    placementCredentialVersion: VERSION,
    workloadRole: 'workspace',
    providerInstanceType: 'cx42',
    providerInstanceVcpuCount: 8,
    providerInstanceMemoryMb: 16384,
    providerInstanceDiskGb: 240,
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    providerInstancePriceDisplay: null,
    providerInstancePriceCurrency: null,
    providerInstancePriceMonthlyCents: null,
    providerInstancePriceHourlyMicros: null,
    placementExplanationJson: null,
  };
  for (const [id, agentVersion] of [
    ['relay', 'current'],
    ['legacy-source', 'legacy'],
  ]) {
    sqlite
      .prepare(
        `INSERT INTO nodes (id,user_id,name,status,runtime,node_class,node_role,
      workload_role,health_status,agent_version,vm_size,vm_location,cloud_provider,
      provider_instance_id,provider_instance_type,capacity_pool_id,capacity_pool_scope,
      capacity_pool_revision,capacity_source_id,capacity_source_generation,
      capacity_pool_candidate_id,placement_credential_source,placement_credential_reference,
      placement_credential_version,created_at,updated_at)
      VALUES (?,'owner',?,'running','vm','managed','workspace','workspace','healthy',?,'large',
      'fsn1','hetzner',?,'cx42','pool','user',4,'source',?,'candidate','user',
      'credentials:credential',?, ?, ?)`
      )
      .run(id, id, agentVersion, 'provider-' + id, VERSION, VERSION, TS, TS);
  }
  sqlite.exec("UPDATE capacity_pools SET revision=5 WHERE id='pool'");
  env = { DATABASE: createSqliteD1(sqlite), VM_AGENT_REQUIRED_VERSION: 'current' } as Env;
  mocks.allocation.mockResolvedValue({
    effectiveProvider: 'hetzner',
    vmSize: 'large',
    vmLocation: 'fsn1',
    providerInstanceType: 'cx42',
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    capacityPlacementSnapshot: snapshot,
  });
});
afterEach(() => sqlite?.close());

type AuthorityPath =
  'legacy user' | 'legacy project' | 'platform' | 'composable user' | 'composable project';
const AUTHORITY_PATHS: AuthorityPath[] = [
  'legacy user',
  'legacy project',
  'platform',
  'composable user',
  'composable project',
];

/** Capture a valid plan, then revoke D1 authority while that plan remains in flight. */
function configureAuthority(path: AuthorityPath): void {
  const projectScoped = path.endsWith('project');
  const scope = path === 'platform' ? 'installation' : projectScoped ? 'project' : 'user';
  const source = path === 'platform' ? 'platform' : projectScoped ? 'project' : 'user';
  sqlite
    .prepare('UPDATE capacity_pools SET scope=?,owner_user_id=?,owner_project_id=?')
    .run(scope, scope === 'user' ? 'owner' : null, projectScoped ? 'project' : null);
  sqlite
    .prepare(
      'UPDATE capacity_sources SET scope=?,owner_user_id=?,owner_project_id=?,credential_source=?'
    )
    .run(scope, scope === 'user' ? 'owner' : null, projectScoped ? 'project' : null, source);
  if (path === 'platform') {
    sqlite
      .prepare(
        `INSERT INTO platform_credentials
      (id,credential_type,provider,label,encrypted_token,iv,is_enabled,created_by,created_at,updated_at)
      VALUES ('platform-credential','cloud-provider','hetzner','Shared compute','enc','iv',1,'owner',?,?)`
      )
      .run(TS, TS);
    sqlite.exec(`UPDATE capacity_sources SET credential_id=NULL,platform_credential_id='platform-credential',
      credential_reference='platform_credentials:platform-credential'`);
    snapshot.placementCredentialReference = 'platform_credentials:platform-credential';
  } else if (path.startsWith('composable')) {
    sqlite
      .prepare(
        `INSERT INTO cc_credentials
      (id,owner_id,name,kind,encrypted_token,iv,is_active,created_at,updated_at)
      VALUES ('cc-credential','owner','Compute','cloud-provider','enc','iv',1,?,?)`
      )
      .run(TS, TS);
    sqlite
      .prepare(
        `INSERT INTO cc_configurations
      (id,owner_id,name,consumer_kind,consumer_target,credential_id,is_active,created_at,updated_at)
      VALUES ('configuration','owner','Compute','compute','hetzner','cc-credential',1,?,?)`
      )
      .run(TS, TS);
    sqlite
      .prepare(
        `INSERT INTO cc_attachments
      (id,configuration_id,consumer_kind,consumer_target,user_id,project_id,is_active,created_at,updated_at)
      VALUES ('attachment','configuration','compute','hetzner','owner',?,1,?,?)`
      )
      .run(projectScoped ? 'project' : null, TS, TS);
    sqlite.exec(`UPDATE capacity_sources SET credential_id=NULL,platform_credential_id=NULL,
      credential_reference='cc_credentials:cc-credential',external_source_ref='cc_attachments:attachment'`);
    snapshot.placementCredentialReference = 'cc_credentials:cc-credential';
    snapshot.capacitySourceExternalRef = 'cc_attachments:attachment';
  } else if (projectScoped) {
    sqlite.exec("UPDATE credentials SET project_id='project'");
  }
  snapshot.capacityPoolScope = scope;
  snapshot.capacityPoolProjectId = projectScoped ? 'project' : null;
  snapshot.placementCredentialSource = source;
  sqlite
    .prepare(
      `UPDATE nodes SET capacity_pool_scope=?,capacity_pool_project_id=?,
    placement_credential_source=?,placement_credential_reference=?,capacity_source_external_ref=?`
    )
    .run(
      scope,
      snapshot.capacityPoolProjectId,
      source,
      snapshot.placementCredentialReference,
      snapshot.capacitySourceExternalRef
    );
  sqlite.exec(`UPDATE nodes SET provider_instance_vcpu_count=8,provider_instance_memory_mb=16384,
    provider_instance_disk_gb=240,observed_hardware_source='observed',
    observed_provider_instance_vcpu_count=8,observed_provider_instance_memory_mb=16384,
    observed_provider_instance_disk_gb=240 WHERE id='relay'`);
}

async function admitWorkspace(id: string): Promise<boolean> {
  return reserveWorkspacePlacement(
    env.DATABASE,
    {
      id,
      nodeId: 'relay',
      projectId: 'project',
      userId: 'owner',
      installationId: 'installation',
      name: id,
      displayName: id,
      normalizedDisplayName: id,
      repository: 'org/repo',
      branch: 'main',
      vmSize: 'large',
      vmLocation: 'fsn1',
      workspaceProfile: 'full',
      devcontainerConfigName: null,
      agentProfileHint: null,
      resourceRequirementsJson: null,
      capacityPlacementSnapshot: snapshot,
      resolvedReservation: {
        cpuMillis: 400,
        memoryMb: 820,
        diskMb: 2048,
        exclusiveNode: false,
        source: 'task',
        sourceId: id,
        version: 3,
      },
      createdAt: TS,
    },
    resolveWorkspaceAdmissionPolicy({})
  );
}

async function assertOwnerPath(): Promise<void> {
  expect(await findSessionSnapshotUploadRelay(env, 'owner', 'project')).toEqual({
    id: 'relay',
    name: 'relay',
  });
  await expect(authorize()).resolves.toBeUndefined();
  expect(await admitWorkspace('owner-control')).toBe(true);
  expect(
    sqlite.prepare("SELECT user_id,node_id FROM workspaces WHERE id='owner-control'").get()
  ).toEqual({ user_id: 'owner', node_id: 'relay' });
  expect(sqlite.prepare("SELECT capacity_pool_revision FROM nodes WHERE id='relay'").get()).toEqual(
    { capacity_pool_revision: 4 }
  );
  sqlite.exec("DELETE FROM workspaces WHERE id='owner-control'");
}

function moveRelayToAnotherOwner(path: AuthorityPath): void {
  sqlite.exec(`INSERT INTO users (id,email,name) VALUES ('other','other@example.test','Other');
    INSERT INTO project_members (project_id,user_id,role,status)
      VALUES ('project','other','owner','active');
    UPDATE nodes SET user_id='other' WHERE id='relay';
    UPDATE capacity_pools SET owner_user_id='other' WHERE scope='user';
    UPDATE capacity_sources SET owner_user_id='other' WHERE scope='user'`);
  if (path === 'legacy user') sqlite.exec("UPDATE credentials SET user_id='other'");
  if (path.startsWith('composable')) {
    sqlite.exec(`UPDATE cc_credentials SET owner_id='other';
      UPDATE cc_configurations SET owner_id='other';
      UPDATE cc_attachments SET user_id='other'`);
  }
}

function credentialTable(path: AuthorityPath): string {
  return path === 'platform'
    ? 'platform_credentials'
    : path.startsWith('composable')
      ? 'cc_credentials'
      : 'credentials';
}

async function authorize() {
  return verifySessionSnapshotRelayAuthorization(
    env,
    'owner',
    'project',
    'relay',
    'Bearer node-token',
    'legacy-source'
  );
}

describe('snapshot relay current authority on real SQLite', () => {
  it('reuses and authorizes an older-revision relay without another paid allocation', async () => {
    expect(await findSessionSnapshotUploadRelay(env, 'owner', 'project')).toEqual({
      id: 'relay',
      name: 'relay',
    });
    await expect(authorize()).resolves.toBeUndefined();
    await ensureSessionSnapshotUploadRelay(env, {
      userId: 'owner',
      projectId: 'project',
      sourceNodeId: 'legacy-source',
    });
    expect(mocks.createNodeRecord).not.toHaveBeenCalled();
    expect(mocks.provisionNode).not.toHaveBeenCalled();
    expect(
      sqlite.prepare("SELECT capacity_pool_revision FROM nodes WHERE id='relay'").get()
    ).toEqual({ capacity_pool_revision: 4 });
  });

  it.each([
    ['revoked credential', 'UPDATE credentials SET is_active=0'],
    ['disabled source', "UPDATE capacity_sources SET status='disabled'"],
    ['removed offering', "UPDATE capacity_pool_candidates SET status='deleted'"],
    ['removed membership', "UPDATE project_members SET status='removed',removed_at='2026-11-14'"],
    ['unconfirmed external VM', "UPDATE nodes SET provider_instance_id=NULL WHERE id='relay'"],
    ['non-running VM', "UPDATE nodes SET status='creating' WHERE id='relay'"],
  ])('refuses an older-revision relay after %s', async (_label, mutation) => {
    sqlite.exec(mutation);
    expect(await findSessionSnapshotUploadRelay(env, 'owner', 'project')).toBeNull();
    await expect(authorize()).rejects.toThrow('Invalid snapshot relay authorization');
  });
});

describe.each(AUTHORITY_PATHS)('existing-node revocations for %s', (path) => {
  beforeEach(() => configureAuthority(path));

  it(
    'admits the current owner through relay and workspace paths across a harmless revision',
    assertOwnerPath
  );

  const revocations: Array<[string, () => void]> = [
    ['cross-user node', () => moveRelayToAnotherOwner(path)],
    [
      'excluded source',
      () => sqlite.exec(`UPDATE capacity_pools SET excluded_source_ids_json='["source"]'`),
    ],
    ['pool no longer default', () => sqlite.exec('UPDATE capacity_pools SET is_default=0')],
    [
      'viewer role',
      () => sqlite.exec("UPDATE project_members SET role='viewer' WHERE user_id='owner'"),
    ],
    [
      'rotated credential',
      () =>
        sqlite.exec(`UPDATE ${credentialTable(path)} SET updated_at='2023-11-14T22:13:21.000Z'`),
    ],
    [
      'deactivated credential',
      () =>
        sqlite.exec(
          `UPDATE ${credentialTable(path)} SET ${path === 'platform' ? 'is_enabled' : 'is_active'}=0`
        ),
    ],
  ];
  if (!path.endsWith('project')) {
    revocations.push([
      'higher-precedence pool',
      () =>
        sqlite.exec(`INSERT INTO capacity_pools
      (id,scope,owner_project_id,name,is_default,status,configuration_state)
      VALUES ('project-pool','project','project','Project pool',1,'active','configured-empty')`),
    ]);
  }
  if (path.startsWith('composable')) {
    revocations.push(
      ['deactivated configuration', () => sqlite.exec('UPDATE cc_configurations SET is_active=0')],
      ['deactivated attachment', () => sqlite.exec('UPDATE cc_attachments SET is_active=0')]
    );
  }
  for (const entryPoint of ['relay discovery', 'relay authorization', 'workspace admission']) {
    it.each(revocations)(
      `rejects %s via ${entryPoint} after an owner-path control`,
      async (_name, revoke) => {
        await assertOwnerPath();
        revoke();
        if (entryPoint === 'relay discovery') {
          expect(await findSessionSnapshotUploadRelay(env, 'owner', 'project')).toBeNull();
        } else if (entryPoint === 'relay authorization') {
          await expect(authorize()).rejects.toThrow('Invalid snapshot relay authorization');
        } else {
          expect(await admitWorkspace('revoked-request')).toBe(false);
        }
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
          count: 0,
        });
      }
    );
  }
});
