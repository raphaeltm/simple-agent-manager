import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectData: {
    getSession: vi.fn(),
    linkSessionToTask: vi.fn(),
  },
  ulid: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => mocks.projectData);
vi.mock('../../../src/lib/ulid', () => ({ ulid: mocks.ulid }));

import { ensureSessionTaskBacked } from '../../../src/services/session-task-repair';

function makeDb(selectResults: unknown[][], rejectFirstInsert = false) {
  const inserted: unknown[] = [];
  let insertCount = 0;
  return {
    inserted,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => selectResults.shift() ?? []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: unknown) => {
          insertCount += 1;
          if (rejectFirstInsert && insertCount === 1) throw new Error('unique constraint');
          inserted.push(value);
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    },
  };
}

const env = {} as never;

describe('ensureSessionTaskBacked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ulid.mockReturnValueOnce('task-repair-1').mockReturnValueOnce('event-1');
    mocks.projectData.getSession.mockResolvedValue({
      id: 'session-1',
      taskId: null,
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      topic: 'Legacy instant conversation',
      status: 'active',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    mocks.projectData.linkSessionToTask.mockResolvedValue(true);
  });

  it('creates one conversation task and links the legacy ProjectData session', async () => {
    const createdTask = {
      id: 'task-repair-1',
      projectId: 'project-1',
      userId: 'user-1',
      chatSessionId: 'session-1',
      title: 'Legacy instant conversation',
      taskMode: 'conversation',
      triggeredBy: 'legacy-session-repair',
    };
    const { db, inserted } = makeDb([[], [createdTask]]);

    const result = await ensureSessionTaskBacked(db as never, env, {
      projectId: 'project-1',
      sessionId: 'session-1',
      fallbackUserId: 'fallback-user',
    });

    expect(result).toMatchObject(createdTask);
    expect(inserted[0]).toMatchObject({
      id: 'task-repair-1',
      chatSessionId: 'session-1',
      workspaceId: 'workspace-1',
      taskMode: 'conversation',
      triggeredBy: 'legacy-session-repair',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    expect(mocks.projectData.linkSessionToTask).toHaveBeenCalledWith(
      env,
      'project-1',
      'session-1',
      'task-repair-1'
    );
  });

  it('reuses the unique-index winner when concurrent repair races', async () => {
    const winner = {
      id: 'task-winner',
      projectId: 'project-1',
      userId: 'user-1',
      chatSessionId: 'session-1',
      title: 'Legacy instant conversation',
      taskMode: 'conversation',
    };
    const { db } = makeDb([[], [winner]], true);

    const result = await ensureSessionTaskBacked(db as never, env, {
      projectId: 'project-1',
      sessionId: 'session-1',
      fallbackUserId: 'fallback-user',
    });

    expect(result.id).toBe('task-winner');
    expect(mocks.projectData.linkSessionToTask).toHaveBeenCalledWith(
      env,
      'project-1',
      'session-1',
      'task-winner'
    );
  });

  it('preserves a stopped legacy session as a completed conversation task', async () => {
    mocks.projectData.getSession.mockResolvedValueOnce({
      id: 'session-1',
      taskId: null,
      workspaceId: null,
      createdByUserId: 'user-1',
      topic: 'Archived conversation',
      status: 'stopped',
      createdAt: '2026-07-01T00:00:00.000Z',
      endedAt: '2026-07-01T01:00:00.000Z',
    });
    const { db, inserted } = makeDb([[], [{ id: 'task-repair-1' }]]);

    await ensureSessionTaskBacked(db as never, env, {
      projectId: 'project-1',
      sessionId: 'session-1',
      fallbackUserId: 'fallback-user',
    });

    expect(inserted[0]).toMatchObject({
      status: 'completed',
      completedAt: '2026-07-01T01:00:00.000Z',
    });
  });

  it('returns an existing backing task without creating another', async () => {
    mocks.projectData.getSession.mockResolvedValueOnce({
      id: 'session-1',
      taskId: 'task-existing',
      createdByUserId: 'user-1',
    });
    const existing = {
      id: 'task-existing',
      projectId: 'project-1',
      userId: 'user-1',
      chatSessionId: 'session-1',
      title: 'Existing',
      taskMode: 'conversation',
    };
    const { db, inserted } = makeDb([[existing]]);

    const result = await ensureSessionTaskBacked(db as never, env, {
      projectId: 'project-1',
      sessionId: 'session-1',
      fallbackUserId: 'fallback-user',
    });

    expect(result.id).toBe('task-existing');
    expect(inserted).toHaveLength(0);
  });
});
