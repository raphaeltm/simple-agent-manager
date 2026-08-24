import type { Task } from '@simple-agent-manager/shared';
import { queryOptions } from '@tanstack/react-query';

import {
  getProjectTask,
  getTaskSessions,
  listActiveTasks,
  listProjectTasks,
  listTaskEvents,
} from '../api';

/**
 * The dashboard's cross-project active-task list (`GET /api/dashboard/active-tasks`).
 *
 * Polled every 15 s. Before this migration the poll was a bare `setInterval` with no
 * visibility check, so it kept issuing requests in background tabs indefinitely.
 * Driven through `refetchInterval` it stops on a hidden tab automatically — see the
 * note in `lib/poll-intervals.ts`.
 *
 * NOT persistable: `DashboardTask` carries user-authored task titles.
 */
export const taskQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'tasks'] as const,
  active: (queryScope: string) => [...taskQueryKeys.all(queryScope), 'active'] as const,
  project: (queryScope: string, projectId: string) =>
    [...taskQueryKeys.all(queryScope), 'project', projectId] as const,
  draftIdeas: (queryScope: string, projectId: string, limit: number, maxPages: number) =>
    [...taskQueryKeys.project(queryScope, projectId), 'draft-ideas', { limit, maxPages }] as const,
  detail: (queryScope: string, projectId: string, taskId: string) =>
    [...taskQueryKeys.project(queryScope, projectId), 'detail', taskId] as const,
  sessions: (queryScope: string, projectId: string, taskId: string) =>
    [...taskQueryKeys.project(queryScope, projectId), 'sessions', taskId] as const,
  events: (queryScope: string, projectId: string, taskId: string, limit?: number) =>
    [...taskQueryKeys.project(queryScope, projectId), 'events', taskId, { limit: limit ?? null }] as const,
};

export function activeTasksQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: taskQueryKeys.active(queryScope),
    queryFn: async () => (await listActiveTasks()).tasks,
  });
}

async function listAllDraftIdeas(projectId: string, limit: number, maxPages: number) {
  const tasks: Task[] = [];
  let cursor: string | undefined;
  let pagesLoaded = 0;

  do {
    const result = await listProjectTasks(projectId, {
      status: 'draft',
      limit,
      cursor,
    });
    tasks.push(...result.tasks);
    cursor = result.nextCursor ?? undefined;
    pagesLoaded += 1;
  } while (cursor && pagesLoaded < maxPages);

  return {
    tasks: tasks.filter((task) => task.status === 'draft'),
    truncated: Boolean(cursor),
  };
}

export function draftIdeasQueryOptions(
  queryScope: string,
  projectId: string,
  limit: number,
  maxPages: number
) {
  return queryOptions({
    queryKey: taskQueryKeys.draftIdeas(queryScope, projectId, limit, maxPages),
    queryFn: () => listAllDraftIdeas(projectId, limit, maxPages),
  });
}

export function taskDetailQueryOptions(queryScope: string, projectId: string, taskId: string) {
  return queryOptions({
    queryKey: taskQueryKeys.detail(queryScope, projectId, taskId),
    queryFn: () => getProjectTask(projectId, taskId),
  });
}

export function taskSessionsQueryOptions(queryScope: string, projectId: string, taskId: string) {
  return queryOptions({
    queryKey: taskQueryKeys.sessions(queryScope, projectId, taskId),
    queryFn: async () => (await getTaskSessions(projectId, taskId)).sessions,
  });
}

export function taskEventsQueryOptions(
  queryScope: string,
  projectId: string,
  taskId: string,
  limit?: number
) {
  return queryOptions({
    queryKey: taskQueryKeys.events(queryScope, projectId, taskId, limit),
    queryFn: async () => (await listTaskEvents(projectId, taskId, limit)).events,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
