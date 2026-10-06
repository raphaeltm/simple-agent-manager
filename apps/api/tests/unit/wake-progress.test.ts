/**
 * Wake-progress visibility: hydration (pull) + broadcast (push).
 *
 * The hydration half runs against a real SQL engine because the thing under test
 * IS a join predicate — a mock whose `.where()` ignores its arguments would pass
 * identically with the join deleted (rule 28).
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { publishSessionWakeProgress } from '../../src/durable-objects/project-data/session-wake-progress';
import {
  DEFAULT_WAKE_PROGRESS_BROADCAST_TIMEOUT_MS,
  getWakeProgressBroadcastTimeoutMs,
  notifyWakeProgress,
  recoveryStatusForStep,
} from '../../src/durable-objects/task-runner/wake-progress-notifier';
import type { Env } from '../../src/env';
import { attachWakeState } from '../../src/routes/chat/wake-state';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

// ---------------------------------------------------------------------------
// Hydration (pull path) — real SQL engine
// ---------------------------------------------------------------------------

const SESSION_ID = 'chat-session-1';
const OTHER_SESSION_ID = 'chat-session-2';

function makeDb() {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  return { sqlite, db: drizzle(createSqliteD1(sqlite), { schema }) };
}

function seedSnapshot(
  sqlite: Database.Database,
  args: { chatSessionId: string; recoveryStatus: string | null; recoveryTaskId: string | null }
) {
  sqlite
    .prepare(
      `INSERT INTO session_snapshots (id, chat_session_id, recovery_status, recovery_task_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      `snap-${args.chatSessionId}`,
      args.chatSessionId,
      args.recoveryStatus,
      args.recoveryTaskId
    );
}

function seedTask(sqlite: Database.Database, id: string, executionStep: string | null) {
  sqlite.prepare(`INSERT INTO tasks (id, execution_step) VALUES (?, ?)`).run(id, executionStep);
}

const BASE_STATE = {
  activity: 'idle' as const,
  activityAt: 0,
  statusError: null,
  currentPlan: null,
  planUpdatedAt: null,
  promptStartedAt: null,
  agentType: null,
  lastStopReason: null,
  runtimeWorkState: null,
  runtimeWorkCount: null,
  runtimeWorkSource: null,
  runtimeWorkUpdatedAt: null,
  runtimeWorkProgressAt: null,
};

describe('attachWakeState (hydration)', () => {
  it('resolves the wake phase from the recovery task', async () => {
    const { sqlite, db } = makeDb();
    seedSnapshot(sqlite, {
      chatSessionId: SESSION_ID,
      recoveryStatus: 'waking',
      recoveryTaskId: 'recovery-task-1',
    });
    seedTask(sqlite, 'recovery-task-1', 'node_provisioning');

    const result = await attachWakeState(db, BASE_STATE, {
      projectId: 'p1',
      sessionId: SESSION_ID,
      sessionStatus: 'sleeping',
    });

    expect(result?.recoveryStatus).toBe('waking');
    expect(result?.wakePhase).toBe('node_provisioning');
  });

  it("does not leak another session's wake", async () => {
    // Discriminating: the join predicate is the only thing preventing this.
    // Delete `eq(sessionSnapshots.chatSessionId, sessionId)` and this fails.
    const { sqlite, db } = makeDb();
    seedSnapshot(sqlite, {
      chatSessionId: OTHER_SESSION_ID,
      recoveryStatus: 'waking',
      recoveryTaskId: 'recovery-task-1',
    });
    seedTask(sqlite, 'recovery-task-1', 'node_provisioning');

    const result = await attachWakeState(db, BASE_STATE, {
      projectId: 'p1',
      sessionId: SESSION_ID,
      sessionStatus: 'sleeping',
    });

    expect(result?.recoveryStatus).toBeUndefined();
    expect(result?.wakePhase).toBeUndefined();
  });

  it('returns a usable state when the DO has no persisted activity row', async () => {
    // Without the EMPTY_STATE fallback the recovery status would be dropped and
    // the banner would not render on mount for a DO that was evicted.
    const { sqlite, db } = makeDb();
    seedSnapshot(sqlite, {
      chatSessionId: SESSION_ID,
      recoveryStatus: 'waking',
      recoveryTaskId: 'recovery-task-1',
    });
    seedTask(sqlite, 'recovery-task-1', 'workspace_ready');

    const result = await attachWakeState(db, null, {
      projectId: 'p1',
      sessionId: SESSION_ID,
      sessionStatus: 'sleeping',
    });

    expect(result?.recoveryStatus).toBe('waking');
    expect(result?.wakePhase).toBe('workspace_ready');
    expect(result?.activity).toBe('idle');
  });

  it('suppresses a stale phase once the wake has settled', async () => {
    // A finished recovery task keeps whatever step it last wrote. Rendering that
    // as live progress on a restored session would be a lie.
    const { sqlite, db } = makeDb();
    seedSnapshot(sqlite, {
      chatSessionId: SESSION_ID,
      recoveryStatus: 'restored',
      recoveryTaskId: 'recovery-task-1',
    });
    seedTask(sqlite, 'recovery-task-1', 'running');

    const result = await attachWakeState(db, BASE_STATE, {
      projectId: 'p1',
      sessionId: SESSION_ID,
      sessionStatus: 'sleeping',
    });

    expect(result?.recoveryStatus).toBe('restored');
    expect(result?.wakePhase).toBeNull();
  });

  it('tolerates a missing recovery task (LEFT JOIN, not INNER)', async () => {
    const { sqlite, db } = makeDb();
    seedSnapshot(sqlite, {
      chatSessionId: SESSION_ID,
      recoveryStatus: 'waking',
      recoveryTaskId: null,
    });

    const result = await attachWakeState(db, BASE_STATE, {
      projectId: 'p1',
      sessionId: SESSION_ID,
      sessionStatus: 'sleeping',
    });

    expect(result?.recoveryStatus).toBe('waking');
    expect(result?.wakePhase).toBeNull();
  });

  it('skips the query entirely for a non-sleeping session', async () => {
    const { sqlite, db } = makeDb();
    seedSnapshot(sqlite, {
      chatSessionId: SESSION_ID,
      recoveryStatus: 'waking',
      recoveryTaskId: null,
    });
    const spy = vi.spyOn(db, 'select');

    const result = await attachWakeState(db, BASE_STATE, {
      projectId: 'p1',
      sessionId: SESSION_ID,
      sessionStatus: 'active',
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result).toBe(BASE_STATE);
  });

  it('degrades to the unmodified state when D1 throws', async () => {
    // A wake indicator is never worth a 500 on the session detail route (rule 50).
    const failing = {
      select: () => {
        throw new Error('D1 unavailable');
      },
    } as never;

    const result = await attachWakeState(failing, BASE_STATE, {
      projectId: 'p1',
      sessionId: SESSION_ID,
      sessionStatus: 'sleeping',
    });

    expect(result).toBe(BASE_STATE);
  });
});

// ---------------------------------------------------------------------------
// Broadcast (push path)
// ---------------------------------------------------------------------------

describe('publishSessionWakeProgress', () => {
  it('scopes the broadcast to the waking chat session', () => {
    const broadcastEvent = vi.fn();

    publishSessionWakeProgress(
      { broadcastEvent },
      { chatSessionId: SESSION_ID, recoveryStatus: 'waking', wakePhase: 'agent_session' },
      1234
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [type, payload, scopedSessionId] = broadcastEvent.mock.calls[0];
    expect(type).toBe('session.wake_progress');
    expect(payload).toEqual({
      sessionId: SESSION_ID,
      recoveryStatus: 'waking',
      wakePhase: 'agent_session',
      at: 1234,
    });
    // Third arg scopes delivery — without it the event fans out to every socket.
    expect(scopedSessionId).toBe(SESSION_ID);
  });

  it('normalizes an absent phase to null', () => {
    const broadcastEvent = vi.fn();
    publishSessionWakeProgress(
      { broadcastEvent },
      { chatSessionId: SESSION_ID, recoveryStatus: 'waking' },
      1
    );
    expect(broadcastEvent.mock.calls[0][1].wakePhase).toBeNull();
  });
});

describe('notifyWakeProgress', () => {
  let publish: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
    publish = vi.fn().mockResolvedValue(undefined);
    env = {
      PROJECT_DATA: {
        idFromName: vi.fn(() => ({ toString: () => 'do-id' })),
        get: vi.fn(() => ({ publishSessionWakeProgress: publish })),
      },
    } as unknown as Env;
  });

  it('broadcasts for a recovery task', async () => {
    const sent = await notifyWakeProgress({
      env,
      projectId: 'p1',
      chatSessionId: SESSION_ID,
      step: 'workspace_creation',
    });

    expect(sent).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      chatSessionId: SESSION_ID,
      recoveryStatus: 'waking',
      wakePhase: 'workspace_creation',
    });
  });

  it('does NOT broadcast for a normal task run', async () => {
    // The discriminating case. `resumeSnapshotChatSessionId` is null for every
    // non-recovery task, so ordinary task execution must produce zero broadcasts
    // and zero DO lookups. Without this guard every task in the fleet would emit.
    for (const chatSessionId of [null, undefined, '']) {
      const sent = await notifyWakeProgress({
        env,
        projectId: 'p1',
        chatSessionId,
        step: 'workspace_creation',
      });
      expect(sent).toBe(false);
    }

    expect(publish).not.toHaveBeenCalled();
    expect(env.PROJECT_DATA.get).not.toHaveBeenCalled();
  });

  it('swallows a DO failure so a broken broadcast cannot fail the wake', async () => {
    publish.mockRejectedValue(new Error('DO overloaded'));

    await expect(
      notifyWakeProgress({
        env,
        projectId: 'p1',
        chatSessionId: SESSION_ID,
        step: 'agent_session',
      })
    ).resolves.toBe(false);
  });

  it('reports restored on the terminal steps so the banner clears', async () => {
    // recovery_status in D1 is written by a different code path; without this
    // mapping the banner would linger until the next poll observed it.
    expect(recoveryStatusForStep('running')).toBe('restored');
    expect(recoveryStatusForStep('awaiting_followup')).toBe('restored');
    expect(recoveryStatusForStep('node_selection')).toBe('waking');
    expect(recoveryStatusForStep('agent_session')).toBe('waking');

    await notifyWakeProgress({
      env,
      projectId: 'p1',
      chatSessionId: SESSION_ID,
      step: 'running',
    });
    expect(publish.mock.calls[0][0].recoveryStatus).toBe('restored');
  });

  it('uses a bounded, env-configurable timeout', () => {
    expect(getWakeProgressBroadcastTimeoutMs({} as Env)).toBe(
      DEFAULT_WAKE_PROGRESS_BROADCAST_TIMEOUT_MS
    );
    expect(
      getWakeProgressBroadcastTimeoutMs({ WAKE_PROGRESS_BROADCAST_TIMEOUT_MS: '1500' } as Env)
    ).toBe(1500);
    // Background control-loop call: must not inherit the 30s interactive default.
    expect(DEFAULT_WAKE_PROGRESS_BROADCAST_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it('gives up on a hung DO instead of wedging the runner', async () => {
    vi.useFakeTimers();
    try {
      publish.mockReturnValue(new Promise(() => {}));
      const pending = notifyWakeProgress({
        env: { ...env, WAKE_PROGRESS_BROADCAST_TIMEOUT_MS: '50' } as Env,
        projectId: 'p1',
        chatSessionId: SESSION_ID,
        step: 'agent_session',
      });
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
