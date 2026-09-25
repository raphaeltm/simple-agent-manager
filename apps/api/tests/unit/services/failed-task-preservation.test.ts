/**
 * The failed-task preservation decision against a real SQL engine (rule 28): every
 * outcome, every gap, project scoping, and the sweep's release/note guards.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  failedTaskWorkLossMessage,
  noteFailedTaskPreservationCapture,
  preserveFailedTaskWork,
  releaseExhaustedFailedTaskPreservation,
} from '../../../src/services/failed-task-preservation';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  cleanupTaskRun: vi.fn(),
  failSession: vi.fn(),
  persistMessage: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  failSession: (...args: unknown[]) => mocks.failSession(...args),
  persistMessage: (...args: unknown[]) => mocks.persistMessage(...args),
}));

vi.mock('../../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => mocks.cleanupTaskRun(...args),
}));

const NOW = new Date('2026-09-25T11:00:00.000Z');
const INPUT = {
  taskId: 'task-1',
  projectId: 'project-1',
  workspaceId: 'ws-1',
  chatSessionId: 'chat-1',
  source: 'test',
};

describe('preserveFailedTaskWork', () => {
  let sqlite: Database.Database;
  let env: Env;

  function seedRuntime(
    overrides: {
      workspaceStatus?: string;
      workspaceProject?: string;
      chatSessionId?: string | null;
      nodeRole?: string;
      runtime?: string;
      agentStatus?: string | null;
    } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, status, node_role, runtime)
         VALUES ('node-1', 'user-1', 'running', ?, ?)`
      )
      .run(overrides.nodeRole ?? 'workspace', overrides.runtime ?? 'vm');
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, node_id, project_id, user_id, chat_session_id, status)
         VALUES ('ws-1', 'node-1', ?, 'user-1', ?, ?)`
      )
      .run(
        overrides.workspaceProject ?? 'project-1',
        overrides.chatSessionId === undefined ? 'chat-1' : overrides.chatSessionId,
        overrides.workspaceStatus ?? 'running'
      );
    if (overrides.agentStatus !== null) {
      sqlite
        .prepare(
          `INSERT INTO agent_sessions (id, workspace_id, status, created_at)
           VALUES ('agent-1', 'ws-1', ?, ?)`
        )
        .run(overrides.agentStatus ?? 'running', NOW.toISOString());
    }
  }

  function seedSnapshot(overrides: Record<string, string | number | null> = {}) {
    const row = {
      status: 'available',
      degradation: 'none',
      sleeping_at: new Date(NOW.getTime() - 60_000).toISOString(),
      sleep_status: 'sleeping',
      sleep_after: null,
      expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
            manifest_r2_key, expires_at, sleeping_at, sleep_status, sleep_after,
            recovery_attempts, sleep_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'ws-1', 'user-1', 'chat-1', 'vm', ?, ?,
                 'manifest.json', ?, ?, ?, ?, 0, 0, ?, ?)`
      )
      .run(
        row.status,
        row.degradation,
        row.expires_at,
        row.sleeping_at,
        row.sleep_status,
        row.sleep_after,
        NOW.toISOString(),
        NOW.toISOString()
      );
  }

  function seedTask(status: string) {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, workspace_id, chat_session_id, status, error_message)
         VALUES ('task-1', 'project-1', 'user-1', 'ws-1', 'chat-1', ?, 'Agent prompt failed')`
      )
      .run(status);
  }

  function sleepIntent() {
    return sqlite
      .prepare(
        `SELECT sleep_status, sleep_after FROM session_snapshots WHERE chat_session_id = 'chat-1'`
      )
      .get();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mocks.cleanupTaskRun.mockResolvedValue(undefined);
    mocks.failSession.mockResolvedValue(undefined);
    mocks.persistMessage.mockResolvedValue('notice-1');
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.nodes,
      schema.workspaces,
      schema.agentSessions,
      schema.sessionSnapshots,
      schema.sessionSummaries,
      schema.tasks,
    ]);
    sqlite.exec(
      'CREATE UNIQUE INDEX idx_session_snapshots_chat_session_id ON session_snapshots(chat_session_id)'
    );
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  it.each(['vm', 'cf-container'])('queues a sleep for a live %s runtime', async (runtime) => {
    seedRuntime({ runtime });

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'sleep_queued',
    });
    expect(sleepIntent()).toEqual({ sleep_status: 'scheduled', sleep_after: NOW.toISOString() });
  });

  it('pulls a far-future idle sleep intent forward to now', async () => {
    seedRuntime();
    seedSnapshot({
      status: 'pending',
      sleeping_at: null,
      sleep_status: 'scheduled',
      sleep_after: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    });

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'sleep_queued',
    });
    expect(sleepIntent()).toEqual({ sleep_status: 'scheduled', sleep_after: NOW.toISOString() });
  });

  it('keeps a conversation that already slept (the production shape)', async () => {
    seedRuntime({ workspaceStatus: 'deleted', agentStatus: 'sleeping' });
    seedSnapshot();

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'already_asleep',
    });
  });

  it('keeps a conversation whose workspace row no longer links the chat', async () => {
    // A wake handoff nulls workspaces.chat_session_id; the task's own link decides.
    seedRuntime({ workspaceStatus: 'deleted', chatSessionId: null, agentStatus: 'sleeping' });
    seedSnapshot();

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'already_asleep',
    });
  });

  it.each([
    ['workspace_not_live', { workspaceStatus: 'stopped' }],
    ['no_chat_session', { chatSessionId: null }],
    ['unsupported_runtime', { runtime: 'deployment' }],
    ['unsupported_runtime', { nodeRole: 'deployment' }],
    ['no_resumable_agent_session', { agentStatus: 'failed' }],
    ['no_resumable_agent_session', { agentStatus: null }],
  ] as const)('reports %s when no runtime can be handed over', async (gap, runtime) => {
    seedRuntime(runtime);

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'not_preservable',
      gap,
    });
    expect(sleepIntent()).toBeUndefined();
  });

  it('refuses a workspace that belongs to another project', async () => {
    // Project scope is part of the lookup (rule 11): a foreign workspace is treated
    // as absent. Owner-path control: the same fixture in project-1 is queued above.
    seedRuntime({ workspaceProject: 'project-2' });

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'not_preservable',
      gap: 'no_workspace',
    });
    expect(sleepIntent()).toBeUndefined();
  });

  it('does not keep an expired sleeping snapshot', async () => {
    seedRuntime({ workspaceStatus: 'deleted', agentStatus: 'sleeping' });
    seedSnapshot({ expires_at: new Date(NOW.getTime() - 1).toISOString() });

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'not_preservable',
      gap: 'workspace_not_live',
    });
  });

  it('withholds teardown when the runtime lookup fails', async () => {
    sqlite.exec('DROP TABLE nodes');

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({ outcome: 'unknown' });
  });

  it('withholds teardown when the sleep-state lookup fails', async () => {
    seedRuntime({ workspaceStatus: 'stopped' });
    sqlite.exec('DROP TABLE session_snapshots');

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({ outcome: 'unknown' });
  });

  it('reports sleep_queue_failed when the sleep cannot be queued', async () => {
    // The queue's snapshot upsert needs the chat_session_id unique index; the
    // sleep-state read does not, so only the queue step fails.
    seedRuntime();
    sqlite.exec('DROP INDEX idx_session_snapshots_chat_session_id');

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'not_preservable',
      gap: 'sleep_queue_failed',
    });
  });

  describe('releaseExhaustedFailedTaskPreservation', () => {
    it('tears down and surfaces once a failed task has no retry left', async () => {
      seedTask('failed');
      seedSnapshot({ sleeping_at: null, sleep_status: 'failed', sleep_after: null });

      await expect(
        releaseExhaustedFailedTaskPreservation(env, { chatSessionId: 'chat-1' })
      ).resolves.toBe(true);
      expect(mocks.persistMessage).toHaveBeenCalledWith(
        env,
        'project-1',
        'chat-1',
        'system',
        failedTaskWorkLossMessage('snapshot_retry_exhausted'),
        null
      );
      expect(mocks.failSession).toHaveBeenCalledWith(
        env,
        'project-1',
        'chat-1',
        'Agent prompt failed'
      );
      expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env);
    });

    it.each([
      ['a retry is still scheduled', { sleep_status: 'failed', sleep_after: NOW.toISOString() }],
      ['the sleep is still in flight', { sleep_status: 'preparing', sleep_after: null }],
      ['the conversation slept', { sleep_status: 'sleeping', sleep_after: null }],
    ] as const)('leaves it alone while %s', async (_label, sleep) => {
      seedTask('failed');
      seedSnapshot({
        sleeping_at: sleep.sleep_status === 'sleeping' ? NOW.toISOString() : null,
        ...sleep,
      });

      await expect(
        releaseExhaustedFailedTaskPreservation(env, { chatSessionId: 'chat-1' })
      ).resolves.toBe(false);
      expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
      expect(mocks.failSession).not.toHaveBeenCalled();
    });

    it('never acts for a completed task', async () => {
      seedTask('completed');
      seedSnapshot({ sleeping_at: null, sleep_status: 'failed', sleep_after: null });

      await expect(
        releaseExhaustedFailedTaskPreservation(env, { chatSessionId: 'chat-1' })
      ).resolves.toBe(false);
      expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
    });
  });

  describe('noteFailedTaskPreservationCapture', () => {
    it.each(['transcript-only', 'wip-skipped', 'entries-skipped'])(
      'surfaces a %s snapshot on a slept failed task',
      async (degradation) => {
        seedTask('failed');
        seedSnapshot({ status: 'degraded', degradation });

        await noteFailedTaskPreservationCapture(env, { chatSessionId: 'chat-1' });

        expect(mocks.persistMessage).toHaveBeenCalledWith(
          env,
          'project-1',
          'chat-1',
          'system',
          expect.stringContaining(`(${degradation})`),
          null
        );
      }
    );

    it.each([
      ['a complete snapshot', 'failed', { status: 'available', degradation: 'none' }],
      ['a home-only degradation', 'failed', { status: 'degraded', degradation: 'home-skipped' }],
      ['a completed task', 'completed', { status: 'degraded', degradation: 'transcript-only' }],
    ] as const)('stays quiet for %s', async (_label, taskStatus, snapshot) => {
      seedTask(taskStatus);
      seedSnapshot(snapshot);

      await noteFailedTaskPreservationCapture(env, { chatSessionId: 'chat-1' });

      expect(mocks.persistMessage).not.toHaveBeenCalled();
    });
  });
});
