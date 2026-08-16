/**
 * Regression tests for the reconciled session-activity state machine.
 *
 * Incident (2026-08-16, session 36a5bb77-…): a conversation-mode turn ended at
 * ~16:15Z but the control plane still reported "prompting" at 20:21Z. The
 * pre-existing SQL-only heal could not fire because it refuses to heal while
 * the ACP session heartbeats — and a vm-agent heartbeats whether or not a
 * prompt is in flight. The three consumers of that one signal (stop-button UI,
 * durable-message delivery gating, idle/sleep scheduling) all broke together.
 *
 * Each test below is written to FAIL on the pre-fix code:
 *  (a) lost idle report + live heartbeat  → probe flips the state to idle
 *  (b) wedged "prompting" + queued message → delivery is released
 *  (c) genuinely prompting session         → probe does NOT flip it (control)
 *  (d) cancel-path turn ending             → terminal transition is recorded
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import { nudgePromptDeliveriesForTarget } from '../../../src/durable-objects/project-data/prompt-delivery';
import {
  applyProbeOutcome,
  classifyProbeResponse,
  probeStaleSessionActivity,
  publishTurnEnd,
  selectStaleActivityProbeCandidates,
  type StaleActivityCandidate,
} from '../../../src/durable-objects/project-data/session-activity-reconciliation';
import {
  reconcileStaleActivity,
  recordTurnEnd,
  upsertActivityState,
} from '../../../src/durable-objects/project-data/session-state';
import { listAgentSessionsOnNode } from '../../../src/services/node-agent';
import { createSqlStorage } from './sql-storage-test-utils';

vi.mock('../../../src/services/node-agent', () => ({
  listAgentSessionsOnNode: vi.fn(),
}));

const FIVE_MINUTES = 5 * 60 * 1000;
const ACP_SESSION = 'acp-1';
const CHAT_SESSION = 'chat-1';
const WORKSPACE = 'ws-1';
const NODE = 'node-1';

describe('session activity reconciliation', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const now = Date.now();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function seedLiveSession(options?: { heartbeatAt?: number }): void {
    sql.exec(
      `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, ?, NULL, 'Conversation', 'active', 0, ?, ?, ?)`,
      CHAT_SESSION,
      WORKSPACE,
      now,
      now,
      now
    );
    // The agent is awake and heartbeating — this is precisely the state that
    // made the pre-fix SQL-only heal unsatisfiable.
    sql.exec(
      `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, node_id, status, agent_type, last_heartbeat_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', 'claude_code', ?, ?, ?)`,
      ACP_SESSION,
      CHAT_SESSION,
      WORKSPACE,
      NODE,
      options?.heartbeatAt ?? now,
      now,
      now
    );
  }

  /** Put the session in the wedged state: prompting, last reported long ago. */
  function wedgePrompting(activityAt: number): void {
    upsertActivityState(sql, ACP_SESSION, { activity: 'prompting', now: activityAt });
  }

  function readState(): Record<string, unknown> | undefined {
    return sql
      .exec(
        'SELECT activity, activity_source, activity_reason, prompt_started_at, activity_probe_attempts FROM session_state WHERE session_id = ?',
        ACP_SESSION
      )
      .toArray()[0];
  }

  function candidates(): StaleActivityCandidate[] {
    return selectStaleActivityProbeCandidates(sql, {
      thresholdMs: FIVE_MINUTES,
      maxAttempts: 3,
      maxCandidates: 10,
    });
  }

  describe('(a) lost idle report after a turn end', () => {
    it('is NOT healed by the SQL-only path while the agent heartbeats', () => {
      seedLiveSession();
      wedgePrompting(now - 4 * 60 * 60 * 1000);

      // Discriminating: this is the pre-fix behavior. The wedge survives.
      expect(reconcileStaleActivity(sql, FIVE_MINUTES)).toEqual([]);
      expect(readState()?.activity).toBe('prompting');
    });

    it('is selected as a probe candidate and reconciled to idle by the probe', () => {
      seedLiveSession();
      wedgePrompting(now - 4 * 60 * 60 * 1000);

      const [candidate] = candidates();
      expect(candidate).toMatchObject({
        acpSessionId: ACP_SESSION,
        chatSessionId: CHAT_SESSION,
        workspaceId: WORKSPACE,
        nodeId: NODE,
      });

      const outcome = classifyProbeResponse(
        { sessions: [{ id: ACP_SESSION, hostStatus: 'idle' }] },
        ACP_SESSION
      );
      expect(outcome).toEqual({ kind: 'not_working', hostStatus: 'idle' });

      expect(applyProbeOutcome(sql, candidate!, outcome, { maxAttempts: 3 })).toBe(true);

      const state = readState();
      expect(state?.activity).toBe('idle');
      expect(state?.activity_source).toBe('probe');
      expect(state?.activity_reason).toBe('probe_reconciled');
      expect(state?.prompt_started_at).toBeNull();
    });

    it('arms idle scheduling once reconciled', () => {
      // The sleep scheduler refuses to sleep a `prompting` session; the whole
      // point of the flip is that the session becomes sleep-eligible again.
      seedLiveSession();
      wedgePrompting(now - 4 * 60 * 60 * 1000);
      const [candidate] = candidates();
      applyProbeOutcome(sql, candidate!, { kind: 'not_working', hostStatus: 'idle' }, {
        maxAttempts: 3,
      });
      expect(readState()?.activity).toBe('idle');
      // ...and it is no longer a probe candidate (escapes the candidate set).
      expect(candidates()).toEqual([]);
    });

    it('reconciles when the node does not know the session at all', () => {
      seedLiveSession();
      wedgePrompting(now - FIVE_MINUTES - 1000);
      const [candidate] = candidates();
      const outcome = classifyProbeResponse({ sessions: [{ id: 'other', hostStatus: 'prompting' }] }, ACP_SESSION);
      expect(outcome).toEqual({ kind: 'not_working', hostStatus: null });
      expect(applyProbeOutcome(sql, candidate!, outcome, { maxAttempts: 3 })).toBe(true);
      expect(readState()?.activity).toBe('idle');
    });
  });

  describe('(c) genuinely prompting session (control case)', () => {
    it('is NOT flipped when the vm-agent reports a live turn', () => {
      seedLiveSession();
      wedgePrompting(now - 4 * 60 * 60 * 1000);
      const [candidate] = candidates();

      const outcome = classifyProbeResponse(
        { sessions: [{ id: ACP_SESSION, hostStatus: 'prompting' }] },
        ACP_SESSION
      );
      expect(outcome).toEqual({ kind: 'working' });
      expect(applyProbeOutcome(sql, candidate!, outcome, { maxAttempts: 3 })).toBe(false);

      const state = readState();
      expect(state?.activity).toBe('prompting');
      // The staleness clock is refreshed, so a long legitimate turn is not
      // re-probed every single alarm tick.
      expect(state?.activity_probe_attempts).toBe(0);
      expect(candidates()).toEqual([]);
    });

    it('treats a recovering host status as a live turn', () => {
      expect(
        classifyProbeResponse({ sessions: [{ id: ACP_SESSION, hostStatus: 'recovering' }] }, ACP_SESSION)
      ).toEqual({ kind: 'working' });
    });
  });

  describe('bounded probe attempts (candidate escape path)', () => {
    it('terminalizes as dead after the attempt budget is exhausted', () => {
      seedLiveSession();
      wedgePrompting(now - FIVE_MINUTES - 1000);

      let candidate = candidates()[0]!;
      expect(
        applyProbeOutcome(sql, candidate, { kind: 'unreachable', error: 'timeout' }, { maxAttempts: 2 })
      ).toBe(false);
      expect(readState()?.activity_probe_attempts).toBe(1);

      candidate = candidates()[0]!;
      expect(
        applyProbeOutcome(sql, candidate, { kind: 'unreachable', error: 'timeout' }, { maxAttempts: 2 })
      ).toBe(true);

      const state = readState();
      expect(state?.activity).toBe('idle');
      expect(state?.activity_reason).toBe('dead');
      // Zombie-candidate check: two sweeps in, the row is gone from the set.
      expect(candidates()).toEqual([]);
    });

    it('drops a candidate from selection once its attempts are exhausted', () => {
      seedLiveSession();
      wedgePrompting(now - FIVE_MINUTES - 1000);
      sql.exec(
        'UPDATE session_state SET activity_probe_attempts = 3 WHERE session_id = ?',
        ACP_SESSION
      );
      expect(
        selectStaleActivityProbeCandidates(sql, {
          thresholdMs: FIVE_MINUTES,
          maxAttempts: 3,
          maxCandidates: 10,
        })
      ).toEqual([]);
    });
  });

  describe('candidate selection guards', () => {
    it('ignores fresh working states', () => {
      seedLiveSession();
      wedgePrompting(now - 1000);
      expect(candidates()).toEqual([]);
    });

    it('ignores sessions with newer message progress', () => {
      seedLiveSession();
      wedgePrompting(now - 4 * 60 * 60 * 1000);
      sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, sequence, created_at)
         VALUES ('m1', ?, 'assistant', 'still working', 1, ?)`,
        CHAT_SESSION,
        now - 1000
      );
      expect(candidates()).toEqual([]);
    });

    it('ignores idle sessions', () => {
      seedLiveSession();
      upsertActivityState(sql, ACP_SESSION, { activity: 'idle', now: now - 4 * 60 * 60 * 1000 });
      expect(candidates()).toEqual([]);
    });
  });

  describe('(b) durable-message delivery behind a wedged turn', () => {
    /**
     * Reproduces the morning half of the incident: a durable message parked in
     * `retry_wait` with lastError "Target VM is currently processing a prompt".
     * Pre-fix, only a VM `idle` activity report released it — the exact report
     * that had gone missing — so the message never delivered.
     */
    function queueBlockedDelivery(nextAttemptAt: number): void {
      sql.exec(
        `INSERT INTO session_inbox
           (id, target_session_id, message_type, content, priority, created_at,
            delivery_state, next_attempt_at, last_error, source_kind)
         VALUES ('msg-1', ?, 'prompt', 'Carry on...', 'normal', ?, 'retry_wait', ?, ?, 'agent_mailbox')`,
        CHAT_SESSION,
        now - 60 * 60 * 1000,
        nextAttemptAt,
        'Target VM is currently processing a prompt'
      );
    }

    function nextAttemptAt(): number | null {
      const row = sql
        .exec('SELECT next_attempt_at FROM session_inbox WHERE id = ?', 'msg-1')
        .toArray()[0];
      return (row?.next_attempt_at as number | null) ?? null;
    }

    it('releases the queued message when the wedge is reconciled', async () => {
      seedLiveSession();
      wedgePrompting(now - 4 * 60 * 60 * 1000);
      const parkedUntil = now + 30 * 60 * 1000;
      queueBlockedDelivery(parkedUntil);

      const [candidate] = candidates();
      expect(
        applyProbeOutcome(sql, candidate!, { kind: 'not_working', hostStatus: 'idle' }, {
          maxAttempts: 3,
        })
      ).toBe(true);
      // Still parked until the transition is published to the consumers.
      expect(nextAttemptAt()).toBe(parkedUntil);

      const nudged: string[] = [];
      const broadcasts: { type: string; sessionId?: string }[] = [];
      const armed: string[] = [];
      await publishTurnEnd(
        {
          broadcastEvent: (type, _payload, sessionId) => broadcasts.push({ type, sessionId }),
          nudgeDeliveries: (chatSessionId) => {
            nudged.push(chatSessionId);
            return nudgePromptDeliveriesForTarget(sql, chatSessionId);
          },
          armIdleCleanup: (chatSessionId) => armed.push(chatSessionId),
          recalculateAlarm: async () => {},
        },
        CHAT_SESSION
      );

      // All three consumers observe the same transition.
      expect(broadcasts).toEqual([{ type: 'session.activity', sessionId: CHAT_SESSION }]);
      expect(armed).toEqual([CHAT_SESSION]);
      expect(nudged).toEqual([CHAT_SESSION]);
      expect(nextAttemptAt()).toBe(now);
    });
  });

  describe('probe entry point (tenant boundary)', () => {
    /**
     * The probe mints a node-management token scoped to the workspace owner,
     * so an ambiguous owner must fail CLOSED (.claude/rules/51) rather than
     * fall through to the permissive path.
     */
    function makeEnv(workspaceRow: { user_id: string | null; project_id: string | null } | null) {
      return {
        DATABASE: {
          prepare: () => ({
            bind: () => ({ first: async () => workspaceRow }),
          }),
        },
      } as unknown as Parameters<typeof probeStaleSessionActivity>[1];
    }

    const hooks = {
      broadcastEvent: () => {},
      nudgeDeliveries: () => 0,
      armIdleCleanup: () => {},
      recalculateAlarm: async () => {},
    };

    beforeEach(() => {
      seedLiveSession();
      wedgePrompting(now - 4 * 60 * 60 * 1000);
      vi.mocked(listAgentSessionsOnNode).mockReset();
      vi.mocked(listAgentSessionsOnNode).mockResolvedValue({
        sessions: [{ id: ACP_SESSION, hostStatus: 'idle' }],
      });
    });

    it('probes and reconciles a workspace owned by this project', async () => {
      const result = await probeStaleSessionActivity(sql, makeEnv({ user_id: 'user-1', project_id: 'proj-1' }), hooks, {
        thresholdMs: FIVE_MINUTES,
        projectId: 'proj-1',
      });

      expect(listAgentSessionsOnNode).toHaveBeenCalledWith(
        NODE,
        WORKSPACE,
        expect.anything(),
        'user-1',
        expect.objectContaining({ requestTimeoutMs: expect.any(Number) })
      );
      expect(result).toEqual({ probed: 1, reconciled: 1 });
      expect(readState()?.activity).toBe('idle');
    });

    it('refuses to probe a workspace belonging to another project', async () => {
      const result = await probeStaleSessionActivity(sql, makeEnv({ user_id: 'victim', project_id: 'proj-other' }), hooks, {
        thresholdMs: FIVE_MINUTES,
        projectId: 'proj-1',
      });

      expect(listAgentSessionsOnNode).not.toHaveBeenCalled();
      expect(result.reconciled).toBe(0);
      // Unresolvable owner counts as an unreachable probe, never a free pass.
      expect(readState()?.activity).toBe('prompting');
      expect(readState()?.activity_probe_attempts).toBe(1);
    });

    it('fails closed when this DO has no project identity yet', async () => {
      const result = await probeStaleSessionActivity(sql, makeEnv({ user_id: 'user-1', project_id: 'proj-1' }), hooks, {
        thresholdMs: FIVE_MINUTES,
        projectId: null,
      });

      expect(listAgentSessionsOnNode).not.toHaveBeenCalled();
      expect(result.reconciled).toBe(0);
      expect(readState()?.activity).toBe('prompting');
    });

    it('fails closed when the workspace row has no project', async () => {
      const result = await probeStaleSessionActivity(sql, makeEnv({ user_id: 'user-1', project_id: null }), hooks, {
        thresholdMs: FIVE_MINUTES,
        projectId: 'proj-1',
      });

      expect(listAgentSessionsOnNode).not.toHaveBeenCalled();
      expect(result.reconciled).toBe(0);
      expect(readState()?.activity).toBe('prompting');
    });

    it('treats a probe timeout as unreachable rather than proof of work', async () => {
      vi.mocked(listAgentSessionsOnNode).mockRejectedValue(new Error('Request timed out after 5000ms'));

      const result = await probeStaleSessionActivity(sql, makeEnv({ user_id: 'user-1', project_id: 'proj-1' }), hooks, {
        thresholdMs: FIVE_MINUTES,
        projectId: 'proj-1',
      });

      expect(result).toEqual({ probed: 1, reconciled: 0 });
      expect(readState()?.activity_probe_attempts).toBe(1);
    });
  });

  describe('(d) control-plane turn endings', () => {
    it('records a terminal transition when the VM idle report never arrives', () => {
      seedLiveSession();
      wedgePrompting(now - 60 * 1000);

      expect(
        recordTurnEnd(sql, ACP_SESSION, {
          reason: 'cancelled',
          source: 'control_plane',
          observedAt: now,
        })
      ).toBe(true);

      const state = readState();
      expect(state?.activity).toBe('idle');
      expect(state?.activity_reason).toBe('cancelled');
      expect(state?.activity_source).toBe('control_plane');
      expect(state?.prompt_started_at).toBeNull();
    });

    it('does not stomp a prompt that started after the observation instant', () => {
      seedLiveSession();
      // Observation captured before the slow cancel call...
      const observedAt = now - 10 * 1000;
      // ...but a brand-new prompt was accepted while the cancel was in flight.
      wedgePrompting(now);

      expect(
        recordTurnEnd(sql, ACP_SESSION, {
          reason: 'cancelled',
          source: 'control_plane',
          observedAt,
        })
      ).toBe(false);
      expect(readState()?.activity).toBe('prompting');
    });

    it('is a no-op for a session that is already idle', () => {
      seedLiveSession();
      upsertActivityState(sql, ACP_SESSION, { activity: 'idle', now });
      expect(
        recordTurnEnd(sql, ACP_SESSION, {
          reason: 'force_stopped',
          source: 'control_plane',
          observedAt: now,
        })
      ).toBe(false);
    });

    it('resets probe accounting so a new prompt starts from a clean slate', () => {
      seedLiveSession();
      wedgePrompting(now - FIVE_MINUTES - 1000);
      const candidate = candidates()[0]!;
      applyProbeOutcome(sql, candidate, { kind: 'unreachable', error: 'timeout' }, {
        maxAttempts: 3,
      });
      expect(readState()?.activity_probe_attempts).toBe(1);

      upsertActivityState(sql, ACP_SESSION, { activity: 'prompting', now });
      expect(readState()?.activity_probe_attempts).toBe(0);
    });
  });
});
