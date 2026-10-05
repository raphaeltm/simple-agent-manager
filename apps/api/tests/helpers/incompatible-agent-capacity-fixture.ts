import Database from 'better-sqlite3';
import { vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner/types';
import { capacityPoolMaxNodesMigrationSql } from './capacity-pool-migrations';
import { createAllSchemaTables, createSqliteD1 } from './sqlite-d1';

export function createIncompatibleCapacityFixture() {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`
 CREATE UNIQUE INDEX snapshot_chat ON session_snapshots(chat_session_id);
 INSERT INTO users (id) VALUES ('user-1');
 INSERT INTO projects (id, user_id) VALUES ('project-1', 'user-1');
 INSERT INTO credentials (id, user_id, provider, credential_type, is_active) VALUES ('credential-1', 'user-1', 'hetzner', 'cloud-provider', 1);
 INSERT INTO capacity_pools (id, scope, owner_user_id, name, is_default, status, strategy, exhaustion_policy, max_nodes)
 VALUES ('pool-1', 'user', 'user-1', 'Pool', 1, 'active', 'pack', 'queue', 1);
 INSERT INTO nodes (id,user_id,name,status,capacity_pool_id,node_role,node_class,runtime,agent_version,created_at)
 VALUES ('existing-node','user-1','Old host','running','pool-1','workspace','managed','vm','old-agent','2026-10-01T00:00:00.000Z');
 INSERT INTO tasks (id,project_id,user_id,status,auto_provisioned_node_id) VALUES ('old-task','project-1','user-1','completed','existing-node');
 INSERT INTO tasks (id,project_id,user_id,status) VALUES ('task-1','project-1','user-1','queued');
 INSERT INTO workspaces (id,user_id,node_id,project_id,chat_session_id,status,created_at,updated_at,last_activity_at)
 VALUES ('old-workspace','user-1','existing-node','project-1','old-chat','running','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z');
 INSERT INTO agent_sessions (id,workspace_id,status,created_at) VALUES ('old-agent-session','old-workspace','running','2026-10-01T00:00:00.000Z');
 `);
  sqlite.exec(
    capacityPoolMaxNodesMigrationSql.slice(
      capacityPoolMaxNodesMigrationSql.indexOf('CREATE TRIGGER')
    )
  );
  const snapshot = {
    capacityPoolId: 'pool-1',
    capacityPoolScope: 'user' as const,
    capacityPoolRevision: 1,
    capacitySourceId: 'source-1',
    capacitySourceGeneration: 1,
    capacitySourceExternalRef: null,
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    capacityPoolCandidateId: 'candidate-1',
    placementCredentialSource: 'user' as const,
    placementCredentialReference: 'credentials:credential-1',
    placementCredentialVersion: 1,
    capacityPoolProjectId: null,
    workloadRole: 'workspace' as const,
    providerInstanceType: 'cx42',
    providerInstanceVcpuCount: 8,
    providerInstanceMemoryMb: 16 * 1024,
    providerInstanceDiskGb: 160,
    placementExplanationJson: '{"kind":"capacity_pool_default"}',
  };
  const state: TaskRunnerState = {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    currentStep: 'node_provisioning',
    stepResults: {
      nodeId: null,
      autoProvisioned: false,
      workspaceId: null,
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: null,
      capacityPlacementSnapshot: snapshot,
    },
    config: {
      vmSize: 'large',
      vmLocation: 'fsn1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'Pool trigger race',
      taskDescription: null,
      repository: 'owner/repo',
      installationId: 'install-1',
      outputBranch: null,
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: null,
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: 'hetzner',
      credentialAttributionUserId: 'user-1',
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      taskMode: 'task',
      model: null,
      effort: null,
      permissionMode: null,
      systemPromptAppend: null,
      agentProfileHint: null,
      attachments: null,
      projectScaling: null,
      vmSizeSource: 'task',
      resolvedReservation: {
        version: 3,
        cpuMillis: 1000,
        memoryMb: 1024,
        diskMb: 2048,
        exclusiveNode: false,
        source: 'task',
        sourceId: 'task-1',
      },
      capacityPoolSelection: {
        poolId: 'pool-1',
        scope: 'user',
        revision: 1,
        strategy: 'pack',
        exhaustionPolicy: 'queue',
        maxNodes: 1,
        capacityPoolProjectId: null,
        workloadRole: 'workspace',
        poolSnapshot: { ...snapshot, capacitySourceId: null, capacityPoolCandidateId: null },
        candidates: [
          {
            id: 'candidate-1',
            poolId: 'pool-1',
            capacitySourceId: 'source-1',
            provider: 'hetzner',
            location: 'fsn1',
            workloadRole: 'workspace',
            runtime: 'vm',
            machineClass: 'shared-vm',
            machineSize: 'large',
            providerInstanceType: 'cx42',
            providerInstanceVcpuCount: 8,
            providerInstanceMemoryMb: 16 * 1024,
            providerInstanceDiskGb: 160,
            priority: 0,
            candidateOrder: 0,
            credentialAttributionSource: 'user',
            placementCredentialSource: 'user',
            placementCredentialReference: 'credentials:credential-1',
            placementCredentialVersion: 1,
            capacityPoolProjectId: null,
            snapshot,
          },
        ],
      },
    },
    retryCount: 0,
    workspaceReadyReceived: false,
    workspaceReadyStatus: null,
    workspaceErrorMessage: null,
    createdAt: Date.now(),
    lastStepAt: Date.now(),
    provisioningStartedAt: null,
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    workspaceDispatchStartedAt: null,
    workspaceDispatchAttempts: 0,
    workspaceDispatchLastAttemptAt: null,
    workspaceDispatchLastError: null,
    workspaceDispatchAckedAt: null,
    lastD1Step: null,
    completed: false,
  };

  sqlite.exec(`
 INSERT INTO project_members (project_id,user_id,status,role) VALUES ('project-1','user-1','active','owner');
 UPDATE credentials SET updated_at='1970-01-01T00:00:00.001Z';
 UPDATE capacity_pools SET revision=1,configuration_state='configured-ready';
 INSERT INTO capacity_sources (id,scope,owner_user_id,source_kind,status,provider,credential_source,credential_reference,credential_version,credential_id,authority_generation)
 VALUES ('source-1','user','user-1','cloud-provider-credential','active','hetzner','user','credentials:credential-1',1,'credential-1',1);
 INSERT INTO capacity_pool_candidates (id,pool_id,capacity_source_id,status,catalog_availability,provider,location,workload_role,provider_instance_type,provider_instance_vcpu_count,provider_instance_memory_mb,provider_instance_disk_gb)
 VALUES ('candidate-1','pool-1','source-1','active','available','hetzner','fsn1','workspace','cx42',8,16384,160);
 UPDATE nodes SET health_status='healthy',capacity_pool_scope='user',capacity_pool_revision=1,capacity_source_id='source-1',capacity_source_generation=1,capacity_pool_candidate_id='candidate-1',placement_credential_source='user',placement_credential_reference='credentials:credential-1',placement_credential_version=1,workload_role='workspace',cloud_provider='hetzner',vm_size='large',vm_location='fsn1',provider_instance_type='cx42',provider_instance_vcpu_count=8,provider_instance_memory_mb=16384,provider_instance_disk_gb=160,provider_instance_id='provider-old',observed_provider_instance_type='cx42',observed_provider_instance_vcpu_count=8,observed_provider_instance_memory_mb=16384,observed_provider_instance_disk_gb=160,observed_hardware_source='observed';
 `);
  sqlite
    .prepare('UPDATE nodes SET last_heartbeat_at=?,last_metrics=?')
    .run(
      new Date().toISOString(),
      JSON.stringify({ version: 1, cpuPercent: 10, memoryPercent: 10, diskPercent: 10 })
    );
  sqlite.prepare('UPDATE workspaces SET resolved_reservation_json=?').run(
    JSON.stringify({
      version: 3,
      cpuMillis: 1000,
      memoryMb: 1024,
      diskMb: 2048,
      exclusiveNode: false,
      source: 'task',
      sourceId: 'old-task',
    })
  );
  const database = createSqliteD1(sqlite);
  const rc = {
    env: {
      DATABASE: database,
      VM_AGENT_REQUIRED_VERSION: 'current-agent',
      MAX_NODES_PER_USER: '10',
      COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      VM_ADMISSION_CONTROL_MODE: 'enforce',
      VM_ADMISSION_WAIT_TIMEOUT_MS: '7200000',
      VM_ADMISSION_RETRY_MIN_MS: '1000',
      VM_ADMISSION_RETRY_MAX_MS: '1000',
    },
    ctx: { storage: { put: vi.fn(async () => undefined), setAlarm: vi.fn(async () => undefined) } },
    assertRecoveryAuthority: vi.fn(async () => undefined),
    advanceToStep: vi.fn(async () => undefined),
    getProvisionPollIntervalMs: () => 1000,
    getProvisionTimeoutMs: () => 600000,
    updateD1ExecutionStep: vi.fn(async () => undefined),
  } as unknown as TaskRunnerContext;
  return { sqlite, database, state, rc };
}
