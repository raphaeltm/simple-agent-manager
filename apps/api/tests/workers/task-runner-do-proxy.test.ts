/**
 * Vertical slice tests for the task-runner-do.ts proxy service.
 *
 * Verifies the Worker→DO contract: that the proxy correctly resolves the
 * DO stub via idFromName(taskId) and forwards arguments to the TaskRunner DO.
 *
 * Uses Miniflare with real DOs — no vi.mock().
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { TaskRunner } from '../../src/durable-objects/task-runner';
import type { TaskRunnerState } from '../../src/durable-objects/task-runner/types';
import {
  advanceTaskRunnerWorkspaceReady,
  ensureTaskRunnerStarted,
  getTaskRunnerStatus,
  startTaskRunnerDO,
} from '../../src/services/task-runner-do';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStub(taskId: string): DurableObjectStub<TaskRunner> {
  const id = env.TASK_RUNNER.idFromName(taskId);
  return env.TASK_RUNNER.get(id) as DurableObjectStub<TaskRunner>;
}

/** Full realistic input for startTaskRunnerDO */
function makeStartInput(taskId: string) {
  return {
    taskId,
    projectId: 'proj-tr-001',
    userId: 'user-tr-001',
    vmSize: 'medium' as const,
    vmLocation: 'nbg1' as const,
    branch: 'main',
    preferredNodeId: 'node-warm-001',
    userName: 'Test User',
    userEmail: 'test@example.com',
    githubId: 'gh-12345',
    taskTitle: 'Fix the flaky test',
    taskDescription: 'The CI test for auth is flaky due to a race condition',
    repository: 'test-org/test-repo',
    installationId: 'inst-001',
    outputBranch: 'fix/flaky-auth-test',
    projectDefaultVmSize: 'small' as const,
    chatSessionId: 'chat-sess-001',
    agentType: 'claude-code',
    workspaceProfile: 'full' as const,
    devcontainerConfigName: 'default',
    cloudProvider: 'hetzner' as const,
    taskMode: 'task' as const,
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'auto-edit',
    opencodeProvider: null,
    opencodeBaseUrl: null,
    systemPromptAppend: 'Always run tests before committing.',
    agentProfileHint: 'profile-release-001',
    attachments: [
      { id: 'att-001', filename: 'spec.md', r2Key: 'attachments/att-001', contentType: 'text/markdown', sizeBytes: 1024 },
    ],
    projectScaling: {
      taskExecutionTimeoutMs: 7200000,
      maxWorkspacesPerNode: 3,
      nodeCpuThresholdPercent: 80,
      nodeMemoryThresholdPercent: 85,
      warmNodeTimeoutMs: 60000,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('task-runner-do proxy — Worker→DO contract', () => {
  it('startTaskRunnerDO forwards full config to the DO', async () => {
    const taskId = 'task-start-001';
    const input = makeStartInput(taskId);

    await startTaskRunnerDO(env, input);

    // Verify via direct DO stub that state was persisted correctly
    const stub = getStub(taskId);
    const status = (await stub.getStatus()) as TaskRunnerState;

    expect(status).toBeTruthy();
    expect(status.taskId).toBe(taskId);
    expect(status.projectId).toBe('proj-tr-001');
    expect(status.userId).toBe('user-tr-001');
    expect(status.currentStep).toBe('node_selection');
    expect(status.completed).toBe(false);

    // Verify config fields were forwarded correctly
    const config = status.config;
    expect(config.vmSize).toBe('medium');
    expect(config.vmLocation).toBe('nbg1');
    expect(config.branch).toBe('main');
    expect(config.preferredNodeId).toBe('node-warm-001');
    expect(config.userName).toBe('Test User');
    expect(config.userEmail).toBe('test@example.com');
    expect(config.githubId).toBe('gh-12345');
    expect(config.taskTitle).toBe('Fix the flaky test');
    expect(config.taskDescription).toBe('The CI test for auth is flaky due to a race condition');
    expect(config.repository).toBe('test-org/test-repo');
    expect(config.installationId).toBe('inst-001');
    expect(config.outputBranch).toBe('fix/flaky-auth-test');
    expect(config.projectDefaultVmSize).toBe('small');
    expect(config.chatSessionId).toBe('chat-sess-001');
    expect(config.agentType).toBe('claude-code');
    expect(config.workspaceProfile).toBe('full');
    expect(config.devcontainerConfigName).toBe('default');
    expect(config.cloudProvider).toBe('hetzner');
    expect(config.taskMode).toBe('task');
    expect(config.model).toBe('claude-sonnet-4-20250514');
    expect(config.permissionMode).toBe('auto-edit');
    expect(config.systemPromptAppend).toBe('Always run tests before committing.');
    expect(config.agentProfileHint).toBe('profile-release-001');
    expect(config.attachments).toHaveLength(1);
    expect(config.attachments![0]!.id).toBe('att-001');
    expect(config.attachments![0]!.filename).toBe('spec.md');
    expect(config.projectScaling?.taskExecutionTimeoutMs).toBe(7200000);
    expect(config.projectScaling?.maxWorkspacesPerNode).toBe(3);
  });

  it('startTaskRunnerDO defaults optional fields to null', async () => {
    const taskId = 'task-start-defaults-001';

    await startTaskRunnerDO(env, {
      taskId,
      projectId: 'proj-tr-002',
      userId: 'user-tr-002',
      vmSize: 'small',
      vmLocation: 'fsn1',
      branch: 'develop',
      taskTitle: 'Minimal task',
      repository: 'test-org/test-repo',
      installationId: 'inst-002',
    });

    const stub = getStub(taskId);
    const status = (await stub.getStatus()) as TaskRunnerState;

    expect(status).toBeTruthy();
    expect(status.config.preferredNodeId).toBeNull();
    expect(status.config.userName).toBeNull();
    expect(status.config.userEmail).toBeNull();
    expect(status.config.githubId).toBeNull();
    expect(status.config.taskDescription).toBeNull();
    expect(status.config.outputBranch).toBeNull();
    expect(status.config.projectDefaultVmSize).toBeNull();
    expect(status.config.chatSessionId).toBeNull();
    expect(status.config.agentType).toBeNull();
    expect(status.config.workspaceProfile).toBeNull();
    expect(status.config.devcontainerConfigName).toBeNull();
    expect(status.config.cloudProvider).toBeNull();
    expect(status.config.taskMode).toBe('task'); // defaults to 'task', not null
    expect(status.config.model).toBeNull();
    expect(status.config.permissionMode).toBeNull();
    expect(status.config.opencodeProvider).toBeNull();
    expect(status.config.opencodeBaseUrl).toBeNull();
    expect(status.config.systemPromptAppend).toBeNull();
    expect(status.config.attachments).toBeNull();
    expect(status.config.projectScaling).toBeNull();
  });

  it('startTaskRunnerDO is idempotent — second call is a no-op', async () => {
    const taskId = 'task-start-idempotent-001';
    const input = makeStartInput(taskId);

    await startTaskRunnerDO(env, input);
    // Second call should not throw and should not overwrite state
    await startTaskRunnerDO(env, { ...input, taskTitle: 'OVERWRITTEN' });

    const stub = getStub(taskId);
    const status = (await stub.getStatus()) as TaskRunnerState;
    expect(status.config.taskTitle).toBe('Fix the flaky test');
  });

  it('advanceTaskRunnerWorkspaceReady forwards running status', async () => {
    const taskId = 'task-advance-running-001';
    await startTaskRunnerDO(env, makeStartInput(taskId));

    await advanceTaskRunnerWorkspaceReady(env, taskId, 'running', null);

    const stub = getStub(taskId);
    const status = (await stub.getStatus()) as TaskRunnerState;
    expect(status.workspaceReadyReceived).toBe(true);
    expect(status.workspaceReadyStatus).toBe('running');
    expect(status.workspaceErrorMessage).toBeNull();
  });

  it('advanceTaskRunnerWorkspaceReady forwards recovery status', async () => {
    const taskId = 'task-advance-recovery-001';
    await startTaskRunnerDO(env, makeStartInput(taskId));

    await advanceTaskRunnerWorkspaceReady(env, taskId, 'recovery', null);

    const stub = getStub(taskId);
    const status = (await stub.getStatus()) as TaskRunnerState;
    expect(status.workspaceReadyReceived).toBe(true);
    expect(status.workspaceReadyStatus).toBe('recovery');
  });

  it('advanceTaskRunnerWorkspaceReady forwards error status with message', async () => {
    const taskId = 'task-advance-error-001';
    await startTaskRunnerDO(env, makeStartInput(taskId));

    await advanceTaskRunnerWorkspaceReady(env, taskId, 'error', 'Container build failed: OOM');

    const stub = getStub(taskId);
    const status = (await stub.getStatus()) as TaskRunnerState;
    expect(status.workspaceReadyReceived).toBe(true);
    expect(status.workspaceReadyStatus).toBe('error');
    expect(status.workspaceErrorMessage).toBe('Container build failed: OOM');
  });

  it('advanceTaskRunnerWorkspaceReady is a no-op on uninitialized DO', async () => {
    // Calling advance on a DO that was never started should not throw
    await expect(
      advanceTaskRunnerWorkspaceReady(env, 'task-advance-noop-001', 'running', null),
    ).resolves.toBeUndefined();

    // Verify DO remains uninitialized
    const status = await getTaskRunnerStatus(env, 'task-advance-noop-001');
    expect(status).toBeNull();
  });

  it('getTaskRunnerStatus returns null for uninitialized DO', async () => {
    const status = await getTaskRunnerStatus(env, 'task-status-none-001');
    expect(status).toBeNull();
  });

  it('ensureTaskRunnerStarted distinguishes an uninitialized DO', async () => {
    await expect(ensureTaskRunnerStarted(env, 'task-ensure-none-001')).resolves.toBe(false);
  });

  it('ensureTaskRunnerStarted repairs a missing alarm for durable work', async () => {
    const taskId = 'task-ensure-alarm-001';
    await startTaskRunnerDO(env, makeStartInput(taskId));
    const stub = getStub(taskId);
    await runInDurableObject(stub, async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      expect(state).toBeTruthy();
      await instance.ctx.storage.deleteAlarm();
    });

    await expect(ensureTaskRunnerStarted(env, taskId)).resolves.toBe(true);
    const alarm = await runInDurableObject(stub, (instance) => instance.ctx.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });

  it('getTaskRunnerStatus returns state for initialized DO', async () => {
    const taskId = 'task-status-init-001';
    await startTaskRunnerDO(env, makeStartInput(taskId));

    const status = (await getTaskRunnerStatus(env, taskId)) as TaskRunnerState;
    expect(status).toBeTruthy();
    expect(status.taskId).toBe(taskId);
    expect(status.currentStep).toBe('node_selection');
    expect(status.retryCount).toBe(0);
    expect(status.completed).toBe(false);
    expect(status.stepResults.nodeId).toBeNull();
    expect(status.stepResults.workspaceId).toBeNull();
    expect(status.stepResults.agentSessionId).toBeNull();
  });

  it('getTaskRunnerStatus redacts mcpToken', async () => {
    const taskId = 'task-redact-mcp-001';
    await startTaskRunnerDO(env, makeStartInput(taskId));

    // Inject an mcpToken into DO storage directly
    const stub = getStub(taskId);
    await runInDurableObject(stub, async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (state) {
        state.stepResults.mcpToken = 'secret-mcp-token-value';
        await instance.ctx.storage.put('state', state);
      }
    });

    // Verify the proxy redacts it
    const status = (await getTaskRunnerStatus(env, taskId)) as TaskRunnerState;
    expect(status.stepResults.mcpToken).toBe('[redacted]');
  });

  it('proxy uses idFromName for deterministic DO resolution', async () => {
    const taskId = 'task-deterministic-001';
    await startTaskRunnerDO(env, makeStartInput(taskId));

    // The proxy and direct stub should access the same DO instance
    const proxyStatus = (await getTaskRunnerStatus(env, taskId)) as TaskRunnerState;
    const directStatus = (await getStub(taskId).getStatus()) as TaskRunnerState;

    expect(proxyStatus.taskId).toBe(directStatus.taskId);
    expect(proxyStatus.currentStep).toBe(directStatus.currentStep);
    expect(proxyStatus.createdAt).toBe(directStatus.createdAt);
  });
});
