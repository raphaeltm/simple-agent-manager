/**
 * Vertical-slice regression for terminal session sleep.
 *
 * D1 lifecycle state and the production service/scheduled-loop composition are
 * real. Only external control planes (ProjectData, VM agent, R2, and the node
 * lifecycle DO) are substituted so contract drift between queue, defer, claim,
 * final snapshot, and cleanup cannot hide behind unit mocks.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import { sleepWorkspaceSession } from '../../src/services/session-sleep';
import { cleanupTerminalTaskResources } from '../../src/services/task-terminal-cleanup';
import type { SleepActivity } from '../helpers/session-sleep-fixture';

const {
  sleepBoundaryMocks: mocks,
  createSessionSleepFixture,
  SLEEP_START: START,
} = await vi.hoisted(() => import('../helpers/session-sleep-fixture'));
const RETRY_AT = new Date('2026-08-14T05:15:00.000Z');

describe('terminal session sleep lifecycle integration', () => {
  let sqlite: Database.Database;
  let env: Env;
  let activity: SleepActivity;
  let fixture: ReturnType<typeof createSessionSleepFixture>;
  let order: string[];

  beforeEach(() => {
    activity = { activity: 'prompting', activityAt: START.getTime() };
    fixture = createSessionSleepFixture('completed', () => activity);
    ({ sqlite, env, order } = fixture);
  });

  afterEach(() => fixture.dispose());

  it.each(['in_progress', 'completed', 'failed', 'cancelled'])(
    'sleeps a VM with task status %s without rewriting terminal tasks',
    async (status) => {
      sqlite
        .prepare("UPDATE tasks SET status = ?, execution_step = 'agent_ready' WHERE id = 'task-1'")
        .run(status);
      activity = { activity: 'idle', activityAt: START.getTime() - 60_000 };

      await sleepWorkspaceSession(env, {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'explicit test sleep',
      });

      expect(
        sqlite.prepare("SELECT status, execution_step FROM tasks WHERE id = 'task-1'").get()
      ).toEqual({
        status: status === 'in_progress' ? 'sleeping' : status,
        execution_step: status === 'in_progress' ? null : 'agent_ready',
      });
      expect(
        sqlite.prepare("SELECT status FROM workspaces WHERE id = 'workspace-1'").get()
      ).toEqual({
        status: 'sleeping',
      });
      expect(mocks.stopWorkspaceOnNode).toHaveBeenCalled();
      const events = sqlite
        .prepare("SELECT from_status, to_status FROM task_status_events WHERE task_id = 'task-1'")
        .all();
      expect(events).toEqual(
        status === 'in_progress' ? [{ from_status: 'in_progress', to_status: 'sleeping' }] : []
      );
    }
  );

  it.each(['user_id', 'project_id'] as const)(
    'refuses a conflicting snapshot %s before lifecycle changes or runtime teardown',
    async (column) => {
      sqlite.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'task-1'").run();
      sqlite
        .prepare(`UPDATE session_snapshots SET ${column} = ? WHERE id = ?`)
        .run('foreign-scope', 'snapshot-1');
      activity = { activity: 'idle', activityAt: START.getTime() - 60_000 };
      const snapshotBefore = sqlite
        .prepare("SELECT * FROM session_snapshots WHERE id = 'snapshot-1'")
        .get();
      const taskBefore = sqlite.prepare("SELECT * FROM tasks WHERE id = 'task-1'").get();
      const workspaceBefore = sqlite
        .prepare("SELECT * FROM workspaces WHERE id = 'workspace-1'")
        .get();
      await expect(
        sleepWorkspaceSession(env, {
          workspaceId: 'workspace-1',
          userId: 'user-1',
          reason: 'ownership conflict regression',
        })
      ).rejects.toThrow('Session snapshot ownership conflict');
      expect(
        sqlite.prepare("SELECT * FROM session_snapshots WHERE id = 'snapshot-1'").get()
      ).toEqual(snapshotBefore);
      expect(sqlite.prepare("SELECT * FROM tasks WHERE id = 'task-1'").get()).toEqual(taskBefore);
      expect(sqlite.prepare("SELECT * FROM workspaces WHERE id = 'workspace-1'").get()).toEqual(
        workspaceBefore
      );
      expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
      expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
      expect(mocks.sleepSession).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    }
  );

  it('protects a long prompt immediately after completion in both sweep and teardown gates', async () => {
    sqlite
      .prepare('UPDATE tasks SET completed_at = ? WHERE id = ?')
      .run(START.toISOString(), 'task-1');
    activity = { activity: 'prompting', activityAt: START.getTime() - 60 * 60 * 1000 };
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'completed' });
    expect(await runSessionSleepSweep(env, START)).toMatchObject({
      deferred: 1,
      claimed: 0,
      slept: 0,
    });
    expect(
      sqlite.prepare('SELECT sleep_after FROM session_snapshots WHERE id = ?').get('snapshot-1')
    ).toEqual({ sleep_after: RETRY_AT.toISOString() });
    await expect(
      sleepWorkspaceSession(env, {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'explicit test sleep',
      })
    ).rejects.toThrow('Workspace agent is not idle (prompting)');
    expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
  });

  it('terminalizes a stopped capture in the service catch before the sweep handles it again', async () => {
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'completed' });
    activity = { activity: 'idle', activityAt: START.getTime() };
    mocks.hibernateAgentSessionOnNode.mockRejectedValue(
      new Error(
        'resolve snapshot devcontainer: workspace is not running/recovery (status: stopped)'
      )
    );

    const first = await runSessionSleepSweep(env, START);
    const second = await runSessionSleepSweep(env, RETRY_AT);

    expect(first).toMatchObject({ claimed: 1, failed: 1 });
    expect(second).toMatchObject({ selected: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT sleep_status, sleep_claim_id FROM session_snapshots
      WHERE id = 'snapshot-1'`
        )
        .get()
    ).toEqual({
      sleep_status: 'terminal_failed',
      sleep_claim_id: null,
    });
    expect(mocks.hibernateAgentSessionOnNode).toHaveBeenCalledTimes(1);
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
  });

  it('preserves a concurrent renewed intent when an old capture fails', async () => {
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'completed' });
    activity = { activity: 'idle', activityAt: START.getTime() };
    mocks.hibernateAgentSessionOnNode.mockImplementation(async () => {
      sqlite
        .prepare(
          `UPDATE session_snapshots SET sleep_status = 'scheduled',
        sleep_claim_id = NULL, sleep_after = '2026-08-15T05:00:00.000Z',
        capture_generation = 'renewed' WHERE id = 'snapshot-1'`
        )
        .run();
      throw new Error(
        'resolve snapshot devcontainer: workspace is not running/recovery (status: stopped)'
      );
    });
    await runSessionSleepSweep(env, START);
    expect(
      sqlite
        .prepare(
          `SELECT sleep_status, sleep_after, capture_generation FROM session_snapshots
      WHERE id = 'snapshot-1'`
        )
        .get()
    ).toEqual({
      sleep_status: 'scheduled',
      sleep_after: '2026-08-15T05:00:00.000Z',
      capture_generation: 'renewed',
    });
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
  });

  it('persists terminal intent, defers prompting without an attempt, then sleeps on idle', async () => {
    await cleanupTerminalTaskResources(env, 'task-1', { status: 'completed' });

    expect(
      sqlite
        .prepare(
          `SELECT status, project_id, workspace_id, node_id, user_id, agent_session_id, runtime,
                  sleep_status, sleep_after, sleep_attempts
           FROM session_snapshots WHERE chat_session_id = 'chat-1'`
        )
        .get()
    ).toEqual({
      status: 'pending',
      project_id: 'project-1',
      workspace_id: 'workspace-1',
      node_id: 'node-1',
      user_id: 'user-1',
      agent_session_id: 'agent-1',
      runtime: 'vm',
      sleep_status: 'scheduled',
      sleep_after: START.toISOString(),
      sleep_attempts: 0,
    });
    expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();

    // Model a crashed sweep owner. The prompting eligibility result must
    // release exactly this stale claim instead of leaving it hot-selected.
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET sleep_status = 'preparing', sleep_after = NULL,
             sleep_claim_id = 'stale-owner', sleep_claimed_at = '2026-08-14T04:00:00.000Z'
         WHERE chat_session_id = 'chat-1'`
      )
      .run();

    const promptingSweep = await runSessionSleepSweep(env, START);
    expect(promptingSweep).toMatchObject({ selected: 1, deferred: 1, claimed: 0, slept: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT sleep_status, sleep_after, sleep_attempts, sleep_claim_id, sleep_claimed_at
           FROM session_snapshots WHERE chat_session_id = 'chat-1'`
        )
        .get()
    ).toEqual({
      sleep_status: 'scheduled',
      sleep_after: RETRY_AT.toISOString(),
      sleep_attempts: 0,
      sleep_claim_id: null,
      sleep_claimed_at: null,
    });

    activity = { activity: 'idle', activityAt: START.getTime() + 30_000 };
    vi.setSystemTime(RETRY_AT);
    sqlite
      .prepare(`UPDATE nodes SET last_heartbeat_at = ? WHERE id = 'node-1'`)
      .run(RETRY_AT.toISOString());
    const idleSweep = await runSessionSleepSweep(env, RETRY_AT);

    expect(idleSweep).toMatchObject({ selected: 1, deferred: 0, claimed: 1, slept: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT status, sleep_status, sleeping_at, sleep_attempts, sleep_after,
                  sleep_claim_id, sleep_claimed_at
           FROM session_snapshots WHERE chat_session_id = 'chat-1'`
        )
        .get()
    ).toEqual({
      status: 'available',
      sleep_status: 'sleeping',
      sleeping_at: RETRY_AT.toISOString(),
      sleep_attempts: 1,
      sleep_after: null,
      sleep_claim_id: null,
      sleep_claimed_at: null,
    });
    expect(sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'workspace-1'`).get()).toEqual({
      status: 'sleeping',
    });
    expect(sqlite.prepare(`SELECT status FROM agent_sessions WHERE id = 'agent-1'`).get()).toEqual({
      status: 'sleeping',
    });

    expect(order.indexOf('final-snapshot:chat-1')).toBeLessThan(
      order.findIndex((event) => event.startsWith('r2-head:'))
    );
    expect(order.findIndex((event) => event.startsWith('r2-head:'))).toBeLessThan(
      order.indexOf('stop-workspace')
    );
    expect(order.indexOf('stop-workspace')).toBeLessThan(order.indexOf('schedule-deletion'));
    expect(order.indexOf('schedule-deletion')).toBeLessThan(order.indexOf('task-cleanup'));
    expect(order.indexOf('task-cleanup')).toBeLessThan(order.indexOf('mark-node-warm'));
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env, 2_700_000);
    expect(mocks.markIdle).toHaveBeenCalledWith('node-1', 'user-1', 2_700_000);
  });

  it('discovers a snapshotless Instant workspace but defers while settling work is fresh', async () => {
    sqlite.prepare(`UPDATE workspaces SET status = 'sleeping' WHERE id = 'workspace-1'`).run();
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, status, node_role, runtime, last_heartbeat_at, updated_at)
         VALUES ('fresh-instant-node', 'user-1', 'running', 'workspace', 'cf-container', ?, ?)`
      )
      .run(START.toISOString(), START.toISOString());
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, node_id, project_id, user_id, chat_session_id, status, updated_at, last_activity_at, provider_instance_type)
         VALUES
           ('fresh-instant-workspace', 'fresh-instant-node', 'project-1', 'user-1', 'fresh-instant-chat',
            'running', ?, ?, 'cf-container')`
      )
      .run(START.toISOString(), START.toISOString());
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, project_id, user_id, workspace_id, chat_session_id, status, execution_step, task_mode, updated_at)
         VALUES
           ('fresh-instant-task', 'project-1', 'user-1', 'fresh-instant-workspace', 'fresh-instant-chat',
            'in_progress', 'awaiting_followup', 'conversation', ?)`
      )
      .run(START.toISOString());
    sqlite
      .prepare(
        `INSERT INTO session_summaries
           (id, project_id, user_id, status, task_id, workspace_id,
            message_count, started_at, last_message_at, updated_at)
         VALUES
           ('fresh-instant-chat', 'project-1', 'user-1', 'active', 'fresh-instant-task',
            'fresh-instant-workspace', 10, ?, ?, ?)`
      )
      .run(START.getTime(), START.getTime(), START.getTime());
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_type, created_at, updated_at)
         VALUES ('fresh-instant-agent', 'fresh-instant-workspace', 'user-1', 'running', 'claude-code', ?, ?)`
      )
      .run(START.toISOString(), START.toISOString());

    activity = {
      activity: 'idle',
      activityAt: START.getTime(),
      runtimeWorkState: 'settling',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude-background-tasks',
      runtimeWorkUpdatedAt: START.getTime(),
      runtimeWorkProgressAt: START.getTime(),
    };

    const result = await runSessionSleepSweep(env, START);

    expect(result).toMatchObject({ reconciled: 1, selected: 1, deferred: 1, claimed: 0, slept: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT runtime, sleep_status, sleep_after, sleep_attempts
           FROM session_snapshots WHERE chat_session_id = 'fresh-instant-chat'`
        )
        .get()
    ).toEqual({
      runtime: 'cf-container',
      sleep_status: 'scheduled',
      sleep_after: '2026-08-14T05:05:00.000Z',
      sleep_attempts: 0,
    });
    expect(
      sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'fresh-instant-workspace'`).get()
    ).toEqual({
      status: 'running',
    });
    expect(mocks.hibernateAgentSessionOnNode).not.toHaveBeenCalled();
    expect(mocks.sleepVmAgentContainer).not.toHaveBeenCalled();
  });

  it('discovers a stranded Instant workspace without a snapshot and sleeps after stale settling expires', async () => {
    sqlite.prepare(`UPDATE workspaces SET status = 'sleeping' WHERE id = 'workspace-1'`).run();
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, status, node_role, runtime, last_heartbeat_at, updated_at)
         VALUES ('instant-node', 'user-1', 'running', 'workspace', 'cf-container', ?, ?)`
      )
      .run(RETRY_AT.toISOString(), RETRY_AT.toISOString());
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, node_id, project_id, user_id, chat_session_id, status, updated_at, last_activity_at, provider_instance_type)
         VALUES
           ('instant-workspace', 'instant-node', 'project-1', 'user-1', 'instant-chat', 'running', ?, ?, 'cf-container')`
      )
      .run(START.toISOString(), START.toISOString());
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, project_id, user_id, workspace_id, chat_session_id, status, execution_step, task_mode, updated_at)
         VALUES
           ('instant-task', 'project-1', 'user-1', 'instant-workspace', 'instant-chat', 'in_progress',
            'awaiting_followup', 'conversation', ?)`
      )
      .run(START.toISOString());
    sqlite
      .prepare(
        `INSERT INTO session_summaries
           (id, project_id, user_id, status, task_id, workspace_id,
            message_count, started_at, last_message_at, updated_at)
         VALUES
           ('instant-chat', 'project-1', 'user-1', 'active', 'instant-task', 'instant-workspace',
            10, ?, ?, ?)`
      )
      .run(START.getTime(), START.getTime(), START.getTime());
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_type, created_at, updated_at)
         VALUES ('instant-agent', 'instant-workspace', 'user-1', 'running', 'claude-code', ?, ?)`
      )
      .run(START.toISOString(), START.toISOString());
    sqlite.prepare(`DELETE FROM session_snapshots WHERE chat_session_id = 'instant-chat'`).run();

    activity = {
      activity: 'idle',
      activityAt: START.getTime(),
      runtimeWorkState: 'settling',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude-background-tasks',
      runtimeWorkUpdatedAt: START.getTime() - 10 * 60 * 1000,
      runtimeWorkProgressAt: START.getTime() - 31 * 60 * 1000,
    };
    vi.setSystemTime(RETRY_AT);

    const result = await runSessionSleepSweep(env, RETRY_AT);

    expect(result).toMatchObject({ reconciled: 1, selected: 1, claimed: 1, slept: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT runtime, status, sleep_status, sleeping_at, sleep_attempts
           FROM session_snapshots WHERE chat_session_id = 'instant-chat'`
        )
        .get()
    ).toEqual({
      runtime: 'cf-container',
      status: 'available',
      sleep_status: 'sleeping',
      sleeping_at: RETRY_AT.toISOString(),
      sleep_attempts: 1,
    });
    expect(
      sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'instant-workspace'`).get()
    ).toEqual({
      status: 'sleeping',
    });
    expect(
      sqlite.prepare(`SELECT status FROM agent_sessions WHERE id = 'instant-agent'`).get()
    ).toEqual({
      status: 'sleeping',
    });
    expect(sqlite.prepare(`SELECT status FROM nodes WHERE id = 'instant-node'`).get()).toEqual({
      status: 'sleeping',
    });
    expect(order).toContain('final-snapshot:instant-chat');
    expect(order).toContain('sleep-container:instant-node');
    expect(order.indexOf('final-snapshot:instant-chat')).toBeLessThan(
      order.findIndex((event) => event.startsWith('r2-head:session-snapshots/instant-chat/'))
    );
    expect(
      order.findIndex((event) => event.startsWith('r2-head:session-snapshots/instant-chat/'))
    ).toBeLessThan(order.indexOf('sleep-container:instant-node'));
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalledWith(
      'instant-node',
      'instant-workspace',
      expect.anything(),
      'user-1'
    );
  });

  it('discovers mixed VM and Instant candidates in the same bounded sweep', async () => {
    sqlite.prepare(`UPDATE workspaces SET status = 'sleeping' WHERE id = 'workspace-1'`).run();
    for (const [prefix, runtime] of [
      ['mixed-vm', 'vm'],
      ['mixed-instant', 'cf-container'],
    ] as const) {
      sqlite
        .prepare(
          `INSERT INTO nodes (id, user_id, status, node_role, runtime, last_heartbeat_at, updated_at)
           VALUES (?, 'user-1', 'running', 'workspace', ?, ?, ?)`
        )
        .run(`${prefix}-node`, runtime, RETRY_AT.toISOString(), RETRY_AT.toISOString());
      sqlite
        .prepare(
          `INSERT INTO workspaces
             (id, node_id, project_id, user_id, chat_session_id, status, updated_at, last_activity_at, provider_instance_type)
           VALUES (?, ?, 'project-1', 'user-1', ?, 'running', ?, ?, ?)`
        )
        .run(
          `${prefix}-workspace`,
          `${prefix}-node`,
          `${prefix}-chat`,
          START.toISOString(),
          START.toISOString(),
          runtime
        );
      sqlite
        .prepare(
          `INSERT INTO tasks
             (id, project_id, user_id, workspace_id, chat_session_id, status, execution_step, task_mode, updated_at)
           VALUES (?, 'project-1', 'user-1', ?, ?, 'in_progress', 'awaiting_followup', 'conversation', ?)`
        )
        .run(`${prefix}-task`, `${prefix}-workspace`, `${prefix}-chat`, START.toISOString());
      sqlite
        .prepare(
          `INSERT INTO session_summaries
             (id, project_id, user_id, status, task_id, workspace_id,
              message_count, started_at, last_message_at, updated_at)
           VALUES (?, 'project-1', 'user-1', 'active', ?, ?, 10, ?, ?, ?)`
        )
        .run(
          `${prefix}-chat`,
          `${prefix}-task`,
          `${prefix}-workspace`,
          START.getTime(),
          START.getTime(),
          START.getTime()
        );
      sqlite
        .prepare(
          `INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_type, created_at, updated_at)
           VALUES (?, ?, 'user-1', 'running', 'claude-code', ?, ?)`
        )
        .run(`${prefix}-agent`, `${prefix}-workspace`, START.toISOString(), START.toISOString());
    }

    activity = {
      activity: 'idle',
      activityAt: START.getTime(),
    };
    vi.setSystemTime(RETRY_AT);

    const result = await runSessionSleepSweep(env, RETRY_AT);

    expect(result).toMatchObject({ reconciled: 2, selected: 2, deferred: 0, claimed: 2, slept: 2 });
    expect(
      sqlite
        .prepare(
          `SELECT chat_session_id, runtime, sleep_status
           FROM session_snapshots
           WHERE chat_session_id IN ('mixed-vm-chat', 'mixed-instant-chat')
           ORDER BY chat_session_id`
        )
        .all()
    ).toEqual([
      {
        chat_session_id: 'mixed-instant-chat',
        runtime: 'cf-container',
        sleep_status: 'sleeping',
      },
      {
        chat_session_id: 'mixed-vm-chat',
        runtime: 'vm',
        sleep_status: 'sleeping',
      },
    ]);
    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledWith(
      'mixed-vm-node',
      'mixed-vm-workspace',
      env,
      'user-1'
    );
    expect(mocks.sleepVmAgentContainer).toHaveBeenCalledWith(env, 'mixed-instant-node');
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalledWith(
      'mixed-instant-node',
      'mixed-instant-workspace',
      expect.anything(),
      'user-1'
    );
  });
});
