/** Common session-list fixtures and API responses for documentation captures. */
import type { Route } from '@playwright/test';

export function neighboringDocsSessions(now: number) {
  const hour = 60 * 60_000;
  return [
    {
      id: 'sess-sleeping',
      topic: 'Move invoice rendering to a queue',
      status: 'sleeping' as const,
      taskStatus: 'in_progress' as const,
      taskMode: 'conversation' as const,
      lastMessageAt: now - 3 * hour,
    },
    {
      id: 'sess-completed',
      topic: 'Add retries to the webhook sender',
      status: 'stopped' as const,
      taskStatus: 'completed' as const,
      taskMode: 'task' as const,
      lastMessageAt: now - 26 * hour,
    },
  ];
}

interface DocsSession {
  id: string;
  topic: string;
  workspaceId: string | null;
  startedAt: number;
  task: { id: string };
}

interface DocsChatRoutes {
  project: { id: string };
  user: unknown;
  sessions: DocsSession[];
  messages: Record<string, unknown[]>;
  state: unknown;
}

function sessionResponse(pathname: string, data: DocsChatRoutes): unknown {
  const detail = new RegExp(
    `^/api/projects/${data.project.id}/sessions/([^/]+)(/messages|/state)?$`
  ).exec(pathname);
  if (!detail) return undefined;
  const [, sessionId, suffix] = detail;
  const messages = data.messages[sessionId ?? ''] ?? [];
  if (suffix === '/state') return data.state;
  if (suffix === '/messages') return { messages, hasMore: false };
  const session = data.sessions.find((item) => item.id === sessionId);
  return session ? { session, messages, hasMore: false, state: data.state } : undefined;
}

function taskResponse(pathname: string, data: DocsChatRoutes): unknown {
  const taskMatch = new RegExp(`^/api/projects/${data.project.id}/tasks/([^/]+)$`).exec(pathname);
  if (!taskMatch) return undefined;
  const session = data.sessions.find((item) => item.task.id === taskMatch[1]);
  if (!session) return undefined;
  return {
    ...session.task,
    title: session.topic,
    projectId: data.project.id,
    workspaceId: session.workspaceId,
    startedAt: new Date(session.startedAt).toISOString(),
  };
}

/** Called after scene-specific routes, preserving their priority over common responses. */
export function fulfillDocsChatRoute(route: Route, data: DocsChatRoutes): Promise<void> {
  const { pathname } = new URL(route.request().url());
  const projectPath = `/api/projects/${data.project.id}`;
  const responses: Record<string, unknown> = {
    '/api/projects': { projects: [data.project], nextCursor: null },
    [projectPath]: data.project,
    [`${projectPath}/sessions`]: { sessions: data.sessions, total: data.sessions.length },
    '/api/report-issue/config': { enabled: false },
    [`${projectPath}/comment-threads`]: { threads: [], total: 0 },
    [`${projectPath}/members`]: { members: [] },
    [`${projectPath}/agent-profiles`]: { items: [] },
    [`${projectPath}/tasks`]: { tasks: [], total: 0 },
    '/api/agents': { agents: [] },
    '/api/github/installations': [],
  };
  let body: unknown;
  if (pathname.startsWith('/api/auth')) body = data.user;
  else if (pathname.startsWith('/api/notifications') || pathname.startsWith('/api/credentials')) body = [];
  else body = responses[pathname] ?? sessionResponse(pathname, data) ?? taskResponse(pathname, data) ?? {};
  return route.fulfill({ status: 200, json: body });
}
