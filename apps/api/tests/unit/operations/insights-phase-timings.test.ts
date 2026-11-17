/**
 * Insights phase-timing reads against a real SQL engine and the shipped migration. The project
 * scope is a SQL predicate, so a foreign project's rows sharing the same skill, profile, task and
 * workspace ids are seeded beside the owner's and must never appear (rules 11 and 28).
 */
import {
  listPhaseTimings,
  MAX_PHASE_STATS_PHASES,
  nearestRankPercentile,
  OperationError,
  phaseDurationStats,
} from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applySqliteMigration,
  createSqliteD1,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';

const MIGRATIONS = [
  new URL('../../../src/db/migrations/0250_lifecycle_phase_timings.sql', import.meta.url),
  new URL(
    '../../../src/db/migrations/0260_lifecycle_phase_timings_pair_indexes.sql',
    import.meta.url
  ),
];
const NOW = 1_794_000_000_000;
const DAY = 86_400_000;

describe('insights phase timings reads', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  function insert(row: {
    project: string | null;
    phase: string;
    durationMs: number;
    operation?: string;
    outcome?: string;
    skill?: string | null;
    profile?: string | null;
    task?: string | null;
    workspace?: string | null;
    ageMs?: number;
  }): void {
    sqlite
      .prepare(
        `INSERT INTO lifecycle_phase_timings
           (operation, phase, outcome, duration_ms, project_id, workspace_id, node_id,
            chat_session_id, task_id, skill_id, agent_profile_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'node-1', 'chat-1', ?, ?, ?, ?)`
      )
      .run(
        row.operation ?? 'workspace',
        row.phase,
        row.outcome ?? 'success',
        row.durationMs,
        row.project,
        row.workspace ?? 'ws-1',
        row.task ?? 'task-1',
        row.skill ?? 'skill-1',
        row.profile ?? 'profile-1',
        NOW - (row.ageMs ?? DAY)
      );
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    for (const migration of MIGRATIONS) applySqliteMigration(sqlite, migration);
    db = createSqliteD1(sqlite);
  });

  it('returns median and p90 per phase for one skill, successful rows in the window only', async () => {
    for (const durationMs of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      insert({ project: 'p', phase: 'git_clone', durationMs });
    }
    insert({ project: 'p', phase: 'devcontainer_up', durationMs: 5_000 });
    insert({ project: 'p', phase: 'git_clone', durationMs: 99_999, outcome: 'error' });
    insert({ project: 'p', phase: 'git_clone', durationMs: 88_888, ageMs: 31 * DAY });
    insert({ project: 'p', phase: 'git_clone', durationMs: 77_777, skill: 'skill-2' });
    // Attack: another project with the same skill id and phase.
    insert({ project: 'foreign', phase: 'git_clone', durationMs: 1_000_000 });

    const result = await phaseDurationStats(db, {
      projectId: 'p',
      skillId: 'skill-1',
      phases: ['git_clone', 'devcontainer_up', 'never_reported'],
      now: NOW,
    });
    expect(result).toEqual({
      windowDays: 30,
      truncated: false,
      stats: [
        {
          operation: 'workspace',
          phase: 'devcontainer_up',
          count: 1,
          medianMs: 5_000,
          p90Ms: 5_000,
          truncated: false,
        },
        {
          operation: 'workspace',
          phase: 'git_clone',
          count: 10,
          medianMs: 50,
          p90Ms: 90,
          truncated: false,
        },
      ],
    });

    // The foreign project sees only its own row.
    const foreign = await phaseDurationStats(db, {
      projectId: 'foreign',
      skillId: 'skill-1',
      phases: ['git_clone'],
      now: NOW,
    });
    expect(foreign.stats).toEqual([
      {
        operation: 'workspace',
        phase: 'git_clone',
        count: 1,
        medianMs: 1_000_000,
        p90Ms: 1_000_000,
        truncated: false,
      },
    ]);
  });

  it('summarises every stored phase when phases is omitted, still within the project', async () => {
    insert({ project: 'p', phase: 'git_clone', durationMs: 40 });
    insert({ project: 'p', phase: 'devcontainer_up', durationMs: 900 });
    insert({ project: 'p', phase: 'sam_env', durationMs: 3, skill: 'skill-2' });
    // Attack: another project's rows under the same skill id and a phase p never stored.
    insert({ project: 'foreign', phase: 'git_clone', durationMs: 1_000_000 });
    insert({ project: 'foreign', phase: 'volume_create', durationMs: 5 });

    const result = await phaseDurationStats(db, { projectId: 'p', skillId: 'skill-1', now: NOW });
    expect(result.stats).toEqual([
      {
        operation: 'workspace',
        phase: 'devcontainer_up',
        count: 1,
        medianMs: 900,
        p90Ms: 900,
        truncated: false,
      },
      {
        operation: 'workspace',
        phase: 'git_clone',
        count: 1,
        medianMs: 40,
        p90Ms: 40,
        truncated: false,
      },
    ]);
  });

  it('caps the sample per phase, so a frequent phase cannot crowd out a rare one', async () => {
    // Skew: 12 recent git_clone rows, then one older devcontainer_up row. A global newest-first
    // cap of 5 would read only git_clone rows.
    for (let i = 0; i < 12; i += 1) {
      insert({ project: 'p', phase: 'git_clone', durationMs: 100 + i, ageMs: DAY - i * 1000 });
    }
    insert({ project: 'p', phase: 'devcontainer_up', durationMs: 900, ageMs: 5 * DAY });

    const capped = await phaseDurationStats(db, {
      projectId: 'p',
      skillId: 'skill-1',
      sampleLimit: 5,
      now: NOW,
    });
    expect(capped.truncated).toBe(true);
    // Only the cut pair says so: the rare phase's median is over every row it has.
    expect(capped.stats.map((stat) => [stat.phase, stat.count, stat.truncated])).toEqual([
      ['devcontainer_up', 1, false],
      ['git_clone', 5, true],
    ]);
    // The newest five git_clone rows are the ones kept (durations 107..111).
    expect(capped.stats[1]).toMatchObject({ medianMs: 109, p90Ms: 111 });

    // Control: a cap above every group reads everything and reports nothing cut.
    const all = await phaseDurationStats(db, {
      projectId: 'p',
      skillId: 'skill-1',
      sampleLimit: 50,
      now: NOW,
    });
    expect(all.truncated).toBe(false);
    expect(all.stats.map((stat) => [stat.phase, stat.count])).toEqual([
      ['devcontainer_up', 1],
      ['git_clone', 12],
    ]);
  });

  it('groups by operation, filters by profile and operation, and reports truncation', async () => {
    insert({ project: 'p', phase: 'workspace_ready', durationMs: 7, operation: 'runner_start' });
    insert({ project: 'p', phase: 'workspace_ready', durationMs: 9, operation: 'runner_wake' });
    insert({ project: 'p', phase: 'workspace_ready', durationMs: 11, operation: 'runner_wake' });
    insert({ project: 'p', phase: 'workspace_ready', durationMs: 13, profile: 'profile-x' });

    const byProfile = await phaseDurationStats(db, {
      projectId: 'p',
      agentProfileId: 'profile-1',
      phases: ['workspace_ready'],
      now: NOW,
    });
    expect(byProfile.stats.map((stat) => [stat.operation, stat.count])).toEqual([
      ['runner_start', 1],
      ['runner_wake', 2],
    ]);

    const wakeOnly = await phaseDurationStats(db, {
      projectId: 'p',
      agentProfileId: 'profile-1',
      phases: ['workspace_ready'],
      operation: 'runner_wake',
      sampleLimit: 1,
      now: NOW,
    });
    expect(wakeOnly).toMatchObject({
      truncated: true,
      stats: [{ operation: 'runner_wake', count: 1 }],
    });
  });

  it('caps each operation of a shared phase separately, so newer rows of one cannot hide another', async () => {
    // VM phases repeat across workspace, sleep and wake. Twelve newer workspace rows must not use
    // up the older wake rows' share: a per-phase cap of any multiple of the sample would.
    for (let i = 0; i < 12; i += 1) {
      insert({ project: 'p', phase: 'git_clone', durationMs: 10 + i, ageMs: DAY - i * 1000 });
    }
    insert({ project: 'p', phase: 'git_clone', durationMs: 90, operation: 'wake', ageMs: 2 * DAY });
    insert({ project: 'p', phase: 'git_clone', durationMs: 91, operation: 'wake', ageMs: 3 * DAY });

    const result = await phaseDurationStats(db, {
      projectId: 'p',
      skillId: 'skill-1',
      sampleLimit: 2,
      now: NOW,
    });
    expect(result.truncated).toBe(true);
    expect(result.stats.map((stat) => [stat.operation, stat.count, stat.medianMs])).toEqual([
      ['wake', 2, 90],
      ['workspace', 2, 20],
    ]);
  });

  it('cuts equal timestamps by id, the same way on every call', async () => {
    // Four rows in the same millisecond, sample 2: the two newest ids (durations 30 and 40) stay.
    for (const durationMs of [10, 20, 30, 40]) {
      insert({ project: 'p', phase: 'git_clone', durationMs, ageMs: DAY });
    }
    const read = () =>
      phaseDurationStats(db, { projectId: 'p', skillId: 'skill-1', sampleLimit: 2, now: NOW });
    const first = await read();
    expect(first.stats).toEqual([
      {
        operation: 'workspace',
        phase: 'git_clone',
        count: 2,
        medianMs: 30,
        p90Ms: 40,
        truncated: true,
      },
    ]);
    expect(await read()).toEqual(first);
  });

  it('takes the newest successful rows of a phase past a run of newer failures', async () => {
    for (let i = 0; i < 20; i += 1) {
      insert({
        project: 'p',
        phase: 'git_clone',
        durationMs: 1,
        outcome: 'failure',
        ageMs: DAY - i,
      });
    }
    insert({ project: 'p', phase: 'git_clone', durationMs: 50, ageMs: 2 * DAY });
    insert({ project: 'p', phase: 'git_clone', durationMs: 60, ageMs: 3 * DAY });
    const result = await phaseDurationStats(db, {
      projectId: 'p',
      skillId: 'skill-1',
      sampleLimit: 1,
      now: NOW,
    });
    expect(result).toMatchObject({
      truncated: true,
      stats: [{ operation: 'workspace', phase: 'git_clone', count: 1, medianMs: 50 }],
    });
  });

  it('reads each (operation, phase) through one index range, never a phase history (rule 81)', async () => {
    // The work bound is per pair: pairs are listed with MIN seeks on the pair index, and each
    // pair's sample is one index range keyed on every filter (operation, phase, outcome,
    // created_at), so it stops at its LIMIT however many older, failed or other-operation rows
    // exist. Checked on the SQL the read actually issues, for every branch of it.
    const issued: string[] = [];
    const recording = {
      ...db,
      prepare: (sql: string) => {
        issued.push(sql);
        return db.prepare(sql);
      },
    } as D1Database;
    const variants: Array<{ phases?: string[]; operation?: string; profile?: boolean }> = [
      {},
      { phases: ['git_clone', 'devcontainer_up'] },
      { operation: 'wake' },
      { profile: true },
    ];
    for (const variant of variants) {
      issued.length = 0;
      await phaseDurationStats(recording, {
        projectId: 'p',
        ...(variant.profile ? { agentProfileId: 'profile-1' } : { skillId: 'skill-1' }),
        phases: variant.phases,
        operation: variant.operation,
        now: NOW,
      });
      expect(issued).toHaveLength(1);
      const binds = (issued[0]!.match(/\?/g) ?? []).map(() => 'x');
      const plan = sqlite
        .prepare(`EXPLAIN QUERY PLAN ${issued[0]}`)
        .all(...binds)
        .map((row) => (row as { detail: string }).detail);
      const index = variant.profile ? 'profile_pair' : 'skill_pair';
      const by = variant.profile ? 'agent_profile_id' : 'skill_id';
      expect(plan).toContain(
        `SEARCH s USING COVERING INDEX idx_lifecycle_phase_timings_${index} (project_id=? AND ${by}=? AND operation=? AND phase=? AND outcome=? AND created_at>?)`
      );
      // Pair listing: seeks into the next operation or the next phase, never a range on the
      // first column alone after an equality on it.
      expect(plan).toContain(
        `SEARCH lifecycle_phase_timings USING COVERING INDEX idx_lifecycle_phase_timings_${index} (project_id=? AND ${by}=? AND operation=? AND phase>?)`
      );
      const tableReads = plan.filter((line) =>
        /lifecycle_phase_timings|^(SCAN|SEARCH) [st]\b/.test(line)
      );
      expect(tableReads.length).toBeGreaterThan(5);
      expect(tableReads.filter((line) => !line.startsWith('SEARCH'))).toEqual([]);
    }
  });

  it('rejects ambiguous or empty inputs', async () => {
    await expect(
      phaseDurationStats(db, { projectId: 'p', phases: ['git_clone'], now: NOW })
    ).rejects.toBeInstanceOf(OperationError);
    await expect(
      phaseDurationStats(db, {
        projectId: 'p',
        skillId: 's',
        agentProfileId: 'a',
        phases: ['git_clone'],
      })
    ).rejects.toBeInstanceOf(OperationError);
    await expect(
      phaseDurationStats(db, { projectId: 'p', skillId: 's', phases: [] })
    ).rejects.toBeInstanceOf(OperationError);
    await expect(
      phaseDurationStats(db, { projectId: '', skillId: 's', phases: ['x'] })
    ).rejects.toBeInstanceOf(OperationError);
    await expect(listPhaseTimings(db, { projectId: 'p' })).rejects.toBeInstanceOf(OperationError);
  });

  it('lists one task’s phases oldest first and never another project’s rows', async () => {
    insert({ project: 'p', phase: 'git_clone', durationMs: 1, ageMs: 3_000 });
    insert({ project: 'p', phase: 'devcontainer_up', durationMs: 2, ageMs: 2_000 });
    insert({
      project: 'p',
      phase: 'running',
      durationMs: 3,
      ageMs: 1_000,
      operation: 'runner_start',
    });
    insert({ project: 'p', phase: 'git_clone', durationMs: 4, task: 'task-2', workspace: 'ws-2' });
    // Attack: same task and workspace ids in another project.
    insert({ project: 'foreign', phase: 'git_clone', durationMs: 999 });
    // Node-level provision rows have no project and are never listed.
    insert({ project: null, phase: 'packages', durationMs: 5, operation: 'provision' });

    const byTask = await listPhaseTimings(db, { projectId: 'p', taskId: 'task-1' });
    expect(byTask.map((row) => [row.phase, row.durationMs])).toEqual([
      ['git_clone', 1],
      ['devcontainer_up', 2],
      ['running', 3],
    ]);
    expect(byTask[0]).toMatchObject({
      operation: 'workspace',
      outcome: 'success',
      workspaceId: 'ws-1',
      taskId: 'task-1',
      skillId: 'skill-1',
      agentProfileId: 'profile-1',
      createdAt: new Date(NOW - 3_000).toISOString(),
    });

    const byWorkspace = await listPhaseTimings(db, {
      projectId: 'p',
      workspaceId: 'ws-1',
      limit: 2,
    });
    expect(byWorkspace.map((row) => row.phase)).toEqual(['devcontainer_up', 'running']);

    expect(await listPhaseTimings(db, { projectId: 'other', taskId: 'task-1' })).toEqual([]);
  });

  it('skips a malformed row instead of failing the read', async () => {
    insert({ project: 'p', phase: 'git_clone', durationMs: 10, ageMs: 3_000 });
    // Bypass NOT NULL semantics with a non-integer duration a writer bug could store.
    sqlite
      .prepare(
        `INSERT INTO lifecycle_phase_timings
           (operation, phase, outcome, duration_ms, project_id, task_id, skill_id, created_at)
         VALUES ('workspace', 'git_clone', 'success', 'not-a-number', 'p', 'task-1', 'skill-1', ?)`
      )
      .run(NOW - 2_000);
    insert({ project: 'p', phase: 'git_clone', durationMs: 30, ageMs: 1_000 });

    const listed = await listPhaseTimings(db, { projectId: 'p', taskId: 'task-1' });
    expect(listed.map((row) => row.durationMs)).toEqual([10, 30]);
    const stats = await phaseDurationStats(db, {
      projectId: 'p',
      skillId: 'skill-1',
      phases: ['git_clone'],
      now: NOW,
    });
    expect(stats.stats[0]).toMatchObject({ count: 2, medianMs: 10, p90Ms: 30 });
  });

  it('uses nearest-rank percentiles', () => {
    expect(nearestRankPercentile([5], 0.9)).toBe(5);
    expect(nearestRankPercentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(nearestRankPercentile([1, 2, 3, 4], 0.9)).toBe(4);
  });

  it('accepts the largest phase list within the D1 bind-parameter limit', async () => {
    insert({ project: 'p', phase: 'phase-63', durationMs: 7, operation: 'runner_wake' });
    const phases = Array.from({ length: MAX_PHASE_STATS_PHASES }, (_, index) => `phase-${index}`);
    // projectId + skill + phases + operation + since + limit stays under D1's 100.
    expect(2 + phases.length + 3).toBeLessThanOrEqual(100);
    const result = await phaseDurationStats(createSqliteD1WithBindLimit(sqlite, 100), {
      projectId: 'p',
      skillId: 'skill-1',
      phases,
      operation: 'runner_wake',
      now: NOW,
    });
    expect(result.stats).toEqual([
      {
        operation: 'runner_wake',
        phase: 'phase-63',
        count: 1,
        medianMs: 7,
        p90Ms: 7,
        truncated: false,
      },
    ]);
  });
});
