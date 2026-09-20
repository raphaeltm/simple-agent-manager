import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { handleNodeProvisioning } from '../../src/durable-objects/task-runner/node-steps';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner/types';
import * as nodesService from '../../src/services/nodes';
import { capacityPoolMaxNodesMigrationSql } from '../helpers/capacity-pool-migrations';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

describe('capacity pool node-limit handler boundary', () => {
  let sqlite: Database.Database;

  afterEach(() => sqlite.close());

  it('translates the real trigger abort and never reaches provider provisioning', async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO users (id) VALUES ('user-1');
      INSERT INTO capacity_pools
        (id, scope, owner_user_id, name, is_default, status, strategy, exhaustion_policy, max_nodes)
      VALUES ('pool-1', 'user', 'user-1', 'Pool', 1, 'active', 'spread', 'queue', 1);
      INSERT INTO nodes
        (id, user_id, name, status, capacity_pool_id, node_role, node_class)
      VALUES ('existing-node', 'user-1', 'Existing', 'running', 'pool-1', 'workspace', 'managed');
    `);
    const triggerOffset = capacityPoolMaxNodesMigrationSql.indexOf('CREATE TRIGGER');
    if (triggerOffset < 0) throw new Error('capacity pool trigger missing from migration');
    sqlite.exec(capacityPoolMaxNodesMigrationSql.slice(triggerOffset));

    const snapshot = {
      capacityPoolId: 'pool-1',
      capacityPoolScope: 'user' as const,
      capacityPoolRevision: 1,
      capacitySourceId: 'source-1',
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
    const state = {
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
          exhaustionPolicy: 'fail',
          maxNodes: 2,
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
    } as unknown as TaskRunnerState;
    const database = createSqliteD1(sqlite);
    const rc = {
      env: {
        DATABASE: database,
        MAX_NODES_PER_USER: '10',
        COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      },
      ctx: {
        storage: { put: vi.fn(async () => undefined), setAlarm: vi.fn(async () => undefined) },
      },
      assertRecoveryAuthority: vi.fn(async () => undefined),
      advanceToStep: vi.fn(async () => undefined),
      getProvisionPollIntervalMs: () => 1000,
      getProvisionTimeoutMs: () => 600_000,
      updateD1ExecutionStep: vi.fn(async () => undefined),
    } as unknown as TaskRunnerContext;
    const provisionSpy = vi.spyOn(nodesService, 'provisionNode');

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'Capacity pool node limit (2) reached and no node can fit the request.',
      permanent: true,
    });

    expect(provisionSpy).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM nodes`).get()).toEqual({ count: 1 });
  });
});
