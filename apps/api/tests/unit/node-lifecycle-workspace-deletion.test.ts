/**
 * Source contract tests for NodeLifecycle workspace auto-deletion feature.
 *
 * Verifies the NodeLifecycle DO workspace deletion scheduling,
 * cancellation, and alarm-based deletion logic.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('NodeLifecycle workspace auto-deletion source contract', () => {
  const doFile = readFileSync(resolve(process.cwd(), 'src/durable-objects/node-lifecycle.ts'), 'utf8');
  const envFile = readFileSync(resolve(process.cwd(), 'src/env.ts'), 'utf8');
  const sharedConstantsFile = readFileSync(
    resolve(process.cwd(), '../../packages/shared/src/constants/node-pooling.ts'),
    'utf8',
  );
  const sharedIndexFile = readFileSync(
    resolve(process.cwd(), '../../packages/shared/src/constants/index.ts'),
    'utf8',
  );

  describe('shared constant', () => {
    it('defines DEFAULT_WORKSPACE_STOPPED_TTL_MS in node-pooling.ts', () => {
      expect(sharedConstantsFile).toContain('export const DEFAULT_WORKSPACE_STOPPED_TTL_MS');
      expect(sharedConstantsFile).toContain('5 * 60 * 1000');
    });

    it('exports DEFAULT_WORKSPACE_STOPPED_TTL_MS from constants barrel', () => {
      expect(sharedIndexFile).toContain('DEFAULT_WORKSPACE_STOPPED_TTL_MS');
    });
  });

  describe('env configuration', () => {
    it('WORKSPACE_STOPPED_TTL_MS is defined in Env type', () => {
      expect(envFile).toContain('WORKSPACE_STOPPED_TTL_MS?: string');
    });

    it('NodeLifecycleEnv includes WORKSPACE_STOPPED_TTL_MS', () => {
      expect(doFile).toContain('WORKSPACE_STOPPED_TTL_MS?: string');
    });
  });

  describe('scheduleWorkspaceDeletion method', () => {
    it('exists as a public async method', () => {
      expect(doFile).toContain('async scheduleWorkspaceDeletion(workspaceId: string, userId: string)');
    });

    it('reads configured TTL via getWorkspaceStoppedTtlMs', () => {
      expect(doFile).toContain('this.getWorkspaceStoppedTtlMs()');
    });

    it('stores entries with ws-delete: prefix in DO storage', () => {
      expect(doFile).toContain('`ws-delete:${workspaceId}`');
    });

    it('stores PendingWorkspaceDeletion with workspaceId, userId, deleteAt', () => {
      expect(doFile).toContain('const entry: PendingWorkspaceDeletion = { workspaceId, userId, deleteAt }');
    });

    it('recalculates alarm after scheduling', () => {
      const method = doFile.slice(doFile.indexOf('async scheduleWorkspaceDeletion'));
      expect(method).toContain('recalculateAlarm');
    });
  });

  describe('cancelWorkspaceDeletion method', () => {
    it('exists as a public async method', () => {
      expect(doFile).toContain('async cancelWorkspaceDeletion(workspaceId: string)');
    });

    it('deletes the ws-delete: entry from DO storage', () => {
      expect(doFile).toContain("this.ctx.storage.delete(`ws-delete:${workspaceId}`)");
    });

    it('recalculates alarm after cancellation', () => {
      const method = doFile.slice(doFile.indexOf('async cancelWorkspaceDeletion'));
      const methodEnd = method.indexOf('async ', 10);
      const methodBody = method.slice(0, methodEnd > 0 ? methodEnd : undefined);
      expect(methodBody).toContain('recalculateAlarm');
    });
  });

  describe('alarm handler processes workspace deletions', () => {
    it('calls processExpiredDeletions in alarm()', () => {
      const alarmMethod = doFile.slice(doFile.indexOf('async alarm()'));
      expect(alarmMethod).toContain('processExpiredDeletions');
    });

    it('processExpiredDeletions checks deleteAt against now', () => {
      expect(doFile).toContain('entry.deleteAt > now');
    });

    it('calls deleteWorkspace for expired entries', () => {
      expect(doFile).toContain('await this.deleteWorkspace(state.nodeId, entry.workspaceId, entry.userId)');
    });

    it('removes processed entries from storage', () => {
      const processMethod = doFile.slice(doFile.indexOf('processExpiredDeletions'));
      expect(processMethod).toContain('this.ctx.storage.delete(key)');
    });

    it('retries failed deletions by pushing deleteAt forward', () => {
      expect(doFile).toContain('entry.deleteAt = now + DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS');
    });
  });

  describe('deleteWorkspace implementation', () => {
    it('calls deleteWorkspaceOnNode via shared helper (proper JWT auth)', () => {
      expect(doFile).toContain('deleteWorkspaceOnNode(nodeId, workspaceId, this.env as unknown as Env, userId)');
    });

    it('updates D1 workspace status to deleted', () => {
      expect(doFile).toContain("UPDATE workspaces SET status = 'deleted'");
    });

    it('only deletes workspaces that are still stopped', () => {
      expect(doFile).toContain("AND status = 'stopped'");
    });

    it('cleans up agent_sessions (best-effort)', () => {
      expect(doFile).toContain('UPDATE agent_sessions SET status');
    });

    it('handles unreachable VM agent gracefully (node may be gone)', () => {
      expect(doFile).toContain('node_lifecycle.workspace_delete_vm_agent_failed');
    });
  });

  describe('recalculateAlarm picks earliest time', () => {
    it('considers warm alarm time', () => {
      const method = doFile.slice(doFile.indexOf('private async recalculateAlarm'));
      expect(method).toContain('warmAlarmTime');
    });

    it('considers pending workspace deletions', () => {
      const method = doFile.slice(doFile.indexOf('private async recalculateAlarm'));
      expect(method).toContain('getPendingDeletions');
    });

    it('picks the minimum of all times', () => {
      const method = doFile.slice(doFile.indexOf('private async recalculateAlarm'));
      expect(method).toContain('entry.deleteAt < earliest');
    });

    it('deletes alarm when no pending events', () => {
      const method = doFile.slice(doFile.indexOf('private async recalculateAlarm'));
      expect(method).toContain('deleteAlarm()');
    });

    it('sets alarm to earliest time', () => {
      const method = doFile.slice(doFile.indexOf('private async recalculateAlarm'));
      expect(method).toContain('setAlarm(earliest)');
    });
  });

  describe('markActive preserves workspace deletion alarms', () => {
    it('calls recalculateAlarm(null) instead of deleteAlarm()', () => {
      const markActiveStart = doFile.indexOf('async markActive()');
      const markActiveEnd = doFile.indexOf('async tryClaim', markActiveStart);
      const markActiveBody = doFile.slice(markActiveStart, markActiveEnd);
      expect(markActiveBody).toContain('recalculateAlarm(null)');
      expect(markActiveBody).not.toContain('deleteAlarm()');
    });
  });

  describe('tryClaim preserves workspace deletion alarms', () => {
    it('calls recalculateAlarm(null) instead of deleteAlarm()', () => {
      const tryClaimStart = doFile.indexOf('async tryClaim(');
      const tryClaimEnd = doFile.indexOf('async getStatus', tryClaimStart);
      const tryClaimBody = doFile.slice(tryClaimStart, tryClaimEnd);
      expect(tryClaimBody).toContain('recalculateAlarm(null)');
      expect(tryClaimBody).not.toContain('deleteAlarm()');
    });
  });

  describe('configurable workspace stopped TTL', () => {
    it('uses WORKSPACE_STOPPED_TTL_MS env var', () => {
      expect(doFile).toContain('WORKSPACE_STOPPED_TTL_MS');
    });

    it('falls back to DEFAULT_WORKSPACE_STOPPED_TTL_MS', () => {
      expect(doFile).toContain('DEFAULT_WORKSPACE_STOPPED_TTL_MS');
    });

    it('imports the constant from shared', () => {
      expect(doFile).toContain("DEFAULT_WORKSPACE_STOPPED_TTL_MS,");
    });
  });

  describe('callers schedule deletion on workspace stop', () => {
    const lifecycleFile = readFileSync(resolve(process.cwd(), 'src/routes/workspaces/lifecycle.ts'), 'utf8');
    const taskRunnerFile = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');
    const stateMachineFile = readFileSync(
      resolve(process.cwd(), 'src/durable-objects/task-runner/state-machine.ts'),
      'utf8',
    );

    it('lifecycle stop route calls scheduleWorkspaceDeletion', () => {
      expect(lifecycleFile).toContain('scheduleWorkspaceDeletion(workspace.id, userId)');
    });

    it('lifecycle restart route calls cancelWorkspaceDeletion', () => {
      expect(lifecycleFile).toContain('cancelWorkspaceDeletion(workspace.id)');
    });

    it('cleanupTaskRun calls scheduleWorkspaceDeletion', () => {
      expect(taskRunnerFile).toContain('scheduleWorkspaceDeletion(workspace.id, task.userId)');
    });

    it('cleanupOnFailure calls scheduleWorkspaceDeletion', () => {
      expect(stateMachineFile).toContain(
        'scheduleWorkspaceDeletion(state.stepResults.workspaceId, state.userId)',
      );
    });

    it('idle cleanup processExpiredCleanups schedules deletion after stop', () => {
      const projectDataIndexFile = readFileSync(
        resolve(process.cwd(), 'src/durable-objects/project-data/index.ts'),
        'utf8',
      );
      expect(projectDataIndexFile).toContain('scheduleWorkspaceDeletion(workspaceId, wsRow.user_id)');
    });
  });

  describe('cron safety-net for stale stopped workspaces', () => {
    const cronFile = readFileSync(resolve(process.cwd(), 'src/scheduled/node-cleanup.ts'), 'utf8');

    it('imports DEFAULT_WORKSPACE_STOPPED_TTL_MS', () => {
      expect(cronFile).toContain('DEFAULT_WORKSPACE_STOPPED_TTL_MS');
    });

    it('includes stoppedWorkspacesDeleted in result', () => {
      expect(cronFile).toContain('stoppedWorkspacesDeleted');
    });

    it('queries for stopped workspaces past TTL', () => {
      expect(cronFile).toContain("w.status = 'stopped'");
      expect(cronFile).toContain('stoppedGraceThreshold');
    });

    it('calls deleteWorkspaceOnNode for stale stopped workspaces', () => {
      expect(cronFile).toContain('deleteWorkspaceOnNode(ws.node_id, ws.id, env, ws.user_id)');
    });

    it('marks stale stopped workspaces as deleted in D1', () => {
      const step5Section = cronFile.slice(cronFile.indexOf('Safety-net'));
      expect(step5Section).toContain("status: 'deleted'");
    });
  });
});
