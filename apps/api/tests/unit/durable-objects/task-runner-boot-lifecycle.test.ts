/** Real D1 recovery, strict deletion, provisioning and readiness; only external services are stubbed. */
import { observedHardware } from '@simple-agent-manager/providers';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { handleNodeAgentReady } from '../../../src/durable-objects/task-runner/node-agent-ready-step';
import { handleNodeProvisioning } from '../../../src/durable-objects/task-runner/node-provisioning-step';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import type { Env } from '../../../src/env';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const external = vi.hoisted(() => ({
  createVM: vi.fn(),
  deleteVM: vi.fn(),
  order: [] as string[],
}));
vi.mock('../../../src/services/provider-credentials', async (original) => ({
  ...(await original<typeof import('../../../src/services/provider-credentials')>()),
  createProviderForUser: vi.fn(async () => ({
    providerName: 'hetzner',
    credentialSource: 'user',
    exactCredentialBinding: {
      credentialSource: 'user',
      credentialReference: 'credential',
      credentialVersion: 1,
      credentialFingerprint: 'fingerprint',
    },
    provider: { createVM: external.createVM, deleteVM: external.deleteVM },
  })),
}));
vi.mock('../../../src/services/jwt', async (original) => ({
  ...(await original<typeof import('../../../src/services/jwt')>()),
  signNodeCallbackToken: vi.fn(async () => 'node-callback'),
}));
vi.mock('../../../src/services/dns', () => ({
  createNodeBackendDNSRecord: vi.fn(async () => 'dns-new'),
  deleteDNSRecord: vi.fn(),
}));
let sqlite: Database.Database;
afterEach(() => {
  sqlite?.close();
  vi.clearAllMocks();
  external.order.length = 0;
});
it('confirms old provider deletion before allocating one replacement that becomes ready', async () => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`
    INSERT INTO users (id,email,status) VALUES ('user','user@example.test','active');
    INSERT INTO projects (id,user_id,name) VALUES ('project','user','Project');
    INSERT INTO project_members (project_id,user_id,role,status) VALUES ('project','user','owner','active');
    INSERT INTO tasks (id,project_id,user_id,title,status,auto_provisioned_node_id) VALUES ('task','project','user','Boot','delegated','old');
    INSERT INTO vm_provisioning_leases (scope_key,owner_task_id,fencing_token,expires_at) VALUES ('scope','task',1,'2099-01-01T00:00:00Z');
    INSERT INTO nodes (id,user_id,name,status,health_status,node_class,node_role,runtime,cloud_provider,provider_instance_id,
      placement_credential_source,placement_credential_reference,placement_credential_version,placement_credential_fingerprint)
      VALUES ('old','user','Old','running','unhealthy','managed','workspace','vm','hetzner','123','user','credential',1,'fingerprint');
  `);
  external.deleteVM.mockImplementation(async (id: string) => {
    expect(id).toBe('123');
    external.order.push('delete');
  });
  external.createVM.mockImplementation(async () => {
    external.order.push('create');
    expect(
      sqlite
        .prepare("SELECT status, runtime_termination_confirmed_at FROM nodes WHERE id = 'old'")
        .get()
    ).toMatchObject({ status: 'deleted', runtime_termination_confirmed_at: expect.any(String) });
    return {
      id: '456',
      ip: '203.0.113.4',
      status: 'running',
      observedHardware: observedHardware({
        serverType: 'cx23',
        resources: { vcpuCount: 2, memoryMb: 4096, diskGb: 40 },
      }),
      serverType: 'cx23',
      location: 'hel1',
      createdAt: new Date().toISOString(),
      labels: {},
    };
  });
  const env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'example.test',
    ENVIRONMENT: 'test',
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    VM_ADMISSION_CONTROL_MODE: 'off',
    COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
    VM_AGENT_REQUIRED_VERSION: 'a'.repeat(40),
    MAX_NODES_PER_USER: '10',
    KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env;
  let saved: TaskRunnerState | undefined;
  const rc = {
    env,
    ctx: {
      storage: {
        put: async (_key: string, value: TaskRunnerState) => {
          saved = structuredClone(value);
        },
        setAlarm: vi.fn(),
      },
    },
    updateD1ExecutionStep: vi.fn(),
    assertRecoveryAuthority: vi.fn(),
    advanceToStep: async (state: TaskRunnerState, step: TaskRunnerState['currentStep']) => {
      state.currentStep = step;
      saved = structuredClone(state);
    },
    getAgentReadyTimeoutMs: () => 900_000,
    getAgentReadyFreshnessSkewMs: () => 30_000,
    getAgentPollIntervalMs: () => 5_000,
    getProvisionPollIntervalMs: () => 5_000,
    getProvisionTimeoutMs: () => 900_000,
  } as unknown as TaskRunnerContext;
  let state = {
    version: 1,
    taskId: 'task',
    projectId: 'project',
    userId: 'user',
    currentStep: 'node_agent_ready',
    retryCount: 0,
    stepResults: { nodeId: 'old', autoProvisioned: true, workspaceId: null, agentStarted: false },
    config: {
      vmSize: 'small',
      vmLocation: 'hel1',
      cloudProvider: 'hetzner',
      taskMode: 'conversation',
      taskTitle: 'Boot',
      preferredNodeId: null,
    },
    agentReadyStartedAt: Date.now() - 400_000,
    admissionScopeKey: 'scope',
    admissionLeaseToken: 1,
  } as TaskRunnerState;
  await handleNodeAgentReady(state, rc);
  expect(state.currentStep).toBe('node_provisioning');
  expect(sqlite.prepare('SELECT count(*) AS count FROM vm_provisioning_leases').get()).toEqual({
    count: 0,
  });
  state = structuredClone(saved ?? state);
  await handleNodeProvisioning(state, rc);
  const replacement = state.stepResults.nodeId;
  expect(replacement).toBeTruthy();
  expect(replacement).not.toBe('old');
  if (state.currentStep === 'node_provisioning') await handleNodeProvisioning(state, rc);
  expect(state.currentStep).toBe('node_agent_ready');
  sqlite
    .prepare(
      'UPDATE nodes SET health_status = ?, last_heartbeat_at = ?, agent_ready_at = ?, agent_version = ? WHERE id = ?'
    )
    .run(
      'healthy',
      new Date().toISOString(),
      new Date().toISOString(),
      env.VM_AGENT_REQUIRED_VERSION,
      replacement
    );
  await handleNodeAgentReady(state, rc);
  expect(state.currentStep).toBe('workspace_creation');
  expect(state.stepResults.nodeId).toBe(replacement);
  expect(state.bootReplacementCount).toBe(1);
  expect(external.order).toEqual(['delete', 'create']);
});
