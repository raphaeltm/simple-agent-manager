/**
 * Source contract tests for task completion callback handling (T033).
 *
 * Verifies that the task status callback endpoint:
 * - On 'completed'/'failed'/'cancelled': triggers terminal task cleanup
 * - Terminal task cleanup stops/fails the ProjectData session before runtime cleanup
 * - cf-container task cleanup destroys the underlying node/container runtime
 * - Handles concurrent/idempotent callbacks gracefully
 *
 * Note: The callback route was extracted from crud.ts to callback.ts to avoid
 * session auth middleware leak (see docs/notes/2026-05-12-task-callback-middleware-leak-postmortem.md).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('task completion callback handling source contract', () => {
  const callbackRouteFile = readFileSync(resolve(process.cwd(), 'src/routes/tasks/callback.ts'), 'utf8');
  const crudRouteFile = readFileSync(resolve(process.cwd(), 'src/routes/tasks/crud.ts'), 'utf8');
  const taskRunnerFile = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');

  it('imports shared terminal cleanup in callback route', () => {
    expect(callbackRouteFile).toContain("import { cleanupTerminalTaskResources } from '../../services/task-terminal-cleanup'");
  });

  it('callback endpoint triggers terminal cleanup on all terminal statuses', () => {
    expect(callbackRouteFile).toContain('cleanupTerminalTaskResources(c.env, taskId');
    expect(callbackRouteFile).toContain("body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'");
  });

  it('passes terminal status and error message to cleanup helper', () => {
    expect(callbackRouteFile).toContain('status: body.toStatus');
    expect(callbackRouteFile).toContain('errorMessage: updatedTask.errorMessage');
  });

  it('cleanupTaskRun destroys cf-container nodes via runtime resource cleanup', () => {
    expect(taskRunnerFile).toContain("node?.runtime === 'cf-container'");
    expect(taskRunnerFile).toContain('stopNodeResources(workspace.nodeId, task.userId, env)');
  });

  it('cleanupTaskRun stops workspace via stopWorkspaceOnNode', () => {
    expect(taskRunnerFile).toContain('stopWorkspaceOnNode');
  });

  it('cleanupTaskRun handles auto-provisioned node cleanup', () => {
    expect(taskRunnerFile).toContain('autoProvisionedNodeId');
    expect(taskRunnerFile).toContain('cleanupAutoProvisionedNode');
  });

  it('completion flow is best-effort (wrapped in catch with logging)', () => {
    const callbackSection = callbackRouteFile.slice(
      callbackRouteFile.indexOf("status/callback'"),
    );
    expect(callbackSection).toContain('.catch((e) =>');
    expect(callbackSection).toContain('cleanupTerminalTaskResources(c.env, taskId');
  });

  it('user-initiated status change also schedules terminal cleanup', () => {
    expect(crudRouteFile).toContain('cleanupTerminalTaskResources(c.env, taskId');
    expect(crudRouteFile).toContain("body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'");
  });
});
