/**
 * Failed-task work preservation, entered through the real trigger (rule 62): the
 * VM-agent failure callback (`POST /:projectId/tasks/:taskId/status/callback`,
 * `toStatus: 'failed'` — what `makeTaskCompletionCallback` posts for "Agent prompt
 * failed", provider usage limits and prompt timeouts).
 *
 * Real SQL for the task transition, the callback workspace fence, terminal cleanup,
 * the preservation decision and the sleep queue. Substituted: the callback JWT,
 * ProjectData, lifecycle-event fan-out, VM admission and runtime teardown.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { AppError } from '../../../src/middleware/error';
import { taskCallbackRoute } from '../../../src/routes/tasks/callback';
import { failedTaskWorkLossMessage } from '../../../src/services/failed-task-preservation';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  cleanupTaskRun: vi.fn(),
  failSession: vi.fn(),
  persistMessage: vi.fn(),
  waitUntil: [] as Promise<unknown>[],
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi
    .fn()
    .mockResolvedValue({ workspace: 'ws-1', type: 'callback', scope: 'workspace' }),
}));

vi.mock('../../../src/services/project-data', () => ({
  recordActivityEvent: vi.fn().mockResolvedValue(undefined),
  failSession: (...args: unknown[]) => mocks.failSession(...args),
  persistMessage: (...args: unknown[]) => mocks.persistMessage(...args),
  stopSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/project-lifecycle-events', () => ({
  isLifecycleTaskStatus: () => true,
  recordTaskLifecycleEventBestEffort: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => mocks.cleanupTaskRun(...args),
}));

vi.mock('../../../src/services/vm-admission-control', () => ({
  cancelVmTaskAdmission: vi.fn().mockResolvedValue(undefined),
}));

const NOW = new Date('2026-09-25T10:00:00.000Z');

function fakeCallbackToken(): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'RS256', typ: 'JWT' })}.${segment({
    iat: Math.floor(NOW.getTime() / 1000),
    workspace: 'ws-1',
  })}.sig`;
}

describe('VM-agent failure callback preserves the failed task work', () => {
  let sqlite: Database.Database;
  let app: Hono;

  function seed(agentSessionStatus: string) {
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, status, node_role, runtime)
         VALUES ('node-1', 'user-1', 'running', 'workspace', 'vm')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, node_id, project_id, user_id, chat_session_id, status, updated_at)
         VALUES ('ws-1', 'node-1', 'project-1', 'user-1', 'chat-1', 'running', ?)`
      )
      .run(NOW.toISOString());
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, project_id, user_id, workspace_id, chat_session_id, title, status, execution_step,
            task_mode, created_at, updated_at)
         VALUES ('task-1', 'project-1', 'user-1', 'ws-1', 'chat-1', 'Rebase PR', 'in_progress',
                 'running', 'task', ?, ?)`
      )
      .run(NOW.toISOString(), NOW.toISOString());
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, status, agent_type, created_at)
         VALUES ('agent-1', 'ws-1', ?, 'claude-code', ?)`
      )
      .run(agentSessionStatus, NOW.toISOString());
  }

  function postCallback(body: Record<string, unknown>): Promise<Response> {
    return app.request(
      '/api/projects/project-1/tasks/task-1/status/callback',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fakeCallbackToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      { DATABASE: createSqliteD1(sqlite) },
      { waitUntil: (promise: Promise<unknown>) => mocks.waitUntil.push(promise) }
    );
  }

  function postFailedCallback(): Promise<Response> {
    return postCallback({
      toStatus: 'failed',
      reason: 'Agent prompt failed',
      errorMessage: "You've hit your usage limit",
    });
  }

  function snapshotRow() {
    return sqlite
      .prepare(
        `SELECT status, sleep_status, sleep_after, sleep_attempts FROM session_snapshots
         WHERE chat_session_id = 'chat-1'`
      )
      .get();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mocks.waitUntil.length = 0;
    mocks.cleanupTaskRun.mockResolvedValue(undefined);
    mocks.failSession.mockResolvedValue(undefined);
    mocks.persistMessage.mockResolvedValue('notice-1');
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      'CREATE UNIQUE INDEX idx_session_snapshots_chat_session_id ON session_snapshots(chat_session_id)'
    );
    app = new Hono();
    app.route('/api/projects', taskCallbackRoute);
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 410 | 500);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
    });
  });

  afterEach(async () => {
    await Promise.allSettled(mocks.waitUntil);
    sqlite.close();
    vi.useRealTimers();
  });

  it('fails the task but queues a snapshot-backed sleep instead of tearing the workspace down', async () => {
    seed('running');

    const response = await postFailedCallback();

    expect(response.status).toBe(200);
    expect(
      sqlite.prepare(`SELECT status, error_message FROM tasks WHERE id = 'task-1'`).get()
    ).toEqual({ status: 'failed', error_message: "You've hit your usage limit" });
    expect(snapshotRow()).toMatchObject({
      status: 'pending',
      sleep_status: 'scheduled',
      sleep_after: NOW.toISOString(),
    });
    expect(sqlite.prepare(`SELECT status FROM workspaces WHERE id = 'ws-1'`).get()).toEqual({
      status: 'running',
    });
    expect(mocks.failSession).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
    expect(mocks.persistMessage).not.toHaveBeenCalled();
  });

  it("keeps the failure's error when a later step report arrives", async () => {
    // A preserved failed task's agent can keep working and reporting steps (e.g.
    // `awaiting_followup` after a follow-up turn). A step report is progress, not
    // an outcome, and must not erase why the task failed.
    seed('running');
    expect((await postFailedCallback()).status).toBe(200);

    const stepReport = await postCallback({ executionStep: 'awaiting_followup' });

    expect(stepReport.status).toBe(200);
    expect(
      sqlite
        .prepare(`SELECT status, execution_step, error_message FROM tasks WHERE id = 'task-1'`)
        .get()
    ).toEqual({
      status: 'failed',
      execution_step: 'awaiting_followup',
      error_message: "You've hit your usage limit",
    });
  });

  it('still clears a live task error on a step report (control)', async () => {
    seed('running');
    sqlite.prepare(`UPDATE tasks SET error_message = 'transient provider error'`).run();

    expect((await postCallback({ executionStep: 'awaiting_followup' })).status).toBe(200);

    expect(
      sqlite.prepare(`SELECT status, error_message FROM tasks WHERE id = 'task-1'`).get()
    ).toEqual({ status: 'in_progress', error_message: null });
  });

  it('stays non-destructive when the VM agent repeats the failure callback', async () => {
    seed('running');

    expect((await postFailedCallback()).status).toBe(200);
    expect((await postFailedCallback()).status).toBe(200);

    expect(snapshotRow()).toMatchObject({ sleep_status: 'scheduled', sleep_attempts: 0 });
    expect(mocks.failSession).not.toHaveBeenCalled();
    expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
  });

  it('surfaces the loss, then fails and tears down, when the agent session has already ended', async () => {
    seed('failed');

    const response = await postFailedCallback();

    expect(response.status).toBe(200);
    expect(snapshotRow()).toBeUndefined();
    expect(mocks.persistMessage).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'chat-1',
      'system',
      failedTaskWorkLossMessage('no_resumable_agent_session'),
      null,
      'failed-task-work-loss-task-1'
    );
    expect(mocks.failSession).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'chat-1',
      "You've hit your usage limit"
    );
    expect(mocks.cleanupTaskRun).toHaveBeenCalledWith(
      'task-1',
      expect.anything(),
      undefined,
      undefined
    );
  });
});
