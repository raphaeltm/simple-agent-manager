/**
 * TDF-5: Workspace Lifecycle — Event-Driven Readiness Tests
 *
 * Validates that the workspace-ready flow is purely callback-driven:
 * - handleWorkspaceReady() does NOT poll D1
 * - /ready and /provisioning-failed handlers notify the DO inline (not waitUntil)
 * - advanceWorkspaceReady() handles all race conditions correctly
 * - Timeout alarm is the only fallback
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const doSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);
const routeSource = readFileSync(
  resolve(process.cwd(), 'src/routes/workspaces.ts'),
  'utf8'
);

// ============================================================================
// handleWorkspaceReady — Pure Callback-Driven (No D1 Polling)
// ============================================================================

describe('handleWorkspaceReady — pure callback-driven (TDF-5)', () => {
  // Extract the handleWorkspaceReady method section for precise assertions
  const wsReadySection = doSource.slice(
    doSource.indexOf('private async handleWorkspaceReady('),
    doSource.indexOf('private async handleAgentSession(')
  );

  it('does NOT query D1 for workspace status', () => {
    // The D1 fallback poll has been removed in TDF-5
    expect(wsReadySection).not.toContain('workspace_ready_from_d1');
    expect(wsReadySection).not.toContain('SELECT status, error_message FROM workspaces');
    expect(wsReadySection).not.toContain('this.env.DATABASE.prepare');
  });

  it('checks callback-received flag (workspaceReadyReceived)', () => {
    expect(wsReadySection).toContain('state.workspaceReadyReceived');
  });

  it('advances to agent_session on running status', () => {
    expect(wsReadySection).toContain("state.workspaceReadyStatus === 'running'");
    expect(wsReadySection).toContain("advanceToStep(state, 'agent_session')");
  });

  it('advances to agent_session on recovery status', () => {
    expect(wsReadySection).toContain("state.workspaceReadyStatus === 'recovery'");
  });

  it('throws permanent error on error status', () => {
    expect(wsReadySection).toContain("state.workspaceReadyStatus === 'error'");
    expect(wsReadySection).toContain('{ permanent: true }');
    expect(wsReadySection).toContain('Workspace creation failed');
  });

  it('uses workspace error message when available', () => {
    expect(wsReadySection).toContain('state.workspaceErrorMessage');
  });

  it('checks timeout when no callback received', () => {
    expect(wsReadySection).toContain('this.getWorkspaceReadyTimeoutMs()');
    expect(wsReadySection).toContain('Workspace did not become ready within');
    expect(wsReadySection).toContain('{ permanent: true }');
  });

  it('initializes timeout tracking on first entry', () => {
    expect(wsReadySection).toContain('if (!state.workspaceReadyStartedAt)');
    expect(wsReadySection).toContain('state.workspaceReadyStartedAt = Date.now()');
  });

  it('schedules alarm at remaining timeout boundary (not fixed poll interval)', () => {
    expect(wsReadySection).toContain('const remaining = timeoutMs - elapsed');
    expect(wsReadySection).toContain('setAlarm(Date.now() + remaining)');
  });

  it('does NOT use agent poll interval for workspace ready step', () => {
    // getAgentPollIntervalMs() should NOT appear in handleWorkspaceReady
    expect(wsReadySection).not.toContain('this.getAgentPollIntervalMs()');
  });

  it('updates D1 execution step on entry', () => {
    expect(wsReadySection).toContain("updateD1ExecutionStep(state.taskId, 'workspace_ready')");
  });

  it('references TDF-5 in comment explaining D1 polling removal', () => {
    expect(wsReadySection).toContain('TDF-5');
    expect(wsReadySection).toContain('D1 polling has been removed');
  });

  it('references TDF-4 callback retry in comment', () => {
    expect(wsReadySection).toContain('TDF-4');
    expect(wsReadySection).toContain('exponential backoff');
  });
});

// ============================================================================
// advanceWorkspaceReady — RPC Signal Handling
// ============================================================================

describe('advanceWorkspaceReady — callback signal handling', () => {
  const advanceSection = doSource.slice(
    doSource.indexOf('async advanceWorkspaceReady('),
    doSource.indexOf('async getStatus()')
  );

  it('returns early if state is null', () => {
    expect(advanceSection).toContain('if (!state || state.completed) return');
  });

  it('returns early if DO is completed', () => {
    expect(advanceSection).toContain('state.completed');
  });

  it('stores workspaceReadyReceived flag', () => {
    expect(advanceSection).toContain('state.workspaceReadyReceived = true');
  });

  it('stores workspaceReadyStatus', () => {
    expect(advanceSection).toContain('state.workspaceReadyStatus = status');
  });

  it('stores workspaceErrorMessage', () => {
    expect(advanceSection).toContain('state.workspaceErrorMessage = errorMessage');
  });

  it('persists state after storing callback signal', () => {
    expect(advanceSection).toContain("this.ctx.storage.put('state', state)");
  });

  it('fires immediate alarm when DO is at workspace_ready step', () => {
    expect(advanceSection).toContain("state.currentStep === 'workspace_ready'");
    expect(advanceSection).toContain('setAlarm(Date.now())');
  });

  it('does NOT fire alarm when DO is at a different step (stored for later)', () => {
    // The alarm is only set when currentStep === 'workspace_ready'.
    // For other steps, the signal is just persisted and the existing
    // alarm flow will pick it up when it reaches workspace_ready.
    const alarmSetLine = advanceSection.indexOf("setAlarm(Date.now())");
    const conditionalCheck = advanceSection.indexOf("state.currentStep === 'workspace_ready'");
    // The alarm set should appear AFTER the conditional check
    expect(conditionalCheck).toBeLessThan(alarmSetLine);
  });

  it('accepts running status', () => {
    expect(advanceSection).toContain("'running' | 'recovery' | 'error'");
  });

  it('accepts recovery status', () => {
    expect(advanceSection).toContain("'running' | 'recovery' | 'error'");
  });

  it('accepts error status with error message', () => {
    expect(advanceSection).toContain('errorMessage: string | null');
  });

  it('logs callback receipt with task context', () => {
    expect(advanceSection).toContain('task_runner_do.workspace_ready_received');
    expect(advanceSection).toContain('taskId');
    expect(advanceSection).toContain('currentStep');
    expect(advanceSection).toContain('status');
  });
});

// ============================================================================
// /ready Route — Inline DO Notification (TDF-5)
// ============================================================================

describe('/ready route — inline DO notification (TDF-5)', () => {
  // Extract the /ready handler
  const readyHandlerStart = routeSource.indexOf("workspacesRoutes.post('/:id/ready'");
  const readyHandlerEnd = routeSource.indexOf(
    "workspacesRoutes.post('/:id/provisioning-failed'"
  );
  const readyHandler = routeSource.slice(readyHandlerStart, readyHandlerEnd);

  it('calls advanceTaskRunnerWorkspaceReady inline (not in waitUntil)', () => {
    expect(readyHandler).toContain('advanceTaskRunnerWorkspaceReady');
    // Should NOT use waitUntil() function call for DO notification
    // (comments may reference waitUntil() to explain the change, so check for actual usage)
    expect(readyHandler).not.toContain('c.executionCtx.waitUntil(');
    expect(readyHandler).toContain('await advanceTaskRunnerWorkspaceReady');
  });

  it('imports advanceTaskRunnerWorkspaceReady from task-runner-do service', () => {
    expect(readyHandler).toContain("import('../services/task-runner-do')");
  });

  it('looks up task by workspace ID', () => {
    expect(readyHandler).toContain('schema.tasks.workspaceId');
    expect(readyHandler).toContain('workspaceId');
  });

  it('only advances tasks in queued or delegated status', () => {
    expect(readyHandler).toContain("'queued', 'delegated'");
  });

  it('maps running status correctly', () => {
    expect(readyHandler).toContain("nextStatus === 'running' ? 'running'");
  });

  it('maps recovery status correctly', () => {
    expect(readyHandler).toContain("nextStatus === 'recovery' ? 'recovery'");
  });

  it('references TDF-5 in comment', () => {
    expect(readyHandler).toContain('TDF-5');
  });

  it('references TDF-4 retry in comment', () => {
    expect(readyHandler).toContain('TDF-4');
  });

  it('updates D1 workspace status before notifying DO', () => {
    const updateIdx = readyHandler.indexOf('.update(schema.workspaces)');
    const doNotifyIdx = readyHandler.indexOf('advanceTaskRunnerWorkspaceReady');
    expect(updateIdx).toBeGreaterThan(-1);
    expect(doNotifyIdx).toBeGreaterThan(updateIdx);
  });

  it('verifies workspace callback auth', () => {
    expect(readyHandler).toContain('verifyWorkspaceCallbackAuth');
  });

  it('returns 404 if workspace not found', () => {
    expect(readyHandler).toContain("errors.notFound('Workspace')");
  });

  it('skips notification if workspace is stopping/stopped', () => {
    expect(readyHandler).toContain("workspace.status === 'stopping'");
    expect(readyHandler).toContain("workspace.status === 'stopped'");
  });
});

// ============================================================================
// /provisioning-failed Route — Inline DO Notification (TDF-5)
// ============================================================================

describe('/provisioning-failed route — inline DO notification (TDF-5)', () => {
  // Extract the /provisioning-failed handler
  const failedHandlerStart = routeSource.indexOf(
    "workspacesRoutes.post('/:id/provisioning-failed'"
  );
  const failedHandlerEnd = routeSource.indexOf(
    "workspacesRoutes.post('/:id/agent-key'"
  );
  const failedHandler = routeSource.slice(failedHandlerStart, failedHandlerEnd);

  it('calls advanceTaskRunnerWorkspaceReady with error status inline', () => {
    expect(failedHandler).toContain('advanceTaskRunnerWorkspaceReady');
    expect(failedHandler).toContain("'error'");
    // Should NOT use waitUntil() function call for DO notification
    expect(failedHandler).not.toContain('c.executionCtx.waitUntil(');
    expect(failedHandler).toContain('await advanceTaskRunnerWorkspaceReady');
  });

  it('imports advanceTaskRunnerWorkspaceReady from task-runner-do service', () => {
    expect(failedHandler).toContain("import('../services/task-runner-do')");
  });

  it('passes error message to DO', () => {
    expect(failedHandler).toContain('errorMessage');
  });

  it('only advances tasks in queued or delegated status', () => {
    expect(failedHandler).toContain("'queued', 'delegated'");
  });

  it('references TDF-5 in comment', () => {
    expect(failedHandler).toContain('TDF-5');
  });

  it('references TDF-4 retry in comment', () => {
    expect(failedHandler).toContain('TDF-4');
  });

  it('updates D1 workspace status to error before notifying DO', () => {
    const updateIdx = failedHandler.indexOf("status: 'error'");
    const doNotifyIdx = failedHandler.indexOf('advanceTaskRunnerWorkspaceReady');
    expect(updateIdx).toBeGreaterThan(-1);
    expect(doNotifyIdx).toBeGreaterThan(updateIdx);
  });

  it('only processes workspaces in creating status', () => {
    expect(failedHandler).toContain("workspace.status !== 'creating'");
    expect(failedHandler).toContain("reason: 'workspace_not_creating'");
  });

  it('uses provided error message or default', () => {
    expect(failedHandler).toContain("'Workspace provisioning failed'");
  });

  it('verifies workspace callback auth', () => {
    expect(failedHandler).toContain('verifyWorkspaceCallbackAuth');
  });
});

// ============================================================================
// Idempotency & Race Condition Coverage
// ============================================================================

describe('workspace lifecycle race condition handling', () => {
  it('advanceWorkspaceReady is idempotent — no-op when completed', () => {
    const advanceSection = doSource.slice(
      doSource.indexOf('async advanceWorkspaceReady('),
      doSource.indexOf('async getStatus()')
    );
    // First check: state is null or completed -> return
    expect(advanceSection).toContain('if (!state || state.completed) return');
  });

  it('DO guarantees single-threaded execution (no concurrent RPC + alarm)', () => {
    // This is a Cloudflare platform guarantee — DOs process one request at a time.
    // We verify the DO extends DurableObject which provides this guarantee.
    expect(doSource).toContain('extends DurableObject<TaskRunnerEnv>');
  });

  it('callback stores signal even when DO not at workspace_ready step', () => {
    const advanceSection = doSource.slice(
      doSource.indexOf('async advanceWorkspaceReady('),
      doSource.indexOf('async getStatus()')
    );
    // Signal is always stored, alarm is only fired if at workspace_ready
    expect(advanceSection).toContain('state.workspaceReadyReceived = true');
    expect(advanceSection).toContain("if (state.currentStep === 'workspace_ready')");
  });

  it('alarm handler checks callback flag before doing anything else', () => {
    const wsReadySection = doSource.slice(
      doSource.indexOf('private async handleWorkspaceReady('),
      doSource.indexOf('private async handleAgentSession(')
    );
    // callback check comes before timeout check
    const callbackCheckIdx = wsReadySection.indexOf('state.workspaceReadyReceived');
    const timeoutCheckIdx = wsReadySection.indexOf('elapsed > timeoutMs');
    expect(callbackCheckIdx).toBeGreaterThan(-1);
    expect(timeoutCheckIdx).toBeGreaterThan(callbackCheckIdx);
  });

  it('timeout check uses configurable env var', () => {
    const wsReadySection = doSource.slice(
      doSource.indexOf('private async handleWorkspaceReady('),
      doSource.indexOf('private async handleAgentSession(')
    );
    expect(wsReadySection).toContain('this.getWorkspaceReadyTimeoutMs()');
  });

  it('alarm handler exits early if state is null or completed', () => {
    const alarmSection = doSource.slice(
      doSource.indexOf('async alarm(): Promise<void>'),
      doSource.indexOf('// =', doSource.indexOf('async alarm(): Promise<void>') + 100)
    );
    expect(alarmSection).toContain('if (!state || state.completed) return');
  });
});

// ============================================================================
// No Residual D1 Polling in DO
// ============================================================================

describe('no residual D1 polling in handleWorkspaceReady', () => {
  const wsReadySection = doSource.slice(
    doSource.indexOf('private async handleWorkspaceReady('),
    doSource.indexOf('private async handleAgentSession(')
  );

  it('does not reference SELECT statements', () => {
    expect(wsReadySection).not.toContain('SELECT');
  });

  it('does not reference this.env.DATABASE.prepare', () => {
    expect(wsReadySection).not.toContain('this.env.DATABASE.prepare');
  });

  it('does not reference workspace_ready_from_d1 log key', () => {
    expect(wsReadySection).not.toContain('workspace_ready_from_d1');
  });

  it('does not reference getAgentPollIntervalMs', () => {
    expect(wsReadySection).not.toContain('getAgentPollIntervalMs');
  });

  it('only uses updateD1ExecutionStep as the sole D1 interaction', () => {
    // The only D1 call from handleWorkspaceReady should be the execution step update
    // which happens at the top of every step handler
    expect(wsReadySection).toContain("updateD1ExecutionStep(state.taskId, 'workspace_ready')");
  });
});

// ============================================================================
// Timeout Alarm Strategy
// ============================================================================

describe('workspace ready timeout alarm strategy', () => {
  const wsReadySection = doSource.slice(
    doSource.indexOf('private async handleWorkspaceReady('),
    doSource.indexOf('private async handleAgentSession(')
  );

  it('calculates remaining time until timeout', () => {
    expect(wsReadySection).toContain('const remaining = timeoutMs - elapsed');
  });

  it('schedules alarm at remaining time boundary', () => {
    expect(wsReadySection).toContain('setAlarm(Date.now() + remaining)');
  });

  it('uses permanent error flag for timeout', () => {
    expect(wsReadySection).toContain("{ permanent: true }");
  });

  it('includes timeout duration in error message', () => {
    expect(wsReadySection).toContain('`Workspace did not become ready within ${timeoutMs}ms`');
  });
});

// ============================================================================
// Service Bridge (task-runner-do.ts)
// ============================================================================

describe('task-runner-do service bridge', () => {
  const serviceSource = readFileSync(
    resolve(process.cwd(), 'src/services/task-runner-do.ts'),
    'utf8'
  );

  it('exports advanceTaskRunnerWorkspaceReady function', () => {
    expect(serviceSource).toContain('export async function advanceTaskRunnerWorkspaceReady');
  });

  it('accepts status parameter (running, recovery, error)', () => {
    expect(serviceSource).toContain("status: 'running' | 'recovery' | 'error'");
  });

  it('accepts nullable error message', () => {
    expect(serviceSource).toContain('errorMessage: string | null');
  });

  it('calls stub.advanceWorkspaceReady', () => {
    expect(serviceSource).toContain('stub.advanceWorkspaceReady(status, errorMessage)');
  });

  it('looks up DO by taskId using idFromName', () => {
    expect(serviceSource).toContain('env.TASK_RUNNER.idFromName(taskId)');
  });

  it('logs the advancement', () => {
    expect(serviceSource).toContain('task_runner_do_service.workspace_ready_advanced');
  });
});
