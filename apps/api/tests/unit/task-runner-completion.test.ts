/**
 * Source contract tests for task completion callback handling (T033).
 *
 * Verifies that the task status callback endpoint:
 * - On 'completed': triggers cleanupTaskRun (destroy workspace + optionally node)
 * - On 'completed'/'failed'/'cancelled': stops the chat session in ProjectData DO
 * - On 'failed'/'cancelled': does NOT trigger cleanupTaskRun (keep workspace alive)
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

  it('imports cleanupTaskRun in callback route', () => {
    expect(callbackRouteFile).toContain("import { cleanupTaskRun } from '../../services/task-runner'");
  });

  it('callback endpoint triggers cleanupTaskRun on completed status', () => {
    expect(callbackRouteFile).toContain('cleanupTaskRun(taskId, c.env)');
    expect(callbackRouteFile).toContain("if (body.toStatus === 'completed')");
  });

  it('stops chat session in ProjectData DO on terminal states', () => {
    expect(callbackRouteFile).toContain('projectDataService.stopSession');
    expect(callbackRouteFile).toContain("body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'");
  });

  it('looks up chatSessionId from workspace record (not task)', () => {
    expect(callbackRouteFile).toContain('schema.workspaces.chatSessionId');
    expect(callbackRouteFile).toContain('schema.workspaces.id');
  });

  it('failed/cancelled callbacks do NOT trigger workspace cleanup', () => {
    const terminalCheck = "body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'";
    const completedOnly = "if (body.toStatus === 'completed')";

    expect(callbackRouteFile).toContain(terminalCheck);
    expect(callbackRouteFile).toContain(completedOnly);

    const callbackSection = callbackRouteFile.slice(
      callbackRouteFile.indexOf("status/callback'"),
    );
    const completedCheckIdx = callbackSection.indexOf(completedOnly);
    const cleanupIdx = callbackSection.indexOf('cleanupTaskRun(taskId');
    expect(completedCheckIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(completedCheckIdx);
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
    expect(callbackSection).toContain('cleanupTaskRun(taskId, c.env).catch');
  });

  it('user-initiated status change also stops chat session on terminal states', () => {
    // The user-facing CRUD status endpoint should also stop chat session
    expect(crudRouteFile).toContain('projectDataService.stopSession');
    expect(crudRouteFile).toContain("body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'");
  });
});
