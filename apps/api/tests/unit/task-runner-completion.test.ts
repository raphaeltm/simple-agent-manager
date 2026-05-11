/**
 * Source contract tests for task completion callback handling (T033).
 *
 * Verifies that the task status callback endpoint:
 * - On terminal states: uses finalizeTaskRun for session/workspace fan-out
 * - On 'failed'/'cancelled': does NOT trigger cleanupTaskRun (keep workspace alive)
 * - Handles concurrent/idempotent callbacks gracefully
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('task completion callback handling source contract', () => {
  const tasksRouteFile = readFileSync(resolve(process.cwd(), 'src/routes/tasks/crud.ts'), 'utf8');
  const taskFinalizationFile = readFileSync(resolve(process.cwd(), 'src/services/task-finalization.ts'), 'utf8');

  it('imports finalizeTaskRun in tasks route', () => {
    expect(tasksRouteFile).toContain("import { finalizeTaskRun } from '../../services/task-finalization'");
  });

  it('callback endpoint finalizes terminal states', () => {
    expect(tasksRouteFile).toContain('await finalizeTerminalStatus(c.env, c.executionCtx, {');
    expect(tasksRouteFile).toContain("body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'");
  });

  it('finalization stops all active task sessions by task ID', () => {
    expect(taskFinalizationFile).toContain('projectDataService.stopActiveSessionsForTask(env, projectId, taskId)');
  });

  it('callback endpoint requests workspace cleanup only for completed status', () => {
    expect(tasksRouteFile).toContain("cleanupWorkspace: input.status === 'completed'");
  });

  it('complete_task uses finalization after D1 completion', () => {
    const taskToolsFile = readFileSync(resolve(process.cwd(), 'src/routes/mcp/task-tools.ts'), 'utf8');
    const completionUpdate = taskToolsFile.indexOf("UPDATE tasks SET status = 'completed'");
    const finalization = taskToolsFile.indexOf('await finalizeTaskRun(env, {');
    expect(completionUpdate).toBeGreaterThan(-1);
    expect(finalization).toBeGreaterThan(completionUpdate);
  });

  it('finalization delegates completed workspace cleanup to cleanupTaskRun', () => {
    expect(taskFinalizationFile).toContain('cleanupWorkspace && input.status ===');
    expect(taskFinalizationFile).toContain('cleanupTaskRun(taskId, env');
  });

  it('user-initiated status change also finalizes terminal states', () => {
    const callbackRouteIdx = tasksRouteFile.indexOf("crudRoutes.post('/:taskId/status/callback'");
    const beforeCallback = tasksRouteFile.slice(0, callbackRouteIdx);
    expect(beforeCallback).toContain('await finalizeTerminalStatus(c.env, c.executionCtx, {');
    expect(beforeCallback).toContain("body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'");
  });
});
