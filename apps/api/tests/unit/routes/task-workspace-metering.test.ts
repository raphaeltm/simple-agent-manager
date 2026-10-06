import { describe, expect, it, vi } from 'vitest';

import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import { claimWorkspaceAllocationForTask } from '../../../src/durable-objects/task-runner/workspace-reserved-allocation';
import { handleWorkspaceCreation } from '../../../src/durable-objects/task-runner/workspace-steps';
import { fixture, seedHost } from './node-pool-upgrade-test-helpers';

describe('task reuse metering through real placement and SQL', () => {
  it.each([true, false])(
    'preserves node pricing when known=%s without inventing unknown prices',
    async (known) => {
      const f = fixture();
      const start = await f.run({
        resourceRequirements: { minVcpu: 1, minMemoryGb: 1, minDiskGb: 0 },
      });
      const snapshot = await seedHost(f, start);
      const prices = known ? ['€8.49/mo', 'EUR', 849, 13600] : [null, null, null, null];
      f.sqlite
        .prepare(
          `UPDATE nodes SET provider_instance_price_display = ?,
      provider_instance_price_currency = ?, provider_instance_price_monthly_cents = ?,
      provider_instance_price_hourly_micros = ? WHERE id = 'host'`
        )
        .run(...prices);
      const state = {
        ...start,
        config: { ...start.config, branch: 'main', defaultBranch: 'main' },
        stepResults: { nodeId: 'host', capacityPlacementSnapshot: snapshot },
      } as TaskRunnerState;
      const rc = {
        env: f.env,
        ctx: { storage: { put: vi.fn(async () => undefined) } },
        assertRecoveryAuthority: vi.fn(async () => undefined),
        advanceToStep: vi.fn(async () => undefined),
        updateD1ExecutionStep: vi.fn(async () => undefined),
      } as unknown as TaskRunnerContext;
      await handleWorkspaceCreation(state, rc);
      expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_dispatch');
      expect(
        f.sqlite
          .prepare(
            `SELECT node_id, provider_instance_type, vcpu_count,
      provider_instance_price_display, provider_instance_price_currency,
      provider_instance_price_monthly_cents, provider_instance_price_hourly_micros
      FROM compute_usage WHERE workspace_id = ?`
          )
          .get(state.stepResults.workspaceId)
      ).toEqual({
        node_id: 'host',
        provider_instance_type: snapshot.providerInstanceType,
        vcpu_count: snapshot.providerInstanceVcpuCount,
        provider_instance_price_display: prices[0],
        provider_instance_price_currency: prices[1],
        provider_instance_price_monthly_cents: prices[2],
        provider_instance_price_hourly_micros: prices[3],
      });
      expect(
        f.sqlite.prepare('SELECT workspace_id, status FROM tasks WHERE id = ?').get(start.taskId)
      ).toEqual({ workspace_id: state.stepResults.workspaceId, status: 'delegated' });
    }
  );
  it.each([
    { reserved: false, taskSession: 'other-chat' },
    { reserved: true, taskSession: null },
  ])(
    'rejects mismatched task identity reserved=$reserved taskSession=$taskSession',
    async ({ reserved, taskSession }) => {
      const f = fixture();
      const start = await f.run();
      const snapshot = await seedHost(f, start);
      const chatSessionId = start.config.chatSessionId!;
      f.sqlite
        .prepare('UPDATE tasks SET chat_session_id = ? WHERE id = ?')
        .run(taskSession, start.taskId);
      f.sqlite
        .prepare(
          `INSERT INTO workspaces (id, node_id, project_id, user_id, installation_id,
      name, repository, branch, chat_session_id, status, vm_size, vm_location)
      VALUES ('allocated', 'host', 'project-1', 'user-1', 'installation-1', 'Allocated',
      'acme/repo', 'main', ?, 'creating', 'small', 'nbg1')`
        )
        .run(chatSessionId);
      const intentFingerprint = 'sha256:' + 'a'.repeat(64);
      // A valid checkpoint isolates the reserved null-session rejection from the
      // separate missing-checkpoint guard.
      if (reserved) {
        f.sqlite
          .prepare(
            `INSERT INTO task_submission_checkpoints
        (task_id, project_id, user_id, chat_session_id, initial_message_id,
         initial_status_event_id, source_kind, source_id, source_execution_id,
         triggered_by, intent_fingerprint, accepted_snapshot_json, branch_name, task_title)
        VALUES (?, 'project-1', 'user-1', ?, 'initial', 'initial-status', 'schedule',
         'schedule-1', 'execution-1', 'cron', ?, '{}', 'main', 'Task')`
          )
          .run(start.taskId, chatSessionId, intentFingerprint);
      }
      const state = {
        ...start,
        config: {
          ...start.config,
          startGuard: reserved
            ? {
                kind: 'reserved_submission',
                taskId: start.taskId,
                projectId: start.projectId,
                userId: start.userId,
                chatSessionId,
                intentFingerprint,
              }
            : null,
        },
        stepResults: {
          nodeId: 'host',
          workspaceId: 'allocated',
          capacityPlacementSnapshot: snapshot,
        },
      } as TaskRunnerState;
      const rc = {
        env: f.env,
        ctx: { storage: { put: vi.fn(async () => undefined) } },
      } as unknown as TaskRunnerContext;
      await expect(
        claimWorkspaceAllocationForTask(state, rc, 'allocated', new Date().toISOString())
      ).rejects.toThrow('authority revoked before workspace assignment');
      expect(
        f.sqlite.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(start.taskId)
      ).toEqual({ workspace_id: null });
      expect(
        f.sqlite.prepare("SELECT status FROM workspaces WHERE id = 'allocated'").get()
      ).toEqual({ status: 'stopped' });
      expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM compute_usage').get()).toEqual({
        count: 0,
      });
    }
  );
});
