import type {
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
} from '@simple-agent-manager/scheduler-core';
import {
  capacityPlacementSnapshotForCandidate,
  DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS,
} from '@simple-agent-manager/scheduler-core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { placeReleaseOnDeploymentNode } from '../../../src/routes/deployment-release-placement';
import { createDeploymentReleaseFromManifest } from '../../../src/routes/deployment-release-submission';
import {
  type DeploymentPlacement,
  findDeploymentNodeWithCapacity,
} from '../../../src/services/deployment-provisioning';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const resolvePlacement = vi.hoisted(() => vi.fn());
const provision = vi.hoisted(() => vi.fn(async () => null));
const teardown = vi.hoisted(() => vi.fn(async () => undefined));
const attach = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../../../src/services/deployment-provisioning', async (original) => ({
  ...(await original<typeof import('../../../src/services/deployment-provisioning')>()),
  provisionDeploymentNode: provision,
  resolveDeploymentPlacement: resolvePlacement,
}));
vi.mock('../../../src/services/node-agent', () => ({
  teardownDeploymentEnvironmentOnNode: teardown,
}));
vi.mock('../../../src/services/deployment-volumes', async (original) => ({
  ...(await original<typeof import('../../../src/services/deployment-volumes')>()),
  attachEnvironmentVolumesToLinkedNode: attach,
}));
const databases: Database.Database[] = [];
const version = Date.parse('2026-11-01T00:00:00.000Z');
function candidate(provider: 'hetzner' | 'gcp'): TaskStartCapacityCandidate {
  return {
    id: provider,
    poolId: 'pool',
    capacitySourceId: provider,
    capacitySourceGeneration: version,
    capacitySourceExternalRef: null,
    provider,
    location: provider === 'hetzner' ? 'fsn1' : 'us-central1-a',
    workloadRole: 'deployment',
    runtime: 'vm',
    machineClass: null,
    machineSize: 'small',
    providerInstanceType: provider === 'hetzner' ? 'cx22' : 'e2-medium',
    providerInstanceVcpuCount: 2,
    providerInstanceMemoryMb: 4096,
    providerInstanceDiskGb: 40,
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    providerInstancePriceDisplay: null,
    providerInstancePriceCurrency: null,
    providerInstancePriceMonthlyCents: null,
    providerInstancePriceHourlyMicros: null,
    priceComparability: 'unknown',
    catalogAvailability: 'available',
    priority: 0,
    candidateOrder: 0,
    credentialAttributionSource: 'user',
    placementCredentialSource: 'user',
    placementCredentialReference: `credentials:${provider}`,
    placementCredentialVersion: version,
    capacityPoolProjectId: null,
  };
}
function fixture(exclusive = false) {
  provision.mockClear();
  teardown.mockClear();
  attach.mockClear();
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createAllSchemaTables(sqlite, schema);
  const env = { DATABASE: createSqliteD1(sqlite) } as Env;
  const db = drizzle(env.DATABASE, { schema });
  const old = candidate('hetzner');
  const top = {
    ...candidate('gcp'),
    credentialAttributionSource: 'platform' as const,
    placementCredentialSource: 'platform' as const,
    placementCredentialReference: 'platform_credentials:gcp',
  };
  const selection: TaskStartCapacityPoolSelection = {
    poolId: 'pool',
    scope: 'user',
    revision: 2,
    strategy: 'balanced',
    exhaustionPolicy: 'queue',
    effectiveState: 'configured-ready',
    selectionSettings: DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS,
    capacityPoolProjectId: null,
    workloadRole: 'deployment',
    poolSnapshot: {} as never,
    candidates: [top, old],
  };
  const reservation = {
    version: 3 as const,
    cpuMillis: 500,
    memoryMb: 512,
    diskMb: 1024,
    exclusiveNode: exclusive,
    source: 'task' as const,
    sourceId: 'environment',
  };
  const placement: DeploymentPlacement = {
    projectId: 'project',
    provider: top.provider,
    location: top.location,
    vmSize: 'small',
    credentialSource: 'platform',
    credentialAttributionUserId: 'user',
    credentialAttributionProjectId: null,
    placementCredentialSource: 'platform',
    placementCredentialReference: top.placementCredentialReference,
    placementCredentialVersion: version,
    providerInstanceType: top.providerInstanceType,
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    capacityPlacementSnapshot: capacityPlacementSnapshotForCandidate(selection, top),
    capacityPoolSelection: selection,
    reservation,
  };
  function insert(table: string, row: Record<string, string | number | null>) {
    const keys = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(row));
  }
  insert('project_members', {
    project_id: 'project',
    user_id: 'user',
    role: 'owner',
    status: 'active',
  });
  insert('capacity_pools', {
    id: 'pool',
    scope: 'user',
    owner_user_id: 'user',
    is_default: 1,
    revision: 2,
    status: 'active',
    configuration_state: 'configured-ready',
  });
  for (const c of [old, top]) {
    if (c.placementCredentialSource === 'platform') {
      insert('platform_credentials', {
        id: c.id,
        provider: c.provider,
        credential_type: 'cloud-provider',
        is_enabled: 1,
        encrypted_token: 'fixture',
        iv: 'fixture',
        updated_at: new Date(version).toISOString(),
      });
    } else {
      insert('credentials', {
        id: c.id,
        user_id: 'user',
        provider: c.provider,
        credential_type: 'cloud-provider',
        is_active: 1,
        encrypted_token: 'fixture',
        iv: 'fixture',
        updated_at: new Date(version).toISOString(),
      });
    }
    insert('capacity_sources', {
      id: c.id,
      scope: 'user',
      owner_user_id: 'user',
      source_kind: 'cloud-provider-credential',
      provider: c.provider,
      credential_source: c.placementCredentialSource,
      credential_id: c.placementCredentialSource === 'user' ? c.id : null,
      platform_credential_id: c.placementCredentialSource === 'platform' ? c.id : null,
      credential_reference: c.placementCredentialReference,
      credential_version: version,
      status: 'active',
      updated_at: new Date(version).toISOString(),
    });
    insert('capacity_pool_candidates', {
      id: c.id,
      pool_id: 'pool',
      capacity_source_id: c.id,
      provider: c.provider,
      location: c.location,
      workload_role: 'deployment',
      provider_instance_type: c.providerInstanceType,
      provider_instance_vcpu_count: 2,
      provider_instance_memory_mb: 4096,
      provider_instance_disk_gb: 40,
      catalog_availability: 'available',
      status: 'active',
    });
  }
  insert('nodes', {
    id: 'node',
    user_id: 'user',
    status: 'running',
    health_status: 'healthy',
    runtime: 'vm',
    node_class: 'managed',
    node_role: 'deployment',
    workload_role: 'deployment',
    node_mode: exclusive ? 'exclusive' : 'shared',
    cloud_provider: 'hetzner',
    vm_location: 'fsn1',
    vm_size: 'small',
    provider_instance_id: 'server',
    provider_instance_type: 'cx22',
    provider_instance_vcpu_count: 2,
    provider_instance_memory_mb: 4096,
    provider_instance_disk_gb: 40,
    observed_hardware_source: 'observed',
    observed_provider_instance_type: 'cx22',
    observed_provider_instance_vcpu_count: 2,
    observed_provider_instance_memory_mb: 4096,
    observed_provider_instance_disk_gb: 40,
    capacity_pool_id: 'pool',
    capacity_pool_scope: 'user',
    capacity_pool_revision: 1,
    capacity_source_id: 'hetzner',
    capacity_source_generation: version,
    capacity_pool_candidate_id: 'hetzner',
    placement_credential_source: 'user',
    placement_credential_reference: 'credentials:hetzner',
    placement_credential_version: version,
  });
  insert('deployment_environments', {
    id: 'environment',
    project_id: 'project',
    status: 'active',
    node_id: 'node',
    provider: 'hetzner',
    location: 'fsn1',
    requires_volumes: exclusive ? 1 : 0,
    resolved_reservation_json: JSON.stringify(reservation),
  });
  insert('deployment_releases', {
    id: 'release',
    environment_id: 'environment',
    version: 2,
    status: 'created',
    manifest: '{}',
    created_by: 'user',
  });
  const place = () =>
    placeReleaseOnDeploymentNode({
      db,
      env,
      envId: 'environment',
      projectId: 'project',
      userId: 'user',
      releaseId: 'release',
      requiresVolumes: exclusive,
      placement,
      reservation,
    });
  return { sqlite, db, env, placement, selection, place };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('linked deployment node pool eligibility through release placement', () => {
  it.each([false, true])(
    'keeps the lower-priority provider after a pool revision change (volumes=%s)',
    async (exclusive) => {
      const f = fixture(exclusive);
      expect(await f.place()).toBe('node');
      expect(provision).not.toHaveBeenCalled();
      expect(teardown).not.toHaveBeenCalled();
      expect(
        f.sqlite.prepare('SELECT node_id, provider, location FROM deployment_environments').get()
      ).toEqual({ node_id: 'node', provider: 'hetzner', location: 'fsn1' });
      if (exclusive) expect(attach).toHaveBeenCalledTimes(1);
      const match = await findDeploymentNodeWithCapacity(f.env, 'user', f.placement, exclusive, {
        nodeId: 'node',
        excludeEnvironmentId: 'environment',
        nodeMode: exclusive ? 'exclusive' : 'shared',
      });
      expect(match?.placement).toMatchObject({
        provider: 'hetzner',
        credentialSource: 'user',
        placementCredentialSource: 'user',
        placementCredentialReference: 'credentials:hetzner',
        capacityPlacementSnapshot: {
          capacityPoolCandidateId: 'hetzner',
          placementCredentialReference: 'credentials:hetzner',
        },
      });
    }
  );
  it('retains an exclusive node through submission when stored volumes are omitted from the manifest', async () => {
    const f = fixture(true);
    f.sqlite.exec(`INSERT INTO deployment_volumes
      (id, environment_id, name, provider_name, location, size_gb, provider_volume_id, status)
      VALUES ('volume', 'environment', 'data', 'hetzner', 'fsn1', 10, 'provider-volume', 'attached')`);
    resolvePlacement.mockImplementation(async (_user, _env, _project, options) => ({
      ...f.placement,
      reservation: options.reservation,
    }));
    const result = await createDeploymentReleaseFromManifest(
      f.db,
      {
        version: 1,
        services: {
          web: {
            image: {
              registry: 'docker.io',
              repository: 'test',
              digest: `sha256:${'a'.repeat(64)}`,
            },
            env: {},
            volumes: [],
          },
        },
        volumes: {},
        routes: [],
      },
      { envId: 'environment', projectId: 'project', userId: 'user', env: f.env }
    );
    expect(result).toMatchObject({ success: true, body: { nodeId: 'node' } });
    expect(resolvePlacement).toHaveBeenCalledWith(
      'user',
      f.env,
      'project',
      expect.objectContaining({
        providerOverride: 'hetzner',
        vmLocationOverride: 'fsn1',
        reservation: expect.objectContaining({ exclusiveNode: true }),
      })
    );
    const row = f.sqlite
      .prepare('SELECT requires_volumes, resolved_reservation_json FROM deployment_environments')
      .get() as {
      requires_volumes: number;
      resolved_reservation_json: string;
    };
    expect(row.requires_volumes).toBe(1);
    expect(JSON.parse(row.resolved_reservation_json)).toMatchObject({ exclusiveNode: true });
    expect(f.sqlite.prepare('SELECT node_mode FROM nodes').get()).toEqual({
      node_mode: 'exclusive',
    });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(provision).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });
  it('does not admit a lower-priority provider for a fresh environment', async () => {
    const f = fixture();
    expect(await findDeploymentNodeWithCapacity(f.env, 'user', f.placement, false)).toBeNull();
  });
  it('refuses a provider removed from the effective pool', async () => {
    const f = fixture(true);
    f.selection.candidates = [candidate('gcp')];
    f.sqlite.exec("UPDATE capacity_pool_candidates SET status = 'disabled' WHERE id = 'hetzner'");
    expect(await f.place()).toBeNull();
    expect(attach).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });
  it('still checks credential authority at the final reservation', async () => {
    const f = fixture(true);
    f.sqlite.exec("UPDATE credentials SET is_active = 0 WHERE id = 'hetzner'");
    expect(await f.place()).toBeNull();
    expect(attach).not.toHaveBeenCalled();
  });
  it('still checks resource capacity', async () => {
    const f = fixture(true);
    f.placement.reservation.memoryMb = 8192;
    expect(await f.place()).toBeNull();
    expect(attach).not.toHaveBeenCalled();
  });
});
