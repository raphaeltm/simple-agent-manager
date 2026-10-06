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

/** Called after scene-specific routes, preserving their priority over common responses. */
export async function fulfillDocsChatRoute(route: Route, data: DocsChatRoutes): Promise<void> {
  const { pathname } = new URL(route.request().url());
  const projectId = data.project.id;
  const json = (body: unknown) => route.fulfill({ status: 200, json: body });

  if (pathname.startsWith('/api/auth')) return json(data.user);
  if (pathname === '/api/projects') return json({ projects: [data.project], nextCursor: null });
  if (pathname === `/api/projects/${projectId}`) return json(data.project);
  if (pathname === `/api/projects/${projectId}/sessions`) {
    return json({ sessions: data.sessions, total: data.sessions.length });
  }

  const detail = pathname.match(
    new RegExp(`^/api/projects/${projectId}/sessions/([^/]+)(/messages|/state)?$`)
  );
  if (detail) {
    const [, sessionId, suffix] = detail;
    const session = data.sessions.find((item) => item.id === sessionId);
    const messages = data.messages[sessionId ?? ''] ?? [];
    if (suffix === '/state') return json(data.state);
    if (suffix === '/messages') return json({ messages, hasMore: false });
    if (session) return json({ session, messages, hasMore: false, state: data.state });
  }

  // The chat re-reads its task on open; return its real status to avoid a starting banner.
  const taskMatch = pathname.match(new RegExp(`^/api/projects/${projectId}/tasks/([^/]+)$`));
  if (taskMatch) {
    const session = data.sessions.find((item) => item.task.id === taskMatch[1]);
    if (session) {
      return json({
        ...session.task,
        title: session.topic,
        projectId,
        workspaceId: session.workspaceId,
        startedAt: new Date(session.startedAt).toISOString(),
      });
    }
  }

  if (pathname === '/api/report-issue/config') return json({ enabled: false });
  if (pathname === `/api/projects/${projectId}/comment-threads`) {
    return json({ threads: [], total: 0 });
  }
  if (pathname === `/api/projects/${projectId}/members`) return json({ members: [] });
  if (pathname === `/api/projects/${projectId}/agent-profiles`) return json({ items: [] });
  if (pathname === `/api/projects/${projectId}/tasks`) return json({ tasks: [], total: 0 });
  if (pathname === '/api/agents') return json({ agents: [] });
  if (pathname.startsWith('/api/notifications')) return json([]);
  if (pathname.startsWith('/api/credentials')) return json([]);
  if (pathname === '/api/github/installations') return json([]);
  return json({});
}
