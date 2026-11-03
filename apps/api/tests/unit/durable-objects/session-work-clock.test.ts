/**
 * The work clock (`session_state.work_at`) against the real ProjectData migrations and
 * the real writers: a same-turn re-report must not move it, real work must.
 * Production 2026-11-03: re-reports kept `activity_at` fresh for 13 h on a completed
 * task, so its workspace never slept and pinned node 01M6EHBZ85GDPDQS5JSAYCKF4Z.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  getSessionState,
  markPromptAccepted,
  recordTurnEnd,
  refreshWorkingActivityForChatSession,
  upsertActivityState,
} from '../../../src/durable-objects/project-data/session-state';
import { isSameTurnRereport } from '../../../src/durable-objects/project-data/session-work-clock';
import { sessionWorkAnchor } from '../../../src/services/session-idleness';
import { idlenessStateChanged } from '../../../src/services/session-sleep-eligibility';
import { createSqlStorage } from './sql-storage-test-utils';

const ACP_SESSION = 'acp-1';
const CHAT_SESSION = 'chat-1';
const T0 = 1_793_600_000_000;
const MINUTE = 60_000;

describe('session work clock', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, 'ws-1', NULL, 'Conversation', 'active', 0, ?, ?, ?)`,
      CHAT_SESSION,
      T0,
      T0,
      T0
    );
    sql.exec(
      `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, node_id, status, agent_type, last_heartbeat_at, created_at, updated_at)
       VALUES (?, ?, 'ws-1', 'node-1', 'running', 'claude-code', ?, ?, ?)`,
      ACP_SESSION,
      CHAT_SESSION,
      T0,
      T0,
      T0
    );
  });

  afterEach(() => db.close());

  function prompting(at: number, extra: Record<string, unknown> = {}) {
    return upsertActivityState(sql, ACP_SESSION, {
      activity: 'prompting',
      observedAt: at,
      now: at,
      promptStartedAt: T0,
      ...extra,
    });
  }

  it("keeps a new turn's start when its prompting report lands after its idle report", () => {
    // Turn 1, then turn 2 whose `prompting` report (start T0 + 2m) is applied after its
    // own `idle` report (T0 + 3m): the activity write is dropped as stale.
    prompting(T0);
    upsertActivityState(sql, ACP_SESSION, {
      activity: 'idle',
      observedAt: T0 + MINUTE,
      now: T0 + MINUTE,
    });
    upsertActivityState(sql, ACP_SESSION, {
      activity: 'idle',
      observedAt: T0 + 3 * MINUTE,
      now: T0 + 3 * MINUTE,
    });
    expect(
      prompting(T0 + 2 * MINUTE, { promptStartedAt: T0 + 2 * MINUTE, now: T0 + 3 * MINUTE + 1 })
    ).toBe(false);

    const state = getSessionState(sql, ACP_SESSION);
    // The stale report changes nothing else...
    expect(state).toMatchObject({ activity: 'idle', activityAt: T0 + 3 * MINUTE });
    // ...but the VM's evidence that a new turn ran survives.
    expect(state?.reportedPromptStartedAt).toBe(T0 + 2 * MINUTE);
  });

  it('never moves the kept turn start backwards for an older stale report (control)', () => {
    prompting(T0 + 5 * MINUTE, { promptStartedAt: T0 + 5 * MINUTE });
    upsertActivityState(sql, ACP_SESSION, {
      activity: 'idle',
      observedAt: T0 + 6 * MINUTE,
      now: T0 + 6 * MINUTE,
    });
    prompting(T0 + 2 * MINUTE, { promptStartedAt: T0 + 2 * MINUTE, now: T0 + 7 * MINUTE });
    expect(getSessionState(sql, ACP_SESSION)?.reportedPromptStartedAt).toBe(T0 + 5 * MINUTE);
  });

  it('keeps the work clock across same-turn re-reports while activity_at advances', () => {
    expect(prompting(T0)).toBe('work_edge');
    for (let minute = 1; minute <= 30; minute++) {
      expect(prompting(T0 + minute * MINUTE)).toBe('same_turn_rereport');
    }
    const state = getSessionState(sql, ACP_SESSION);
    expect(state).toMatchObject({ activity: 'prompting', activityAt: T0 + 30 * MINUTE });
    expect(state?.workAt).toBe(T0);
  });

  it('keeps the work clock when re-reports carry unchanged inactive harness work', () => {
    const runtime = {
      runtimeWorkState: 'inactive' as const,
      runtimeWorkCount: 0,
      runtimeWorkSource: 'claude-background-tasks',
      runtimeWorkProgressAt: T0,
    };
    expect(prompting(T0, runtime)).toBe('work_edge');
    expect(prompting(T0 + MINUTE, runtime)).toBe('same_turn_rereport');
    expect(prompting(T0 + 2 * MINUTE, runtime)).toBe('same_turn_rereport');
    expect(getSessionState(sql, ACP_SESSION)?.workAt).toBe(T0);
  });

  it('moves the work clock on harness progress', () => {
    const runtime = {
      runtimeWorkState: 'active' as const,
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude-background-tasks',
      runtimeWorkProgressAt: T0,
    };
    prompting(T0, runtime);
    expect(prompting(T0 + MINUTE, { ...runtime, runtimeWorkProgressAt: T0 + MINUTE })).toBe(
      'work_edge'
    );
    expect(getSessionState(sql, ACP_SESSION)?.workAt).toBe(T0 + MINUTE);
  });

  it('moves the work clock when a message is persisted during the turn', () => {
    prompting(T0);
    prompting(T0 + MINUTE);
    refreshWorkingActivityForChatSession(sql, CHAT_SESSION, T0 + 2 * MINUTE, T0 + 2 * MINUTE);
    expect(getSessionState(sql, ACP_SESSION)?.workAt).toBe(T0 + 2 * MINUTE);
  });

  it('never moves the work clock backwards for a delayed message batch', () => {
    prompting(T0);
    refreshWorkingActivityForChatSession(sql, CHAT_SESSION, T0 + 5 * MINUTE, T0 + 5 * MINUTE);
    refreshWorkingActivityForChatSession(sql, CHAT_SESSION, T0 + 2 * MINUTE, T0 + 2 * MINUTE);
    expect(getSessionState(sql, ACP_SESSION)?.workAt).toBe(T0 + 5 * MINUTE);
  });

  it('moves the work clock once for a new turn whose idle edge was lost, then holds it', () => {
    prompting(T0);
    expect(prompting(T0 + 5 * MINUTE, { promptStartedAt: T0 + 5 * MINUTE })).toBe('work_edge');
    expect(prompting(T0 + 6 * MINUTE, { promptStartedAt: T0 + 5 * MINUTE })).toBe(
      'same_turn_rereport'
    );
    expect(prompting(T0 + 7 * MINUTE, { promptStartedAt: T0 + 5 * MINUTE })).toBe(
      'same_turn_rereport'
    );
    expect(getSessionState(sql, ACP_SESSION)?.workAt).toBe(T0 + 5 * MINUTE);
  });

  it('holds the clock after a durable delivery whose accept time precedes the VM turn start', () => {
    // Durable delivery: the control plane records the accept time first, the VM's own
    // turn start is a little later, and every re-report repeats the VM's value.
    const acceptedAt = T0;
    const vmTurnStart = T0 + 5;
    expect(markPromptAccepted(sql, ACP_SESSION, acceptedAt, acceptedAt)).toBe(true);
    expect(prompting(T0 + 1_000, { promptStartedAt: vmTurnStart })).toBe('work_edge');
    for (let minute = 1; minute <= 20; minute++) {
      expect(prompting(T0 + minute * MINUTE, { promptStartedAt: vmTurnStart })).toBe(
        'same_turn_rereport'
      );
    }
    expect(getSessionState(sql, ACP_SESSION)?.workAt).toBe(T0 + 1_000);
  });

  it('does not treat a report without a turn start as a new turn', () => {
    prompting(T0);
    expect(
      upsertActivityState(sql, ACP_SESSION, {
        activity: 'prompting',
        observedAt: T0 + MINUTE,
        now: T0 + MINUTE,
      })
    ).toBe('same_turn_rereport');
    expect(getSessionState(sql, ACP_SESSION)?.workAt).toBe(T0);
  });

  it('ignores a delayed report from an older turn and keeps the newer turn start', () => {
    prompting(T0, { promptStartedAt: T0 + 5 * MINUTE });
    // A late report naming the previous turn (newer observedAt, older turn start).
    expect(prompting(T0 + MINUTE, { promptStartedAt: T0 })).toBe('same_turn_rereport');
    // The next current-turn re-report is still recognised as the same turn.
    expect(prompting(T0 + 2 * MINUTE, { promptStartedAt: T0 + 5 * MINUTE })).toBe(
      'same_turn_rereport'
    );
    expect(getSessionState(sql, ACP_SESSION)?.workAt).toBe(T0);
  });

  it('never lets an earlier prompt acceptance move the work clock backwards', () => {
    prompting(T0);
    refreshWorkingActivityForChatSession(sql, CHAT_SESSION, T0 + 5 * MINUTE, T0 + 5 * MINUTE);
    markPromptAccepted(sql, ACP_SESSION, T0 + 6 * MINUTE, T0 + 2 * MINUTE);
    expect(getSessionState(sql, ACP_SESSION)?.workAt).toBe(T0 + 5 * MINUTE);
  });

  it('clamps harness progress reported ahead of receipt to the receipt time', () => {
    const runtime = {
      runtimeWorkState: 'active' as const,
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude-background-tasks',
    };
    prompting(T0, { ...runtime, runtimeWorkProgressAt: T0 + 24 * 60 * MINUTE });
    expect(getSessionState(sql, ACP_SESSION)?.runtimeWorkProgressAt).toBe(T0);
    expect(sessionWorkAnchor(getSessionState(sql, ACP_SESSION))).toBe(T0);
  });

  it('moves the work clock on control-plane turn transitions', () => {
    prompting(T0);
    recordTurnEnd(sql, ACP_SESSION, {
      reason: 'cancelled',
      source: 'control_plane',
      observedAt: T0 + MINUTE,
      guard: 'turn_start',
      now: T0 + MINUTE,
    });
    expect(getSessionState(sql, ACP_SESSION)).toMatchObject({
      activity: 'idle',
      workAt: T0 + MINUTE,
    });
    markPromptAccepted(sql, ACP_SESSION, 7, T0 + 2 * MINUTE);
    expect(getSessionState(sql, ACP_SESSION)).toMatchObject({
      activity: 'prompting',
      workAt: T0 + 2 * MINUTE,
    });
  });

  it('reports a rejected stale report as false and leaves the clock alone', () => {
    prompting(T0 + MINUTE);
    expect(prompting(T0)).toBe(false);
    expect(getSessionState(sql, ACP_SESSION)?.workAt).toBe(T0 + MINUTE);
  });

  it('does not let a runtime-work difference the upsert will not write count as work', () => {
    expect(
      isSameTurnRereport(
        {
          activity: 'prompting',
          reportedPromptStartedAt: T0,
          runtimeWorkState: 'active',
          runtimeWorkCount: 1,
          runtimeWorkProgressAt: T0 + MINUTE,
        },
        {
          activity: 'prompting',
          promptStartedAt: T0,
          hasRuntimeWorkUpdate: true,
          runtimeWorkState: 'inactive',
          runtimeWorkCount: 0,
          runtimeWorkProgressAt: T0,
        }
      )
    ).toBe(true);
  });

  describe('sleep abort check', () => {
    it('ignores a same-turn re-report between two reads', () => {
      prompting(T0, {
        runtimeWorkState: 'inactive',
        runtimeWorkCount: 0,
        runtimeWorkSource: 'claude-background-tasks',
      });
      const before = getSessionState(sql, ACP_SESSION)!;
      prompting(T0 + MINUTE, {
        runtimeWorkState: 'inactive',
        runtimeWorkCount: 0,
        runtimeWorkSource: 'claude-background-tasks',
      });
      const after = getSessionState(sql, ACP_SESSION)!;
      expect(after.activityAt).not.toBe(before.activityAt);
      expect(after.runtimeWorkUpdatedAt).not.toBe(before.runtimeWorkUpdatedAt);
      expect(idlenessStateChanged(before, after)).toBe(false);
    });

    it('detects a persisted message between two reads (control)', () => {
      prompting(T0);
      const before = getSessionState(sql, ACP_SESSION)!;
      refreshWorkingActivityForChatSession(sql, CHAT_SESSION, T0 + MINUTE, T0 + MINUTE);
      expect(idlenessStateChanged(before, getSessionState(sql, ACP_SESSION)!)).toBe(true);
    });

    it('detects a whole turn that started and ended between two reads (control)', () => {
      upsertActivityState(sql, ACP_SESSION, { activity: 'idle', observedAt: T0, now: T0 });
      const before = getSessionState(sql, ACP_SESSION)!;
      prompting(T0 + MINUTE, { promptStartedAt: T0 + MINUTE });
      upsertActivityState(sql, ACP_SESSION, {
        activity: 'idle',
        observedAt: T0 + 2 * MINUTE,
        now: T0 + 2 * MINUTE,
      });
      const after = getSessionState(sql, ACP_SESSION)!;
      expect(after.activity).toBe(before.activity);
      expect(idlenessStateChanged(before, after)).toBe(true);
    });
  });

  it('anchors legacy rows without a work clock on the turn start', () => {
    expect(
      sessionWorkAnchor({ activity: 'prompting', activityAt: T0 + MINUTE, promptStartedAt: T0 })
    ).toBe(T0);
    expect(sessionWorkAnchor({ activity: 'idle', activityAt: T0 })).toBe(T0);
    expect(sessionWorkAnchor(null)).toBeNull();
  });
});
