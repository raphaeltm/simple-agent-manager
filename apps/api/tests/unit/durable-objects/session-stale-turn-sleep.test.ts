/**
 * A hung turn on a running task, from ProjectData's real writers to the real sleep gate.
 *
 * Production 2026-11-04 (idea 01M6K6QTEE7T9KNYB7317D7Y8E): a conversation's control-plane
 * delivery started a turn at 02:01Z that never returned. The VM re-reported `prompting` every
 * minute and the stale-activity probe asked the VM, which answered "working", so the session's
 * sleep was refused with "Workspace agent is not idle (prompting)" for ~10 hours on an idle VM.
 *
 * Each case drives the production writers in order (delivery accepted, VM turn start, agent
 * output, per-minute re-reports, a probe confirmation) on the real ProjectData migrations, then
 * asks the real teardown gate, whose stale-turn bound is read through the real admin settings
 * resolver (`operations.sessionStaleTurnNoWorkMinutes`).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  applyProbeOutcome,
  selectStaleActivityProbeCandidates,
} from '../../../src/durable-objects/project-data/session-activity-reconciliation';
import {
  getSessionState,
  markPromptAccepted,
  refreshWorkingActivityForChatSession,
  upsertActivityState,
} from '../../../src/durable-objects/project-data/session-state';
import type { Env } from '../../../src/env';
import {
  sessionSleepDeferralReason,
  sleepStateChanged,
  sleepTeardownSafetyGate,
} from '../../../src/services/session-sleep-eligibility';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { createSqlStorage } from './sql-storage-test-utils';

const ACP_SESSION = 'acp-1';
const CHAT_SESSION = 'chat-1';
const T0 = Date.parse('2026-11-04T02:01:07.000Z');
const MINUTE = 60_000;
const RUNNING_TASK = { taskStatus: 'in_progress', taskCompletedAt: null };

describe('a hung turn on a running task reaches the sleep gate', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let settings: Database.Database;
  let env: Env;

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
    ({ sqlite: settings, env } = createAdminSettingsEnv());
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    settings.close();
  });

  function report(at: number) {
    upsertActivityState(sql, ACP_SESSION, {
      activity: 'prompting',
      observedAt: at,
      now: at,
      promptStartedAt: T0 + 1_000,
    });
  }

  /** The delivered turn starts, the agent writes for two minutes, then only re-reports arrive. */
  function hungTurnUntil(end: number, options: { lateMessageAt?: number } = {}) {
    markPromptAccepted(sql, ACP_SESSION, T0, T0);
    report(T0 + 1_000);
    refreshWorkingActivityForChatSession(sql, CHAT_SESSION, T0 + 2 * MINUTE, T0 + 2 * MINUTE);
    for (let at = T0 + 3 * MINUTE; at <= end; at += MINUTE) {
      if (options.lateMessageAt && at === options.lateMessageAt) {
        refreshWorkingActivityForChatSession(sql, CHAT_SESSION, at, at);
      }
      report(at);
      if (at === T0 + 20 * MINUTE) confirmWorkingByProbe(at);
    }
  }

  /** The reconciliation sweep asks the VM's SessionHost, which says the turn is still open. */
  function confirmWorkingByProbe(at: number) {
    const [candidate] = selectStaleActivityProbeCandidates(sql, {
      thresholdMs: 0,
      maxAttempts: 3,
      maxCandidates: 10,
      now: at + 1,
    });
    expect(candidate?.acpSessionId).toBe(ACP_SESSION);
    applyProbeOutcome(sql, candidate!, { kind: 'working' }, { maxAttempts: 3, now: at + 1 });
  }

  function setStaleTurnMinutes(value: number) {
    settings
      .prepare(
        `INSERT OR REPLACE INTO platform_settings (key, value, updated_at, updated_by)
         VALUES ('operations.sessionStaleTurnNoWorkMinutes', ?, '2026-11-04T00:00:00Z', NULL)`
      )
      .run(JSON.stringify(value));
  }

  async function gateAt(at: number) {
    vi.useFakeTimers({ now: at, toFake: ['Date'] });
    const state = getSessionState(sql, ACP_SESSION);
    const gate = sleepTeardownSafetyGate(env, RUNNING_TASK);
    return { state, classification: await gate(state) };
  }

  it('lets the sleep through once the turn has done no work for the default bound', async () => {
    const end = T0 + 2 * MINUTE + 31 * MINUTE;
    hungTurnUntil(end);

    const { state, classification } = await gateAt(end);

    // The re-reports and the probe kept the last-report clock fresh; the work clock did not move.
    expect(state?.activity).toBe('prompting');
    expect(state?.activityAt).toBeGreaterThanOrEqual(end);
    expect(classification).toMatchObject({ idle: true, reason: 'prompt_turn_stale' });
  });

  it('keeps refusing while the bound has not elapsed (control)', async () => {
    const end = T0 + 2 * MINUTE + 29 * MINUTE;
    hungTurnUntil(end);

    const { state, classification } = await gateAt(end);

    expect(classification).toMatchObject({ idle: false, reason: 'prompt_turn_active' });
    expect(sessionSleepDeferralReason(classification, state)).toBe(
      'Workspace agent is not idle (prompting)'
    );
  });

  it('keeps refusing when the agent persisted output inside the bound (control)', async () => {
    const end = T0 + 2 * MINUTE + 31 * MINUTE;
    hungTurnUntil(end, { lateMessageAt: T0 + 20 * MINUTE });

    expect((await gateAt(end)).classification).toMatchObject({ idle: false });
  });

  it('follows the admin setting: a longer bound refuses, 0 turns the bound off', async () => {
    const end = T0 + 2 * MINUTE + 61 * MINUTE;
    hungTurnUntil(end);

    setStaleTurnMinutes(90);
    expect((await gateAt(end)).classification).toMatchObject({ idle: false });

    ({ sqlite: settings, env } = createAdminSettingsEnv());
    setStaleTurnMinutes(0);
    expect((await gateAt(end)).classification).toMatchObject({ idle: false });

    ({ sqlite: settings, env } = createAdminSettingsEnv());
    setStaleTurnMinutes(60);
    expect((await gateAt(end)).classification).toMatchObject({ idle: true });
  });

  it('does not abort the sleep for a same-turn re-report between the gate reads', async () => {
    const end = T0 + 2 * MINUTE + 31 * MINUTE;
    hungTurnUntil(end);
    const before = getSessionState(sql, ACP_SESSION);
    report(end + MINUTE);
    const after = getSessionState(sql, ACP_SESSION);

    expect(sleepStateChanged(before, after, 'normal')).toBe(false);
  });
});
