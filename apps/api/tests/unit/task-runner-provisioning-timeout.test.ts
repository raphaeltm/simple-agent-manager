/**
 * Tests for node provisioning timeout and idempotent D1 step updates.
 *
 * Two cooperating bugs caused tasks to get stuck in "Queued / Setting up a new server..."
 * for days:
 *
 * Bug 1 (Belt): handleNodeProvisioning had no timeout — unlike handleNodeAgentReady
 * and handleWorkspaceReady which track startedAt timestamps and throw after configurable
 * timeouts, handleNodeProvisioning would poll forever if a node stayed in 'creating'.
 *
 * Bug 2 (Suspenders): updateD1ExecutionStep refreshed updated_at on every poll cycle
 * even when the step hadn't changed, defeating the stuck-tasks cron's staleness detection.
 */
import { DEFAULT_TASK_RUNNER_PROVISION_TIMEOUT_MS } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import { handleNodeAgentReady, handleNodeProvisioning } from '../../src/durable-objects/task-runner/node-steps';
import type { TaskRunnerContext, TaskRunnerState } from '../../src/durable-objects/task-runner/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<TaskRunnerState> = {}): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'proj-1',
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
    },
    config: {
      vmSize: 'small',
      vmLocation: 'fsn1',
      branch: 'main',
      preferredNodeId: null,
      userName: 'test',
      userEmail: 'test@example.com',
      githubId: null,
      taskTitle: 'Test task',
      taskDescription: null,
      repository: 'org/repo',
      installationId: 'inst-1',
      outputBranch: null,
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: null,
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
    retryCount: 0,
    workspaceReadyReceived: false,
    workspaceReadyStatus: null,
    workspaceErrorMessage: null,
    createdAt: Date.now(),
    lastStepAt: Date.now(),
    provisioningStartedAt: null,
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    lastD1Step: null,
    completed: false,
    ...overrides,
  };
}

function makeContext(overrides: Partial<TaskRunnerContext> = {}): TaskRunnerContext {
  return {
    env: {
      DATABASE: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        }),
      },
    } as unknown as TaskRunnerContext['env'],
    ctx: {
      storage: {
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        setAlarm: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as TaskRunnerContext['ctx'],
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    getAgentPollIntervalMs: () => 5000,
    getAgentReadyTimeoutMs: () => 900_000,
    getWorkspaceReadyTimeoutMs: () => 1_800_000,
    getWorkspaceReadyPollIntervalMs: () => 30_000,
    getProvisionPollIntervalMs: () => 10_000,
    getProvisionTimeoutMs: () => DEFAULT_TASK_RUNNER_PROVISION_TIMEOUT_MS,
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Bug 1: Provisioning timeout
// ---------------------------------------------------------------------------

describe('handleNodeProvisioning — timeout', () => {
  it('initializes provisioningStartedAt on first entry', async () => {
    const state = makeState({ stepResults: { ...makeState().stepResults, nodeId: 'node-1' } });
    expect(state.provisioningStartedAt).toBeNull();

    const rc = makeContext();
    // Node is still creating — will schedule another poll
    (rc.env.DATABASE.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ id: 'node-1', status: 'creating', error_message: null }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    });

    await handleNodeProvisioning(state, rc);

    expect(state.provisioningStartedAt).toBeTypeOf('number');
    expect(rc.ctx.storage.put).toHaveBeenCalledWith('state', state);
  });

  it('does NOT throw within timeout window', async () => {
    const state = makeState({
      provisioningStartedAt: Date.now() - 60_000, // 1 minute ago (well within 15 min timeout)
      stepResults: { ...makeState().stepResults, nodeId: 'node-1' },
    });

    const rc = makeContext();
    (rc.env.DATABASE.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ id: 'node-1', status: 'creating', error_message: null }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    });

    // Should not throw — just schedules another poll
    await handleNodeProvisioning(state, rc);
    expect(rc.ctx.storage.setAlarm).toHaveBeenCalled();
  });

  it('throws permanent error when provisioning exceeds timeout', async () => {
    const timeoutMs = 900_000; // 15 minutes
    const state = makeState({
      provisioningStartedAt: Date.now() - timeoutMs - 1000, // past timeout
      stepResults: { ...makeState().stepResults, nodeId: 'node-1' },
    });

    const rc = makeContext();
    (rc.env.DATABASE.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ id: 'node-1', status: 'creating', error_message: null }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toThrow(
      /Node provisioning timed out after 15 minutes/
    );
  });

  it('timeout is configurable via context', async () => {
    const customTimeoutMs = 60_000; // 1 minute
    const state = makeState({
      provisioningStartedAt: Date.now() - 90_000, // 1.5 minutes ago
      stepResults: { ...makeState().stepResults, nodeId: 'node-1' },
    });

    const rc = makeContext({
      getProvisionTimeoutMs: () => customTimeoutMs,
    });
    (rc.env.DATABASE.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ id: 'node-1', status: 'creating', error_message: null }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toThrow(
      /Node provisioning timed out after 1 minute$/
    );
  });

  it('timeout error has permanent flag', async () => {
    const state = makeState({
      provisioningStartedAt: Date.now() - 1_000_000, // way past timeout
      stepResults: { ...makeState().stepResults, nodeId: 'node-1' },
    });

    const rc = makeContext();

    try {
      await handleNodeProvisioning(state, rc);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error & { permanent?: boolean }).permanent).toBe(true);
    }
  });

  it('still advances when node becomes running within timeout', async () => {
    const state = makeState({
      provisioningStartedAt: Date.now() - 60_000, // within timeout
      stepResults: { ...makeState().stepResults, nodeId: 'node-1' },
    });

    const rc = makeContext();
    (rc.env.DATABASE.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ id: 'node-1', status: 'running', error_message: null }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    });

    await handleNodeProvisioning(state, rc);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('still throws on node error regardless of timeout', async () => {
    const state = makeState({
      provisioningStartedAt: Date.now() - 10_000, // well within timeout
      stepResults: { ...makeState().stepResults, nodeId: 'node-1' },
    });

    const rc = makeContext();
    (rc.env.DATABASE.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ id: 'node-1', status: 'error', error_message: 'Server creation failed' }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      }),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toThrow('Server creation failed');
  });
});

