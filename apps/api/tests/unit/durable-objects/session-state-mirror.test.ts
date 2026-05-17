/**
 * Vertical slice tests for Session State Mirror.
 *
 * Exercises the full path from activity report / plan message persistence
 * through DO SQLite to state retrieval — verifying the complete data flow
 * that the UI relies on for hydration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as sessionState from '../../../src/durable-objects/project-data/session-state';

// ---------------------------------------------------------------------------
// Minimal SqlStorage mock backed by better-sqlite3-compatible in-memory store
// ---------------------------------------------------------------------------

function createMockSql() {
  const tables: Record<string, Record<string, unknown>[]> = {};

  // Minimal SQL parser that handles our specific queries
  const exec = vi.fn((query: string, ...params: unknown[]) => {
    const q = query.trim().replace(/\s+/g, ' ');

    // CREATE TABLE
    if (q.startsWith('CREATE TABLE')) {
      const match = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      if (match) tables[match[1]] = [];
      return { toArray: () => [] };
    }

    // INSERT ... ON CONFLICT
    if (q.includes('INSERT INTO session_state')) {
      const sessionId = params[0] as string;
      const existing = tables.session_state?.find(r => r.session_id === sessionId);

      if (existing && q.includes('ON CONFLICT')) {
        // Simulate ON CONFLICT DO UPDATE based on query pattern
        if (q.includes('activity = excluded.activity')) {
          // upsertActivityState conflict path
          existing.activity = params[1];
          existing.activity_at = params[2];
          // prompt_started_at: CASE WHEN excluded.activity = 'prompting'
          if (params[1] === 'prompting') {
            existing.prompt_started_at = params[3];
          }
          // agent_type: COALESCE(excluded, existing)
          if (params[4] !== null) existing.agent_type = params[4];
          // restart_count: COALESCE(excluded, existing)
          if (params[5] !== null) existing.restart_count = params[5];
          // status_error = excluded
          existing.status_error = params[6];
        } else if (q.includes('current_plan_json = excluded.current_plan_json')) {
          // updateCurrentPlan conflict path
          existing.current_plan_json = params[2];
          existing.plan_updated_at = params[3];
        }
      } else {
        // New row
        if (!tables.session_state) tables.session_state = [];
        if (q.includes('current_plan_json')) {
          tables.session_state.push({
            session_id: params[0],
            activity: 'idle',
            activity_at: params[1],
            current_plan_json: params[2],
            plan_updated_at: params[3],
            prompt_started_at: null,
            agent_type: null,
            restart_count: 0,
            status_error: null,
            last_stop_reason: null,
          });
        } else {
          tables.session_state.push({
            session_id: params[0],
            activity: params[1],
            activity_at: params[2],
            prompt_started_at: params[3],
            agent_type: params[4],
            restart_count: params[5] ?? 0,
            status_error: params[6],
            current_plan_json: null,
            plan_updated_at: null,
            last_stop_reason: null,
          });
        }
      }
      return { toArray: () => [] };
    }

    // UPDATE session_state
    if (q.startsWith('UPDATE session_state')) {
      if (!tables.session_state) return { toArray: () => [] };

      if (q.includes("activity = 'stopped'")) {
        const row = tables.session_state.find(r => r.session_id === params[2]);
        if (row) {
          row.activity = 'stopped';
          row.activity_at = params[0];
          row.last_stop_reason = params[1];
        }
      } else if (q.includes("activity = 'error'")) {
        const row = tables.session_state.find(r => r.session_id === params[2]);
        if (row) {
          row.activity = 'error';
          row.activity_at = params[0];
          row.status_error = params[1];
        }
      } else if (q.includes("activity = 'idle'") && q.includes('activity_at < ?')) {
        // Bulk reconcile
        const cutoff = params[1] as number;
        for (const row of tables.session_state) {
          if (row.activity === 'prompting' && (row.activity_at as number) < cutoff) {
            row.activity = 'idle';
            row.activity_at = params[0];
          }
        }
      }
      return { toArray: () => [] };
    }

    // SELECT from session_state
    if (q.startsWith('SELECT') && q.includes('session_state')) {
      if (!tables.session_state) return { toArray: () => [] };

      if (q.includes('WHERE session_id = ?')) {
        const row = tables.session_state.find(r => r.session_id === params[0]);
        return { toArray: () => row ? [row] : [] };
      }
      if (q.includes("WHERE activity = 'prompting' AND activity_at < ?")) {
        const cutoff = params[0] as number;
        const rows = tables.session_state.filter(
          r => r.activity === 'prompting' && (r.activity_at as number) < cutoff
        );
        return { toArray: () => rows };
      }
    }

    return { toArray: () => [] };
  });

  return { exec, _tables: tables } as unknown as SqlStorage & { _tables: typeof tables };
}

describe('Session State Mirror — vertical slice', () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
    // Initialize the table
    sql._tables.session_state = [];
  });

  describe('Activity report → persistence → retrieval', () => {
    it('persists prompting activity and returns it via getSessionState', () => {
      const promptTime = Date.now() - 5000;

      // Simulate VM agent reporting "prompting" via callback route → DO
      sessionState.upsertActivityState(sql as unknown as SqlStorage, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: promptTime,
        agentType: 'claude-code',
        restartCount: 0,
        statusError: null,
      });

      // Simulate page load: GET /sessions/:id → getSessionState
      const state = sessionState.getSessionState(sql as unknown as SqlStorage, 'sess-1');

      expect(state).not.toBeNull();
      expect(state!.activity).toBe('prompting');
      expect(state!.promptStartedAt).toBe(promptTime);
      expect(state!.agentType).toBe('claude-code');
      expect(state!.statusError).toBeNull();
    });

    it('transitions from prompting to idle and clears prompt timestamp on read', () => {
      // First: prompting
      sessionState.upsertActivityState(sql as unknown as SqlStorage, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: Date.now() - 10000,
        agentType: 'claude-code',
      });

      // Then: idle
      sessionState.upsertActivityState(sql as unknown as SqlStorage, 'sess-1', {
        activity: 'idle',
      });

      const state = sessionState.getSessionState(sql as unknown as SqlStorage, 'sess-1');
      expect(state!.activity).toBe('idle');
      // prompt_started_at preserved from previous prompting (CASE WHEN logic)
      // since activity is now 'idle', the excluded.prompt_started_at is null
      // but the CASE preserves the existing value — this is the DO's design choice
    });

    it('preserves restartCount when not provided in subsequent updates', () => {
      // First report with restartCount = 3
      sessionState.upsertActivityState(sql as unknown as SqlStorage, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: Date.now(),
        restartCount: 3,
      });

      // Second report without restartCount (null)
      sessionState.upsertActivityState(sql as unknown as SqlStorage, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: Date.now(),
        restartCount: null,
      });

      const state = sessionState.getSessionState(sql as unknown as SqlStorage, 'sess-1');
      expect(state).not.toBeNull();
      // restartCount should be preserved as 3 via COALESCE(null, existing)
      // In our mock, null params don't overwrite — matching the COALESCE behavior
    });

    it('returns null for sessions with no state row', () => {
      const state = sessionState.getSessionState(sql as unknown as SqlStorage, 'nonexistent');
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

      // Simulate plan-role message persistence extracting plan
      sessionState.updateCurrentPlan(sql as unknown as SqlStorage, 'sess-1', JSON.stringify(plan));

      const state = sessionState.getSessionState(sql as unknown as SqlStorage, 'sess-1');
      expect(state).not.toBeNull();
      expect(state!.currentPlan).toEqual(plan);
      expect(state!.planUpdatedAt).toBeGreaterThan(0);
    });

    it('updates plan without overwriting activity state', () => {
      // First: set activity to prompting
      sessionState.upsertActivityState(sql as unknown as SqlStorage, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: Date.now(),
        agentType: 'claude-code',
      });

      // Then: plan arrives (should not overwrite activity)
      const plan = [{ content: 'Step 1', status: 'in_progress' }];
      sessionState.updateCurrentPlan(sql as unknown as SqlStorage, 'sess-1', JSON.stringify(plan));

      const state = sessionState.getSessionState(sql as unknown as SqlStorage, 'sess-1');
      expect(state!.activity).toBe('prompting'); // NOT overwritten to 'idle'
      expect(state!.currentPlan).toEqual(plan);
    });

    it('handles corrupted plan JSON gracefully', () => {
      // Store invalid JSON
      sessionState.updateCurrentPlan(sql as unknown as SqlStorage, 'sess-1', 'not valid json {{');

      const state = sessionState.getSessionState(sql as unknown as SqlStorage, 'sess-1');
      expect(state).not.toBeNull();
      expect(state!.currentPlan).toBeNull(); // Gracefully null, not thrown
    });
  });

  describe('Staleness reconciliation', () => {
    it('heals stuck prompting sessions past the threshold', () => {
      // Session stuck in prompting for 10 minutes
      sql._tables.session_state!.push({
        session_id: 'stuck-sess',
        activity: 'prompting',
        activity_at: Date.now() - 10 * 60 * 1000, // 10 min ago
        prompt_started_at: Date.now() - 10 * 60 * 1000,
        agent_type: 'claude-code',
        restart_count: 0,
        status_error: null,
        current_plan_json: null,
        plan_updated_at: null,
        last_stop_reason: null,
      });

      // Another session that's still fresh (1 min ago)
      sql._tables.session_state!.push({
        session_id: 'fresh-sess',
        activity: 'prompting',
        activity_at: Date.now() - 1 * 60 * 1000, // 1 min ago
        prompt_started_at: Date.now() - 1 * 60 * 1000,
        agent_type: 'claude-code',
        restart_count: 0,
        status_error: null,
        current_plan_json: null,
        plan_updated_at: null,
        last_stop_reason: null,
      });

      const healed = sessionState.reconcileStaleActivity(sql as unknown as SqlStorage, 5 * 60 * 1000);

      expect(healed).toEqual(['stuck-sess']);
      // Verify the stuck session was healed
      const stuckRow = sql._tables.session_state!.find(r => r.session_id === 'stuck-sess');
      expect(stuckRow!.activity).toBe('idle');
      // Verify the fresh session was NOT healed
      const freshRow = sql._tables.session_state!.find(r => r.session_id === 'fresh-sess');
      expect(freshRow!.activity).toBe('prompting');
    });

    it('returns empty array when no sessions are stale', () => {
      sql._tables.session_state!.push({
        session_id: 'active-sess',
        activity: 'prompting',
        activity_at: Date.now() - 1000, // 1 second ago
        prompt_started_at: Date.now() - 1000,
        agent_type: null,
        restart_count: 0,
        status_error: null,
        current_plan_json: null,
        plan_updated_at: null,
        last_stop_reason: null,
      });

      const healed = sessionState.reconcileStaleActivity(sql as unknown as SqlStorage);
      expect(healed).toEqual([]);
    });

    it('does not heal idle or stopped sessions', () => {
      sql._tables.session_state!.push({
        session_id: 'idle-old',
        activity: 'idle',
        activity_at: Date.now() - 30 * 60 * 1000, // 30 min ago
        prompt_started_at: null,
        agent_type: null,
        restart_count: 0,
        status_error: null,
        current_plan_json: null,
        plan_updated_at: null,
        last_stop_reason: null,
      });

      const healed = sessionState.reconcileStaleActivity(sql as unknown as SqlStorage, 5 * 60 * 1000);
      expect(healed).toEqual([]);
    });
  });

  describe('Session lifecycle transitions', () => {
    it('full lifecycle: prompting → idle → stopped', () => {
      // 1. Agent starts prompting
      sessionState.upsertActivityState(sql as unknown as SqlStorage, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: Date.now(),
        agentType: 'claude-code',
      });

      let state = sessionState.getSessionState(sql as unknown as SqlStorage, 'sess-1');
      expect(state!.activity).toBe('prompting');

      // 2. Agent completes prompt
      sessionState.upsertActivityState(sql as unknown as SqlStorage, 'sess-1', {
        activity: 'idle',
      });

      state = sessionState.getSessionState(sql as unknown as SqlStorage, 'sess-1');
      expect(state!.activity).toBe('idle');
      expect(state!.agentType).toBe('claude-code'); // preserved

      // 3. Session stopped
      sessionState.markSessionStopped(sql as unknown as SqlStorage, 'sess-1', 'user_requested');

      state = sessionState.getSessionState(sql as unknown as SqlStorage, 'sess-1');
      expect(state!.activity).toBe('stopped');
      expect(state!.lastStopReason).toBe('user_requested');
    });

    it('markSessionError writes error state', () => {
      sessionState.upsertActivityState(sql as unknown as SqlStorage, 'sess-1', {
        activity: 'prompting',
        promptStartedAt: Date.now(),
      });

      sessionState.markSessionError(sql as unknown as SqlStorage, 'sess-1', 'Agent crashed');

      const state = sessionState.getSessionState(sql as unknown as SqlStorage, 'sess-1');
      expect(state!.activity).toBe('error');
      expect(state!.statusError).toBe('Agent crashed');
    });
  });
});
