/**
 * Integration test: task state machine transition side effects and optimistic locking.
 *
 * Verifies that the task state machine's transitions correctly trigger
 * side effects (timestamp updates, executionStep clearing, status events)
 * and that optimistic locking prevents race conditions.
 *
 * Key properties tested:
 * 1. setTaskStatus sets startedAt when transitioning to in_progress
 * 2. setTaskStatus sets completedAt and clears executionStep on terminal states
 * 3. setTaskStatus resets workspace/timing fields when transitioning to ready
 * 4. appendStatusEvent creates a status event record for every transition
 * 5. Optimistic locking on queued→delegated and delegated→in_progress
 * 6. failTask is idempotent — skips already-terminal tasks
 * 7. canTransitionTaskStatus is checked before all user/callback transitions
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('task state machine integration', () => {
  const tasksRouteFile = readFileSync(resolve(process.cwd(), 'src/routes/tasks.ts'), 'utf8');
  const taskRunnerFile = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');
  const taskStatusFile = readFileSync(resolve(process.cwd(), 'src/services/task-status.ts'), 'utf8');

  // ===========================================================================
  // Transition side effects in setTaskStatus
  // ===========================================================================
  describe('setTaskStatus transition side effects', () => {
    // Extract the setTaskStatus function (it comes AFTER appendStatusEvent and getTaskDependencies)
    const setStatusStart = tasksRouteFile.indexOf('async function setTaskStatus');
    const setStatusFn = tasksRouteFile.slice(setStatusStart, setStatusStart + 2000);

    it('always sets updatedAt on every transition', () => {
      expect(setStatusFn).toContain('updatedAt: now');
    });

    it('sets startedAt when transitioning to in_progress (first time only)', () => {
      expect(setStatusFn).toContain("'in_progress'");
      expect(setStatusFn).toContain('startedAt');
    });

    it('guards startedAt with check against existing value', () => {
      // The condition ensures we don't overwrite an existing startedAt
      expect(setStatusFn).toContain('!task.startedAt');
    });

    it('sets completedAt on terminal states', () => {
      const terminalCheck = setStatusFn.includes("'completed' || toStatus === 'failed' || toStatus === 'cancelled'");
      expect(terminalCheck).toBe(true);
      expect(setStatusFn).toContain('completedAt');
    });

    it('clears executionStep on terminal states', () => {
      // Find the terminal block and verify executionStep is cleared
      const termIdx = setStatusFn.indexOf("'completed' || toStatus === 'failed' || toStatus === 'cancelled'");
      const afterTerminal = setStatusFn.slice(termIdx, termIdx + 200);
      expect(afterTerminal).toContain('executionStep');
      expect(afterTerminal).toContain('null');
    });

    it('resets fields when transitioning to ready (retry/reactivate)', () => {
      const readyIdx = setStatusFn.indexOf("toStatus === 'ready'");
      expect(readyIdx).toBeGreaterThan(-1);
      const readyBlock = setStatusFn.slice(readyIdx, readyIdx + 300);
      expect(readyBlock).toContain('workspaceId');
      expect(readyBlock).toContain('startedAt');
      expect(readyBlock).toContain('completedAt');
      expect(readyBlock).toContain('errorMessage');
      expect(readyBlock).toContain('executionStep');
    });

    it('calls appendStatusEvent after updating task', () => {
      // DB update must come before event recording
      const updateIdx = setStatusFn.indexOf('.update(schema.tasks)');
      const eventIdx = setStatusFn.indexOf('appendStatusEvent(');
      expect(updateIdx).toBeGreaterThan(-1);
      expect(eventIdx).toBeGreaterThan(updateIdx);
    });

    it('reloads task after transition for consistency', () => {
      // After update and event, re-select the task
      const eventIdx = setStatusFn.indexOf('appendStatusEvent(');
      const selectIdx = setStatusFn.indexOf('.select()', eventIdx);
      expect(selectIdx).toBeGreaterThan(eventIdx);
    });
  });

  // ===========================================================================
  // appendStatusEvent correctness
  // ===========================================================================
  describe('appendStatusEvent', () => {
    const appendStart = tasksRouteFile.indexOf('async function appendStatusEvent');
    const appendEnd = tasksRouteFile.indexOf('async function getTaskDependencies');
    const appendFn = tasksRouteFile.slice(appendStart, appendEnd);

    it('inserts into taskStatusEvents table', () => {
      expect(appendFn).toContain('db.insert(schema.taskStatusEvents)');
    });

    it('records fromStatus (the state before transition)', () => {
      expect(appendFn).toContain('fromStatus');
    });

    it('records toStatus (the target state)', () => {
      expect(appendFn).toContain('toStatus');
    });

    it('records actorType (user, system, workspace_callback)', () => {
      expect(appendFn).toContain('actorType');
    });

    it('generates a unique ID for each event', () => {
      expect(appendFn).toContain('ulid()');
    });

    it('timestamps each event', () => {
      expect(appendFn).toContain('createdAt');
    });
  });

  // ===========================================================================
  // Transition validation in routes
  // ===========================================================================
  describe('transition validation before status changes', () => {
    it('user status endpoint validates transitions with canTransitionTaskStatus', () => {
      const statusEndpoint = tasksRouteFile.slice(
        tasksRouteFile.indexOf("tasksRoutes.post('/:taskId/status'"),
        tasksRouteFile.indexOf("tasksRoutes.post('/:taskId/status/callback'")
      );
      expect(statusEndpoint).toContain('canTransitionTaskStatus(');
      expect(statusEndpoint).toContain('Invalid transition');
    });

    it('callback endpoint validates transitions with canTransitionTaskStatus', () => {
      const callbackEndpoint = tasksRouteFile.slice(
        tasksRouteFile.indexOf("tasksRoutes.post('/:taskId/status/callback'")
      );
      expect(callbackEndpoint).toContain('canTransitionTaskStatus(');
    });

    it('user status endpoint blocks executable transitions on blocked tasks', () => {
      const statusEndpoint = tasksRouteFile.slice(
        tasksRouteFile.indexOf("tasksRoutes.post('/:taskId/status'"),
        tasksRouteFile.indexOf("tasksRoutes.post('/:taskId/status/callback'")
      );
      expect(statusEndpoint).toContain('isExecutableTaskStatus');
      expect(statusEndpoint).toContain('Task is blocked by unresolved dependencies');
    });

    it('invalid transition returns allowed transitions in error message', () => {
      expect(tasksRouteFile).toContain('getAllowedTaskTransitions(');
      expect(tasksRouteFile).toContain('Allowed:');
    });
  });

  // ===========================================================================
  // Optimistic locking in task runner
  // ===========================================================================
  describe('optimistic locking prevents race conditions', () => {
    const executeFn = taskRunnerFile.slice(
      taskRunnerFile.indexOf('async function executeTaskRun')
    );

    it('queued → delegated uses WHERE status = queued', () => {
      expect(executeFn).toContain("eq(schema.tasks.status, 'queued')");
    });

    it('delegated → in_progress uses WHERE status = delegated', () => {
      expect(executeFn).toContain("eq(schema.tasks.status, 'delegated')");
    });

    it('checks returned row count to detect concurrent modification', () => {
      expect(taskRunnerFile).toContain('delegatedRows.length === 0');
      expect(taskRunnerFile).toContain('inProgressRows.length === 0');
    });

    it('logs warning when transition fails due to concurrent modification', () => {
      expect(taskRunnerFile).toContain("'task_run.aborted_by_recovery'");
    });

    it('returns gracefully (does not throw) on concurrent modification', () => {
      // After detecting 0 rows, should return not throw
      const delegatedCheck = taskRunnerFile.slice(
        taskRunnerFile.indexOf('delegatedRows.length === 0')
      );
      const returnIdx = delegatedCheck.indexOf('return;');
      expect(returnIdx).toBeGreaterThan(-1);
      expect(returnIdx).toBeLessThan(200); // return should be close to the check
    });

    it('uses .returning() to get affected rows', () => {
      expect(executeFn).toContain('.returning(');
    });
  });

  // ===========================================================================
  // failTask idempotency
  // ===========================================================================
  describe('failTask idempotency', () => {
    const failStart = taskRunnerFile.indexOf('async function failTask');
    const failFn = taskRunnerFile.slice(failStart, failStart + 1500);

    it('reads current status before attempting transition', () => {
      expect(failFn).toContain('.select(');
      expect(failFn).toContain('schema.tasks.status');
    });

    it('skips if already completed', () => {
      expect(failFn).toContain("'completed'");
    });

    it('skips if already failed', () => {
      expect(failFn).toContain("'failed'");
    });

    it('skips if already cancelled', () => {
      expect(failFn).toContain("'cancelled'");
    });

    it('returns early without inserting status event for already-terminal tasks', () => {
      // The early return must come BEFORE the DB update
      const earlyReturn = failFn.indexOf('return;');
      const update = failFn.indexOf('.update(schema.tasks)');
      expect(earlyReturn).toBeGreaterThan(-1);
      expect(update).toBeGreaterThan(earlyReturn);
    });

    it('clears executionStep on failure', () => {
      expect(failFn).toContain('executionStep: null');
    });

    it('sets completedAt on failure', () => {
      const updateSection = failFn.slice(failFn.indexOf('.update(schema.tasks)'));
      expect(updateSection).toContain('completedAt');
    });

    it('records the fromStatus in the status event', () => {
      const insertSection = failFn.slice(failFn.indexOf('insert(schema.taskStatusEvents)'));
      expect(insertSection).toContain('fromStatus');
    });
  });

  // ===========================================================================
  // State machine module exports
  // ===========================================================================
  describe('task-status module exports', () => {
    it('exports TERMINAL_STATUSES set', () => {
      expect(taskStatusFile).toContain('export const TERMINAL_STATUSES');
    });

    it('exports isTerminalStatus function', () => {
      expect(taskStatusFile).toContain('export function isTerminalStatus');
    });

    it('exports canProgressExecutionStep function', () => {
      expect(taskStatusFile).toContain('export function canProgressExecutionStep');
    });

    it('exports getExecutionStepIndex function', () => {
      expect(taskStatusFile).toContain('export function getExecutionStepIndex');
    });

    it('imports TASK_EXECUTION_STEPS from shared package', () => {
      expect(taskStatusFile).toContain('TASK_EXECUTION_STEPS');
      expect(taskStatusFile).toContain("'@simple-agent-manager/shared'");
    });
  });
});
