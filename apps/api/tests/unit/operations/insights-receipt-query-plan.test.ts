/**
 * Query plans of the Run receipt's D1 statements at production-like row counts, with
 * production's declared indexes (`.claude/rules/69`, "D1 CPU is a ceiling too"). D1 keeps no
 * planner statistics, so a statement that reads fine on a 10-row fixture can walk a project's
 * whole task history. The plans asserted here are those of the SQL the operation actually
 * issues, recorded from the D1 binding.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { runReceipt } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  getRunReceiptFacts: vi.fn(async () => null),
}));

/** Tasks in the project: mostly other skills, so an unindexed skill filter would walk them all. */
const TASKS = 3_001;

let sqlite: Database.Database | null = null;
afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

function plan(query: string): string[] {
  const placeholders = (query.match(/\?/g) ?? []).length;
  return (
    sqlite!
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all(...Array.from({ length: placeholders }, () => null)) as { detail: string }[]
  ).map((row) => row.detail);
}

function setup() {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  createDeclaredIndexes(
    sqlite,
    Object.values(schema).filter((value): value is SQLiteTable => is(value, SQLiteTable))
  );
  sqlite.exec(`
    INSERT INTO projects (id, name, repository) VALUES ('p', 'Project', 'acme/app');
    INSERT INTO users (id, name, email) VALUES ('owner', 'Owner', 'o@example.com');
    INSERT INTO project_members (project_id, user_id, role, status) VALUES ('p', 'owner', 'owner', 'active');
    INSERT INTO skills (id, project_id, user_id, name, created_at, updated_at)
      VALUES ('skill-rare', 'p', 'owner', 'rare', '2026-11-01', '2026-11-01');
  `);
  const insertTask = sqlite.prepare(
    `INSERT INTO tasks (id, project_id, user_id, created_by, title, status, skill_id, workspace_id,
       chat_session_id, created_at, updated_at)
     VALUES (?, 'p', 'owner', 'owner', 'Run', 'completed', ?, ?, ?, ?, ?)`
  );
  const insertWorkspace = sqlite.prepare(
    `INSERT INTO workspaces (id, project_id, user_id, name, status, vm_size, creating_started_at)
     VALUES (?, 'p', 'owner', ?, 'stopped', 'small', ?)`
  );
  const now = Date.now();
  sqlite.transaction(() => {
    for (let i = 0; i < TASKS; i += 1) {
      const at = new Date(now - i * 60_000).toISOString();
      insertWorkspace.run(`ws-${i}`, `ws-${i}`, at);
      insertTask.run(`t-${i}`, i % 500 === 0 ? 'skill-rare' : null, `ws-${i}`, `chat-${i}`, at, at);
    }
  })();
  const statements: string[] = [];
  const base = createSqliteD1(sqlite);
  const d1 = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (query: string) => {
          statements.push(query);
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env = { DATABASE: d1, BASE_DOMAIN: 'example.test' } as unknown as Env;
  const ctx: OperationContext = {
    env,
    ports: createOperationPorts(env),
    requestId: 'plan',
    actor: { userId: 'owner', via: 'web', scopes: new Set(['sam.read']) },
  };
  return { ctx, statements };
}

describe('run receipt query plans', { timeout: 30_000 }, () => {
  it('finds comparable runs, asks and status events by index, never by scanning the project', async () => {
    const { ctx, statements } = setup();
    await runReceipt(ctx, { projectId: 'p', taskId: 't-0' });

    const comparison = statements.find((query) => query.includes('t.skill_id = ?'));
    const task = statements.find((query) => query.includes('FROM tasks t\n    JOIN projects p'));
    expect(comparison, 'the comparison statement ran').toBeDefined();
    expect(task, 'the task statement ran').toBeDefined();

    const comparisonPlan = plan(comparison!).join('\n');
    expect(comparisonPlan).toMatch(/idx_tasks_project_skill_created/);
    expect(comparisonPlan).toMatch(/idx_task_status_events_task_created_at/);
    expect(comparisonPlan).not.toMatch(/SCAN t\b|SCAN tasks/);

    const taskPlan = plan(task!).join('\n');
    expect(taskPlan).toMatch(/idx_asks_session_status/);
    expect(taskPlan).not.toMatch(/idx_asks_project_status/);
    expect(taskPlan).not.toMatch(/SCAN (asks|task_status_events|workspace_resource_summaries)/);
  });

  it('reads the pull request’s opening-commit verdict by primary key, never by scanning', async () => {
    const { ctx, statements } = setup();
    const insertPr = sqlite!.prepare(
      `INSERT INTO pull_requests (id, project_id, repository, number, url, title, state, head_sha,
         created_at, updated_at)
       VALUES (?, 'p', 'acme/app', ?, ?, 'PR', 'open', ?, '2026-11-01', '2026-11-01')`
    );
    const insertHead = sqlite!.prepare(
      `INSERT INTO pull_request_heads (project_id, repository, pr_number, head_sha, first_seen_at, from_open)
       VALUES ('p', 'acme/app', ?, ?, '2026-11-01', 1)`
    );
    const insertCheck = sqlite!.prepare(
      `INSERT INTO pull_request_checks (project_id, repository, head_sha, check_key, state, updated_at)
       VALUES ('p', 'acme/app', ?, ?, 'success', '2026-11-01')`
    );
    // Many pull requests with heads and checks, so an unindexed read would walk them all.
    sqlite!.transaction(() => {
      for (let n = 1; n <= 2_000; n += 1) {
        const sha = n.toString(16).padStart(40, '0');
        insertPr.run(`pr-${n}`, n, `https://github.com/acme/app/pull/${n}`, sha);
        insertHead.run(n, sha);
        for (const key of ['lint', 'test', 'build']) insertCheck.run(sha, key);
      }
    })();
    sqlite!.exec(
      `UPDATE tasks SET output_pr_url = 'https://github.com/acme/app/pull/1234' WHERE id = 't-0'`
    );

    const receipt = await runReceipt(ctx, { projectId: 'p', taskId: 't-0' });
    expect(receipt.outcome.ciFirstTry).toBe('passed');
    const pullRequest = statements.find((query) => query.includes('AS first_try'));
    expect(pullRequest, 'the pull request statement ran').toBeDefined();
    const pullRequestPlan = plan(pullRequest!).join('\n');
    expect(pullRequestPlan).toMatch(/SEARCH h USING/);
    expect(pullRequestPlan).toMatch(/SEARCH c USING/);
    expect(pullRequestPlan).not.toMatch(/SCAN (h|c|pr|pull_request_heads|pull_request_checks)\b/);
  });

  it('finds comparable runs of the same profile by index when the run has no skill', async () => {
    const { ctx, statements } = setup();
    sqlite!.exec(
      `UPDATE tasks SET skill_id = NULL,
         agent_profile_hint = CASE WHEN rowid % 400 = 0 THEN 'profile-rare' ELSE 'profile-common' END`
    );
    sqlite!.exec(`UPDATE tasks SET agent_profile_hint = 'profile-rare' WHERE id = 't-0'`);
    await runReceipt(ctx, { projectId: 'p', taskId: 't-0' });
    const comparison = statements.find((query) => query.includes('t.agent_profile_hint = ?'));
    expect(comparison, 'the profile comparison statement ran').toBeDefined();
    const comparisonPlan = plan(comparison!).join('\n');
    expect(comparisonPlan).toMatch(/idx_tasks_project_profile_created/);
    expect(comparisonPlan).not.toMatch(/SCAN t\b|SCAN tasks/);
  });
});
