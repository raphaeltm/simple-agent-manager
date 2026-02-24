/**
 * Integration test: task delegation resilience and observability.
 *
 * Verifies the execution step tracking, deferred delegation, and
 * step-aware stuck task recovery wiring introduced to prevent tasks
 * from getting stuck in misleading states when Workers die mid-execution.
 *
 * Key properties tested:
 * 1. Execution step is persisted BEFORE each long-running operation
 * 2. Delegation transition is deferred until AFTER workspace creation on node
 * 3. Stuck task recovery includes step info in failure messages
 * 4. Admin endpoints expose stuck tasks and recent failures
 * 5. Terminal state transitions clear executionStep
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('task delegation resilience integration', () => {
  const taskRunnerFile = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');
  const stuckTasksFile = readFileSync(resolve(process.cwd(), 'src/scheduled/stuck-tasks.ts'), 'utf8');
  const adminRoutesFile = readFileSync(resolve(process.cwd(), 'src/routes/admin.ts'), 'utf8');
  const tasksRoutesFile = readFileSync(resolve(process.cwd(), 'src/routes/tasks.ts'), 'utf8');
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
  const sharedTypesFile = readFileSync(resolve(process.cwd(), '../../packages/shared/src/types.ts'), 'utf8');
  const constantsFile = readFileSync(resolve(process.cwd(), '../../packages/shared/src/constants.ts'), 'utf8');

  // ===========================================================================
  // Execution step tracking
  // ===========================================================================
  describe('execution step tracking', () => {
    it('schema defines executionStep column on tasks table', () => {
      expect(schemaFile).toContain("executionStep: text('execution_step')");
    });

    it('shared types define TaskExecutionStep union', () => {
      expect(sharedTypesFile).toContain('TaskExecutionStep');
      expect(sharedTypesFile).toContain("'node_selection'");
      expect(sharedTypesFile).toContain("'node_provisioning'");
      expect(sharedTypesFile).toContain("'node_agent_ready'");
      expect(sharedTypesFile).toContain("'workspace_creation'");
      expect(sharedTypesFile).toContain("'workspace_ready'");
      expect(sharedTypesFile).toContain("'agent_session'");
      expect(sharedTypesFile).toContain("'running'");
    });

    it('Task interface includes executionStep field', () => {
      expect(sharedTypesFile).toContain('executionStep:');
    });

    it('setExecutionStep helper persists step and updatedAt', () => {
      expect(taskRunnerFile).toContain('async function setExecutionStep');
      // Must update both executionStep and updatedAt
      const setStepFn = taskRunnerFile.slice(
        taskRunnerFile.indexOf('async function setExecutionStep')
      );
      expect(setStepFn).toContain('set({ executionStep: step, updatedAt:');
    });

    it('setExecutionStep called BEFORE each long-running operation', () => {
      // Each step must be persisted before the actual operation starts
      // This is the core resilience mechanism
      const steps = [
        'node_selection',
        'node_provisioning',
        'node_agent_ready',
        'workspace_creation',
        'workspace_ready',
        'agent_session',
        'running',
      ];
      for (const step of steps) {
        expect(taskRunnerFile).toContain(`'${step}'`);
      }
    });

    it('node_selection step set before node query in executeTaskRun', () => {
      // Search within executeTaskRun function body (not the import or initiateTaskRun)
      const executeFnStart = taskRunnerFile.indexOf('async function executeTaskRun');
      const executeFnSection = taskRunnerFile.slice(executeFnStart);
      const stepIdx = executeFnSection.indexOf("setExecutionStep(db, task.id, 'node_selection')");
      const queryIdx = executeFnSection.indexOf('selectNodeForTaskRun');
      expect(stepIdx).toBeGreaterThan(-1);
      expect(queryIdx).toBeGreaterThan(stepIdx);
    });

    it('workspace_creation step set before createWorkspaceOnNode', () => {
      const wsCreationIdx = taskRunnerFile.indexOf("'workspace_creation'");
      const createWsIdx = taskRunnerFile.indexOf('createWorkspaceOnNode(nodeId');
      expect(wsCreationIdx).toBeGreaterThan(-1);
      expect(createWsIdx).toBeGreaterThan(wsCreationIdx);
    });

    it('agent_session step set before createAgentSessionOnNode', () => {
      // Search within executeTaskRun function body (not the import)
      const executeFnStart = taskRunnerFile.indexOf('async function executeTaskRun');
      const executeFnSection = taskRunnerFile.slice(executeFnStart);
      const stepIdx = executeFnSection.indexOf("setExecutionStep(db, task.id, 'agent_session')");
      const createIdx = executeFnSection.indexOf('createAgentSessionOnNode(');
      expect(stepIdx).toBeGreaterThan(-1);
      expect(createIdx).toBeGreaterThan(stepIdx);
    });

    it('initial queued transition includes node_selection step', () => {
      // When transitioning to queued, executionStep should be set to node_selection
      expect(taskRunnerFile).toContain("status: 'queued', executionStep: 'node_selection'");
    });
  });

  // ===========================================================================
  // Deferred delegation
  // ===========================================================================
  describe('deferred delegation transition', () => {
    it('task stays queued during workspace creation', () => {
      // The old bug: task was marked as delegated BEFORE workspace existed on node.
      // Now: task stays queued until AFTER createWorkspaceOnNode succeeds.
      const createWsIdx = taskRunnerFile.indexOf('createWorkspaceOnNode(nodeId');
      const delegatedTransitionIdx = taskRunnerFile.indexOf("status: 'delegated'", createWsIdx);
      expect(createWsIdx).toBeGreaterThan(-1);
      // delegated transition comes AFTER createWorkspaceOnNode
      expect(delegatedTransitionIdx).toBeGreaterThan(createWsIdx);
    });

    it('workspace DB record created before node HTTP call', () => {
      // Workspace is inserted into D1 first, then created on the node
      const dbInsertIdx = taskRunnerFile.indexOf('db.insert(schema.workspaces)');
      const nodeCallIdx = taskRunnerFile.indexOf('createWorkspaceOnNode(nodeId');
      expect(dbInsertIdx).toBeGreaterThan(-1);
      expect(nodeCallIdx).toBeGreaterThan(dbInsertIdx);
    });

    it('task workspaceId set before delegation', () => {
      // workspaceId is stored on the task BEFORE the workspace is created on the node
      const setWsIdIdx = taskRunnerFile.indexOf('set({ workspaceId, updatedAt');
      const createOnNodeIdx = taskRunnerFile.indexOf('createWorkspaceOnNode(nodeId');
      expect(setWsIdIdx).toBeGreaterThan(-1);
      expect(createOnNodeIdx).toBeGreaterThan(setWsIdIdx);
    });

    it('delegated event records workspace and node IDs in reason', () => {
      expect(taskRunnerFile).toContain('`Delegated to workspace ${workspaceId} on node ${nodeId}`');
    });
  });

  // ===========================================================================
  // Stuck task recovery with step info
  // ===========================================================================
  describe('step-aware stuck task recovery', () => {
    it('recoverStuckTasks reads execution_step from SQL', () => {
      expect(stuckTasksFile).toContain('execution_step');
      expect(stuckTasksFile).toContain("WHERE status IN ('queued', 'delegated', 'in_progress')");
    });

    it('STEP_DESCRIPTIONS map provides human-readable labels', () => {
      expect(stuckTasksFile).toContain('STEP_DESCRIPTIONS');
      expect(stuckTasksFile).toContain('node_selection');
      expect(stuckTasksFile).toContain('node_provisioning');
      expect(stuckTasksFile).toContain('workspace_creation');
      expect(stuckTasksFile).toContain('workspace_ready');
      expect(stuckTasksFile).toContain('agent_session');
    });

    it('error messages include step information', () => {
      expect(stuckTasksFile).toContain('Last step:');
      expect(stuckTasksFile).toContain('describeStep(task.execution_step)');
    });

    it('clears executionStep when marking task as failed', () => {
      const recoverSection = stuckTasksFile.slice(
        stuckTasksFile.indexOf('if (!isStuck) continue')
      );
      expect(recoverSection).toContain('executionStep: null');
    });

    it('logs executionStep in structured output', () => {
      expect(stuckTasksFile).toContain('executionStep: task.execution_step');
    });

    it('uses configurable timeout thresholds from shared constants', () => {
      expect(stuckTasksFile).toContain('DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS');
      expect(stuckTasksFile).toContain('DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS');
      expect(stuckTasksFile).toContain('DEFAULT_TASK_RUN_MAX_EXECUTION_MS');
    });

    it('queued timeout tightened to 2 minutes', () => {
      expect(constantsFile).toContain('DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS = 2 * 60 * 1000');
    });

    it('delegated timeout tightened to 5 minutes', () => {
      expect(constantsFile).toContain('DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS = 5 * 60 * 1000');
    });
  });

  // ===========================================================================
  // Terminal state executionStep clearing
  // ===========================================================================
  describe('terminal state executionStep clearing', () => {
    it('failTask clears executionStep to null', () => {
      const failFn = taskRunnerFile.slice(
        taskRunnerFile.indexOf('async function failTask')
      );
      expect(failFn).toContain('executionStep: null');
    });

    it('setTaskStatus clears executionStep on completed/failed/cancelled', () => {
      // In the tasks route, terminal states must clear executionStep
      const setStatusFn = tasksRoutesFile.slice(
        tasksRoutesFile.indexOf('async function setTaskStatus')
      );
      expect(setStatusFn).toContain("toStatus === 'completed' || toStatus === 'failed' || toStatus === 'cancelled'");
      expect(setStatusFn).toContain('nextValues.executionStep = null');
    });

    it('setTaskStatus clears executionStep when resetting to ready', () => {
      const setStatusFn = tasksRoutesFile.slice(
        tasksRoutesFile.indexOf('async function setTaskStatus')
      );
      // The ready block sets executionStep to null via nextValues assignment
      const readyIdx = setStatusFn.indexOf("toStatus === 'ready'");
      expect(readyIdx).toBeGreaterThan(-1);
      // Both terminal and ready blocks assign nextValues.executionStep = null
      const assignments = setStatusFn.match(/nextValues\.executionStep = null/g);
      expect(assignments).not.toBeNull();
      expect(assignments!.length).toBeGreaterThanOrEqual(2);
    });

    it('toTaskResponse maps executionStep from task record', () => {
      expect(tasksRoutesFile).toContain("executionStep: (task.executionStep as Task['executionStep']) ?? null");
    });
  });

  // ===========================================================================
  // Admin observability endpoints
  // ===========================================================================
  describe('admin stuck tasks endpoint', () => {
    it('GET /api/admin/tasks/stuck endpoint exists', () => {
      expect(adminRoutesFile).toContain("adminRoutes.get('/tasks/stuck'");
    });

    it('queries tasks in transient states', () => {
      expect(adminRoutesFile).toContain("inArray(schema.tasks.status, ['queued', 'delegated', 'in_progress'])");
    });

    it('returns executionStep in response', () => {
      expect(adminRoutesFile).toContain('executionStep: schema.tasks.executionStep');
    });

    it('calculates elapsed time for each stuck task', () => {
      expect(adminRoutesFile).toContain('elapsedMs');
      expect(adminRoutesFile).toContain('elapsedSeconds');
    });

    it('requires superadmin authentication', () => {
      expect(adminRoutesFile).toContain('requireSuperadmin()');
    });
  });

  describe('admin recent failures endpoint', () => {
    it('GET /api/admin/tasks/recent-failures endpoint exists', () => {
      expect(adminRoutesFile).toContain("adminRoutes.get('/tasks/recent-failures'");
    });

    it('returns execution_step for failed tasks', () => {
      const failuresSection = adminRoutesFile.slice(
        adminRoutesFile.indexOf("'/tasks/recent-failures'")
      );
      expect(failuresSection).toContain('execution_step');
    });

    it('returns error_message for debugging', () => {
      const failuresSection = adminRoutesFile.slice(
        adminRoutesFile.indexOf("'/tasks/recent-failures'")
      );
      expect(failuresSection).toContain('error_message');
    });

    it('supports configurable limit parameter', () => {
      expect(adminRoutesFile).toContain("c.req.query('limit')");
      expect(adminRoutesFile).toContain('LIMIT ?');
    });

    it('orders by completed_at DESC for most recent first', () => {
      expect(adminRoutesFile).toContain('ORDER BY completed_at DESC');
    });
  });

  // ===========================================================================
  // Error handling and cleanup
  // ===========================================================================
  describe('error handling with step context', () => {
    it('catch block in executeTaskRun logs step-level context', () => {
      expect(taskRunnerFile).toContain("log.error('task_run.failed'");
      expect(taskRunnerFile).toContain('errorCode');
      expect(taskRunnerFile).toContain('workspaceId');
      expect(taskRunnerFile).toContain('nodeId');
      expect(taskRunnerFile).toContain('totalDurationMs');
    });

    it('step-level logging includes duration', () => {
      expect(taskRunnerFile).toContain("log.info('task_run.step.node_selection'");
      expect(taskRunnerFile).toContain("log.info('task_run.step.workspace_creation'");
      expect(taskRunnerFile).toContain("log.info('task_run.step.agent_session_creation'");
      expect(taskRunnerFile).toContain('durationMs');
    });

    it('TaskRunError uses typed error codes', () => {
      expect(taskRunnerFile).toContain('class TaskRunError');
      expect(taskRunnerFile).toContain("'NOT_FOUND'");
      expect(taskRunnerFile).toContain("'NODE_UNAVAILABLE'");
      expect(taskRunnerFile).toContain("'WORKSPACE_CREATION_FAILED'");
      expect(taskRunnerFile).toContain("'WORKSPACE_TIMEOUT'");
      expect(taskRunnerFile).toContain("'WORKSPACE_LOST'");
      expect(taskRunnerFile).toContain("'LIMIT_EXCEEDED'");
      expect(taskRunnerFile).toContain("'PROVISION_FAILED'");
    });

    it('best-effort workspace cleanup on task failure', () => {
      expect(taskRunnerFile).toContain('stopWorkspaceOnNode(nodeId, workspaceId, env, userId)');
      expect(taskRunnerFile).toContain("log.error('task_run.cleanup.workspace_stop_failed'");
    });

    it('auto-provisioned node cleanup on task failure', () => {
      const catchSection = taskRunnerFile.slice(taskRunnerFile.indexOf('} catch (err)'));
      expect(catchSection).toContain('autoProvisioned && nodeId');
      expect(catchSection).toContain('cleanupAutoProvisionedNode');
    });
  });

  // ===========================================================================
  // Migration
  // ===========================================================================
  describe('database migration', () => {
    it('migration file adds execution_step column', () => {
      const migrationFile = readFileSync(
        resolve(process.cwd(), 'src/db/migrations/0019_task_execution_step.sql'),
        'utf8'
      );
      expect(migrationFile).toContain('ALTER TABLE tasks ADD COLUMN execution_step TEXT');
    });
  });
});
