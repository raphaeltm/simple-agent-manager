/**
 * Miniflare integration tests for the TaskRunner Durable Object.
 *
 * Exercises state persistence, idempotency, and failure handling with
 * real D1 transactions and DO storage. Step handlers that make external
 * HTTP calls (Hetzner, VM agent) cannot be tested end-to-end in Miniflare,
 * so these tests focus on:
 *
 * 1. start() persists correct initial state
 * 2. start() idempotency (second call is no-op)
 * 3. getStatus() returns state with redacted mcpToken
 * 4. advanceWorkspaceReady() stores signal
 * 5. failTask() updates D1 and records status events (via alarm error path)
 *
 * TaskRunner DO: apps/api/src/durable-objects/task-runner/index.ts
 * State machine: apps/api/src/durable-objects/task-runner/state-machine.ts
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type {
  StartTaskInput,
  TaskRunner,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner';
import { encrypt } from '../../src/services/encryption';
import { seedInstallation, seedNode, seedProject, seedTask, seedUser } from './helpers/seed-d1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStub(taskId: string): DurableObjectStub<TaskRunner> {
  const id = env.TASK_RUNNER.idFromName(taskId);
  return env.TASK_RUNNER.get(id) as DurableObjectStub<TaskRunner>;
}

const TEST_USER_ID = 'user-tr-test-001';
const TEST_PROJECT_ID = 'project-tr-test-001';
const TEST_INSTALLATION_ID = 'install-tr-test-001';

async function seedTestData(): Promise<void> {
  await seedUser(TEST_USER_ID, { githubId: 'gh-tr-test', email: 'tr-test@test.com' });
  await seedInstallation(TEST_INSTALLATION_ID, TEST_USER_ID);
  await seedProject(TEST_PROJECT_ID, TEST_USER_ID, TEST_INSTALLATION_ID);

  const { ciphertext, iv } = await encrypt(
    'hetzner-token-for-task-runner-tests',
    env.ENCRYPTION_KEY
  );
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO credentials
       (id, user_id, provider, credential_type, credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
     VALUES ('cred-tr-test-cloud', ?, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(TEST_USER_ID, ciphertext, iv)
    .run();
}

async function seedTestTask(taskId: string): Promise<void> {
  await seedTask(taskId, TEST_PROJECT_ID, TEST_USER_ID);
}

/**
 * Build a minimal StartTaskInput for testing.
 */
function buildStartInput(taskId: string): StartTaskInput {
  return {
    taskId,
    projectId: TEST_PROJECT_ID,
    userId: TEST_USER_ID,
    config: {
      vmSize: 'medium',
      vmLocation: 'nbg1',
      branch: 'main',
      defaultBranch: 'main',
      preferredNodeId: null,
      userName: 'Test User',
      userEmail: 'test@test.com',
      githubId: 'gh-12345',
      taskTitle: `Test task ${taskId}`,
      taskDescription: 'A test task for Miniflare integration testing',
      repository: 'test-org/test-repo',
      installationId: TEST_INSTALLATION_ID,
      outputBranch: null,
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: 'claude-code',
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: null,
      taskMode: 'task',
      model: null,
      permissionMode: null,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      attachments: null,
    },
  };
}

async function getTaskFromD1(
  taskId: string
): Promise<{ status: string; execution_step: string | null; error_message: string | null } | null> {
  return await env.DATABASE.prepare(
    `SELECT status, execution_step, error_message FROM tasks WHERE id = ?`
  )
    .bind(taskId)
    .first<{ status: string; execution_step: string | null; error_message: string | null }>();
}

async function getStatusEvents(
  taskId: string
): Promise<Array<{ from_status: string | null; to_status: string; reason: string | null }>> {
  const result = await env.DATABASE.prepare(
    `SELECT from_status, to_status, reason FROM task_status_events WHERE task_id = ? ORDER BY created_at ASC`
  )
    .bind(taskId)
    .all<{ from_status: string | null; to_status: string; reason: string | null }>();
  return result.results;
}

