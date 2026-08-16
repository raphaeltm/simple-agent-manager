/**
 * Vertical slice tests for Session State Mirror.
 *
 * Exercises the full path from activity report / plan message persistence
 * through DO SQLite to state retrieval — verifying the complete data flow
 * that the UI relies on for hydration.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import { persistMessageWithSideEffects } from '../../../src/durable-objects/project-data/message-persistence';
import * as sessionState from '../../../src/durable-objects/project-data/session-state';
import { createSqlStorage } from './sql-storage-test-utils';

describe('Session State Mirror — vertical slice', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });

  afterEach(() => {
    db.close();
  });

  describe('Activity report → persistence → retrieval', () => {
    it('parses positive stale thresholds and falls back for invalid values', () => {
      expect(sessionState.parseActivityStaleThreshold('1234')).toBe(1234);
      expect(sessionState.parseActivityStaleThreshold('0')).toBe(
        sessionState.DEFAULT_SESSION_ACTIVITY_STALE_THRESHOLD_MS
      );
      expect(sessionState.parseActivityStaleThreshold(undefined)).toBe(
        sessionState.DEFAULT_SESSION_ACTIVITY_STALE_THRESHOLD_MS
      );
    });

    it('persists prompting activity and returns it via getSessionState', () => {
      const promptTime = Date.now() - 5000;

      sessionState.upsertActivityState(sql, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: promptTime,
        agentType: 'claude-code',
        restartCount: 0,
        statusError: null,
      });

      const state = sessionState.getSessionState(sql, 'sess-1');

      expect(state).not.toBeNull();
      expect(state!.activity).toBe('prompting');
      expect(state!.promptStartedAt).toBe(promptTime);
      expect(state!.agentType).toBe('claude-code');
      expect(state!.statusError).toBeNull();
    });

    it('transitions from prompting to idle', () => {
      sessionState.upsertActivityState(sql, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: Date.now() - 10000,
        agentType: 'claude-code',
      });

      sessionState.upsertActivityState(sql, 'sess-1', {
        activity: 'idle',
      });

      const state = sessionState.getSessionState(sql, 'sess-1');
      expect(state!.activity).toBe('idle');
    });

    it('persists normalized harness work without retaining raw lifecycle data', () => {
      sessionState.upsertActivityState(sql, 'sess-runtime-work', {
        activity: 'idle',
        runtimeWorkState: 'active',
        runtimeWorkCount: 2,
        runtimeWorkSource: 'claude_sdk',
        runtimeWorkProgressAt: 900,
        now: 1_000,
      });

      expect(sessionState.getSessionState(sql, 'sess-runtime-work')).toMatchObject({
        activity: 'idle',
        runtimeWorkState: 'active',
        runtimeWorkCount: 2,
        runtimeWorkSource: 'claude_sdk',
        runtimeWorkUpdatedAt: 1_000,
        runtimeWorkProgressAt: 900,
      });
      const columns = sql
        .exec('PRAGMA table_info(session_state)')
        .toArray()
        .map((row) => row.name);
      expect(columns).not.toContain('runtime_work_payload');
      expect(columns).not.toContain('runtime_work_description');
    });

    it('preserves runtime work across reports from older VM agents and clears it explicitly', () => {
      sessionState.upsertActivityState(sql, 'sess-runtime-compatible', {
        activity: 'idle',
        runtimeWorkState: 'active',
        runtimeWorkCount: 1,
        runtimeWorkSource: 'claude_sdk',
        runtimeWorkProgressAt: 900,
        now: 1_000,
      });
      sessionState.upsertActivityState(sql, 'sess-runtime-compatible', {
        activity: 'idle',
        now: 2_000,
      });
      expect(sessionState.getSessionState(sql, 'sess-runtime-compatible')).toMatchObject({
        runtimeWorkState: 'active',
        runtimeWorkUpdatedAt: 1_000,
      });

      sessionState.upsertActivityState(sql, 'sess-runtime-compatible', {
        activity: 'idle',
        runtimeWorkState: 'inactive',
        runtimeWorkCount: 0,
        runtimeWorkSource: 'claude_sdk',
        runtimeWorkProgressAt: 2_900,
        now: 3_000,
      });
      expect(sessionState.getSessionState(sql, 'sess-runtime-compatible')).toMatchObject({
        runtimeWorkState: 'inactive',
        runtimeWorkCount: 0,
        runtimeWorkUpdatedAt: 3_000,
        runtimeWorkProgressAt: 2_900,
      });
    });

    it('rejects a delayed older runtime-work snapshot without extending its lease', () => {
      sessionState.upsertActivityState(sql, 'sess-runtime-ordered', {
        activity: 'idle',
        runtimeWorkState: 'inactive',
        runtimeWorkCount: 0,
        runtimeWorkSource: 'claude_sdk',
        runtimeWorkProgressAt: 2_900,
        now: 3_000,
      });

      // This active snapshot was captured before the inactive edge but its
      // independent HTTP goroutine completed later.
      sessionState.upsertActivityState(sql, 'sess-runtime-ordered', {
        activity: 'idle',
        runtimeWorkState: 'active',
        runtimeWorkCount: 1,
        runtimeWorkSource: 'claude_sdk',
        runtimeWorkProgressAt: 900,
        now: 4_000,
      });

      expect(sessionState.getSessionState(sql, 'sess-runtime-ordered')).toMatchObject({
        runtimeWorkState: 'inactive',
        runtimeWorkCount: 0,
        runtimeWorkUpdatedAt: 3_000,
        runtimeWorkProgressAt: 2_900,
      });
    });

    it('refreshes the finite lease for a same-progress active runtime-work rereport', () => {
      sessionState.upsertActivityState(sql, 'sess-runtime-heartbeat', {
        activity: 'idle',
        runtimeWorkState: 'active',
        runtimeWorkCount: 1,
        runtimeWorkSource: 'claude_sdk',
        runtimeWorkProgressAt: 900,
        now: 1_000,
      });
      sessionState.upsertActivityState(sql, 'sess-runtime-heartbeat', {
        activity: 'idle',
        runtimeWorkState: 'active',
        runtimeWorkCount: 1,
        runtimeWorkSource: 'claude_sdk',
        runtimeWorkProgressAt: 900,
        now: 2_000,
      });

      expect(sessionState.getSessionState(sql, 'sess-runtime-heartbeat')).toMatchObject({
        runtimeWorkState: 'active',
        runtimeWorkCount: 1,
        runtimeWorkUpdatedAt: 2_000,
        runtimeWorkProgressAt: 900,
      });
    });

    it('returns null for sessions with no state row', () => {
      const state = sessionState.getSessionState(sql, 'nonexistent');
      expect(state).toBeNull();
    });

    it('preserves the original prompt epoch across same-epoch prompting and recovering rereports', () => {
      sessionState.upsertActivityState(sql, 'sess-epoch', {
        activity: 'prompting',
        promptStartedAt: 1_000,
        now: 1_100,
      });
      sessionState.upsertActivityState(sql, 'sess-epoch', {
        activity: 'prompting',
        promptStartedAt: 5_000,
        now: 5_100,
      });
      sessionState.upsertActivityState(sql, 'sess-epoch', {
        activity: 'recovering',
        promptStartedAt: 8_000,
        now: 8_100,
      });

      expect(sessionState.getSessionState(sql, 'sess-epoch')?.promptStartedAt).toBe(1_000);
      expect(sessionState.getPromptEpoch(sql, 'sess-epoch')).toBe(1_000);
    });

    it('accepts a newer epoch only through positive prompt acceptance', () => {
      sessionState.upsertActivityState(sql, 'sess-new-epoch', {
        activity: 'prompting',
        promptStartedAt: 1_000,
        now: 1_000,
      });

      expect(sessionState.markPromptAccepted(sql, 'sess-new-epoch', 900, 2_000)).toBe(false);
      expect(sessionState.markPromptAccepted(sql, 'sess-new-epoch', 3_000, 3_100)).toBe(true);
      expect(sessionState.getSessionState(sql, 'sess-new-epoch')?.promptStartedAt).toBe(3_000);
      expect(sessionState.getPromptEpoch(sql, 'sess-new-epoch')).toBe(3_000);
    });

    it('resolves ACP activity IDs to their owning chat and falls back to the input ID', () => {
      sql.exec(
        `INSERT INTO chat_sessions
           (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('chat-resolve', 'workspace-resolve', 'Resolve', 'active', 0, 1000, 1000, 1000);

         INSERT INTO acp_sessions
           (id, chat_session_id, workspace_id, status, agent_type, created_at, updated_at)
         VALUES ('acp-resolve', 'chat-resolve', 'workspace-resolve', 'running',
                 'claude_code', 1000, 1000)`
      );

      expect(sessionState.resolveActivityChatSessionId(sql, 'acp-resolve')).toBe('chat-resolve');
      expect(sessionState.resolveActivityChatSessionId(sql, 'chat-direct')).toBe('chat-direct');
    });
  });

  describe('Plan message persistence → retrieval', () => {
    it('stores plan JSON and returns it in session state', () => {
      const plan = [
        { content: 'Research codebase', status: 'completed' },
        { content: 'Implement feature', status: 'in_progress' },
        { content: 'Write tests', status: 'pending' },
      ];

      sessionState.updateCurrentPlan(sql, 'sess-1', JSON.stringify(plan));

      const state = sessionState.getSessionState(sql, 'sess-1');
      expect(state).not.toBeNull();
      expect(state!.currentPlan).toEqual(plan);
      expect(state!.planUpdatedAt).toBeGreaterThan(0);
    });

    it('updates plan without overwriting activity state', () => {
      sessionState.upsertActivityState(sql, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: Date.now(),
        agentType: 'claude-code',
      });

      const plan = [{ content: 'Step 1', status: 'in_progress' }];
      sessionState.updateCurrentPlan(sql, 'sess-1', JSON.stringify(plan));

      const state = sessionState.getSessionState(sql, 'sess-1');
      expect(state!.activity).toBe('prompting');
      expect(state!.currentPlan).toEqual(plan);
    });

    it('handles corrupted plan JSON gracefully', () => {
      sessionState.updateCurrentPlan(sql, 'sess-1', 'not valid json {{');

      const state = sessionState.getSessionState(sql, 'sess-1');
      expect(state).not.toBeNull();
      expect(state!.currentPlan).toBeNull();
    });

    it('loads the latest persisted plan message and rejects missing or invalid snapshots', () => {
      sql.exec(
        `INSERT INTO chat_sessions
           (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES
           ('chat-plan', 'workspace-plan', 'Plan', 'active', 0, 1000, 1000, 1000),
           ('chat-invalid-plan', 'workspace-invalid', 'Invalid', 'active', 0, 1000, 1000, 1000),
           ('chat-object-plan', 'workspace-object', 'Object', 'active', 0, 1000, 1000, 1000);

         INSERT INTO chat_messages
           (id, session_id, sequence, role, content, created_at)
         VALUES
           ('plan-old', 'chat-plan', 1, 'plan', '[{"content":"old","status":"pending"}]', 1000),
           ('plan-new', 'chat-plan', 2, 'plan', '[{"content":"new","status":"in_progress"}]', 2000),
           ('plan-invalid', 'chat-invalid-plan', 1, 'plan', '{not-json', 3000),
           ('plan-object', 'chat-object-plan', 1, 'plan', '{"content":"not-an-array"}', 4000)`
      );

      expect(sessionState.getLatestPersistedPlan(sql, 'chat-plan')).toEqual({
        currentPlan: [{ content: 'new', status: 'in_progress' }],
        planUpdatedAt: 2000,
      });
      expect(sessionState.getLatestPersistedPlan(sql, 'chat-missing-plan')).toBeNull();
      expect(sessionState.getLatestPersistedPlan(sql, 'chat-invalid-plan')).toBeNull();
      expect(sessionState.getLatestPersistedPlan(sql, 'chat-object-plan')).toBeNull();
    });
  });

  describe('Staleness reconciliation', () => {
    it('heals stuck prompting sessions past the threshold', () => {
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      const oneMinAgo = Date.now() - 1 * 60 * 1000;

      // Manually insert rows with past timestamps (upsertActivityState uses Date.now())
      sql.exec(
        `INSERT INTO session_state (session_id, activity, activity_at, prompt_started_at, agent_type, restart_count)
         VALUES (?, 'prompting', ?, ?, 'claude-code', 0)`,
        'stuck-sess',
        tenMinAgo,
        tenMinAgo
      );
      sql.exec(
        `INSERT INTO session_state (session_id, activity, activity_at, prompt_started_at, agent_type, restart_count)
         VALUES (?, 'prompting', ?, ?, 'claude-code', 0)`,
        'fresh-sess',
        oneMinAgo,
        oneMinAgo
      );

      const healed = sessionState.reconcileStaleActivity(sql, 5 * 60 * 1000);

      expect(healed).toEqual(['stuck-sess']);
      expect(sessionState.getSessionState(sql, 'stuck-sess')!.activity).toBe('idle');
      expect(sessionState.getSessionState(sql, 'stuck-sess')!.promptStartedAt).toBeNull();
      expect(sessionState.getPromptEpoch(sql, 'stuck-sess')).toBeNull();
      expect(sessionState.getSessionState(sql, 'fresh-sess')!.activity).toBe('prompting');
    });

    it('returns empty array when no sessions are stale', () => {
      sessionState.upsertActivityState(sql, 'active-sess', { activity: 'prompting' });
      const healed = sessionState.reconcileStaleActivity(sql);
      expect(healed).toEqual([]);
    });

    it('does not heal idle or stopped sessions', () => {
      const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
      sql.exec(
        `INSERT INTO session_state (session_id, activity, activity_at, restart_count)
         VALUES (?, 'idle', ?, 0)`,
        'idle-old',
        thirtyMinAgo
      );

      const healed = sessionState.reconcileStaleActivity(sql, 5 * 60 * 1000);
      expect(healed).toEqual([]);
    });
  });

  describe('Message persistence liveness refresh', () => {
    it('bumps activity_at for prompting ACP sessions when a message is persisted', async () => {
      const now = Date.now();
      sql.exec(
        `INSERT INTO chat_sessions (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('chat-1', 'ws-1', 'Topic', 'active', 0, ?, ?, ?)`,
        now,
        now,
        now
      );
      sql.exec(
        `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, status, agent_type, created_at, updated_at)
         VALUES ('acp-1', 'chat-1', 'ws-1', 'running', 'claude_code', ?, ?)`,
        now,
        now
      );
      sessionState.upsertActivityState(sql, 'acp-1', { activity: 'prompting' });
      const before = sessionState.getSessionState(sql, 'acp-1')!.activityAt;

      await new Promise((resolve) => setTimeout(resolve, 1));
      await persistMessageWithSideEffects(
        sql,
        { DATABASE: {} as D1Database },
        {
          recalculateAlarm: async () => {},
          scheduleSummarySync: () => {},
          broadcastEvent: () => {},
        },
        'chat-1',
        'assistant',
        'progress',
        null
      );

      const after = sessionState.getSessionState(sql, 'acp-1')!.activityAt;
      expect(after).toBeGreaterThan(before);
    });

    it('keeps an old prompt epoch when recent progress refreshes activity', async () => {
      const oldPromptAt = 1_000;
      const recentActivityAt = 10_000;
      sql.exec(
        `INSERT INTO chat_sessions (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('chat-old-prompt', 'ws-old-prompt', 'Topic', 'active', 0, ?, ?, ?)`,
        oldPromptAt,
        oldPromptAt,
        oldPromptAt
      );
      sql.exec(
        `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, status, agent_type, created_at, updated_at)
         VALUES ('acp-old-prompt', 'chat-old-prompt', 'ws-old-prompt', 'running', 'claude_code', ?, ?)`,
        oldPromptAt,
        oldPromptAt
      );
      sessionState.upsertActivityState(sql, 'acp-old-prompt', {
        activity: 'prompting',
        promptStartedAt: oldPromptAt,
        now: oldPromptAt,
      });

      sessionState.refreshWorkingActivityForChatSession(sql, 'chat-old-prompt', recentActivityAt);

      const state = sessionState.getSessionState(sql, 'acp-old-prompt');
      expect(state?.activityAt).toBe(recentActivityAt);
      expect(state?.promptStartedAt).toBe(oldPromptAt);
      expect(sessionState.getPromptEpoch(sql, 'acp-old-prompt')).toBe(oldPromptAt);
    });
  });

  describe('Session lifecycle transitions', () => {
    it('full lifecycle: prompting → idle → stopped', () => {
      sessionState.upsertActivityState(sql, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: Date.now(),
        agentType: 'claude-code',
      });
      expect(sessionState.getSessionState(sql, 'sess-1')!.activity).toBe('prompting');

      sessionState.upsertActivityState(sql, 'sess-1', { activity: 'idle' });
      let state = sessionState.getSessionState(sql, 'sess-1');
      expect(state!.activity).toBe('idle');
      expect(state!.agentType).toBe('claude-code');

      sessionState.markSessionStopped(sql, 'sess-1', 'user_requested');
      state = sessionState.getSessionState(sql, 'sess-1');
      expect(state!.activity).toBe('stopped');
      expect(state!.lastStopReason).toBe('user_requested');
      expect(state!.promptStartedAt).toBeNull();
      expect(state!.runtimeWorkState).toBe('inactive');
      expect(state!.runtimeWorkCount).toBe(0);
      expect(sessionState.getPromptEpoch(sql, 'sess-1')).toBeNull();
    });

    it('markSessionError writes error state', () => {
      sessionState.upsertActivityState(sql, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: Date.now(),
      });

      sessionState.markSessionError(sql, 'sess-1', 'Agent crashed');

      const state = sessionState.getSessionState(sql, 'sess-1');
      expect(state!.activity).toBe('error');
      expect(state!.statusError).toBe('Agent crashed');
    });
  });
});
