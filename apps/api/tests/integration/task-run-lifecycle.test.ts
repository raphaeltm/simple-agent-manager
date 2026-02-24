/**
 * Integration test: task run lifecycle end-to-end (T036).
 *
 * Verifies the source code wiring for the full task run lifecycle:
 * 1. Task runner creates chat session with taskId
 * 2. Task runner sets output_branch to task/{taskId} format
 * 3. Callback endpoint handles completion (cleanup) and failure (preserve workspace)
 * 4. Session stop on terminal states
 * 5. Activity events recorded for status transitions
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('task run lifecycle integration', () => {
  const taskRunnerFile = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');
  const tasksRouteFile = readFileSync(resolve(process.cwd(), 'src/routes/tasks.ts'), 'utf8');
  const projectDataFile = readFileSync(resolve(process.cwd(), 'src/services/project-data.ts'), 'utf8');

  describe('task submission → workspace creation → session creation', () => {
    it('executeTaskRun creates chat session via projectDataService', () => {
      expect(taskRunnerFile).toContain('projectDataService.createSession');
      expect(taskRunnerFile).toContain("import * as projectDataService from './project-data'");
    });

    it('chat session is created with taskId for linking', () => {
      // createSession called with task.id as the taskId parameter
      expect(taskRunnerFile).toContain('task.id // taskId');
    });

    it('chatSessionId stored on workspace record in D1', () => {
      expect(taskRunnerFile).toContain('set({ chatSessionId');
      expect(taskRunnerFile).toContain('eq(schema.workspaces.id, workspaceId)');
    });

    it('output_branch set to task/{taskId} format', () => {
      expect(taskRunnerFile).toContain('`task/${task.id}`');
      expect(taskRunnerFile).toContain('set({ outputBranch');
    });

    it('task transitions through queued → delegated → in_progress', () => {
      expect(taskRunnerFile).toContain("toStatus: 'queued'");
      expect(taskRunnerFile).toContain("toStatus: 'delegated'");
      expect(taskRunnerFile).toContain("toStatus: 'in_progress'");
    });

    it('session creation failure does not block workspace provisioning', () => {
      // Best-effort pattern: try/catch around session creation
      const sessionSection = taskRunnerFile.slice(
        taskRunnerFile.indexOf('projectDataService.createSession')
      );
      expect(sessionSection).toContain('catch (err)');
      expect(taskRunnerFile).toContain('Failed to create chat session for task workspace');
    });
  });

  describe('completion callback → workspace destroyed → task completed', () => {
    it('callback endpoint validates JWT auth', () => {
      expect(tasksRouteFile).toContain('verifyCallbackToken');
      expect(tasksRouteFile).toContain("Missing or invalid Authorization header");
    });

    it('callback validates workspace claim matches task', () => {
      expect(tasksRouteFile).toContain('Token workspace mismatch');
      expect(tasksRouteFile).toContain('payload.workspace !== task.workspaceId');
    });

    it('completed status triggers cleanupTaskRun', () => {
      const callbackSection = tasksRouteFile.slice(
        tasksRouteFile.indexOf("status/callback'")
      );
      expect(callbackSection).toContain("if (body.toStatus === 'completed')");
      expect(callbackSection).toContain('cleanupTaskRun(taskId, c.env)');
    });

    it('cleanupTaskRun stops workspace via stopWorkspaceOnNode', () => {
      expect(taskRunnerFile).toContain('stopWorkspaceOnNode(workspace.nodeId, workspace.id, env');
    });

    it('cleanupTaskRun checks auto-provisioned node for cleanup', () => {
      expect(taskRunnerFile).toContain('task.autoProvisionedNodeId');
      expect(taskRunnerFile).toContain('cleanupAutoProvisionedNode');
    });

    it('auto-provisioned node not cleaned up if other workspaces active', () => {
      expect(taskRunnerFile).toContain('activeWorkspaces.length > 0');
    });
  });

  describe('failure callback → workspace preserved → task failed', () => {
    it('failed/cancelled callbacks do NOT trigger cleanup', () => {
      const callbackSection = tasksRouteFile.slice(
        tasksRouteFile.indexOf("status/callback'")
      );
      // cleanupTaskRun only inside completed check, not in terminal states check
      const completedCheck = callbackSection.indexOf("if (body.toStatus === 'completed')");
      const cleanupCall = callbackSection.indexOf('cleanupTaskRun(taskId');
      expect(completedCheck).toBeGreaterThan(-1);
      expect(cleanupCall).toBeGreaterThan(completedCheck);
    });

    it('executeTaskRun error path transitions task to failed', () => {
      expect(taskRunnerFile).toContain('failTask(db, task.id, errorMessage)');
    });

    it('executeTaskRun error path does best-effort workspace cleanup', () => {
      // On failure during executeTaskRun itself, stop workspace best-effort
      expect(taskRunnerFile).toContain('stopWorkspaceOnNode(nodeId, workspaceId, env, userId)');
    });
  });

  describe('terminal state → chat session stopped', () => {
    it('callback endpoint stops chat session on all terminal states', () => {
      const callbackSection = tasksRouteFile.slice(
        tasksRouteFile.indexOf("status/callback'")
      );
      expect(callbackSection).toContain('projectDataService.stopSession');
      expect(callbackSection).toContain("body.toStatus === 'completed' || body.toStatus === 'failed' || body.toStatus === 'cancelled'");
    });

    it('user status endpoint also stops chat session on terminal states', () => {
      const callbackRouteIdx = tasksRouteFile.indexOf("tasksRoutes.post('/:taskId/status/callback'");
      const beforeCallback = tasksRouteFile.slice(0, callbackRouteIdx);
      expect(beforeCallback).toContain('projectDataService.stopSession');
    });

    it('chat session stop is best-effort (catch blocks)', () => {
      const callbackSection = tasksRouteFile.slice(
        tasksRouteFile.indexOf("status/callback'")
      );
      // Both session stop and cleanup are wrapped in catch
      const catchCount = (callbackSection.match(/\.catch\(\(\) =>/g) || []).length;
      expect(catchCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('activity event recording', () => {
    it('callback endpoint records activity events', () => {
      expect(tasksRouteFile).toContain('projectDataService.recordActivityEvent');
    });

    it('activity events include task title and status transition', () => {
      expect(tasksRouteFile).toContain('title: task.title');
      expect(tasksRouteFile).toContain('fromStatus: task.status');
      expect(tasksRouteFile).toContain('toStatus: body.toStatus');
    });
  });

  describe('project-data service supports required operations', () => {
    it('exports createSession with taskId parameter', () => {
      expect(projectDataFile).toContain('export async function createSession');
      expect(projectDataFile).toContain('taskId');
    });

    it('exports stopSession', () => {
      expect(projectDataFile).toContain('export async function stopSession');
    });

    it('exports recordActivityEvent', () => {
      expect(projectDataFile).toContain('export async function recordActivityEvent');
    });

    it('exports persistMessageBatch for agent message persistence', () => {
      expect(projectDataFile).toContain('export async function persistMessageBatch');
    });
  });
});
