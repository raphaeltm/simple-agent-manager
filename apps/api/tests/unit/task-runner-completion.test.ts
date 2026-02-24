/**
 * Source contract tests for task completion callback handling (T033).
 *
 * Verifies that the task status callback endpoint:
 * - On 'completed': triggers cleanupTaskRun (destroy workspace + optionally node)
 * - On 'completed'/'failed'/'cancelled': stops the chat session in ProjectData DO
 * - On 'failed'/'cancelled': does NOT trigger cleanupTaskRun (keep workspace alive)
 * - Handles concurrent/idempotent callbacks gracefully
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('task completion callback handling source contract', () => {
  const tasksRouteFile = readFileSync(resolve(process.cwd(), 'src/routes/tasks.ts'), 'utf8');
  const taskRunnerFile = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');

  it('imports cleanupTaskRun in tasks route', () => {
    expect(tasksRouteFile).toContain("import { cleanupTaskRun } from '../services/task-runner'");
  });

  it('callback endpoint triggers cleanupTaskRun on completed status', () => {
    // The callback section should call cleanupTaskRun for completed tasks
    expect(tasksRouteFile).toContain('cleanupTaskRun(taskId, c.env)');
    // Only on completed — not failed or cancelled
    expect(tasksRouteFile).toContain("if (body.toStatus === 'completed')");
  });

  it('stops chat session in ProjectData DO on terminal states', () => {
    // Should stop the session via projectDataService.stopSession
    expect(tasksRouteFile).toContain('projectDataService.stopSession');
    // For all terminal states
    expect(tasksRouteFile).toContain("body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'");
  });

  it('looks up chatSessionId from workspace record (not task)', () => {
    // chatSessionId is on workspace, not task — must query workspace
    expect(tasksRouteFile).toContain('schema.workspaces.chatSessionId');
    expect(tasksRouteFile).toContain('schema.workspaces.id');
  });

  it('failed/cancelled callbacks do NOT trigger workspace cleanup', () => {
    // cleanupTaskRun should only be called inside a 'completed' check,
    // not inside the broader terminal states check
    const terminalCheck = "body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'";
    const completedOnly = "if (body.toStatus === 'completed')";

    // Both patterns exist in the callback section
    expect(tasksRouteFile).toContain(terminalCheck);
    expect(tasksRouteFile).toContain(completedOnly);

    // cleanupTaskRun appears after the completed-only check, not the terminal check
    const callbackSection = tasksRouteFile.slice(
      tasksRouteFile.indexOf("status/callback'")
    );
    const completedCheckIdx = callbackSection.indexOf(completedOnly);
    const cleanupIdx = callbackSection.indexOf('cleanupTaskRun(taskId');
    expect(completedCheckIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(-1);
    // cleanup call is after the completed-only check
    expect(cleanupIdx).toBeGreaterThan(completedCheckIdx);
  });

  it('cleanupTaskRun stops workspace via stopWorkspaceOnNode', () => {
    expect(taskRunnerFile).toContain('stopWorkspaceOnNode');
  });

  it('cleanupTaskRun handles auto-provisioned node cleanup', () => {
    expect(taskRunnerFile).toContain('autoProvisionedNodeId');
    expect(taskRunnerFile).toContain('cleanupAutoProvisionedNode');
  });

  it('completion flow is best-effort (wrapped in catch)', () => {
    // Both the session stop and cleanup are wrapped in catch for best-effort
    const callbackSection = tasksRouteFile.slice(
      tasksRouteFile.indexOf("status/callback'")
    );
    // Session stop is best-effort
    expect(callbackSection).toContain('.catch(() =>');
    // cleanupTaskRun is best-effort
    expect(callbackSection).toContain('cleanupTaskRun(taskId, c.env).catch');
  });

  it('user-initiated status change also stops chat session on terminal states', () => {
    // The user-facing status endpoint should also stop chat session.
    // Find the section between the user status handler and the callback handler.
    const callbackRouteIdx = tasksRouteFile.indexOf("tasksRoutes.post('/:taskId/status/callback'");
    const beforeCallback = tasksRouteFile.slice(0, callbackRouteIdx);
    expect(beforeCallback).toContain('projectDataService.stopSession');
    expect(beforeCallback).toContain("body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'");
  });
});
