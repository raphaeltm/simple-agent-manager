/**
 * The 'creating' deadline (`workspace-creating-deadline.ts`) has a JS form (TaskRunner) and a SQL
 * form (provisioning-timeout cron, stuck-task sweep). They must agree on every row, at the exact
 * boundary, for default and non-default budgets. The SQL runs on a real SQLite engine.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isWorkspaceCreatingOverdue,
  type WorkspaceCreatingBudgets,
  type WorkspaceCreatingClock,
  workspaceCreatingDeadline,
  workspaceCreatingOverdueSql,
} from '../../../src/services/workspace-creating-deadline';

const MINUTE = 60_000;
const BASE = Date.parse('2026-11-09T04:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let sqlite: Database.Database | null = null;
afterEach(() => sqlite?.close());

function sqlOverdue(
  clock: WorkspaceCreatingClock,
  budgets: WorkspaceCreatingBudgets,
  nowMs: number
): boolean {
  sqlite = new Database(':memory:');
  sqlite.exec(
    'CREATE TABLE workspaces (id TEXT, created_at TEXT, creating_started_at TEXT, build_started_at TEXT)'
  );
  sqlite
    .prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)')
    .run('w1', clock.createdAt, clock.creatingStartedAt, clock.buildStartedAt);
  const overdue = workspaceCreatingOverdueSql('w', iso(nowMs), budgets);
  const row = sqlite
    .prepare(`SELECT ${overdue.sql} AS overdue FROM workspaces w WHERE w.id = 'w1'`)
    .get(...overdue.binds) as { overdue: number };
  sqlite.close();
  sqlite = null;
  return row.overdue === 1;
}

const BUDGETS: Record<string, WorkspaceCreatingBudgets> = {
  defaults: { queueWaitMs: 60 * MINUTE, buildMs: 30 * MINUTE },
  // An operator gave builds longer than the queue budget: the queued phase must not shorten it.
  'build longer than queue': { queueWaitMs: 10 * MINUTE, buildMs: 45 * MINUTE },
  'short build': { queueWaitMs: 90 * MINUTE, buildMs: 5 * MINUTE },
};

const CLOCKS: Record<string, WorkspaceCreatingClock> = {
  'legacy row (no attempt clock)': {
    createdAt: iso(BASE),
    creatingStartedAt: null,
    buildStartedAt: null,
  },
  'queued (restarted long after creation)': {
    createdAt: iso(BASE - 600 * MINUTE),
    creatingStartedAt: iso(BASE),
    buildStartedAt: null,
  },
  'legacy row with the CURRENT_TIMESTAMP format': {
    createdAt: '2026-11-09 04:00:00',
    creatingStartedAt: null,
    buildStartedAt: null,
  },
  'building (queued 50 minutes first)': {
    createdAt: iso(BASE - 50 * MINUTE),
    creatingStartedAt: iso(BASE - 50 * MINUTE),
    buildStartedAt: iso(BASE),
  },
};

describe('workspace creating deadline', () => {
  for (const [budgetName, budgets] of Object.entries(BUDGETS)) {
    for (const [clockName, clock] of Object.entries(CLOCKS)) {
      it(`JS and SQL agree at the boundary: ${clockName}, ${budgetName}`, () => {
        const { deadlineMs } = workspaceCreatingDeadline(clock, budgets);
        for (const nowMs of [deadlineMs - 1, deadlineMs, deadlineMs + 1]) {
          const js = isWorkspaceCreatingOverdue(clock, budgets, nowMs);
          expect(sqlOverdue(clock, budgets, nowMs), `now = deadline ${nowMs - deadlineMs}ms`).toBe(
            js
          );
        }
        // The boundary itself is still in time; one millisecond later is not.
        expect(isWorkspaceCreatingOverdue(clock, budgets, deadlineMs)).toBe(false);
        expect(isWorkspaceCreatingOverdue(clock, budgets, deadlineMs + 1)).toBe(true);
      });
    }
  }

  it('gives a queued attempt the larger budget, and a started build its build budget', () => {
    const queued = CLOCKS['queued (restarted long after creation)'];
    const building = CLOCKS['building (queued 50 minutes first)'];
    expect(workspaceCreatingDeadline(queued, BUDGETS.defaults).deadlineMs).toBe(BASE + 60 * MINUTE);
    expect(workspaceCreatingDeadline(queued, BUDGETS['build longer than queue']).deadlineMs).toBe(
      BASE + 45 * MINUTE
    );
    // Queue time already spent does not shorten the build.
    expect(workspaceCreatingDeadline(building, BUDGETS.defaults)).toEqual({
      phase: 'building',
      anchor: iso(BASE),
      deadlineMs: BASE + 30 * MINUTE,
    });
  });

  it('anchors a restarted attempt on its own start, not on created_at', () => {
    const queued = CLOCKS['queued (restarted long after creation)'];
    expect(isWorkspaceCreatingOverdue(queued, BUDGETS.defaults, BASE + 59 * MINUTE)).toBe(false);
    expect(sqlOverdue(queued, BUDGETS.defaults, BASE + 59 * MINUTE)).toBe(false);
  });

  it('counts an unreadable timestamp as overdue in both forms', () => {
    const clock = { createdAt: 'not-a-date', creatingStartedAt: null, buildStartedAt: null };
    expect(isWorkspaceCreatingOverdue(clock, BUDGETS.defaults, BASE)).toBe(true);
    expect(sqlOverdue(clock, BUDGETS.defaults, BASE)).toBe(true);
    const building = { ...clock, createdAt: iso(BASE), buildStartedAt: 'garbage' };
    expect(isWorkspaceCreatingOverdue(building, BUDGETS.defaults, BASE)).toBe(true);
    expect(sqlOverdue(building, BUDGETS.defaults, BASE)).toBe(true);
  });
});
