/**
 * Tunnel transport through the two non-direct, non-TaskRunner provisionNode entry points
 * (caller inventory: node-provisioning-caller-inventory.test.ts): deployment environments
 * (`provisionDeploymentNode`) and the session-snapshot upload relay
 * (`ensureSessionSnapshotUploadRelay`). Each is entered through its real exported function on
 * a real SQLite engine with the real provisionNode, tunnel journal and Cloudflare client
 * (stateful fake at the fetch boundary). Mocked: canonical placement, the authority checks and
 * quota (their own suites cover them), plus the shared fixture's provider/cloud-init boundary.
 */
// Register shared boundary mocks before importing production services.
import './node-tunnel-fixture';

import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { provisionDeploymentNode } from '../../../src/services/deployment-provisioning';
import { runNodeTunnelCleanupSweep } from '../../../src/services/node-tunnel-cleanup';
import { ensureSessionSnapshotUploadRelay } from '../../../src/services/session-snapshot-upload-relay';
import { cf, env, journal, mocks as fixtureMocks, sqlite, USER } from './node-tunnel-fixture';

const entry = vi.hoisted(() => ({
  resolveCanonicalVmAllocationPlan: vi.fn(),
  assertDeploymentProvisioningAuthority: vi.fn(),
  assertRelayProvisioningAuthority: vi.fn(),
  cleanupFreshProvisioningNode: vi.fn(),
  markIdle: vi.fn(),
}));
vi.mock('../../../src/services/canonical-vm-allocation', () => ({
  placementProjectDefaultsFromRow: (project: unknown) => project,
  resolveCanonicalVmAllocationPlan: entry.resolveCanonicalVmAllocationPlan,
}));
vi.mock('../../../src/services/provisioning-authority', () => ({
  assertDeploymentProvisioningAuthority: entry.assertDeploymentProvisioningAuthority,
  assertRelayProvisioningAuthority: entry.assertRelayProvisioningAuthority,
  cleanupFreshProvisioningNode: entry.cleanupFreshProvisioningNode,
}));
// Deployment admission (capacity predicates, environment link) has its own SQL suite; here the
// link always succeeds so the test exercises provisioning, not admission.
vi.mock('../../../src/services/deployment-node-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/deployment-node-admission')>()),
  findDeploymentNodeWithCapacity: async () => null,
  linkEnvironmentToNode: async () => true,
}));
vi.mock('../../../src/services/compute-quotas', () => ({
  checkQuotaForUser: async () => ({ allowed: true }),
}));

const PROJECT = 'project-tunnel-1';
const ENVIRONMENT = 'env-tunnel-1';

function allocation(workloadRole: 'deployment' | 'workspace') {
  return {
    placement: {
      workloadRole,
      resolvedReservation: {
        cpuMillis: 250,
        memoryMb: 256,
        diskMb: 1_024,
        exclusiveNode: false,
        source: 'task',
        sourceId: 'environment',
        version: 3,
      },
    },
    credential: { credentialSource: 'user', providerName: 'hetzner' },
    quotaCredentialSource: 'user',
    credentialAttributionUserId: USER,
    credentialAttributionProjectId: null,
    credentialAttributionSource: 'user',
    effectiveProvider: 'hetzner',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    providerInstanceType: 'cx33',
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    capacityPoolSelection: null,
    eligibleCapacityPoolSelection: null,
    capacityPlacementSnapshot: null,
  };
}

