/**
 * Query plans of Insights · People's D1 statements at production-like row counts, with
 * production's declared indexes (`.claude/rules/69`, "D1 CPU is a ceiling too"; `.claude/rules/81`).
 * D1 keeps no planner statistics, so a statement that reads fine on a 10-row fixture can walk a
 * project's whole ask history. The plans asserted are those of the SQL `projectPeople` actually
 * issues, recorded from the D1 binding. The fixture exceeds every count in the path: 10,001
 * closed asks (almost all closed before the range), 5,001 open asks, 2,501 review cycles.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { projectPeople } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const CLOSED = 10_001;
const OPEN = 5_001;
const CYCLES = 2_501;

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
    INSERT INTO users (id, name, email) VALUES ('owner', 'Owner', 'o@example.com'),
      ('mate', 'Mate', 'm@example.com');
    INSERT INTO project_members (project_id, user_id, role, status) VALUES
      ('p', 'owner', 'owner', 'active'), ('p', 'mate', 'member', 'active');
  `);
  const insertAsk = sqlite.prepare(
    `INSERT INTO asks (id, project_id, assignee_kind, assignee_user_id, kind, title, status,
       resolved_by_user_id, resolved_at, created_at, updated_at)
     VALUES (?, 'p', 'user', ?, ?, 'Title', ?, ?, ?, ?, ?)`
  );
  const insertCycle = sqlite.prepare(
    `INSERT INTO pull_request_review_requests
       (project_id, repository, pr_number, reviewer_kind, reviewer_key, requested_at, first_review_at)
     VALUES ('p', 'acme/app', ?, 'user', 'alice', ?, ?)`
  );
  sqlite.transaction(() => {
    for (let i = 0; i < CLOSED; i += 1) {
      // One in 50 was resolved inside the 30-day range; the rest long before it.
      const resolved = NOW - (i % 50 === 0 ? DAY : 200 * DAY + i * 1_000);
      insertAsk.run(
        `c-${i}`,
        'owner',
        'question',
        'answered',
        'owner',
        resolved,
        resolved - DAY,
        resolved
      );
    }
    for (let i = 0; i < OPEN; i += 1) {
      const created = NOW - i * 60_000;
      insertAsk.run(
        `o-${i}`,
        i % 2 ? 'owner' : 'mate',
        i % 3 ? 'question' : 'task',
        'open',
        null,
        null,
        created,
        created
      );
    }
    for (let i = 0; i < CYCLES; i += 1) {
      const requested = new Date(NOW - (i % 60) * DAY - i * 1_000).toISOString();
      const reviewed = new Date(NOW - (i % 60) * DAY - i * 1_000 + 3_600_000).toISOString();
      insertCycle.run(i, requested, i % 4 ? reviewed : null);
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

describe('insights people query plans', { timeout: 60_000 }, () => {
  it('reads every section by index at production scale, and completes in one call', async () => {
    const { ctx, statements } = setup();
    const result = await projectPeople(ctx, { projectId: 'p', range: '30d', nowMs: NOW });

    // The read finished with every section, at counts past every cap in the path.
    expect(result.unavailable).toEqual([]);
    expect(result.waiting.total).toBe(OPEN);
    expect(result.waiting.groups.every((g) => g.items.length <= result.waiting.listed)).toBe(true);
    expect(result.firstPerson.closed).toBe(Math.ceil(CLOSED / 50));
    expect(result.reviewPickup.state).toBe('recorded');

    const first = statements.find((query) => query.includes("a.status IN ('answered', 'done')"));
    const items = statements.find((query) => query.includes('WITH ranked AS'));
    const cycles = statements.find((query) => query.includes('first_review_at\n      FROM'));
    expect(first, 'the first-person statement ran').toBeDefined();
    expect(items, 'the waiting items statement ran').toBeDefined();
    expect(cycles, 'the review cycles statement ran').toBeDefined();

    // Answered asks are sought by when they were resolved: the 9,800 closed before the range are
    // never read.
    const firstPlan = plan(first!).join('\n');
    expect(firstPlan).toMatch(/idx_asks_project_status_resolved/);
    expect(firstPlan).not.toMatch(/SCAN a\b|SCAN asks/);
    expect(firstPlan).toMatch(/idx_ask_activity_ask_created/);

    // Open asks come from the project/status index, and picked rows are joined back by key.
    const itemsPlan = plan(items!).join('\n');
    expect(itemsPlan).toMatch(/idx_asks_project_status/);
    expect(itemsPlan).not.toMatch(/SCAN a\b|SCAN asks/);

    const cyclesPlan = plan(cycles!).join('\n');
    expect(cyclesPlan).toMatch(/idx_pull_request_review_requests_project_requested/);
  });
});
