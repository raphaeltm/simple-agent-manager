import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { correlateVMErrorsToTasks } from '../../../src/services/vm-error-correlation';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

describe('VM error task correlation', () => {
  let sqlite: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        node_id TEXT,
        project_id TEXT,
        chat_session_id TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        project_id TEXT,
        chat_session_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
    `);
    d1 = createSqliteD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  function insertWorkspace(id: string, nodeId: string = 'node-1', sessionId: string = 'session-1') {
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, node_id, project_id, chat_session_id)
         VALUES (?, ?, 'project-1', ?)`
      )
      .run(id, nodeId, sessionId);
  }

  function insertTask(
    id: string,
    workspaceId: string,
    sessionId: string = 'session-1',
    startedAt: string = '2026-08-09T06:00:00.000Z',
    completedAt: string | null = null
  ) {
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, workspace_id, project_id, chat_session_id, created_at, started_at, completed_at)
         VALUES (?, ?, 'project-1', ?, ?, ?, ?)`
      )
      .run(id, workspaceId, sessionId, startedAt, startedAt, completedAt);
  }

  it('returns the canonical task/session when node, workspace, project, and session agree', async () => {
    insertWorkspace('workspace-1');
    insertTask('task-1', 'workspace-1');

    await expect(
      correlateVMErrorsToTasks(d1, 'node-1', [
        { workspaceId: 'workspace-1', timestamp: Date.parse('2026-08-09T06:47:29.000Z') },
      ])
    ).resolves.toEqual([
      {
        correlation: { taskId: 'task-1', sessionId: 'session-1' },
        rejectionReason: null,
      },
    ]);
  });

  it('fails closed when corrupted state produces more than one candidate', async () => {
    insertWorkspace('workspace-1');
    insertTask('task-1', 'workspace-1');
    insertTask('task-2', 'workspace-1');

    await expect(
      correlateVMErrorsToTasks(d1, 'node-1', [
        { workspaceId: 'workspace-1', timestamp: Date.parse('2026-08-09T06:47:29.000Z') },
      ])
    ).resolves.toEqual([{ correlation: null, rejectionReason: 'ambiguous_task_binding' }]);
  });

  it('does not attach stale evidence outside the task lifetime', async () => {
    insertWorkspace('workspace-1');
    insertTask('task-1', 'workspace-1', 'session-1', '2026-08-09 06:00:00', '2026-08-09 06:30:00');

    await expect(
      correlateVMErrorsToTasks(d1, 'node-1', [
        { workspaceId: 'workspace-1', timestamp: Date.parse('2026-08-09T06:47:29.000Z') },
      ])
    ).resolves.toEqual([{ correlation: null, rejectionReason: 'outside_task_lifetime' }]);
  });

  it('reports node and session identity rejection reasons', async () => {
    insertWorkspace('workspace-other-node', 'node-2');
    insertTask('task-other-node', 'workspace-other-node');
    insertWorkspace('workspace-session-mismatch');
    insertTask('task-session-mismatch', 'workspace-session-mismatch', 'session-2');

    await expect(
      correlateVMErrorsToTasks(d1, 'node-1', [
        {
          workspaceId: 'workspace-other-node',
          timestamp: Date.parse('2026-08-09T06:47:29.000Z'),
        },
        {
          workspaceId: 'workspace-session-mismatch',
          timestamp: Date.parse('2026-08-09T06:47:29.000Z'),
        },
      ])
    ).resolves.toEqual([
      { correlation: null, rejectionReason: 'node_mismatch' },
      { correlation: null, rejectionReason: 'canonical_task_missing' },
    ]);
  });

  it('rejects missing or invalid producer timestamps', async () => {
    insertWorkspace('workspace-1');
    insertTask('task-1', 'workspace-1');

    await expect(
      correlateVMErrorsToTasks(d1, 'node-1', [
        { workspaceId: 'workspace-1', timestamp: null },
        { workspaceId: 'workspace-1', timestamp: Number.NaN },
      ])
    ).resolves.toEqual([
      { correlation: null, rejectionReason: 'invalid_incident_timestamp' },
      { correlation: null, rejectionReason: 'invalid_incident_timestamp' },
    ]);
  });

  it('chunks operator-sized batches below the D1 bind-parameter ceiling', async () => {
    insertWorkspace('workspace-160');
    insertTask('task-160', 'workspace-160');
    const requests = Array.from({ length: 161 }, (_, index) => ({
      workspaceId: `workspace-${index}`,
      timestamp: Date.parse('2026-08-09T06:47:29.000Z'),
    }));
    let prepareCalls = 0;
    const trackingD1 = new Proxy(d1, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (query: string) => {
            prepareCalls += 1;
            return target.prepare(query);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await correlateVMErrorsToTasks(trackingD1, 'node-1', requests);

    expect(prepareCalls).toBe(2);
    expect(result[160]).toEqual({
      correlation: { taskId: 'task-160', sessionId: 'session-1' },
      rejectionReason: null,
    });
    expect(result.filter((entry) => entry.correlation)).toHaveLength(1);
  });
});
