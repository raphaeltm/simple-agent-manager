import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { allocation, healthy } = vi.hoisted(() => ({
  allocation: vi.fn(),
  healthy: vi.fn(async () => true),
}));
// This suite starts at an already resolved plan. The SQL authority predicate,
// observed-capacity admission, and real D1 query execution remain production code.
vi.mock('../../../src/services/canonical-vm-allocation', async (load) => ({
  ...(await load<typeof import('../../../src/services/canonical-vm-allocation')>()),
  resolveCanonicalVmAllocationPlan: allocation,
}));
vi.mock('../../../src/durable-objects/task-runner/node-steps', async (load) => ({
  ...(await load<typeof import('../../../src/durable-objects/task-runner/node-steps')>()),
  verifyNodeAgentHealthy: healthy,
}));

import * as schema from '../../../src/db/schema';
import { handleNodeSelection } from '../../../src/durable-objects/trial-orchestrator/steps';
import type {
  TrialOrchestratorContext,
  TrialOrchestratorState,
} from '../../../src/durable-objects/trial-orchestrator/types';
import type { Env } from '../../../src/env';
import { findSessionSnapshotUploadRelay } from '../../../src/services/session-snapshot-upload-relay';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];

function fixture() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createAllSchemaTables(sqlite, schema);
  const env = {
    DATABASE: createSqliteD1(sqlite),
    VM_AGENT_REQUIRED_VERSION: 'current-agent',
    TRIAL_ANONYMOUS_USER_ID: 'user',
  } as Env;
  allocation.mockResolvedValue({
    effectiveProvider: 'hetzner',
    vmLocation: 'fsn1',
    vmSize: 'small',
    providerInstanceType: 'native-sku',
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    capacityPlacementSnapshot: null,
    placement: {
      resolvedReservation: {
        cpuMillis: 2000,
        memoryMb: 4096,
        diskMb: 40960,
        exclusiveNode: false,
        maxCoTenants: 4,
      },
    },
  });
  sqlite.exec(`
    INSERT INTO projects (id, user_id, name) VALUES ('project', 'user', 'Project');
    INSERT INTO project_members (project_id, user_id, role, status)
      VALUES ('project', 'user', 'maintainer', 'active');
    INSERT INTO nodes
      (id, user_id, name, status, health_status, runtime, node_class, node_role,
       workload_role, cloud_provider, vm_location, vm_size, provider_instance_type,
       provider_instance_id, agent_version, observed_provider_instance_vcpu_count,
       observed_provider_instance_memory_mb, observed_provider_instance_disk_gb,
       observed_hardware_source)
      VALUES ('node', 'user', 'native node', 'running', 'healthy', 'vm', 'managed',
              'workspace', 'workspace', 'hetzner', 'fsn1', 'large', 'native-sku',
              'provider-runtime', 'current-agent', 8, 16384, 100, 'observed');
  `);
  sqlite
    .prepare('UPDATE nodes SET last_heartbeat_at = ?, last_metrics = ?')
    .run(
      new Date().toISOString(),
      JSON.stringify({ version: 1, cpuLoadAvg1: 0, memoryPercent: 10, diskPercent: 10 })
    );
  const state = { trialId: 'trial', projectId: 'project', nodeId: null } as TrialOrchestratorState;
  const advanceToStep = vi.fn(async () => undefined);
  const context = {
    env,
    ctx: { storage: { put: vi.fn(async () => undefined) } },
    advanceToStep,
  } as unknown as TrialOrchestratorContext;
  return { sqlite, env, state, context, advanceToStep };
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
  vi.clearAllMocks();
});

describe('native relay and trial selection', () => {
  it('reuses a relay with the same native plan and a different deprecated label', async () => {
    const { env } = fixture();
    expect(await findSessionSnapshotUploadRelay(env, 'user', 'project')).toEqual({
      id: 'node',
      name: 'native node',
    });
  });

  it('rejects a relay with a matching deprecated label but the wrong native offering', async () => {
    const { sqlite, env } = fixture();
    sqlite.exec("UPDATE nodes SET vm_size = 'small', provider_instance_type = 'wrong-sku'");
    expect(await findSessionSnapshotUploadRelay(env, 'user', 'project')).toBeNull();
  });

  it('reuses sufficient observed trial capacity despite a different deprecated label', async () => {
    const { state, context, advanceToStep } = fixture();
    await handleNodeSelection(state, context);
    expect(state.nodeId).toBe('node');
    expect(advanceToStep).toHaveBeenCalledWith(state, 'workspace_creation');
  });

  it('rejects wrong native trial hardware even when its deprecated label matches', async () => {
    const { sqlite, state, context, advanceToStep } = fixture();
    sqlite.exec("UPDATE nodes SET vm_size = 'small', provider_instance_type = 'wrong-sku'");
    await handleNodeSelection(state, context);
    expect(state.nodeId).toBeNull();
    expect(advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
  });

  it('retains observed capacity admission for the matching native trial offering', async () => {
    const { sqlite, state, context, advanceToStep } = fixture();
    sqlite.exec('UPDATE nodes SET observed_provider_instance_vcpu_count = 1');
    await handleNodeSelection(state, context);
    expect(state.nodeId).toBeNull();
    expect(advanceToStep).toHaveBeenCalledWith(state, 'node_provisioning');
  });
});
