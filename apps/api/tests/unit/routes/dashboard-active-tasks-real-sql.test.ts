/**
 * Vertical slice for the dashboard's Active Tasks cap: the real
 * `listAgentActivityTasks` SQL (its ORDER BY and LIMIT) over an in-memory
 * SQLite database, through the real route, with only auth and the per-project
 * Durable Object session lookup faked.
 *
 * Message recency lives in each project's Durable Object, not in D1, so the
 * route has to rank every active candidate before capping. Capping the D1 read
 * instead keeps the most recently *started* tasks — and `task-old-hot` below,
 * started five days ago but messaged a minute ago, is the one that disappears.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { dashboardRoutes } from '../../../src/routes/dashboard';
import * as projectDataService from '../../../src/services/project-data';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/services/project-data', () => ({
  getSessionsByTaskIds: vi.fn(),
}));

const NOW = Date.now();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface TaskFixture {
  id: string;
  projectId: string;
  userId?: string;
  status?: string;
  supersededByTaskId?: string;
  createdAgo: number;
  /** Omitted for a task that has not started yet. */
  startedAgo?: number;
  /** Omitted for a task whose session has no messages yet. */
  lastMessageAgo?: number;
}

const TASKS: TaskFixture[] = [
  // The user's active tasks. Start order and activity order disagree on purpose.
  { id: 'task-queued-fresh', projectId: 'project-1', status: 'queued', createdAgo: 30 * SECOND },
  {
    id: 'task-old-hot',
    projectId: 'project-2',
    createdAgo: 5 * DAY,
    startedAgo: 5 * DAY,
    lastMessageAgo: 1 * MINUTE,
  },
  {
    id: 'task-recent-1',
    projectId: 'project-1',
    createdAgo: HOUR,
    startedAgo: HOUR,
    lastMessageAgo: 5 * MINUTE,
  },
  {
    id: 'task-recent-2',
    projectId: 'project-2',
    createdAgo: 2 * HOUR,
    startedAgo: 2 * HOUR,
    lastMessageAgo: 15 * MINUTE,
  },
  {
    id: 'task-recent-3',
    projectId: 'project-1',
    createdAgo: 3 * HOUR,
    startedAgo: 3 * HOUR,
    lastMessageAgo: 45 * MINUTE,
  },
  {
    id: 'task-dormant-1',
    projectId: 'project-1',
    createdAgo: 4 * HOUR,
    startedAgo: 4 * HOUR,
    lastMessageAgo: 3 * HOUR,
  },
  {
    id: 'task-dormant-2',
    projectId: 'project-2',
    createdAgo: 6 * HOUR,
    startedAgo: 6 * HOUR,
    lastMessageAgo: 5 * HOUR,
  },
  {
    id: 'task-dormant-3',
    projectId: 'project-1',
    createdAgo: 8 * HOUR,
    startedAgo: 8 * HOUR,
    lastMessageAgo: 7 * HOUR,
  },
  // Messaged most recently of all, yet never candidates: finished, handed to a
  // successor, or someone else's.
  {
    id: 'task-completed',
    projectId: 'project-1',
    status: 'completed',
    createdAgo: HOUR,
    startedAgo: HOUR,
    lastMessageAgo: 10 * SECOND,
  },
  {
    id: 'task-superseded',
    projectId: 'project-2',
    supersededByTaskId: 'task-old-hot',
    createdAgo: 6 * DAY,
    startedAgo: 6 * DAY,
    lastMessageAgo: 10 * SECOND,
  },
  {
    id: 'task-other-user',
    projectId: 'project-3',
    userId: 'user-2',
    createdAgo: HOUR,
    startedAgo: HOUR,
    lastMessageAgo: 5 * SECOND,
  },
];

