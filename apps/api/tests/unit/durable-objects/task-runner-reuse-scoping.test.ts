/**
 * Canonical reusable-node selection scoping, against a REAL SQL engine.
 *
 * These invariants used to live in tests for `services/node-selector.ts`, which
 * had zero production importers — the TaskRunner has selected nodes through
 * `findNodeWithCapacity` / `tryClaimWarmNode` for a long time. Those tests
 * asserted the guards on a dead module through a `.where()`-ignoring mock, so
 * they could not have detected the predicate being removed from the live path
 * (`.claude/rules/28`). They are re-pointed here, at the canonical query, and
 * driven through better-sqlite3 so the WHERE clauses actually execute.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  findNodeWithCapacity,
  nodeSatisfiesTaskResources,
} from '../../../src/durable-objects/task-runner/node-selection';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const REQUIRED_AGENT_VERSION = 'agent-v1';

interface NodeRow {
  id: string;
  userId?: string;
  status?: string;
  healthStatus?: string;
  nodeRole?: string;
  runtime?: string | null;
  vcpu?: number;
  memoryMb?: number;
  diskGb?: number;
  observedHardwareSource?: string | null;
  providerInstanceId?: string | null;
  warmSince?: string | null;
}

function insertNode(sqlite: Database.Database, row: NodeRow): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO nodes (
         id, user_id, name, status, health_status, node_role, node_class, runtime,
         vm_size, vm_location, cloud_provider, agent_version, last_heartbeat_at,
         warm_since, provider_instance_id, provider_instance_type,
         provider_instance_vcpu_count, provider_instance_memory_mb, provider_instance_disk_gb,
         observed_provider_instance_type, observed_provider_instance_vcpu_count,
         observed_provider_instance_memory_mb, observed_provider_instance_disk_gb,
         observed_hardware_source, last_metrics, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, 'managed', ?,
         'large', 'nbg1', 'hetzner', ?, ?,
         ?, ?, 'cx-observed',
         ?, ?, ?,
         'cx-observed', ?,
         ?, ?,
         ?, ?, ?, ?
       )`
    )
    .run(
      row.id,
      row.userId ?? 'user-1',
      `node ${row.id}`,
      row.status ?? 'running',
      row.healthStatus ?? 'healthy',
      row.nodeRole ?? 'workspace',
      row.runtime === undefined ? 'vm' : row.runtime,
      REQUIRED_AGENT_VERSION,
      now,
      row.warmSince ?? null,
      row.providerInstanceId === undefined ? `pi-${row.id}` : row.providerInstanceId,
      row.vcpu ?? 8,
      row.memoryMb ?? 16384,
      row.diskGb ?? 160,
      row.vcpu ?? 8,
      row.memoryMb ?? 16384,
      row.diskGb ?? 160,
      row.observedHardwareSource === undefined ? 'observed' : row.observedHardwareSource,
      JSON.stringify({ cpuLoadAvg1: 0, memoryPercent: 5, diskPercent: 5 }),
      now,
      now
    );
}

function createState(userId = 'user-1'): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId,
    currentStep: 'node_selection',
    stepResults: {
      nodeId: null,
      autoProvisioned: false,
      workspaceId: null,
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: null,
    },
    config: {
      vmSize: 'large',
      vmLocation: 'nbg1',
      projectScaling: null,
      capacityPoolSelection: null,
      credentialAttributionUserId: userId,
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
    },
    retryCount: 0,
    completed: false,
  } as unknown as TaskRunnerState;
}

function createContext(database: D1Database): TaskRunnerContext {
  return {
    env: { DATABASE: database, VM_AGENT_REQUIRED_VERSION: REQUIRED_AGENT_VERSION },
    ctx: { storage: { put: vi.fn(), setAlarm: vi.fn() } },
    assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskRunnerContext;
}

let sqlite: Database.Database;
let database: D1Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`INSERT INTO project_members (project_id, user_id, role, status)
    VALUES ('project-1', 'user-1', 'owner', 'active'), ('project-1', 'user-2', 'owner', 'active')`);
  database = createSqliteD1(sqlite);
});

describe('findNodeWithCapacity scoping (real SQL)', () => {
  it('never selects a node owned by a DIFFERENT user', async () => {
    insertNode(sqlite, { id: 'other-user-node', userId: 'user-2' });

    const result = await findNodeWithCapacity(createState('user-1'), createContext(database));

    expect(result).toBeNull();
  });

  it('owner control: selects the submitter’s own node', async () => {
    // Rule 28: the cross-tenant assertion above is also satisfied by selection
    // being broken outright, so the same fixture must prove the owner succeeds.
    insertNode(sqlite, { id: 'own-node', userId: 'user-1' });

    const result = await findNodeWithCapacity(createState('user-1'), createContext(database));

    expect(result?.nodeId).toBe('own-node');
  });

  it('picks the submitter’s node and ignores another user’s node beside it', async () => {
    insertNode(sqlite, { id: 'foreign-node', userId: 'user-2' });
    insertNode(sqlite, { id: 'own-node', userId: 'user-1' });

    const result = await findNodeWithCapacity(createState('user-1'), createContext(database));

    expect(result?.nodeId).toBe('own-node');
  });

  it('excludes deployment-role nodes', async () => {
    insertNode(sqlite, { id: 'deploy-node', nodeRole: 'deployment' });

    expect(await findNodeWithCapacity(createState(), createContext(database))).toBeNull();
  });

  it('selects the workspace-role node when a deployment node sits beside it', async () => {
    insertNode(sqlite, { id: 'deploy-node', nodeRole: 'deployment' });
    insertNode(sqlite, { id: 'workspace-node', nodeRole: 'workspace' });

    const result = await findNodeWithCapacity(createState(), createContext(database));

    expect(result?.nodeId).toBe('workspace-node');
  });

  it('excludes cf-container runtime nodes from VM reuse', async () => {
    insertNode(sqlite, { id: 'container-node', runtime: 'cf-container' });

    expect(await findNodeWithCapacity(createState(), createContext(database))).toBeNull();
  });

  it('excludes unhealthy and non-running nodes', async () => {
    insertNode(sqlite, { id: 'unhealthy', healthStatus: 'unhealthy' });
    insertNode(sqlite, { id: 'stopped', status: 'stopped' });

    expect(await findNodeWithCapacity(createState(), createContext(database))).toBeNull();
  });

  it('is discriminating: removing the user predicate would admit the foreign node', async () => {
    // Proves the fixture can distinguish the two outcomes at all — the foreign
    // node is otherwise perfectly selectable, so the ONLY reason it loses is the
    // user_id predicate.
    insertNode(sqlite, { id: 'foreign-node', userId: 'user-2' });

    const asOwner = await findNodeWithCapacity(createState('user-2'), createContext(database));
    expect(asOwner?.nodeId).toBe('foreign-node');

    const asStranger = await findNodeWithCapacity(createState('user-1'), createContext(database));
    expect(asStranger).toBeNull();
  });
});

describe('nodeSatisfiesTaskResources fails closed without trusted hardware', () => {
  const state = createState();

  it('admits a node with verified observed capacity', () => {
    expect(
      nodeSatisfiesTaskResources(
        {
          id: 'n',
          vmSize: 'large',
          vmLocation: 'nbg1',
          cloudProvider: 'hetzner',
          capacityPoolId: null,
          capacityPoolScope: null,
          capacitySourceId: null,
          capacityPoolProjectId: null,
          workloadRole: 'workspace',
          nodeClass: 'managed',
          providerInstanceId: 'pi-n',
          observedProviderInstanceType: 'cx-observed',
          observedProviderInstanceVcpuCount: 8,
          observedProviderInstanceMemoryMb: 16384,
          observedProviderInstanceDiskGb: 160,
          observedHardwareSource: 'observed',
        },
        state
      )
    ).toBe(true);
  });

  it('rejects a node whose only evidence is a legacy vm_size label', () => {
    // The removed `canSatisfyVmSize(node.vmSize, config.vmSize)` fallback would
    // have admitted this node on the strength of a stale string.
    expect(
      nodeSatisfiesTaskResources(
        {
          id: 'legacy',
          vmSize: 'large',
          vmLocation: 'nbg1',
          cloudProvider: 'hetzner',
          capacityPoolId: null,
          capacityPoolScope: null,
          capacitySourceId: null,
          capacityPoolProjectId: null,
          workloadRole: 'workspace',
          nodeClass: 'managed',
          providerInstanceId: null,
          observedHardwareSource: null,
        },
        state
      )
    ).toBe(false);
  });

  it('accepts a native instance identity as a pre-heartbeat compatibility estimate', () => {
    expect(
      nodeSatisfiesTaskResources(
        {
          id: 'booting',
          vmSize: 'large',
          vmLocation: 'nbg1',
          cloudProvider: 'hetzner',
          capacityPoolId: null,
          capacityPoolScope: null,
          capacitySourceId: null,
          capacityPoolProjectId: null,
          workloadRole: 'workspace',
          nodeClass: 'managed',
          providerInstanceId: null,
          observedHardwareSource: null,
          providerInstanceType: 'cx41',
          providerInstanceVcpuCount: 8,
          providerInstanceMemoryMb: 16384,
          providerInstanceDiskGb: 160,
        },
        state
      )
    ).toBe(true);
  });
});