/** Insert a row, filling every NOT NULL column without a default with a placeholder. */
function seedRow(db: Database.Database, table: string, values: Record<string, unknown>) {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }>;
  const row: Record<string, unknown> = { ...values };
  for (const column of columns) {
    if (column.name in row || !column.notnull || column.dflt_value !== null) continue;
    row[column.name] = /INT|REAL|NUM/i.test(column.type) ? 0 : `seed-${column.name}`;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names
      .map(() => '?')
      .join(', ')})`
  ).run(...names.map((n) => row[n]));
}

function nodeRow(id: string) {
  return sqlite
    .prepare(
      `SELECT status, node_role AS nodeRole, transport, tunnel_id AS tunnelId,
        ip_address AS ipAddress, backend_dns_record_id AS backendDnsRecordId
       FROM nodes WHERE id = ?`
    )
    .get(id) as Record<string, unknown> | undefined;
}

beforeEach(() => {
  entry.resolveCanonicalVmAllocationPlan.mockReset();
  entry.assertDeploymentProvisioningAuthority.mockResolvedValue(undefined);
  entry.assertRelayProvisioningAuthority.mockResolvedValue(undefined);
  entry.cleanupFreshProvisioningNode.mockResolvedValue('placeholder-deleted');
  entry.markIdle.mockResolvedValue(undefined);
  sqlite.pragma('foreign_keys = OFF');
  seedRow(sqlite, 'users', { id: USER, email: 'tunnel@example.test', status: 'active' });
  seedRow(sqlite, 'projects', {
    id: PROJECT,
    user_id: USER,
    name: 'Tunnel project',
    default_provider: 'hetzner',
    default_location: 'nbg1',
    default_vm_size: 'medium',
  });
  Object.assign(env, {
    NODE_LIFECYCLE: {
      idFromName: (name: string) => name,
      get: () => ({ markIdle: entry.markIdle }),
    },
  });
});

describe('deployment environments provision tunnel nodes through provisionDeploymentNode', () => {
  beforeEach(() => {
    seedRow(sqlite, 'deployment_environments', {
      id: ENVIRONMENT,
      project_id: PROJECT,
      name: 'production',
      status: 'active',
    });
    entry.resolveCanonicalVmAllocationPlan.mockResolvedValue(allocation('deployment'));
  });

  it('creates a deployment node on the tunnel for its agent and keeps its IP for app routes', async () => {
    const result = await provisionDeploymentNode(ENVIRONMENT, PROJECT, USER, env);
    expect(result).not.toBeNull();
    await result!.provisioningPromise;

    const [tunnel] = cf.liveTunnels();
    expect(nodeRow(result!.nodeId)).toMatchObject({
      status: 'running',
      nodeRole: 'deployment',
      transport: 'cloudflare-tunnel',
      tunnelId: tunnel?.id,
      ipAddress: '203.0.113.1',
      backendDnsRecordId: null,
    });
    expect(journal(result!.nodeId)).toMatchObject([{ status: 'active' }]);
    expect(fixtureMocks.cloudInitVars[0]).toMatchObject({
      role: 'deployment',
      environmentId: ENVIRONMENT,
      cloudflareTunnelToken: tunnel?.token,
    });
  });

  it('releases and cleans the tunnel when the deployment node fails before its VM exists', async () => {
    cf.inject('tunnel.configure', { kind: 'status', status: 400, code: 1055 });
    const result = await provisionDeploymentNode(ENVIRONMENT, PROJECT, USER, env);
    await expect(result!.provisioningPromise).rejects.toThrow();
    expect(fixtureMocks.createVM).not.toHaveBeenCalled();
    await runNodeTunnelCleanupSweep(env);
    expect(journal(result!.nodeId)).toMatchObject([{ status: 'cleaned' }]);
    expect(cf.liveTunnels()).toEqual([]);
    expect(cf.records()).toEqual([]);
  });
});

describe('the snapshot upload relay provisions a tunnel node through ensureSessionSnapshotUploadRelay', () => {
  beforeEach(() => {
    Object.assign(env, { VM_AGENT_REQUIRED_VERSION: 'abcdef1234567890' });
    entry.resolveCanonicalVmAllocationPlan.mockResolvedValue(allocation('workspace'));
    seedRow(sqlite, 'nodes', {
      id: 'legacy-source',
      user_id: USER,
      name: 'legacy',
      status: 'running',
      vm_size: 'medium',
      vm_location: 'nbg1',
      cloud_provider: 'hetzner',
      runtime: 'vm',
      node_class: 'managed',
      agent_version: 'legacy-version',
      provider_instance_type: 'cx33',
    });
  });

  it('creates the relay on the tunnel and enrols it in the warm pool', async () => {
    await ensureSessionSnapshotUploadRelay(env, {
      userId: USER,
      sourceNodeId: 'legacy-source',
      projectId: PROJECT,
    });
    const relay = sqlite
      .prepare(`SELECT id FROM nodes WHERE name LIKE 'Session snapshot relay%'`)
      .get() as { id: string };
    expect(nodeRow(relay.id)).toMatchObject({
      status: 'running',
      transport: 'cloudflare-tunnel',
      tunnelId: cf.liveTunnels()[0]?.id,
      backendDnsRecordId: null,
    });
    expect(journal(relay.id)).toMatchObject([{ status: 'active' }]);
    expect(entry.markIdle).toHaveBeenCalledWith(relay.id, USER, null);
  });

  it('releases the relay tunnel when provisioning fails before the VM exists', async () => {
    cf.inject('tunnel.token', { kind: 'status', status: 403, code: 10000 });
    await ensureSessionSnapshotUploadRelay(env, {
      userId: USER,
      sourceNodeId: 'legacy-source',
      projectId: PROJECT,
    });
    const relay = sqlite
      .prepare(`SELECT id FROM nodes WHERE name LIKE 'Session snapshot relay%'`)
      .get() as { id: string } | undefined;
    expect(fixtureMocks.createVM).not.toHaveBeenCalled();
    expect(entry.markIdle).not.toHaveBeenCalled();
    await runNodeTunnelCleanupSweep(env);
    if (relay) expect(journal(relay.id)).toMatchObject([{ status: 'cleaned' }]);
    expect(cf.liveTunnels()).toEqual([]);
  });
});
