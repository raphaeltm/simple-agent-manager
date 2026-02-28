/**
 * Source contract tests for the TaskRunner DO service layer.
 *
 * Validates that task-runner-do.ts correctly bridges routes to the DO,
 * and that the routes are properly wired to use the DO instead of waitUntil.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const serviceSource = readFileSync(
  resolve(process.cwd(), 'src/services/task-runner-do.ts'),
  'utf8'
);
const taskSubmitSource = readFileSync(
  resolve(process.cwd(), 'src/routes/task-submit.ts'),
  'utf8'
);
const taskRunsSource = readFileSync(
  resolve(process.cwd(), 'src/routes/task-runs.ts'),
  'utf8'
);
const workspacesSource = readFileSync(
  resolve(process.cwd(), 'src/routes/workspaces.ts'),
  'utf8'
);
const stuckTasksSource = readFileSync(
  resolve(process.cwd(), 'src/scheduled/stuck-tasks.ts'),
  'utf8'
);

describe('task-runner-do service', () => {
  it('exports startTaskRunnerDO function', () => {
    expect(serviceSource).toContain('export async function startTaskRunnerDO(');
  });

  it('exports advanceTaskRunnerWorkspaceReady function', () => {
    expect(serviceSource).toContain('export async function advanceTaskRunnerWorkspaceReady(');
  });

  it('exports getTaskRunnerStatus function', () => {
    expect(serviceSource).toContain('export async function getTaskRunnerStatus(');
  });

  it('uses typed DO stub via getStub helper', () => {
    expect(serviceSource).toContain('function getStub(env: Env, taskId: string): DurableObjectStub<TaskRunner>');
  });

  it('uses idFromName(taskId) for deterministic mapping', () => {
    expect(serviceSource).toContain('env.TASK_RUNNER.idFromName(taskId)');
  });

  it('casts stub to typed DurableObjectStub<TaskRunner>', () => {
    expect(serviceSource).toContain('as DurableObjectStub<TaskRunner>');
  });

  it('calls stub.start() with StartTaskInput', () => {
    expect(serviceSource).toContain('await stub.start(startInput)');
  });

  it('calls stub.advanceWorkspaceReady()', () => {
    expect(serviceSource).toContain('await stub.advanceWorkspaceReady(status, errorMessage)');
  });

  it('calls stub.getStatus()', () => {
    expect(serviceSource).toContain('return stub.getStatus()');
  });

  it('passes all config fields to StartTaskInput', () => {
    const configFields = [
      'vmSize', 'vmLocation', 'branch', 'preferredNodeId',
      'userName', 'userEmail', 'githubId', 'taskTitle',
      'taskDescription', 'repository', 'installationId',
      'outputBranch', 'projectDefaultVmSize',
    ];
    for (const field of configFields) {
      expect(serviceSource).toContain(field);
    }
  });
});

describe('task-submit route uses TaskRunner DO', () => {
  it('imports startTaskRunnerDO (not executeTaskRun)', () => {
    expect(taskSubmitSource).toContain("import { startTaskRunnerDO } from '../services/task-runner-do'");
    expect(taskSubmitSource).not.toContain('executeTaskRun');
    expect(taskSubmitSource).not.toContain('initiateTaskRun');
  });

  it('calls startTaskRunnerDO instead of waitUntil(executeTaskRun(...))', () => {
    expect(taskSubmitSource).toContain('await startTaskRunnerDO(c.env,');
    expect(taskSubmitSource).not.toContain('waitUntil(\n    executeTaskRun');
  });

  it('passes project repository and installationId', () => {
    expect(taskSubmitSource).toContain('repository: project.repository');
    expect(taskSubmitSource).toContain('installationId: project.installationId');
  });

  it('passes user identity fields', () => {
    expect(taskSubmitSource).toContain('userName: auth.user.name');
    expect(taskSubmitSource).toContain('userEmail: auth.user.email');
    expect(taskSubmitSource).toContain('githubId: userRow?.githubId');
  });
});

describe('task-runs route uses TaskRunner DO', () => {
  it('imports startTaskRunnerDO (not initiateTaskRun)', () => {
    expect(taskRunsSource).toContain("import { startTaskRunnerDO } from '../services/task-runner-do'");
    expect(taskRunsSource).not.toContain('initiateTaskRun');
  });

  it('still imports cleanupTaskRun for cleanup endpoint', () => {
    expect(taskRunsSource).toContain("import { cleanupTaskRun } from '../services/task-runner'");
  });

  it('transitions task to queued before starting DO', () => {
    const runSection = taskRunsSource.slice(
      taskRunsSource.indexOf("'/:taskId/run'"),
      taskRunsSource.indexOf("'/:taskId/run/cleanup'")
    );
    // Raw D1 query uses status = 'queued' (with optimistic lock on status = 'ready')
    const queuedIdx = runSection.indexOf("status = 'queued'");
    const doIdx = runSection.indexOf('startTaskRunnerDO');
    expect(queuedIdx).toBeGreaterThan(-1);
    expect(doIdx).toBeGreaterThan(queuedIdx);
  });

  it('records status event before starting DO', () => {
    const runSection = taskRunsSource.slice(
      taskRunsSource.indexOf("'/:taskId/run'"),
      taskRunsSource.indexOf("'/:taskId/run/cleanup'")
    );
    expect(runSection).toContain('taskStatusEvents');
    expect(runSection).toContain("'ready'");
    expect(runSection).toContain("toStatus: 'queued'");
  });

  it('returns 202 with queued status', () => {
    expect(taskRunsSource).toContain("status: 'queued'");
    expect(taskRunsSource).toContain('c.json(response, 202)');
  });
});

describe('workspace ready callback notifies TaskRunner DO', () => {
  it('workspace ready route imports advanceTaskRunnerWorkspaceReady', () => {
    expect(workspacesSource).toContain('advanceTaskRunnerWorkspaceReady');
  });

  it('looks up associated task by workspaceId', () => {
    // The callback finds the task linked to this workspace
    expect(workspacesSource).toContain('eq(schema.tasks.workspaceId, workspaceId)');
  });

  it('only notifies for tasks in queued or delegated status', () => {
    expect(workspacesSource).toContain("inArray(schema.tasks.status, ['queued', 'delegated'])");
  });

  it('notifies DO inline (not waitUntil) per TDF-5', () => {
    const readySection = workspacesSource.slice(
      workspacesSource.indexOf("/:id/ready'"),
      workspacesSource.indexOf("/:id/provisioning-failed'")
    );
    // TDF-5: moved from waitUntil to inline await
    expect(readySection).not.toContain('c.executionCtx.waitUntil(');
    expect(readySection).toContain('advanceTaskRunnerWorkspaceReady');
    expect(readySection).toContain('await advanceTaskRunnerWorkspaceReady');
  });

  it('provisioning-failed route also notifies DO', () => {
    const failedSection = workspacesSource.slice(
      workspacesSource.indexOf("/:id/provisioning-failed'"),
      workspacesSource.indexOf("/:id/agent-key'")
    );
    expect(failedSection).toContain('advanceTaskRunnerWorkspaceReady');
    expect(failedSection).toContain("'error'");
  });
});

describe('stuck-tasks cron compatibility with TaskRunner DO', () => {
  it('documents TDF-2 compatibility in header comment', () => {
    expect(stuckTasksSource).toContain('TDF-2 compatibility');
  });

  it('mentions optimistic locking as safety mechanism', () => {
    expect(stuckTasksSource).toContain('optimistic locking');
  });

  it('still queries queued/delegated/in_progress tasks', () => {
    expect(stuckTasksSource).toContain("status IN ('queued', 'delegated', 'in_progress')");
  });

  it('still calls cleanupTaskRun on stuck tasks', () => {
    expect(stuckTasksSource).toContain('cleanupTaskRun(task.id, env)');
  });
});

describe('no waitUntil(executeTaskRun) remaining in routes', () => {
  it('task-submit does not use waitUntil for orchestration', () => {
    // waitUntil should only be used for best-effort operations (activity events)
    const submitSection = taskSubmitSource.slice(
      taskSubmitSource.indexOf('startTaskRunnerDO'),
    );
    expect(submitSection).not.toContain('waitUntil(\n    executeTaskRun');
  });

  it('task-runs does not use waitUntil for orchestration', () => {
    const runSection = taskRunsSource.slice(
      taskRunsSource.indexOf("'/:taskId/run'"),
      taskRunsSource.indexOf("'/:taskId/run/cleanup'")
    );
    expect(runSection).not.toContain('waitUntil(\n    executeTaskRun');
    expect(runSection).not.toContain('initiateTaskRun');
  });
});
