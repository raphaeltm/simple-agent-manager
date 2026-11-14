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
