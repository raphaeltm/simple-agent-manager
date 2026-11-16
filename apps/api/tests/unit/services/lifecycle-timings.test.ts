import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { recordRunnerPhase } from '../../../src/durable-objects/task-runner/phase-timings';
import type { TaskRunnerState } from '../../../src/durable-objects/task-runner/types';
import { log } from '../../../src/lib/logger';
import {
  boundedLifecycleTimings,
  LIFECYCLE_PHASES,
  recordLifecycleTimings,
  storeLifecyclePhaseTimings,
} from '../../../src/services/lifecycle-timings';
import { applySqliteMigration, createSqliteD1 } from '../../helpers/sqlite-d1';

const MIGRATION = new URL(
  '../../../src/db/migrations/0250_lifecycle_phase_timings.sql',
  import.meta.url
);

/** The shipped migration plus the two tables the INSERT resolves attribution from. */
function phaseTimingDb() {
  const sqlite = new Database(':memory:');
  applySqliteMigration(sqlite, MIGRATION);
  sqlite.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT,
    workspace_id TEXT, skill_id TEXT, agent_profile_hint TEXT, created_at TEXT)`);
  sqlite.exec(`CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT)`);
  return { sqlite, db: createSqliteD1(sqlite) };
}

/** Throws on any use, like a D1 binding that is down. */
const brokenDb = {
  prepare: () => {
    throw new Error('D1 unavailable');
  },
  batch: () => Promise.reject(new Error('D1 unavailable')),
} as unknown as D1Database;

describe('bounded lifecycle summaries', () => {
  it('preserves every fixed phase through the real logger without exposing extra fields', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { db } = phaseTimingDb();
      await recordLifecycleTimings(
        db,
        'workspace',
        LIFECYCLE_PHASES.map((phase) => ({
          phase,
          durationMs: 12,
          token: 'sam_pat_canary-secret',
        })),
        { workspaceId: 'ws' }
      );
      const serialized = output.mock.calls[0]?.[0] as string;
      const entry = JSON.parse(serialized);
      expect(entry.phases).toEqual(
        LIFECYCLE_PHASES.map((phase) => ({
          phase: phase === 'sam_env' ? 'platform_environment' : phase,
          durationMs: 12,
        }))
      );
      expect(serialized).not.toContain('canary');
      expect(serialized).not.toContain('[REDACTED]');
    } finally {
      output.mockRestore();
    }
  });
  it('drops secrets, arbitrary labels, malformed numbers and duplicate phases', () => {
    const phases = boundedLifecycleTimings([
      { phase: 'home_upload', durationMs: 42, error: 'ghp_canary' },
      { phase: 'secret/path', durationMs: 5 },
      { phase: 'docker', durationMs: -1 },
      { phase: 'git_clone', durationMs: Infinity },
      { phase: 'home_upload', durationMs: 50 },
    ]);
    expect(phases).toEqual([{ phase: 'home_upload', durationMs: 50 }]);
    expect(boundedLifecycleTimings(undefined)).toEqual([]);
    expect(
      boundedLifecycleTimings(Array(1000).fill({ phase: 'docker', durationMs: 1 }))
    ).toHaveLength(1);
    expect(LIFECYCLE_PHASES.length).toBeLessThan(50);
  });
  it('logs numeric summaries and trusted identity, and stores the same phases', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const { sqlite, db } = phaseTimingDb();
    await recordLifecycleTimings(
      db,
      'wake',
      [{ phase: 'home_restore', durationMs: 12, token: 'canary' }],
      { workspaceId: 'ws' }
    );
    expect(info).toHaveBeenCalledWith('session_lifecycle.timings', {
      operation: 'wake',
      outcome: 'success',
      workspaceId: 'ws',
      phases: [{ phase: 'home_restore', durationMs: 12 }],
    });
    info.mockRestore();
    expect(
      sqlite.prepare('SELECT operation, phase, duration_ms FROM lifecycle_phase_timings').all()
    ).toEqual([{ operation: 'wake', phase: 'home_restore', duration_ms: 12 }]);
  });
  it('stores the whole vocabulary in one batch, and nothing for an empty summary', async () => {
    const { sqlite, db } = phaseTimingDb();
    const batch = vi.spyOn(db, 'batch');
    await recordLifecycleTimings(
      db,
      'workspace',
      LIFECYCLE_PHASES.map((phase) => ({ phase, durationMs: 1 })),
      { workspaceId: 'ws' }
    );
    await recordLifecycleTimings(db, 'workspace', [], { workspaceId: 'ws' });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lifecycle_phase_timings').get()).toEqual({
      n: LIFECYCLE_PHASES.length,
    });
  });
  it('never throws when the store fails, and logs the drop', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await expect(
      recordLifecycleTimings(brokenDb, 'sleep', [{ phase: 'prepare', durationMs: 3 }], {
        workspaceId: 'ws',
      })
    ).resolves.toBeUndefined();
    await expect(
      storeLifecyclePhaseTimings(brokenDb, {
        operation: 'runner_start',
        outcome: 'success',
        phases: [{ phase: 'node_selection', durationMs: 1 }],
        identity: {},
      })
    ).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith(
      'session_lifecycle.timings_store_failed',
      expect.objectContaining({ operation: 'sleep', action: 'dropped' })
    );
    warn.mockRestore();
  });
});

describe('recordRunnerPhase', () => {
  function runnerState(overrides: Partial<TaskRunnerState['config']> = {}): TaskRunnerState {
    return {
      taskId: 'task-1',
      projectId: 'proj-1',
      currentStep: 'workspace_ready',
      lastStepAt: Date.now() - 2_500,
      stepResults: { nodeId: 'node-1', workspaceId: 'ws-1', chatSessionId: 'chat-1' },
      config: { resumeSnapshotChatSessionId: null, recoveryAttemptId: null, ...overrides },
    } as unknown as TaskRunnerState;
  }

  it('stores one runner row attributed to its own task, skill and project profile', async () => {
    const { sqlite, db } = phaseTimingDb();
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, workspace_id, skill_id, agent_profile_hint, created_at)
         VALUES ('task-1', 'proj-1', 'u1', 'ws-1', 'skill-1', 'profile-1', '2026-11-16T00:00:00Z')`
      )
      .run();
    sqlite.prepare("INSERT INTO agent_profiles VALUES ('profile-1', 'proj-1', 'u1')").run();
    vi.spyOn(log, 'info').mockImplementation(() => {});

    await recordRunnerPhase(db, runnerState(), 'success');
    await recordRunnerPhase(db, runnerState({ resumeSnapshotChatSessionId: 'chat-1' }), 'error');

    const rows = sqlite
      .prepare(
        `SELECT operation, phase, outcome, duration_ms, project_id, workspace_id, node_id,
                chat_session_id, task_id, skill_id, agent_profile_id
           FROM lifecycle_phase_timings ORDER BY id`
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => [row.operation, row.outcome])).toEqual([
      ['runner_start', 'success'],
      ['runner_wake', 'error'],
    ]);
    expect(rows[0]).toMatchObject({
      phase: 'workspace_ready',
      project_id: 'proj-1',
      workspace_id: 'ws-1',
      node_id: 'node-1',
      chat_session_id: 'chat-1',
      task_id: 'task-1',
      skill_id: 'skill-1',
      agent_profile_id: 'profile-1',
    });
    expect(rows[0]!.duration_ms as number).toBeGreaterThanOrEqual(2_500);
    vi.restoreAllMocks();
  });

  it('keeps its own task id but attributes nothing when the task row belongs to another project', async () => {
    const { sqlite, db } = phaseTimingDb();
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, workspace_id, skill_id, created_at)
         VALUES ('task-1', 'proj-other', 'u1', 'ws-1', 'skill-other', '2026-11-16T00:00:00Z')`
      )
      .run();
    vi.spyOn(log, 'info').mockImplementation(() => {});
    await recordRunnerPhase(db, runnerState(), 'success');
    expect(sqlite.prepare('SELECT task_id, skill_id FROM lifecycle_phase_timings').get()).toEqual({
      task_id: 'task-1',
      skill_id: null,
    });
    vi.restoreAllMocks();
  });
});