async function startWithoutAlarm(
  stub: DurableObjectStub<TaskRunner>,
  input: StartTaskInput
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await instance.start(input);
    await instance.ctx.storage.deleteAlarm();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskRunner DO — state persistence and idempotency', () => {
  it('start() persists initial state with correct shape', async () => {
    await seedTestData();
    const taskId = 'tr-test-start-001';
    await seedTestTask(taskId);

    const stub = getStub(taskId);
    const input = buildStartInput(taskId);

    await startWithoutAlarm(stub, input);

    // Read internal state via getStatus
    const status = await stub.getStatus();

    expect(status).toBeTruthy();
    expect(status!.taskId).toBe(taskId);
    expect(status!.projectId).toBe(TEST_PROJECT_ID);
    expect(status!.userId).toBe(TEST_USER_ID);
    expect(status!.currentStep).toBe('node_selection');
    expect(status!.retryCount).toBe(0);
    expect(status!.completed).toBe(false);
    expect(status!.version).toBe(1);

    // Step results should be initialized
    expect(status!.stepResults.nodeId).toBeNull();
    expect(status!.stepResults.workspaceId).toBeNull();
    expect(status!.stepResults.agentSessionId).toBeNull();
    expect(status!.stepResults.autoProvisioned).toBe(false);
  });

  it('start() is idempotent — second call is a no-op', async () => {
    await seedTestData();
    const taskId = 'tr-test-idempotent-001';
    await seedTestTask(taskId);

    const stub = getStub(taskId);
    const input = buildStartInput(taskId);

    // First call
    await startWithoutAlarm(stub, input);
    const statusAfterFirst = await stub.getStatus();
    const createdAt = statusAfterFirst!.createdAt;

    // Second call — should be a no-op
    await startWithoutAlarm(stub, input);
    const statusAfterSecond = await stub.getStatus();

    // CreatedAt should not change (state was not re-initialized)
    expect(statusAfterSecond!.createdAt).toBe(createdAt);
    expect(statusAfterSecond!.currentStep).toBe('node_selection');
  });

  it('getStatus() redacts mcpToken', async () => {
    await seedTestData();
    const taskId = 'tr-test-redact-001';
    await seedTestTask(taskId);

    const stub = getStub(taskId);
    const input = buildStartInput(taskId);
    await startWithoutAlarm(stub, input);

    // Manually inject a mock mcpToken into DO state
    await runInDurableObject(stub, async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (state) {
        state.stepResults.mcpToken = 'secret-token-12345';
        await instance.ctx.storage.put('state', state);
      }
    });

    const status = await stub.getStatus();
    expect(status!.stepResults.mcpToken).toBe('[redacted]');
  });

  it('getStatus() returns null when no state exists', async () => {
    const stub = getStub('tr-test-nostate-001');
    const status = await stub.getStatus();
    expect(status).toBeNull();
  });
});

describe('TaskRunner DO — advanceWorkspaceReady', () => {
  it('stores the workspace-ready signal in state', async () => {
    await seedTestData();
    const taskId = 'tr-test-ws-ready-001';
    await seedTestTask(taskId);

    const stub = getStub(taskId);
    await startWithoutAlarm(stub, buildStartInput(taskId));

    // Send workspace ready signal
    await stub.advanceWorkspaceReady('running', null);

    const status = await stub.getStatus();
    expect(status!.workspaceReadyReceived).toBe(true);
    expect(status!.workspaceReadyStatus).toBe('running');
    expect(status!.workspaceErrorMessage).toBeNull();
  });

  it('stores error signal when workspace reports error', async () => {
    await seedTestData();
    const taskId = 'tr-test-ws-error-001';
    await seedTestTask(taskId);

    const stub = getStub(taskId);
    await startWithoutAlarm(stub, buildStartInput(taskId));

    await stub.advanceWorkspaceReady('error', 'container failed to start');

    const status = await stub.getStatus();
    expect(status!.workspaceReadyReceived).toBe(true);
    expect(status!.workspaceReadyStatus).toBe('error');
    expect(status!.workspaceErrorMessage).toBe('container failed to start');
  });

  it('is a no-op when state is completed', async () => {
    await seedTestData();
    const taskId = 'tr-test-ws-completed-001';
    await seedTestTask(taskId);

    const stub = getStub(taskId);
    await startWithoutAlarm(stub, buildStartInput(taskId));

    // Mark DO as completed
    await runInDurableObject(stub, async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (state) {
        state.completed = true;
        await instance.ctx.storage.put('state', state);
      }
    });

    // Should not throw, just return
    await stub.advanceWorkspaceReady('running', null);

    // workspaceReadyReceived should still be false (no-op)
    await runInDurableObject(stub, async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      expect(state!.workspaceReadyReceived).toBe(false);
    });
  });
});