/** Every active task of user-1, most recently active first. */
const ACTIVE_BY_RECENCY = [
  'task-queued-fresh',
  'task-old-hot',
  'task-recent-1',
  'task-recent-2',
  'task-recent-3',
  'task-dormant-1',
  'task-dormant-2',
  'task-dormant-3',
];

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function seedDatabase(): D1Database {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.projects,
    schema.workspaces,
    schema.tasks,
    schema.sessionSnapshots,
  ]);

  const insertProject = sqlite.prepare(
    `INSERT INTO projects (id, user_id, name, repository, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const [id, userId] of [
    ['project-1', 'user-1'],
    ['project-2', 'user-1'],
    ['project-3', 'user-2'],
  ]) {
    insertProject.run(id, userId, `Project ${id}`, `owner/${id}`, iso(30 * DAY), iso(30 * DAY));
  }

  const insertTask = sqlite.prepare(
    `INSERT INTO tasks
       (id, project_id, user_id, superseded_by_task_id, title, status, execution_step,
        created_by, created_at, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const task of TASKS) {
    const userId = task.userId ?? 'user-1';
    insertTask.run(
      task.id,
      task.projectId,
      userId,
      task.supersededByTaskId ?? null,
      `Title of ${task.id}`,
      task.status ?? 'in_progress',
      task.status === 'queued' ? null : 'running',
      userId,
      iso(task.createdAgo),
      task.startedAgo === undefined ? null : iso(task.startedAgo),
      iso(task.createdAgo)
    );
  }

  return createSqliteD1(sqlite);
}

/** Answers for the tasks it is asked about, as each project's Durable Object would. */
function fakeSessionLookup(): void {
  vi.mocked(projectDataService.getSessionsByTaskIds).mockImplementation(
    async (_env, projectId, taskIds) =>
      TASKS.filter(
        (task) =>
          task.projectId === projectId &&
          taskIds.includes(task.id) &&
          task.lastMessageAgo !== undefined
      ).map((task) => ({
        id: `session-${task.id}`,
        taskId: task.id,
        lastMessageAt: NOW - (task.lastMessageAgo ?? 0),
        messageCount: 3,
      }))
  );
}

async function requestActiveTasks(vars: Partial<Env> = {}): Promise<{ tasks: any[] }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/dashboard', dashboardRoutes);
  const env = {
    DATABASE: seedDatabase(),
    SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: '3',
    ...vars,
  } as Env;

  const res = await app.request('/dashboard/active-tasks', {}, env);
  expect(res.status).toBe(200);
  return (await res.json()) as { tasks: any[] };
}

describe('GET /dashboard/active-tasks against real SQL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeSessionLookup();
  });

  it('returns the six most recently active tasks, not the six most recently started', async () => {
    const body = await requestActiveTasks();

    expect(body.tasks.map((t) => t.id)).toEqual(ACTIVE_BY_RECENCY.slice(0, 6));

    const oldHot = body.tasks.find((t) => t.id === 'task-old-hot');
    expect(oldHot).toMatchObject({
      sessionId: 'session-task-old-hot',
      lastMessageAt: NOW - MINUTE,
      isActive: true,
    });
    const queuedFresh = body.tasks.find((t) => t.id === 'task-queued-fresh');
    expect(queuedFresh).toMatchObject({ sessionId: null, lastMessageAt: null, status: 'queued' });
  });

  it('returns every active task in activity order when the display limit is raised', async () => {
    const body = await requestActiveTasks({ DASHBOARD_ACTIVE_TASK_LIMIT: '50' });

    expect(body.tasks.map((t) => t.id)).toEqual(ACTIVE_BY_RECENCY);
  });

  it('ranks only the candidates the bounded read returns, which are the most recently started', async () => {
    const body = await requestActiveTasks({ DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT: '7' });

    // The oldest-started active task falls outside a seven-task read.
    expect(body.tasks.map((t) => t.id)).toEqual(
      ACTIVE_BY_RECENCY.filter((id) => id !== 'task-old-hot').slice(0, 6)
    );
  });
});