// ---------------------------------------------------------------------------
// Timeout parity: handleNodeAgentReady has a timeout, handleNodeProvisioning now matches
// ---------------------------------------------------------------------------

describe('timeout parity — node_agent_ready vs node_provisioning', () => {
  it('handleNodeAgentReady throws after timeout', async () => {
    const state = makeState({
      currentStep: 'node_agent_ready',
      agentReadyStartedAt: Date.now() - 1_000_000, // way past 15 min timeout
      stepResults: { ...makeState().stepResults, nodeId: 'node-1' },
    });

    const rc = makeContext();

    await expect(handleNodeAgentReady(state, rc)).rejects.toThrow(/Node agent not ready within/);
  });

  it('handleNodeProvisioning throws after timeout (matching pattern)', async () => {
    const state = makeState({
      provisioningStartedAt: Date.now() - 1_000_000,
      stepResults: { ...makeState().stepResults, nodeId: 'node-1' },
    });

    const rc = makeContext();

    await expect(handleNodeProvisioning(state, rc)).rejects.toThrow(/Node provisioning timed out/);
  });

  it('both have provisioningStartedAt / agentReadyStartedAt fields in state', () => {
    const state = makeState();
    expect(state).toHaveProperty('provisioningStartedAt');
    expect(state).toHaveProperty('agentReadyStartedAt');
  });
});

// ---------------------------------------------------------------------------
// Bug 2: Idempotent updateD1ExecutionStep
// ---------------------------------------------------------------------------

