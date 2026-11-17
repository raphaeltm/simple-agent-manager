/**
 * Shared real-SQL fixture for the Insights · Accounts tests (`insights-accounts.test.ts`,
 * `insights-accounts-usage.test.ts`): an in-memory schema, a project `p` (owner and teammate) beside
 * a foreign project, and the rows a run leaves (workspace, agent session, task) in production shape.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

type Row = Record<string, string | number | null>;

export function insertRow(sqlite: Database.Database, table: string, row: Row): void {
  const columns = Object.keys(row);
  sqlite
    .prepare(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    )
    .run(...Object.values(row));
}

export function insertCredential(
  sqlite: Database.Database,
  id: string,
  ownerId: string,
  name: string,
  kind: string
): void {
  insertRow(sqlite, 'cc_credentials', {
    id,
    owner_id: ownerId,
    name,
    kind,
    encrypted_token: 'ciphertext-never-read',
    iv: 'iv-never-read',
  });
}

/** Users owner, mate (both members of `p`) and outsider (owner of `foreign`), and their env. */
export function createAccountsTestDb(): { sqlite: Database.Database; env: Env } {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`
    INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'),
      ('mate','Mate','m@example.com'), ('outsider','Out','x@example.com');
    INSERT INTO projects (id, name, repository, user_id) VALUES ('p', 'Project', 'acme/app', 'owner'),
      ('foreign', 'Other', 'acme/app', 'outsider');
    INSERT INTO project_members (project_id, user_id, role, status) VALUES
      ('p','owner','owner','active'), ('p','mate','member','active'), ('foreign','outsider','owner','active');
  `);
  const env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  return { sqlite, env };
}

export function operationContext(env: Env, userId: string): OperationContext {
  return {
    env,
    ports: createOperationPorts(env),
    requestId: 'test',
    actor: { userId, via: 'web', scopes: new Set(['sam.read']) },
  };
}

/**
 * One run `id`: workspace `w-<id>`, agent session `s-<id>` and task `<id>`, as production leaves
 * them. `session` and `task` override the defaults column by column.
 */
export function insertRun(
  sqlite: Database.Database,
  id: string,
  options: {
    projectId?: string;
    workspaceProjectId?: string;
    userId?: string;
    credentialReference: string | null;
    session?: Row;
    task?: Row;
    taskTimes: { created: string; ended: string };
  }
): void {
  const projectId = options.projectId ?? 'p';
  const userId = options.userId ?? 'owner';
  insertRow(sqlite, 'workspaces', {
    id: `w-${id}`,
    project_id: options.workspaceProjectId ?? projectId,
    user_id: userId,
    name: `ws ${id}`,
    repository: 'acme/app',
    branch: 'main',
    status: 'deleted',
    vm_size: 'small',
    vm_location: 'fsn1',
  });
  insertRow(sqlite, 'agent_sessions', {
    id: `s-${id}`,
    workspace_id: `w-${id}`,
    user_id: userId,
    status: 'stopped',
    agent_type: 'claude-code',
    agent_credential_source: 'user',
    agent_credential_reference: options.credentialReference,
    ...options.session,
  });
  insertRow(sqlite, 'tasks', {
    id,
    project_id: projectId,
    user_id: userId,
    title: `Run ${id}`,
    status: 'completed',
    task_mode: 'task',
    is_idea: 0,
    workspace_id: `w-${id}`,
    created_at: options.taskTimes.created,
    updated_at: options.taskTimes.ended,
    completed_at: options.taskTimes.ended,
    ...options.task,
  });
}

/**
 * The D1 binding with one statement (matched by its SQL) failing, and the batch failing as a
 * whole, so the operation's per-statement retry isolates exactly that section.
 */
export function withFailingStatement(real: D1Database, matches: (sql: string) => boolean) {
  return {
    ...real,
    prepare: (sql: string) => {
      const statement = real.prepare(sql);
      if (!matches(sql)) return statement;
      const failing = {
        all: async () => {
          throw new Error('D1_ERROR: simulated');
        },
      };
      return { ...statement, bind: () => failing, ...failing };
    },
    batch: async () => {
      throw new Error('D1_ERROR: batch failed');
    },
  } as unknown as D1Database;
}
