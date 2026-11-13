/**
 * Chat task-state enrichment past D1's 100-bound-parameter ceiling (apps/api/.claude/rules/69):
 * better-sqlite3 allows tens of thousands, so the fixture runs on a harness that enforces D1's
 * limit, with more task ids than one statement can bind and a remainder chunk.
 */
import { chatTaskStates } from '@simple-agent-manager/operations/internal/chat-operational';
import { D1_MAX_BOUND_PARAMETERS } from '@simple-agent-manager/worker-core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { createSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

describe('chatTaskStates', () => {
  let sqlite: Database.Database;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.tasks]);
  });
  afterEach(() => sqlite.close());

  it('reads every task when the page holds more ids than one statement can bind', async () => {
    // Derived from the constant on purpose: the bind-limited harness is what fails outright
    // should a chunk ever exceed the real ceiling.
    const count = D1_MAX_BOUND_PARAMETERS * 2 + 1;
    const insert = sqlite.prepare(
      "INSERT INTO tasks (id,project_id,user_id,title,status,execution_step) VALUES (?,'p','u','t',?,?)"
    );
    const rows = Array.from({ length: count }, (_, index) => {
      insert.run(`task-${index}`, index % 2 ? 'completed' : 'in_progress', 'running');
      return { id: `chat-${index}`, projectId: 'p', taskId: `task-${index}`, status: 'active' };
    });
    const db = drizzle(createSqliteD1WithBindLimit(sqlite, D1_MAX_BOUND_PARAMETERS), { schema });
    const states = await chatTaskStates(db, rows);
    expect(states.size).toBe(count);
    expect(states.get(`chat-${count - 1}`)).toMatchObject({ taskStatus: 'in_progress' });
    expect(states.get('chat-1')).toMatchObject({ taskTerminal: true, labelMayBeStale: true });
  });

  it('a failed task read leaves the chats without enrichment instead of failing the list', async () => {
    sqlite.exec('DROP TABLE tasks');
    const db = drizzle(createSqliteD1WithBindLimit(sqlite, D1_MAX_BOUND_PARAMETERS), { schema });
    const states = await chatTaskStates(db, [
      { id: 'chat', projectId: 'p', taskId: 'task', status: 'active' },
    ]);
    expect(states.size).toBe(0);
  });
});