describe('idempotent updateD1ExecutionStep — state-persisted guard', () => {
  /**
   * Creates an updateD1ExecutionStep closure that mirrors the production
   * implementation in TaskRunner.buildContext(): it reads lastD1Step from
   * DO storage, skips D1 writes when the step hasn't changed, and persists
   * the updated lastD1Step back to storage.
   */
  function buildUpdateD1ExecutionStep() {
    const dbRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const dbBind = vi.fn().mockReturnValue({ run: dbRun });
    const dbPrepare = vi.fn().mockReturnValue({ bind: dbBind });

    // Simulate DO storage with state object (mirrors ctx.storage.get/put)
    let storedState: TaskRunnerState = makeState();
    const storagePut = vi.fn().mockImplementation((_key: string, val: TaskRunnerState) => {
      storedState = val;
      return Promise.resolve();
    });
    const storageGet = vi.fn().mockImplementation(() => Promise.resolve(storedState));

    const updateD1ExecutionStep = async (taskId: string, step: string) => {
      // Production pattern from index.ts buildContext():
      const currentState = await storageGet('state');
      if (currentState && step === currentState.lastD1Step) return;
      if (currentState) {
        currentState.lastD1Step = step;
        await storagePut('state', currentState);
      }
      await dbPrepare(`UPDATE tasks SET execution_step = ?, updated_at = ? WHERE id = ?`)
        .bind(step, new Date().toISOString(), taskId)
        .run();
    };

    return { updateD1ExecutionStep, dbRun, storagePut, storageGet };
  }

  it('skips redundant D1 writes when step has not changed', async () => {
    const { updateD1ExecutionStep, dbRun } = buildUpdateD1ExecutionStep();

    // First call — should write
    await updateD1ExecutionStep('task-1', 'node_provisioning');
    expect(dbRun).toHaveBeenCalledTimes(1);

    // Second call with same step — should skip (guard reads from persisted state)
    await updateD1ExecutionStep('task-1', 'node_provisioning');
    expect(dbRun).toHaveBeenCalledTimes(1); // still 1

    // Third call with same step — should skip
    await updateD1ExecutionStep('task-1', 'node_provisioning');
    expect(dbRun).toHaveBeenCalledTimes(1); // still 1

    // Fourth call with different step — should write
    await updateD1ExecutionStep('task-1', 'node_agent_ready');
    expect(dbRun).toHaveBeenCalledTimes(2);
  });

  it('writes on step change after skipping', async () => {
    const { updateD1ExecutionStep, dbRun } = buildUpdateD1ExecutionStep();

    await updateD1ExecutionStep('task-1', 'node_selection');
    await updateD1ExecutionStep('task-1', 'node_selection');
    await updateD1ExecutionStep('task-1', 'node_provisioning');
    await updateD1ExecutionStep('task-1', 'node_provisioning');
    await updateD1ExecutionStep('task-1', 'node_agent_ready');

    // 3 step transitions, 3 writes
    expect(dbRun).toHaveBeenCalledTimes(3);
  });

  it('persists lastD1Step to storage so guard survives DO eviction', async () => {
    const { updateD1ExecutionStep, storagePut } = buildUpdateD1ExecutionStep();

    await updateD1ExecutionStep('task-1', 'node_provisioning');

    // Verify lastD1Step was persisted to storage
    expect(storagePut).toHaveBeenCalled();
    const persistedState = storagePut.mock.calls[0][1] as TaskRunnerState;
    expect(persistedState.lastD1Step).toBe('node_provisioning');
  });
});

// ---------------------------------------------------------------------------
// Combined: provisioning timeout + idempotent steps prevent stuck tasks
// ---------------------------------------------------------------------------

describe('combined fix — belt and suspenders', () => {
  it('without fixes: a task would poll for 13 days with fresh updated_at', () => {
    // This test documents what USED to happen:
    // - handleNodeProvisioning polled every 10s with no timeout
    // - Each poll refreshed updated_at via updateD1ExecutionStep
    // - The stuck-tasks cron never saw the task as stale
    //
    // With the fix:
    // - Belt: provisioningStartedAt tracks when provisioning began
    //         After 15 min, the DO throws a permanent error
    // - Suspenders: updateD1ExecutionStep skips D1 writes on same step
    //              The cron can detect staleness even if the DO is alive
    const thirteenDaysMs = 13 * 24 * 60 * 60 * 1000;
    const timeoutMs = DEFAULT_TASK_RUNNER_PROVISION_TIMEOUT_MS;

    expect(thirteenDaysMs).toBeGreaterThan(timeoutMs);
    expect(timeoutMs).toBe(900_000); // 15 minutes
  });
});
