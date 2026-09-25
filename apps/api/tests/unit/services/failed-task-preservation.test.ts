/**
 * The failed-task preservation decision against a real SQL engine (rule 28): every
 * outcome, every gap, project scoping, and the sweep's release/note guards.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  failedTaskIncompleteSnapshotMessage,
  failedTaskWorkLossMessage,
  noteFailedTaskPreservationCapture,
  preserveFailedTaskWork,
} from '../../../src/services/failed-task-preservation';
import {
  releaseExhaustedFailedTaskPreservation,
  releaseUnclaimableFailedTaskPreservation,
} from '../../../src/services/failed-task-preservation-release';
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
const WORK_LOSS_NOTICE_ID = 'failed-task-work-loss-task-1';
const INCOMPLETE_SNAPSHOT_NOTICE_ID = 'failed-task-snapshot-incomplete-task-1';

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
      runtime: 'vm',
      status: 'available',
      degradation: 'none',
      sleeping_at: new Date(NOW.getTime() - 60_000).toISOString(),
      sleep_status: 'sleeping',
      sleep_after: null,
      sleep_attempts: 0,
      sleep_claim_id: null,
      sleep_claimed_at: null,
      capture_generation: null,
      expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
            manifest_r2_key, expires_at, sleeping_at, sleep_status, sleep_after, sleep_attempts,
            sleep_claim_id, sleep_claimed_at, capture_generation, recovery_attempts,
            created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'ws-1', 'user-1', 'chat-1', ?, ?, ?,
                 'manifest.json', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        row.runtime,
        row.status,
        row.degradation,
        row.expires_at,
        row.sleeping_at,
        row.sleep_status,
        row.sleep_after,
        row.sleep_attempts,
        row.sleep_claim_id,
        row.sleep_claimed_at,
        row.capture_generation,
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

  function sleepRow() {
    return sqlite
      .prepare(
        `SELECT sleep_status, sleep_after, sleep_attempts, sleep_claim_id
           FROM session_snapshots WHERE chat_session_id = 'chat-1'`
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

  it('starts a fresh sleep budget when an earlier sleep of this runtime spent its own', async () => {
    // An earlier, unrelated idle sleep exhausted its retries; the workspace kept
    // running. Without a fresh budget the sweep would release this failure on its
    // first look, without a single attempt (`.claude/rules/61`).
    seedRuntime();
    seedSnapshot({
      status: 'pending',
      sleeping_at: null,
      sleep_status: 'failed',
      sleep_after: null,
      sleep_attempts: 9,
    });

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'sleep_queued',
    });
    expect(sleepRow()).toEqual({
      sleep_status: 'scheduled',
      sleep_after: NOW.toISOString(),
      sleep_attempts: 0,
      sleep_claim_id: null,
    });
  });

  it('does not claim a sleep was queued when the row cannot hold an intent', async () => {
    // An earlier sleep was refused terminally ("cannot sleep from status stopped")
    // and the workspace was later restarted. The queue writes nothing for a
    // `terminal_failed` row, so reporting `sleep_queued` would leave the runtime
    // exempt from the reapers and never slept.
    seedRuntime();
    seedSnapshot({
      status: 'pending',
      sleeping_at: null,
      sleep_status: 'terminal_failed',
      sleep_after: null,
    });

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'not_preservable',
      gap: 'sleep_queue_failed',
    });
    expect(sleepRow()).toMatchObject({ sleep_status: 'terminal_failed', sleep_after: null });
  });

  it('leaves a sleep that is already in flight to finish', async () => {
    seedRuntime();
    seedSnapshot({
      status: 'pending',
      sleeping_at: null,
      sleep_status: 'preparing',
      sleep_attempts: 3,
      sleep_claim_id: 'claim-1',
      sleep_claimed_at: NOW.toISOString(),
    });

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'already_asleep',
    });
    expect(sleepRow()).toEqual({
      sleep_status: 'preparing',
      sleep_after: null,
      sleep_attempts: 3,
      sleep_claim_id: 'claim-1',
    });
  });

  it('keeps a conversation that already slept (the production shape)', async () => {
    seedTask('failed');
    seedRuntime({ workspaceStatus: 'deleted', agentStatus: 'sleeping' });
    seedSnapshot();

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'already_asleep',
    });
    // Liveness: a complete snapshot is not reported as incomplete.
    expect(mocks.persistMessage).not.toHaveBeenCalled();
  });

  it('says so when a conversation that already slept has an incomplete snapshot', async () => {
    // The production shape behind the task's own example: the conversation slept
    // with a transcript-only snapshot long before it failed, and no later sleep
    // would ever run to report that.
    seedTask('failed');
    seedRuntime({ workspaceStatus: 'deleted', agentStatus: 'sleeping' });
    seedSnapshot({ status: 'degraded', degradation: 'transcript-only' });

    await expect(preserveFailedTaskWork(env, INPUT)).resolves.toEqual({
      outcome: 'already_asleep',
    });
    expect(mocks.persistMessage).toHaveBeenCalledWith(
      env,
      'project-1',
      'chat-1',
      'system',
      failedTaskIncompleteSnapshotMessage('transcript-only', 'vm'),
      null,
      INCOMPLETE_SNAPSHOT_NOTICE_ID
    );
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
    ['no_resumable_agent_session', { agentStatus: 'error' }],
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
    function expectReleased(reason: 'snapshot_retry_exhausted' | 'snapshot_unavailable') {
      expect(mocks.persistMessage).toHaveBeenCalledWith(
        env,
        'project-1',
        'chat-1',
        'system',
        failedTaskWorkLossMessage(reason),
        null,
        WORK_LOSS_NOTICE_ID
      );
      expect(mocks.failSession).toHaveBeenCalledWith(
        env,
        'project-1',
        'chat-1',
        'Agent prompt failed'
      );
      expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env);
      // The episode is ended, so neither the sweep nor a later release retries it.
      expect(sleepRow()).toMatchObject({ sleep_status: 'terminal_failed', sleep_after: null });
    }

    it('tears down and surfaces once a failed task has no retry left', async () => {
      seedTask('failed');
      seedSnapshot({ sleeping_at: null, sleep_status: 'failed', sleep_after: null });

      await expect(
        releaseExhaustedFailedTaskPreservation(env, { chatSessionId: 'chat-1' })
      ).resolves.toBe(true);
      expectReleased('snapshot_retry_exhausted');
    });

    it('releases a terminally refused sleep on its first attempt', async () => {
      // `failSessionSnapshotSleepBeforeTeardown` writes `terminal_failed` with no
      // retry for "Workspace cannot sleep from status stopped".
      seedTask('failed');
      seedSnapshot({ sleeping_at: null, sleep_status: 'terminal_failed', sleep_after: null });

      await expect(
        releaseExhaustedFailedTaskPreservation(env, { chatSessionId: 'chat-1' })
      ).resolves.toBe(true);
      expectReleased('snapshot_unavailable');
    });

    it.each([
      ['a degraded capture', { status: 'degraded', degradation: 'transcript-only' }],
      ['a capture in progress', { capture_generation: 'generation-2' }],
    ] as const)(
      'stops retrying %s once the budget is spent, unlike other sleeps',
      async (_label, repairable) => {
        seedTask('failed');
        seedSnapshot({
          sleeping_at: null,
          sleep_status: 'failed',
          sleep_after: new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
          sleep_attempts: 9,
          ...repairable,
        });

        await expect(
          releaseExhaustedFailedTaskPreservation(env, { chatSessionId: 'chat-1' })
        ).resolves.toBe(true);
        expectReleased('snapshot_retry_exhausted');
      }
    );

    it.each([
      ['a retry is still scheduled', { sleep_status: 'failed', sleep_after: NOW.toISOString() }],
      [
        'a repairable capture is still inside its budget',
        {
          sleep_status: 'failed',
          sleep_after: NOW.toISOString(),
          status: 'degraded',
          degradation: 'transcript-only',
          sleep_attempts: 8,
        },
      ],
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
      expect(sleepRow()).toMatchObject({ sleep_status: sleep.sleep_status });
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

  describe('releaseUnclaimableFailedTaskPreservation', () => {
    const RELEASE_INPUT = { chatSessionId: 'chat-1', workspaceId: 'ws-1' };

    function seedQueuedFailure() {
      seedTask('failed');
      seedSnapshot({
        status: 'pending',
        sleeping_at: null,
        sleep_status: 'scheduled',
        sleep_after: NOW.toISOString(),
      });
    }

    it.each([
      // A fatal agent error (prompt timeout, unrecoverable crash) lands after the
      // failure callback queued the sleep: the sweep can never claim it now.
      ['no_resumable_agent_session', { agentStatus: 'error' }],
      // A reaper stopped the workspace before the sweep reached it.
      ['workspace_not_live', { workspaceStatus: 'stopped' }],
    ] as const)('releases a queued preservation once %s', async (gap, runtime) => {
      seedQueuedFailure();
      seedRuntime(runtime);

      await expect(releaseUnclaimableFailedTaskPreservation(env, RELEASE_INPUT)).resolves.toBe(
        true
      );
      expect(mocks.persistMessage).toHaveBeenCalledWith(
        env,
        'project-1',
        'chat-1',
        'system',
        failedTaskWorkLossMessage(gap),
        null,
        WORK_LOSS_NOTICE_ID
      );
      expect(mocks.failSession).toHaveBeenCalledWith(
        env,
        'project-1',
        'chat-1',
        'Agent prompt failed'
      );
      expect(mocks.cleanupTaskRun).toHaveBeenCalledWith('task-1', env);
      expect(sleepRow()).toMatchObject({ sleep_status: 'terminal_failed', sleep_after: null });
    });

    it('leaves a runtime the sweep can still claim alone', async () => {
      seedQueuedFailure();
      seedRuntime();

      await expect(releaseUnclaimableFailedTaskPreservation(env, RELEASE_INPUT)).resolves.toBe(
        false
      );
      expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
      expect(mocks.persistMessage).not.toHaveBeenCalled();
      expect(sleepRow()).toMatchObject({ sleep_status: 'scheduled' });
    });

    it('does not interrupt a sleep that is already in flight', async () => {
      seedTask('failed');
      seedRuntime({ agentStatus: 'error' });
      seedSnapshot({
        status: 'pending',
        sleeping_at: null,
        sleep_status: 'stopping',
        sleep_claim_id: 'claim-1',
        sleep_claimed_at: NOW.toISOString(),
      });

      await expect(releaseUnclaimableFailedTaskPreservation(env, RELEASE_INPUT)).resolves.toBe(
        false
      );
      expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
      expect(sleepRow()).toMatchObject({ sleep_status: 'stopping', sleep_claim_id: 'claim-1' });
    });

    it.each([
      ['a completed task', 'completed', { status: 'pending', sleeping_at: null }],
      ['a failed task whose conversation slept', 'failed', {}],
    ] as const)('never acts for %s', async (_label, taskStatus, snapshot) => {
      seedTask(taskStatus);
      seedRuntime({ agentStatus: 'error' });
      seedSnapshot({ sleep_status: 'scheduled', sleep_after: NOW.toISOString(), ...snapshot });

      await expect(releaseUnclaimableFailedTaskPreservation(env, RELEASE_INPUT)).resolves.toBe(
        false
      );
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
          failedTaskIncompleteSnapshotMessage(degradation, 'vm'),
          null,
          INCOMPLETE_SNAPSHOT_NOTICE_ID
        );
      }
    );

    it('tells an Instant user the workspace cannot be restored for any degradation', async () => {
      // An Instant workspace wakes in place only, and `cleanupTaskRun` keeps its
      // container only for a complete snapshot.
      seedTask('failed');
      seedSnapshot({ runtime: 'cf-container', status: 'degraded', degradation: 'home-skipped' });

      await noteFailedTaskPreservationCapture(env, { chatSessionId: 'chat-1' });

      expect(mocks.persistMessage).toHaveBeenCalledWith(
        env,
        'project-1',
        'chat-1',
        'system',
        expect.stringContaining('this Instant workspace cannot be restored'),
        null,
        INCOMPLETE_SNAPSHOT_NOTICE_ID
      );
    });

    it.each([
      ['a complete snapshot', 'failed', { status: 'available', degradation: 'none' }],
      ['a home-only VM degradation', 'failed', { status: 'degraded', degradation: 'home-skipped' }],
      ['a completed task', 'completed', { status: 'degraded', degradation: 'transcript-only' }],
    ] as const)('stays quiet for %s', async (_label, taskStatus, snapshot) => {
      seedTask(taskStatus);
      seedSnapshot(snapshot);

      await noteFailedTaskPreservationCapture(env, { chatSessionId: 'chat-1' });

      expect(mocks.persistMessage).not.toHaveBeenCalled();
    });
  });
});
