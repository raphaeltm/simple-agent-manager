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

    it('returns null for sessions with no state row', () => {
      const state = sessionState.getSessionState(sql, 'nonexistent');
      expect(state).toBeNull();
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
  });

  describe('Staleness reconciliation', () => {
    it('heals stuck prompting sessions past the threshold', () => {
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      const oneMinAgo = Date.now() - 1 * 60 * 1000;

      // Manually insert rows with past timestamps (upsertActivityState uses Date.now())
      sql.exec(
        `INSERT INTO session_state (session_id, activity, activity_at, prompt_started_at, agent_type, restart_count)
         VALUES (?, 'prompting', ?, ?, 'claude-code', 0)`,
        'stuck-sess', tenMinAgo, tenMinAgo,
      );
      sql.exec(
        `INSERT INTO session_state (session_id, activity, activity_at, prompt_started_at, agent_type, restart_count)
         VALUES (?, 'prompting', ?, ?, 'claude-code', 0)`,
        'fresh-sess', oneMinAgo, oneMinAgo,
      );

      const healed = sessionState.reconcileStaleActivity(sql, 5 * 60 * 1000);

      expect(healed).toEqual(['stuck-sess']);
      expect(sessionState.getSessionState(sql, 'stuck-sess')!.activity).toBe('idle');
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
        'idle-old', thirtyMinAgo,
      );

      const healed = sessionState.reconcileStaleActivity(sql, 5 * 60 * 1000);
      expect(healed).toEqual([]);
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
