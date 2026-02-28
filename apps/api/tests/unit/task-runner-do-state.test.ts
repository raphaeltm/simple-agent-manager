/**
 * Source contract tests for TaskRunner DO state management and step flow.
 *
 * Validates the DO's structure, state schema, step handlers, alarm dispatch,
 * retry logic, and safety mechanisms via source code analysis.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const doSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);

describe('TaskRunner DO state schema', () => {
  it('exports TaskRunnerState interface', () => {
    expect(doSource).toContain('export interface TaskRunnerState');
  });

  it('has version field for schema evolution', () => {
    expect(doSource).toContain('version: 1');
  });

  it('tracks core identifiers', () => {
    expect(doSource).toContain('taskId: string');
    expect(doSource).toContain('projectId: string');
    expect(doSource).toContain('userId: string');
  });

  it('tracks current step in state machine', () => {
    expect(doSource).toContain('currentStep: TaskExecutionStep');
  });

  it('tracks step results (nodeId, workspaceId, etc)', () => {
    expect(doSource).toContain('stepResults: StepResults');
    expect(doSource).toContain('nodeId: string | null');
    expect(doSource).toContain('workspaceId: string | null');
    expect(doSource).toContain('agentSessionId: string | null');
    expect(doSource).toContain('autoProvisioned: boolean');
  });

  it('tracks retry state', () => {
    expect(doSource).toContain('retryCount: number');
  });

  it('tracks workspace ready callback state', () => {
    expect(doSource).toContain('workspaceReadyReceived: boolean');
    expect(doSource).toContain("workspaceReadyStatus: 'running' | 'recovery' | 'error' | null");
  });

  it('tracks timeout boundaries', () => {
    expect(doSource).toContain('agentReadyStartedAt: number | null');
    expect(doSource).toContain('workspaceReadyStartedAt: number | null');
  });

  it('has terminal completion flag', () => {
    expect(doSource).toContain('completed: boolean');
  });
});

describe('TaskRunner DO public RPCs', () => {
  it('exports start() RPC', () => {
    expect(doSource).toContain('async start(input: StartTaskInput): Promise<void>');
  });

  it('exports advanceWorkspaceReady() RPC', () => {
    expect(doSource).toContain('async advanceWorkspaceReady(');
  });

  it('exports getStatus() RPC for debugging', () => {
    expect(doSource).toContain('async getStatus(): Promise<TaskRunnerState | null>');
  });

  it('start() is idempotent — skips if already initialized', () => {
    expect(doSource).toContain('already_initialized');
    expect(doSource).toContain('const existing = await this.getState()');
  });

  it('start() persists initial state to storage', () => {
    expect(doSource).toContain("await this.ctx.storage.put('state', state)");
  });

  it('start() schedules first alarm immediately', () => {
    const startSection = doSource.slice(
      doSource.indexOf('async start('),
      doSource.indexOf('async advanceWorkspaceReady(')
    );
    expect(startSection).toContain('setAlarm(now)');
  });
});

describe('TaskRunner DO alarm dispatch', () => {
  it('has alarm() handler', () => {
    expect(doSource).toContain('async alarm(): Promise<void>');
  });

  it('exits early if state is null or completed', () => {
    expect(doSource).toContain('if (!state || state.completed) return');
  });

  it('dispatches to all step handlers', () => {
    const stepHandlers = [
      'node_selection',
      'node_provisioning',
      'node_agent_ready',
      'workspace_creation',
      'workspace_ready',
      'agent_session',
    ];
    for (const step of stepHandlers) {
      expect(doSource).toContain(`case '${step}':`);
    }
  });

  it('handles running/awaiting_followup as terminal DO steps', () => {
    expect(doSource).toContain("case 'running':");
    expect(doSource).toContain("case 'awaiting_followup':");
  });

  it('logs unknown steps and fails the task', () => {
    expect(doSource).toContain('task_runner_do.unknown_step');
    expect(doSource).toContain('Unknown execution step');
  });
});

describe('TaskRunner DO retry logic', () => {
  it('catches errors in alarm handler', () => {
    const alarmSection = doSource.slice(
      doSource.indexOf('async alarm()'),
      doSource.indexOf('// ===', doSource.indexOf('async alarm()') + 100)
    );
    expect(alarmSection).toContain('} catch (err)');
  });

  it('checks isTransientError before retrying', () => {
    expect(doSource).toContain('isTransientError(err)');
  });

  it('checks max retries before retrying', () => {
    expect(doSource).toContain('state.retryCount < this.getMaxRetries()');
  });

  it('increments retryCount on transient failure', () => {
    expect(doSource).toContain('state.retryCount++');
  });

  it('computes backoff delay for retries', () => {
    expect(doSource).toContain('computeBackoffMs(');
    expect(doSource).toContain('this.getRetryBaseDelayMs()');
    expect(doSource).toContain('this.getRetryMaxDelayMs()');
  });

  it('fails task on permanent error or max retries exceeded', () => {
    expect(doSource).toContain('await this.failTask(state, errorMessage)');
  });

  it('logs retry scheduling with backoff info', () => {
    expect(doSource).toContain('task_runner_do.step_retry_scheduled');
    expect(doSource).toContain('backoffMs');
  });
});

describe('TaskRunner DO step advancement', () => {
  it('has advanceToStep helper', () => {
    expect(doSource).toContain('private async advanceToStep(');
  });

  it('resets retryCount on step advancement', () => {
    const advanceSection = doSource.slice(
      doSource.indexOf('private async advanceToStep('),
      doSource.indexOf('/**', doSource.indexOf('private async advanceToStep(') + 50)
    );
    expect(advanceSection).toContain('state.retryCount = 0');
  });

  it('schedules alarm immediately for next step', () => {
    const advanceSection = doSource.slice(
      doSource.indexOf('private async advanceToStep('),
      doSource.indexOf('/**', doSource.indexOf('private async advanceToStep(') + 50)
    );
    expect(advanceSection).toContain('setAlarm(Date.now())');
  });

  it('persists state before scheduling alarm', () => {
    const advanceSection = doSource.slice(
      doSource.indexOf('private async advanceToStep('),
      doSource.indexOf('/**', doSource.indexOf('private async advanceToStep(') + 50)
    );
    const putIdx = advanceSection.indexOf("storage.put('state'");
    const alarmIdx = advanceSection.indexOf('setAlarm');
    expect(putIdx).toBeGreaterThan(-1);
    expect(alarmIdx).toBeGreaterThan(putIdx);
  });
});

describe('TaskRunner DO step handlers', () => {
  describe('handleNodeSelection', () => {
    it('updates D1 execution step', () => {
      const section = doSource.slice(
        doSource.indexOf('private async handleNodeSelection('),
        doSource.indexOf('private async handleNodeProvisioning(')
      );
      expect(section).toContain("updateD1ExecutionStep(state.taskId, 'node_selection')");
    });

    it('checks preferred node first', () => {
      expect(doSource).toContain('state.config.preferredNodeId');
    });

    it('tries warm pool', () => {
      expect(doSource).toContain('tryClaimWarmNode(state)');
    });

    it('tries capacity-based selection', () => {
      expect(doSource).toContain('findNodeWithCapacity(state)');
    });

    it('falls through to provisioning if no node found', () => {
      expect(doSource).toContain("advanceToStep(state, 'node_provisioning')");
    });
  });

  describe('handleNodeProvisioning', () => {
    it('checks user node limit', () => {
      expect(doSource).toContain('maxNodes');
      expect(doSource).toContain('Cannot auto-provision');
    });

    it('creates node record and provisions', () => {
      expect(doSource).toContain('createNodeRecord');
      expect(doSource).toContain('provisionNode');
    });

    it('stores autoProvisionedNodeId on task', () => {
      expect(doSource).toContain('auto_provisioned_node_id');
    });

    it('advances to node_agent_ready after provisioning', () => {
      expect(doSource).toContain("advanceToStep(state, 'node_agent_ready')");
    });

    it('handles already-provisioned node on retry', () => {
      expect(doSource).toContain('if (state.stepResults.nodeId)');
    });
  });

  describe('handleNodeAgentReady', () => {
    it('initializes timeout tracking on first entry', () => {
      expect(doSource).toContain('if (!state.agentReadyStartedAt)');
    });

    it('checks timeout', () => {
      expect(doSource).toContain('this.getAgentReadyTimeoutMs()');
      expect(doSource).toContain('Node agent not ready within');
    });

    it('checks agent health via HTTP', () => {
      expect(doSource).toContain('/health');
      expect(doSource).toContain('response.ok');
    });

    it('schedules poll alarm if not ready', () => {
      expect(doSource).toContain('this.getAgentPollIntervalMs()');
    });
  });

  describe('handleWorkspaceCreation', () => {
    it('creates workspace in D1', () => {
      expect(doSource).toContain('db.insert(schema.workspaces)');
    });

    it('links existing chat session to workspace (TDF-6: no duplicate session creation)', () => {
      // Session linking is in ensureSessionLinked helper (shared by fresh + recovery paths)
      expect(doSource).toContain('private async ensureSessionLinked(');
      expect(doSource).toContain('linkSessionToWorkspace');
      expect(doSource).toContain('session_linked_to_workspace');
      expect(doSource).toContain('session_d1_linked');
      expect(doSource).toContain('session_d1_link_failed');
      expect(doSource).toContain('session_do_link_failed');
      // Must NOT create a new session — session is created at submit time
      const wsCreationStart = doSource.indexOf('private async handleWorkspaceCreation(');
      const wsCreationEnd = doSource.indexOf('private async handleWorkspaceReady(');
      const wsCreationSection = doSource.slice(wsCreationStart, wsCreationEnd);
      expect(wsCreationSection).not.toContain('createSession(');
    });

    it('creates workspace on VM agent', () => {
      expect(doSource).toContain('createWorkspaceOnNode');
    });

    it('signs callback token for workspace', () => {
      expect(doSource).toContain('signCallbackToken');
    });

    it('transitions task to delegated with optimistic locking', () => {
      expect(doSource).toContain("status = 'delegated'");
      expect(doSource).toContain("status = 'queued'");
    });

    it('aborts gracefully if cron already failed the task', () => {
      expect(doSource).toContain('aborted_by_recovery');
    });
  });

  describe('handleWorkspaceReady', () => {
    it('checks callback-received flag first', () => {
      expect(doSource).toContain('state.workspaceReadyReceived');
    });

    it('checks timeout', () => {
      expect(doSource).toContain('this.getWorkspaceReadyTimeoutMs()');
    });

    it('falls back to D1 polling', () => {
      expect(doSource).toContain('workspace_ready_from_d1');
    });

    it('advances to agent_session on ready', () => {
      expect(doSource).toContain("advanceToStep(state, 'agent_session')");
    });
  });

  describe('handleAgentSession', () => {
    it('creates agent session in D1', () => {
      expect(doSource).toContain('db.insert(schema.agentSessions)');
    });

    it('creates agent session on VM agent', () => {
      expect(doSource).toContain('createAgentSessionOnNode');
    });

    it('transitions to in_progress', () => {
      expect(doSource).toContain('transitionToInProgress');
    });

    it('handles already-created session on retry', () => {
      expect(doSource).toContain('state.stepResults.agentSessionId');
    });
  });
});

describe('TaskRunner DO failure handling', () => {
  it('has failTask method', () => {
    expect(doSource).toContain('private async failTask(');
  });

  it('checks for terminal status before failing (idempotent)', () => {
    const failSection = doSource.slice(
      doSource.indexOf('private async failTask('),
      doSource.indexOf('private async cleanupOnFailure(')
    );
    expect(failSection).toContain("'failed'");
    expect(failSection).toContain("'completed'");
    expect(failSection).toContain("'cancelled'");
  });

  it('writes to OBSERVABILITY_DATABASE on failure', () => {
    expect(doSource).toContain('OBSERVABILITY_DATABASE');
    expect(doSource).toContain("INSERT INTO errors");
  });

  it('calls cleanupOnFailure after failing', () => {
    expect(doSource).toContain('await this.cleanupOnFailure(state)');
  });

  it('marks DO as completed after failure', () => {
    const failSection = doSource.slice(
      doSource.indexOf('private async failTask('),
      doSource.indexOf('private async cleanupOnFailure(')
    );
    expect(failSection).toContain('state.completed = true');
  });
});

describe('TaskRunner DO cleanup', () => {
  it('has cleanupOnFailure method', () => {
    expect(doSource).toContain('private async cleanupOnFailure(');
  });

  it('stops workspace if it exists', () => {
    const cleanupSection = doSource.slice(
      doSource.indexOf('private async cleanupOnFailure('),
      doSource.indexOf('// =====', doSource.indexOf('private async cleanupOnFailure(') + 100)
    );
    expect(cleanupSection).toContain('stopWorkspaceOnNode');
  });

  it('delegates to cleanupTaskRun for auto-provisioned nodes', () => {
    expect(doSource).toContain("import('../services/task-runner')");
    expect(doSource).toContain('cleanupTaskRun');
  });
});

describe('TaskRunner DO configuration', () => {
  const configMethods = [
    'getMaxRetries',
    'getRetryBaseDelayMs',
    'getRetryMaxDelayMs',
    'getAgentPollIntervalMs',
    'getAgentReadyTimeoutMs',
    'getWorkspaceReadyTimeoutMs',
    'getProvisionPollIntervalMs',
  ];

  for (const method of configMethods) {
    it(`has ${method}() configuration method`, () => {
      expect(doSource).toContain(`private ${method}()`);
    });

    it(`${method}() reads from env var with DEFAULT fallback`, () => {
      const section = doSource.slice(
        doSource.indexOf(`private ${method}()`),
        doSource.indexOf('}', doSource.indexOf(`private ${method}()`) + 50) + 1
      );
      expect(section).toContain('parseEnvInt');
      expect(section).toContain('this.env.');
      expect(section).toContain('DEFAULT_TASK_RUNNER');
    });
  }
});

describe('TaskRunner DO warm node selection', () => {
  it('has tryClaimWarmNode helper', () => {
    expect(doSource).toContain('private async tryClaimWarmNode(');
  });

  it('queries warm nodes from D1', () => {
    expect(doSource).toContain('warm_since IS NOT NULL');
  });

  it('sorts by size/location preference', () => {
    expect(doSource).toContain('state.config.vmSize');
    expect(doSource).toContain('state.config.vmLocation');
  });

  it('claims via NodeLifecycle DO', () => {
    expect(doSource).toContain('NODE_LIFECYCLE.idFromName');
    expect(doSource).toContain('stub.tryClaim(state.taskId)');
  });

  it('has findNodeWithCapacity helper', () => {
    expect(doSource).toContain('private async findNodeWithCapacity(');
  });

  it('respects CPU and memory thresholds', () => {
    expect(doSource).toContain('TASK_RUN_NODE_CPU_THRESHOLD_PERCENT');
    expect(doSource).toContain('TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT');
  });

  it('respects max workspaces per node', () => {
    expect(doSource).toContain('MAX_WORKSPACES_PER_NODE');
  });
});
