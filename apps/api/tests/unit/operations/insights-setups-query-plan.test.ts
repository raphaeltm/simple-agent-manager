/**
 * Query plan of the Agent setups statement with production's declared indexes (`.claude/rules/69`,
 * "D1 CPU is a ceiling too"): D1 keeps no planner statistics, so the plan decides the cost.
 * Review measured the first version at 14.4 s for 9,000 runs and 30,000 pull requests, because
 * rework was a correlated subquery scanning later pull requests once per merge, and the token and
 * memory reads walked the project's whole history once per picked run. These assertions pin the
 * shape that removed both, on the SQL the operation actually issues.
 */
import { flowWindow } from '@simple-agent-manager/operations/internal/insights-flow';
import { setupRunsStatement } from '@simple-agent-manager/operations/internal/insights-setups-sql';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { createAllSchemaTables, createDeclaredIndexes } from '../../helpers/sqlite-d1';

let sqlite: Database.Database | null = null;
afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('setupRunsStatement query plan', () => {
  it('searches per picked run by index and joins rework instead of scanning per merge', () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    createDeclaredIndexes(
      sqlite,
      Object.values(schema).filter((value): value is SQLiteTable => is(value, SQLiteTable))
    );
    const statement = setupRunsStatement(flowWindow('p', '90d', Date.now()), {
      viewerId: 'owner',
      cap: 2000,
      reworkWindowDays: 7,
    });
    const details = (
      sqlite.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.binds) as {
        detail: string;
      }[]
    ).map((row) => row.detail);
    const text = details.join('\n');

    // Token and memory reads: an index search per picked run, never a pass over the project.
    expect(text).toMatch(
      /SEARCH u USING INDEX idx_agent_run_usage_key \(project_id=\? AND chat_session_id=\?\)/
    );
    expect(text).toMatch(
      /SEARCH rs USING INDEX idx_workspace_resource_summaries_project_task \(project_id=\? AND task_id=\?\)/
    );
    expect(text).not.toMatch(/SEARCH u USING INDEX idx_agent_run_usage_project_updated/);
    // Rework: a join on an automatic index, never a scan of later pull requests per merge.
    expect(text).toMatch(
      /SEARCH b USING AUTOMATIC COVERING INDEX \(repository=\? AND head_ref=\?\)/
    );
    expect(text).not.toMatch(/SCAN b\b/);
    // The run lists are built once each (Flow's population, then the picked runs).
    expect(details.filter((d) => d === 'MATERIALIZE picked')).toHaveLength(1);
    expect(statement.binds).toHaveLength((statement.sql.match(/\?/g) ?? []).length);
  });
});