describe('TaskRunner DO — failure handling', () => {
  it('terminalizes a task whose claimed node was deleted without returning the node to warm reuse', async () => {
    await seedTestData();
    const taskId = 'tr-test-claimed-node-deleted-001';
    const nodeId = 'tr-test-node-deleted-001';
    await seedNode(nodeId, TEST_USER_ID, {
      status: 'deleted',
      healthStatus: 'stale',
      warmSince: null,
    });
    await seedTask(taskId, TEST_PROJECT_ID, TEST_USER_ID, {
      autoProvisionedNodeId: nodeId,
      executionStep: 'node_agent_ready',
    });

    const stub = getStub(taskId);
    await runInDurableObject(stub, async (instance) => {
      await instance.start(buildStartInput(taskId));
      await instance.ctx.storage.deleteAlarm();
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (!state) throw new Error('TaskRunner state was not initialized');
      state.currentStep = 'node_agent_ready';
      state.stepResults.nodeId = nodeId;
      state.stepResults.autoProvisioned = true;
      state.agentReadyStartedAt = Date.now() - 65_000;
      await instance.ctx.storage.put('state', state);

      await instance.alarm();

      expect(await instance.ctx.storage.getAlarm()).toBeNull();
    });

    const status = await stub.getStatus();
    expect(status).toMatchObject({
      completed: true,
      currentStep: 'node_agent_ready',
      stepResults: {
        nodeId,
        autoProvisioned: false,
      },
    });

    const dbTask = await getTaskFromD1(taskId);
    expect(dbTask).toMatchObject({
      status: 'failed',
      execution_step: null,
      error_message: expect.stringContaining(
        `Provisioned node ${nodeId} disappeared during node_agent_ready`
      ),
    });
    expect(await getStatusEvents(taskId)).toContainEqual(
      expect.objectContaining({
        from_status: 'delegated',
        to_status: 'failed',
        reason: expect.stringContaining(
          `Provisioned node ${nodeId} disappeared during node_agent_ready`
        ),
      })
    );

    const node = await env.DATABASE.prepare(
      `SELECT status, warm_since FROM nodes WHERE id = ?`
    )
      .bind(nodeId)
      .first<{ status: string; warm_since: string | null }>();
    expect(node).toEqual({ status: 'deleted', warm_since: null });
  });

  it('an unknown execution step fails the task and records a status event', async () => {
    await seedTestData();
    const taskId = 'tr-test-fail-001';
    await seedTestTask(taskId);

    const stub = getStub(taskId);
    await runInDurableObject(stub, async (instance) => {
      await instance.start(buildStartInput(taskId));
      await instance.ctx.storage.deleteAlarm();
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (state) {
        state.currentStep = 'unsupported_test_step' as TaskRunnerState['currentStep'];
        await instance.ctx.storage.put('state', state);
      }
      await instance.alarm();
    });

    const status = await stub.getStatus();
    expect(status!.completed).toBe(true);

    const dbTask = await getTaskFromD1(taskId);
    expect(dbTask!.status).toBe('failed');
    expect(dbTask!.error_message).toContain('Unknown execution step: unsupported_test_step');

    const events = await getStatusEvents(taskId);
    expect(events).toContainEqual(
      expect.objectContaining({
        from_status: 'delegated',
        to_status: 'failed',
        reason: expect.stringContaining('Unknown execution step: unsupported_test_step'),
      })
    );
  });

  it('alarm is a no-op on completed state', async () => {
    await seedTestData();
    const taskId = 'tr-test-alarm-noop-001';
    await seedTestTask(taskId);

    const stub = getStub(taskId);
    await startWithoutAlarm(stub, buildStartInput(taskId));

    // Mark completed
    await runInDurableObject(stub, async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (state) {
        state.completed = true;
        await instance.ctx.storage.put('state', state);
      }
    });

    // Alarm should be a no-op — no state changes
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    const status = await stub.getStatus();
    expect(status!.completed).toBe(true);
    // D1 task should still be delegated (failTask was never called)
    const dbTask = await getTaskFromD1(taskId);
    expect(dbTask!.status).toBe('delegated');
  });

  it('alarm with no state is a no-op', async () => {
    const stub = getStub('tr-test-alarm-nostate-001');

    // Should not throw
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
  });
});
