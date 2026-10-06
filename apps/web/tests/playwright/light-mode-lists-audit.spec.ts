import { type Page } from '@playwright/test';

import {
  describeThemeAudit,
  makeMockUser,
  setupAuditRoutes,
  visitAndCapture,
} from './audit-helpers';

/**
 * Light-mode visual audit for top-level list surfaces (/projects, /chats).
 *
 * These screens were not covered by an existing light-mode audit (slice-e only
 * covers project-scoped sub-pages). This audit captures dark and light at every
 * viewport project so future light-mode regressions on the project/chat cards
 * and task detail panels fail CI.
 */

const PROJECT_ID = 'proj-lists-audit';

const MOCK_USER = makeMockUser({
  email: 'lists-audit@example.com',
  name: 'Lists Audit User',
  role: 'superadmin',
  sessionId: 'session-lists-audit',
  userId: 'user-lists-audit',
});

const longName =
  'Very long list item name that keeps going through multiple clauses and includes symbols <>& "quotes" to stress wrapping';

const NOW = Date.now();

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Lists Audit Project With A Very Long Name That Must Wrap Without Overflow',
  repository: 'raphaeltm/simple-agent-manager',
  defaultBranch: 'main',
  userId: 'user-lists-audit',
  githubInstallationId: 'inst-lists-audit',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
};

const projects = Array.from({ length: 30 }, (_, index) => ({
  id: index === 0 ? PROJECT_ID : `project-${index}`,
  name: index === 0 ? longName : `Project ${index}`,
  repository: index === 1 ? '' : 'raphaeltm/simple-agent-manager',
  defaultBranch: 'main',
  userId: 'user-lists-audit',
  githubInstallationId: index === 1 ? null : 'inst-lists-audit',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
  lastActivityAt: NOW - index * 3_600_000,
  activeTaskCount: index % 4,
  activeSessionCount: index % 3,
}));

const sessions = Array.from({ length: 30 }, (_, index) => ({
  id: index === 0 ? 'session-lists-audit' : `session-${index}`,
  projectId: index === 0 ? PROJECT_ID : `project-${index}`,
  projectName: index === 0 ? longName : `Project ${index}`,
  userId: 'user-lists-audit',
  status: 'active',
  topic: index === 0 ? longName : index === 1 ? null : `Conversation about feature ${index}`,
  taskId: index % 3 === 0 ? `task-${index}` : null,
  workspaceId: index % 2 === 0 ? `ws-${index}` : null,
  messageCount: index * 3,
  startedAt: NOW - index * 60_000,
  lastMessageAt: NOW - index * 30_000,
  agentCompletedAt: index % 5 === 0 ? NOW - index * 20_000 : null,
  endedAt: null,
  isIdle: index % 5 === 0,
  updatedAt: NOW - index * 30_000,
}));

const TASK_DETAIL = {
  id: 'task-lists-audit',
  projectId: PROJECT_ID,
  title: longName,
  description: 'A'.repeat(420),
  status: 'completed',
  priority: 2,
  blocked: false,
  parentTaskId: null,
  agentProfileId: null,
  workspaceId: 'ws-lists-audit',
  outputSummary: 'B'.repeat(320),
  outputBranch: 'feat/very-long-branch-name-for-wrapping-stress-check',
  outputPrUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/1234',
  errorMessage: null,
  trigger: {
    id: 'trigger-lists-audit',
    name: 'Daily scheduled review trigger with a long name',
    cronHumanReadable: 'Every day at 9:00 AM',
  },
  triggerExecution: { sequenceNumber: 7 },
  dependencies: [],
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
  startedAt: '2026-06-01T01:00:00Z',
  completedAt: '2026-06-06T02:00:00Z',
};

const taskEvents = Array.from({ length: 12 }, (_, index) => ({
  id: `event-${index}`,
  taskId: 'task-lists-audit',
  fromStatus: index === 0 ? null : 'in_progress',
  toStatus: index === 0 ? 'queued' : index % 2 === 0 ? 'in_progress' : 'completed',
  note: index === 0 ? 'C'.repeat(260) : 'Status transition note.',
  // ISO string — matches the API contract (TaskEvent.createdAt: string). A raw
  // epoch number here makes formatDate() call .trim() on a number and crash.
  createdAt: new Date(NOW - index * 120_000).toISOString(),
}));

const siblingTasks = Array.from({ length: 8 }, (_, index) => ({
  id: `task-sibling-${index}`,
  projectId: PROJECT_ID,
  title: index === 0 ? longName : `Sibling task ${index}`,
  description: 'A sibling task for dependency selection.',
  status: index % 2 === 0 ? 'queued' : 'completed',
  priority: index % 4,
  parentTaskId: null,
  agentProfileId: null,
  workspaceId: null,
  outputSummary: null,
  error: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
  startedAt: null,
  completedAt: null,
}));

async function setupMocks(page: Page) {
  await setupAuditRoutes(page, (path, respond) => {
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications')
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/agents') return respond(200, []);
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/workspaces')) return respond(200, []);
    if (path === '/api/chats' || path === '/api/chats/recent')
      return respond(200, { sessions, total: sessions.length, totalActive: sessions.length });
    if (path === '/api/projects') return respond(200, { projects, total: projects.length });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath.match(/^\/tasks\/[^/]+\/events/)) return respond(200, { events: taskEvents });
      if (subPath.match(/^\/tasks\/[^/]+$/)) return respond(200, TASK_DETAIL);
      if (subPath === '/tasks') return respond(200, { tasks: siblingTasks, nextCursor: null });
      if (subPath === '/sessions') return respond(200, { sessions: [], total: 0 });
      return respond(200, MOCK_PROJECT);
    }
    return undefined;
  });
}

describeThemeAudit('Lists theme audit', setupMocks, async (page, theme, suffix) => {
  // /projects — grid of project summary cards
  await visitAndCapture(page, '/projects', `lists-projects-${suffix}`, theme);

  // /chats — list of active chat session cards across all projects
  await visitAndCapture(page, '/chats', `lists-chats-${suffix}`, theme);

});
