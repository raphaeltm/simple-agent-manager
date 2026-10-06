/** Real SQLite VM teardown followed by production activity and MCP consumers. */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { handleSendDurableMessage } from '../../src/routes/mcp/mailbox-tools';
import {
  handleSendMessageToSubtask,
  handleStopSubtask,
} from '../../src/routes/mcp/orchestration-comms';
import { listAgentActivityTasks } from '../../src/services/agent-activity';
import { sleepWorkspaceSession } from '../../src/services/session-sleep';
import type { SleepActivity } from '../helpers/session-sleep-fixture';

const {
  sleepBoundaryMocks: mocks,
  createSessionSleepFixture,
  SLEEP_START: START,
} = await vi.hoisted(() => import('../helpers/session-sleep-fixture'));

describe('sleeping task consumers after real VM teardown', () => {
  let sqlite: Database.Database;
  let env: Env;
  let activity: SleepActivity;
  let fixture: ReturnType<typeof createSessionSleepFixture>;

  beforeEach(() => {
    activity = { activity: 'idle', activityAt: START.getTime() };
    fixture = createSessionSleepFixture('in_progress', () => activity);
    ({ sqlite, env } = fixture);
    sqlite
      .prepare(
        "UPDATE tasks SET parent_task_id = 'parent-task', chat_session_id = 'chat-1' WHERE id = 'task-1'"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO tasks (id, project_id, user_id, status) VALUES ('parent-task', 'project-1', 'user-1', 'in_progress')"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO project_members (project_id, user_id, role, status) VALUES ('project-1', 'user-1', 'owner', 'active')"
      )
      .run();
    mocks.acceptPromptDelivery.mockResolvedValue({
      message: { id: 'message-1', targetSessionId: 'chat-1', deliveryState: 'queued' },
    });
    env.DURABLE_PROMPT_DELIVERY_ENABLED = 'true';
  });

  afterEach(() => fixture.dispose());

  const token = {
    taskId: 'parent-task',
    projectId: 'project-1',
    userId: 'user-1',
    workspaceId: 'parent-workspace',
    createdAt: START.toISOString(),
  };

  async function sleep() {
    await sleepWorkspaceSession(env, {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      reason: 'consumer regression',
    });
    expect(sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get()).toEqual({
      status: 'sleeping',
    });
    expect(sqlite.prepare("SELECT status FROM agent_sessions WHERE id = 'agent-1'").get()).toEqual({
      status: 'sleeping',
    });
    mocks.cleanupTaskRun.mockClear();
    mocks.stopWorkspaceOnNode.mockClear();
  }

  it('keeps a slept VM in active activity while excluding terminal controls', async () => {
    await sleep();
    for (const status of ['completed', 'failed', 'cancelled']) {
      sqlite
        .prepare('INSERT INTO tasks (id, project_id, user_id, status) VALUES (?, ?, ?, ?)')
        .run(`terminal-${status}`, 'project-1', 'user-1', status);
    }
    const rows = await listAgentActivityTasks(env, { projectId: 'project-1' });
    expect(rows.find((row) => row.id === 'task-1')).toMatchObject({ status: 'sleeping' });
    expect(rows.filter((row) => row.id.startsWith('terminal-'))).toEqual([]);
  });

  it.each(['absent', 'deleted'])(
    'durably accepts both message tools after VM teardown with a %s node',
    async (nodeState) => {
      await sleep();
      if (nodeState === 'absent') sqlite.prepare("DELETE FROM nodes WHERE id = 'node-1'").run();
      else sqlite.prepare("UPDATE nodes SET status = 'deleted' WHERE id = 'node-1'").run();
      sqlite.prepare("DELETE FROM agent_sessions WHERE id = 'agent-1'").run();
      const handoff = await handleSendMessageToSubtask(
        1,
        { taskId: 'task-1', message: 'Continue work' },
        token,
        env
      );
      const durable = await handleSendDurableMessage(
        2,
        { targetTaskId: 'task-1', message: 'Continue work' },
        token,
        env
      );
      expect(handoff.error).toBeUndefined();
      expect(durable.error).toBeUndefined();
      expect(mocks.acceptPromptDelivery).toHaveBeenCalledTimes(2);
      for (const call of mocks.acceptPromptDelivery.mock.calls) {
        expect(call).toEqual([
          env,
          'project-1',
          expect.objectContaining({
            targetSessionId: 'chat-1',
            displayContent: 'Continue work',
            sourceTaskId: 'parent-task',
          }),
        ]);
      }
      expect(mocks.sendPrompt).not.toHaveBeenCalled();
    }
  );

  it.each(['absent', 'deleted'])(
    'keeps live-runtime checks for active handoff and stop with a %s node',
    async (nodeState) => {
      if (nodeState === 'absent') sqlite.prepare("DELETE FROM nodes WHERE id = 'node-1'").run();
      else sqlite.prepare("UPDATE nodes SET status = 'deleted' WHERE id = 'node-1'").run();
      expect(
        (await handleSendMessageToSubtask(1, { taskId: 'task-1', message: 'Continue' }, token, env))
          .error
      ).toBeDefined();
      expect((await handleStopSubtask(2, { taskId: 'task-1' }, token, env)).error).toBeDefined();
      expect(mocks.acceptPromptDelivery).not.toHaveBeenCalled();
      expect(mocks.sendPrompt).not.toHaveBeenCalled();
      expect(mocks.stopAgent).not.toHaveBeenCalled();
      expect(sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get()).toEqual({
        status: 'in_progress',
      });
    }
  );

  it('explicitly refuses sleeping messages when durable delivery is disabled', async () => {
    await sleep();
    env.DURABLE_PROMPT_DELIVERY_ENABLED = 'false';
    for (const result of [
      await handleSendMessageToSubtask(1, { taskId: 'task-1', message: 'Wake' }, token, env),
      await handleSendDurableMessage(2, { targetTaskId: 'task-1', message: 'Wake' }, token, env),
    ]) {
      expect(result.error?.message).toMatch(/durable.*(disabled|enabled)|enable.*durable/i);
    }
    expect(mocks.acceptPromptDelivery).not.toHaveBeenCalled();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });

  it('parent cancels a slept VM without a node or agent, including warning reason', async () => {
    await sleep();
    sqlite.prepare("DELETE FROM nodes WHERE id = 'node-1'").run();
    sqlite.prepare("DELETE FROM agent_sessions WHERE id = 'agent-1'").run();
    const result = await handleStopSubtask(
      1,
      { taskId: 'task-1', reason: 'No longer needed' },
      token,
      env
    );
    expect(result.error).toBeUndefined();
    expect(
      sqlite.prepare("SELECT status, error_message FROM tasks WHERE id = 'task-1'").get()
    ).toEqual({ status: 'cancelled', error_message: 'Stopped by parent: No longer needed' });
    expect(
      sqlite
        .prepare(
          "SELECT from_status, to_status FROM task_status_events WHERE to_status = 'cancelled'"
        )
        .all()
    ).toEqual([{ from_status: 'sleeping', to_status: 'cancelled' }]);
    expect(mocks.stopSession).toHaveBeenCalledWith(env, 'project-1', 'chat-1');
    expect(fixture.sessionStatus).toBe('stopped');
    expect(mocks.cleanupTaskRun).toHaveBeenCalled();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(mocks.stopAgent).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'cancelled'])(
    'all tools reject terminal %s targets',
    async (status) => {
      await sleep();
      sqlite.prepare("UPDATE tasks SET status = ? WHERE id = 'task-1'").run(status);
      const results = [
        await handleSendMessageToSubtask(1, { taskId: 'task-1', message: 'Wake' }, token, env),
        await handleSendDurableMessage(2, { targetTaskId: 'task-1', message: 'Wake' }, token, env),
        await handleStopSubtask(3, { taskId: 'task-1' }, token, env),
      ];
      for (const result of results) expect(result.error).toBeDefined();
      expect(mocks.acceptPromptDelivery).not.toHaveBeenCalled();
      expect(mocks.stopSession).not.toHaveBeenCalled();
    }
  );

  it('preserves project messaging and direct-parent stop boundaries after sleep', async () => {
    await sleep();
    const otherProject = { ...token, projectId: 'other-project' };
    expect(
      (
        await handleSendMessageToSubtask(
          1,
          { taskId: 'task-1', message: 'Wake' },
          otherProject,
          env
        )
      ).error
    ).toBeDefined();
    expect(
      (
        await handleSendDurableMessage(
          2,
          { targetTaskId: 'task-1', message: 'Wake' },
          otherProject,
          env
        )
      ).error
    ).toBeDefined();
    sqlite.prepare("UPDATE tasks SET parent_task_id = 'other-parent' WHERE id = 'task-1'").run();
    expect((await handleStopSubtask(3, { taskId: 'task-1' }, token, env)).error?.message).toMatch(
      /direct parent/
    );
    expect(mocks.acceptPromptDelivery).not.toHaveBeenCalled();
    expect(mocks.stopSession).not.toHaveBeenCalled();
  });

  it('refuses a sleeping caller while allowing an active project peer to message', async () => {
    await sleep();
    sqlite
      .prepare("UPDATE tasks SET parent_task_id = 'different-parent' WHERE id = 'task-1'")
      .run();
    expect(
      (
        await handleSendMessageToSubtask(
          1,
          { taskId: 'task-1', message: 'Peer message' },
          token,
          env
        )
      ).error
    ).toBeUndefined();
    sqlite.prepare("UPDATE tasks SET status = 'sleeping' WHERE id = 'parent-task'").run();
    expect(
      (await handleSendMessageToSubtask(2, { taskId: 'task-1', message: 'Wake' }, token, env)).error
    ).toBeDefined();
    expect(
      (await handleSendDurableMessage(3, { targetTaskId: 'task-1', message: 'Wake' }, token, env))
        .error
    ).toBeDefined();
    expect(mocks.acceptPromptDelivery).toHaveBeenCalledTimes(1);
  });

  it.each(['removed', 'viewer'])(
    'refuses parent stop after membership becomes %s',
    async (change) => {
      await sleep();
      if (change === 'removed')
        sqlite.prepare("UPDATE project_members SET status = 'removed'").run();
      else sqlite.prepare("UPDATE project_members SET role = 'viewer'").run();
      expect((await handleStopSubtask(1, { taskId: 'task-1' }, token, env)).error).toBeDefined();
      expect(sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get()).toEqual({
        status: 'sleeping',
      });
      expect(mocks.stopSession).not.toHaveBeenCalled();
      expect(mocks.stopAgent).not.toHaveBeenCalled();
    }
  );

  it('does not commit sleeping task state when the transition event cannot be persisted', async () => {
    sqlite.exec(`CREATE TRIGGER reject_sleep_event BEFORE INSERT ON task_status_events
      WHEN NEW.to_status = 'sleeping' BEGIN SELECT RAISE(ABORT, 'event store unavailable'); END`);
    await expect(
      sleepWorkspaceSession(env, {
        workspaceId: 'workspace-1',
        userId: 'user-1',
        reason: 'event persistence failure',
      })
    ).rejects.toThrow('event store unavailable');
    expect(sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get()).toEqual({
      status: 'in_progress',
    });
  });

  it('records the sleep status transition once when sleep is retried', async () => {
    await sleep();
    await sleepWorkspaceSession(env, {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      reason: 'retry consumer regression',
    });
    expect(
      sqlite
        .prepare(
          "SELECT task_id, from_status, to_status FROM task_status_events WHERE to_status = 'sleeping'"
        )
        .all()
    ).toEqual([{ task_id: 'task-1', from_status: 'in_progress', to_status: 'sleeping' }]);
  });
});
