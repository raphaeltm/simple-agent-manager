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
  type ClaimCase = {
    name: string;
    reserved: boolean;
    arrange: (f: ReturnType<typeof fixture>, taskId: string, chatSessionId: string) => void;
    expected: (chatSessionId: string) => string;
    /** The allocated workspace row afterwards; tombstoned unless the case removed it. */
    workspaceAfter?: { status: string } | undefined;
  };
  const ORDINARY = 'Task start abandoned before workspace assignment: ';
  const RESERVED = 'Reserved task submission authority revoked before workspace assignment: ';
  const INTENT = 'sha256:' + 'a'.repeat(64);
  const setTask = (f: ReturnType<typeof fixture>, taskId: string, column: string, value: unknown) =>
    f.sqlite.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(value, taskId);

  const refusals: ClaimCase[] = [
    {
      // The 2026-10-10 double start: the orchestrator rebound the task to its own session.
      name: 'another start bound the task to its session',
      reserved: false,
      arrange: (f, taskId) => setTask(f, taskId, 'chat_session_id', 'other-chat'),
      expected: (cs) =>
        `${ORDINARY}task is bound to chat session other-chat, not this start's session ${cs}`,
    },
    {
      name: 'a reserved task lost its session claim',
      reserved: true,
      arrange: (f, taskId) => setTask(f, taskId, 'chat_session_id', null),
      expected: (cs) => `${RESERVED}task has no chat session; this start owns session ${cs}`,
    },
    {
      name: 'the task left the queue',
      reserved: false,
      arrange: (f, taskId, cs) => {
        setTask(f, taskId, 'chat_session_id', cs);
        setTask(f, taskId, 'status', 'cancelled');
      },
      expected: () => `${ORDINARY}task is cancelled, not queued`,
    },
    {
      name: 'the task is assigned to another workspace',
      reserved: false,
      arrange: (f, taskId, cs) => {
        setTask(f, taskId, 'chat_session_id', cs);
        setTask(f, taskId, 'workspace_id', 'other-workspace');
      },
      expected: () => `${ORDINARY}task is already assigned to workspace other-workspace`,
    },
    {
      name: 'the reserved session was revoked',
      reserved: true,
      arrange: (f, taskId, cs) => {
        setTask(f, taskId, 'chat_session_id', cs);
        f.sqlite
          .prepare(
            `INSERT INTO reserved_task_session_revocations
               (project_id, chat_session_id, task_id, reason, source, revoked_at)
             VALUES ('project-1', ?, ?, 'session_stopped', 'test', '2026-10-11T00:00:00Z')`
          )
          .run(cs, taskId);
      },
      expected: (cs) => `${RESERVED}chat session ${cs} was revoked (session_stopped)`,
    },
    {
      name: 'the allocated workspace stopped',
      reserved: false,
      arrange: (f, taskId, cs) => {
        setTask(f, taskId, 'chat_session_id', cs);
        f.sqlite.prepare("UPDATE workspaces SET status = 'stopped' WHERE id = 'allocated'").run();
      },
      expected: () => `${ORDINARY}workspace allocated is stopped`,
    },
    {
      name: 'the reserved checkpoint no longer matches',
      reserved: true,
      arrange: (f, taskId, cs) => {
        setTask(f, taskId, 'chat_session_id', cs);
        f.sqlite
          .prepare(
            'UPDATE task_submission_checkpoints SET intent_fingerprint = ? WHERE task_id = ?'
          )
          .run('sha256:' + 'b'.repeat(64), taskId);
      },
      expected: () => `${RESERVED}reserved submission checkpoint no longer matches this start`,
    },
    {
      name: 'the task row is gone',
      reserved: false,
      arrange: (f, taskId) => {
        f.sqlite.pragma('foreign_keys = OFF');
        f.sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      },
      expected: () => `${ORDINARY}task task-1 no longer exists`,
    },
    {
      name: 'the task moved to another user',
      reserved: false,
      arrange: (f, taskId, cs) => {
        setTask(f, taskId, 'chat_session_id', cs);
        setTask(f, taskId, 'user_id', 'owner');
      },
      expected: () => `${ORDINARY}task task-1 now belongs to a different project or user`,
    },
    {
      name: 'the allocated workspace is bound to another session',
      reserved: false,
      arrange: (f, taskId, cs) => {
        setTask(f, taskId, 'chat_session_id', cs);
        f.sqlite
          .prepare("UPDATE workspaces SET chat_session_id = 'other-chat' WHERE id = 'allocated'")
          .run();
      },
      expected: (cs) =>
        `${ORDINARY}workspace allocated is bound to chat session other-chat, not ${cs}`,
    },
    {
      name: 'the allocated workspace row is gone',
      reserved: false,
      arrange: (f, taskId, cs) => {
        setTask(f, taskId, 'chat_session_id', cs);
        f.sqlite.pragma('foreign_keys = OFF');
        f.sqlite.prepare("DELETE FROM workspaces WHERE id = 'allocated'").run();
      },
      expected: () => `${ORDINARY}workspace allocated no longer exists`,
      workspaceAfter: undefined,
    },
    {
      name: 'the reserved checkpoint names another session',
      reserved: true,
      arrange: (f, taskId, cs) => {
        setTask(f, taskId, 'chat_session_id', cs);
        f.sqlite
          .prepare(
            "UPDATE task_submission_checkpoints SET chat_session_id = 'other-chat' WHERE task_id = ?"
          )
          .run(taskId);
      },
      expected: () => `${RESERVED}reserved submission checkpoint no longer matches this start`,
    },
  ];

  async function claimFixture(reserved: boolean) {
    const f = fixture();
    const start = await f.run();
    const snapshot = await seedHost(f, start);
    const chatSessionId = start.config.chatSessionId!;
    f.sqlite
      .prepare(
        `INSERT INTO workspaces (id, node_id, project_id, user_id, installation_id,
      name, repository, branch, chat_session_id, status, vm_size, vm_location)
      VALUES ('allocated', 'host', 'project-1', 'user-1', 'installation-1', 'Allocated',
      'acme/repo', 'main', ?, 'creating', 'small', 'nbg1')`
      )
      .run(chatSessionId);
    // A valid checkpoint isolates each reserved refusal from the checkpoint guard.
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
        .run(start.taskId, chatSessionId, INTENT);
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
              intentFingerprint: INTENT,
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
    return { f, start, state, rc, chatSessionId };
  }

  it.each(refusals)('names the refusal when $name', async (refusal) => {
    const { reserved, arrange, expected } = refusal;
    const { f, start, state, rc, chatSessionId } = await claimFixture(reserved);
    arrange(f, start.taskId, chatSessionId);
    const before = f.sqlite
      .prepare('SELECT workspace_id FROM tasks WHERE id = ?')
      .get(start.taskId) as { workspace_id: string | null };

    const error = await claimWorkspaceAllocationForTask(
      state,
      rc,
      'allocated',
      new Date().toISOString()
    ).then(
      () => null,
      (err: unknown) => err as Error
    );

    expect(error?.message).toBe(expected(chatSessionId));
    expect(
      f.sqlite.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(start.taskId)
    ).toEqual(before);
    expect(f.sqlite.prepare("SELECT status FROM workspaces WHERE id = 'allocated'").get()).toEqual(
      'workspaceAfter' in refusal ? refusal.workspaceAfter : { status: 'stopped' }
    );
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM compute_usage').get()).toEqual({
      count: 0,
    });
  });

  it("assigns the workspace when the task row already carries this start's session", async () => {
    // dispatch_task now commits tasks.chat_session_id in the task INSERT.
    const { f, start, state, rc, chatSessionId } = await claimFixture(false);
    setTask(f, start.taskId, 'chat_session_id', chatSessionId);

    await claimWorkspaceAllocationForTask(state, rc, 'allocated', new Date().toISOString());

    expect(
      f.sqlite
        .prepare('SELECT workspace_id, chat_session_id FROM tasks WHERE id = ?')
        .get(start.taskId)
    ).toEqual({ workspace_id: 'allocated', chat_session_id: chatSessionId });
    expect(f.sqlite.prepare("SELECT status FROM workspaces WHERE id = 'allocated'").get()).toEqual({
      status: 'creating',
    });
  });
});
