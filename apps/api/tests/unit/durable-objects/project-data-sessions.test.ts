import { describe, expect, it } from 'vitest';

import { stopActiveSessionsForTask } from '../../../src/durable-objects/project-data/sessions';

type SessionRow = {
  id: string;
  workspace_id: string | null;
  task_id: string | null;
  status: 'active' | 'stopped';
  message_count: number;
  ended_at?: number;
  updated_at?: number;
};

class FakeSqlStorage {
  constructor(private readonly sessions: SessionRow[]) {}

  exec(query: string, ...params: unknown[]) {
    if (query.includes('SELECT id, workspace_id, message_count')) {
      const [taskId] = params;
      const rows = this.sessions
        .filter((session) => session.task_id === taskId && session.status === 'active')
        .map((session) => ({
          id: session.id,
          workspace_id: session.workspace_id,
          message_count: session.message_count,
        }));
      return { toArray: () => rows };
    }

    if (query.includes('UPDATE chat_sessions')) {
      const [endedAt, updatedAt, taskId] = params as [number, number, string];
      for (const session of this.sessions) {
        if (session.task_id === taskId && session.status === 'active') {
          session.status = 'stopped';
          session.ended_at = endedAt;
          session.updated_at = updatedAt;
        }
      }
      return { toArray: () => [] };
    }

    throw new Error(`Unexpected query: ${query}`);
  }
}

describe('ProjectData session helpers', () => {
  it('stops every active session for a task while leaving unrelated sessions untouched', () => {
    const rows: SessionRow[] = [
      { id: 'canonical', workspace_id: 'workspace-1', task_id: 'task-1', status: 'active', message_count: 7 },
      { id: 'orphan', workspace_id: null, task_id: 'task-1', status: 'active', message_count: 1 },
      { id: 'already-stopped', workspace_id: null, task_id: 'task-1', status: 'stopped', message_count: 1 },
      { id: 'other-task', workspace_id: 'workspace-2', task_id: 'task-2', status: 'active', message_count: 2 },
    ];

    const stopped = stopActiveSessionsForTask(new FakeSqlStorage(rows) as unknown as SqlStorage, 'task-1');

    expect(stopped).toEqual([
      { sessionId: 'canonical', workspaceId: 'workspace-1', messageCount: 7 },
      { sessionId: 'orphan', workspaceId: null, messageCount: 1 },
    ]);
    expect(rows.find((row) => row.id === 'canonical')?.status).toBe('stopped');
    expect(rows.find((row) => row.id === 'orphan')?.status).toBe('stopped');
    expect(rows.find((row) => row.id === 'already-stopped')?.ended_at).toBeUndefined();
    expect(rows.find((row) => row.id === 'other-task')?.status).toBe('active');
  });
});
