import { expect, type Page, test } from '@playwright/test';

import {
  assertNoOverflow,
  makeMockUser,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

/**
 * Visual audit for pages with no prior Playwright coverage:
 *
 * - /workspaces          (workspaces list — states + empty)
 * - /workspaces/new      (create-workspace form)
 * - /projects/:id/activity       (activity feed)
 * - /projects/:id/notifications  (project notifications, all types)
 * - /projects/:id/settings/runtime (runtime env vars + files)
 */

const PROJECT_ID = 'proj-sweep-1';
const NOW = Date.now();

const MOCK_USER = makeMockUser({
  userId: 'sweep-user',
  sessionId: 'session-sweep',
  email: 'sweep@example.com',
  name: 'Sweep Audit User',
  role: 'user',
});

const project = {
  id: PROJECT_ID,
  name: 'Sweep Audit Project With A Long Name To Stress Header Wrapping',
  repository: 'acme/sweep-audit-repository-with-a-fairly-long-name',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: 'sweep-user',
  installationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  defaultLocation: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  taskExecutionTimeoutMs: null,
  maxConcurrentTasks: null,
  maxDispatchDepth: null,
  maxSubTasksPerTask: null,
  warmNodeTimeoutMs: null,
  maxWorkspacesPerNode: null,
  nodeCpuThresholdPercent: null,
  nodeMemoryThresholdPercent: null,
  createdAt: '2026-07-06T00:00:00.000Z',
  updatedAt: '2026-07-06T00:00:00.000Z',
  summary: {
    activeWorkspaceCount: 1,
    activeSessionCount: 2,
    lastActivityAt: NOW - 60_000,
    taskCountsByStatus: {},
    linkedWorkspaces: 1,
  },
};

function makeWorkspace(i: number, overrides: Record<string, unknown>) {
  return {
    id: `ws-sweep-${i}`,
    nodeId: `node-${i % 2}`,
    projectId: PROJECT_ID,
    name: `workspace-${i}`,
    displayName: i === 1
      ? 'Workspace with an extremely long display name that stresses card layout wrapping on narrow mobile viewports'
      : `Workspace ${i}`,
    repository: 'acme/sweep-audit-repository-with-a-fairly-long-name',
    branch: i === 2 ? 'feat/very-long-branch-name-created-by-an-agent-for-a-multi-step-task' : 'main',
    status: 'running',
    vmSize: 'cx32',
    vmLocation: 'fsn1',
    workspaceProfile: null,
    devcontainerConfigName: null,
    vmIp: '192.0.2.10',
    lastActivityAt: new Date(NOW - i * 3_600_000).toISOString(),
    portsPublicEnabled: false,
    errorMessage: null,
    createdAt: new Date(NOW - i * 86_400_000).toISOString(),
    updatedAt: new Date(NOW - i * 3_600_000).toISOString(),
    url: `https://ws-sweep-${i}.example.com`,
    ...overrides,
  };
}

const workspaces = [
  // Worst-case row the truncation fix must survive: long title AND long branch
  // AND running status (Open button + overflow menu both compete for the row).
  makeWorkspace(1, {
    status: 'running',
    branch: 'sam/next-5-hours-thoroughly-5d5pke',
  }),
  makeWorkspace(2, { status: 'creating', vmIp: null, url: undefined }),
  makeWorkspace(3, { status: 'stopped' }),
  makeWorkspace(4, {
    status: 'error',
    errorMessage:
      'Cloud-init provisioning failed: devcontainer build exited with code 1 — see node logs for the full trace. This long message should wrap without breaking the card layout.',
  }),
  makeWorkspace(5, { status: 'stopping' }),
];

const nodes = [
  {
    id: 'node-0',
    name: 'node-alpha-with-long-name',
    status: 'active',
    healthStatus: 'healthy',
    cloudProvider: 'hetzner',
    vmSize: 'cx32',
    vmLocation: 'fsn1',
    nodeRole: 'workspace',
    ipAddress: '192.0.2.10',
    lastHeartbeatAt: new Date(NOW - 30_000).toISOString(),
    errorMessage: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  },
  {
    id: 'node-1',
    name: 'node-beta',
    status: 'active',
    healthStatus: 'healthy',
    cloudProvider: 'hetzner',
    vmSize: 'cx42',
    vmLocation: 'nbg1',
    nodeRole: 'workspace',
    ipAddress: '192.0.2.11',
    lastHeartbeatAt: new Date(NOW - 45_000).toISOString(),
    errorMessage: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  },
];

const activityEvents = [
  { eventType: 'session.started', actorType: 'user' },
  { eventType: 'task.created', actorType: 'user' },
  { eventType: 'task.status_changed', actorType: 'system' },
  { eventType: 'workspace.created', actorType: 'system' },
  { eventType: 'message.sent', actorType: 'workspace_callback' },
  { eventType: 'task.completed', actorType: 'workspace_callback' },
  { eventType: 'session.ended', actorType: 'user' },
  { eventType: 'node.provisioned', actorType: 'system' },
].map((e, i) => ({
  id: `evt-${i}`,
  eventType: e.eventType,
  actorType: e.actorType,
  actorId: e.actorType === 'user' ? 'sweep-user' : null,
  workspaceId: i % 2 === 0 ? 'ws-sweep-1' : null,
  sessionId: i % 3 === 0 ? 'session-1' : null,
  taskId: i % 2 === 1 ? 'task-1' : null,
  payload:
    i === 1
      ? {
          title:
            'A task with a very long title that keeps going to make sure the activity feed wraps text instead of overflowing horizontally on mobile',
        }
      : { title: `Event payload ${i}` },
  createdAt: NOW - i * 45 * 60_000,
}));

const notifications = [
  {
    type: 'task_complete',
    urgency: 'info',
    title: 'Task completed: Fix the workspace provisioning race',
    body: 'The agent finished the task and opened PR #1234. All CI checks passed. The change is ready for staging verification.',
    readAt: null,
  },
  {
    type: 'needs_input',
    urgency: 'action',
    title: 'Agent needs input on a decision with a very long notification title that should wrap cleanly on mobile',
    body: 'Should I use approach A (faster, more invasive) or approach B (slower, safer)? '.repeat(6),
    readAt: null,
  },
  {
    type: 'error',
    urgency: 'critical',
    title: 'Task failed: staging deploy',
    body: 'Deploy Staging workflow failed with exit code 1 — missing secret CF_API_TOKEN.',
    readAt: new Date(NOW - 3_600_000).toISOString(),
  },
  {
    type: 'progress',
    urgency: 'info',
    title: 'Long-running task update',
    body: 'Completed 4/7 checklist items.',
    readAt: new Date(NOW - 3_600_000).toISOString(),
  },
  {
    type: 'session_ended',
    urgency: 'info',
    title: 'Session ended',
    body: null,
    readAt: new Date(NOW - 7_200_000).toISOString(),
  },
  {
    type: 'pr_created',
    urgency: 'info',
    title: 'PR created: feat/notifications-page-polish',
    body: 'https://github.com/acme/sweep-audit-repository-with-a-fairly-long-name/pull/999',
    readAt: null,
  },
].map((n, i) => ({
  id: `notif-${i}`,
  projectId: PROJECT_ID,
  taskId: i % 2 === 0 ? `task-${i}` : null,
  sessionId: i % 2 === 1 ? `session-${i}` : null,
  actionUrl: i % 2 === 0 ? `/projects/${PROJECT_ID}/chat/session-${i}` : null,
  metadata: i === 1 ? { fullMessage: `${'Full message detail. '.repeat(40)}` } : null,
  dismissedAt: null,
  createdAt: new Date(NOW - i * 5_400_000).toISOString(),
  ...n,
}));

const runtimeConfig = {
  envVars: [
    { key: 'DATABASE_URL', isSecret: true, updatedAt: '2026-07-10T00:00:00.000Z' },
    { key: 'FEATURE_FLAG_LONG_NAME_FOR_WRAPPING_CHECK_IN_NARROW_LAYOUTS', isSecret: false, value: 'enabled-with-a-fairly-long-value-string', updatedAt: '2026-07-11T00:00:00.000Z' },
    { key: 'API_BASE', isSecret: false, value: 'https://api.example.com', updatedAt: '2026-07-12T00:00:00.000Z' },
  ],
  files: [
    { path: '.config/tool/settings.json', isSecret: false, updatedAt: '2026-07-10T00:00:00.000Z', sizeBytes: 512 },
    { path: '.ssh/deploy_key_with_long_filename_for_wrapping', isSecret: true, updatedAt: '2026-07-11T00:00:00.000Z', sizeBytes: 3327 },
  ],
};

async function setupMocks(page: Page, options: { emptyWorkspaces?: boolean } = {}) {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-sweep-user', 'true')
  );

  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects') return respond(200, { projects: [project] });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 3 });
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications, unreadCount: 3, nextCursor: null });
    }
    if (path === '/api/github/installations') {
      return respond(200, [
        { id: 'inst-1', accountLogin: 'acme', accountType: 'Organization' },
      ]);
    }
    if (path.startsWith('/api/github/repositories')) {
      return respond(200, {
        repositories: [
          {
            id: 1,
            fullName: 'acme/sweep-audit-repository-with-a-fairly-long-name',
            defaultBranch: 'main',
            private: true,
          },
          { id: 2, fullName: 'acme/second-repo', defaultBranch: 'main', private: false },
        ],
      });
    }
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path === '/api/workspaces') {
      return respond(200, options.emptyWorkspaces ? [] : workspaces);
    }
    if (path === '/api/nodes') return respond(200, nodes);
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path.startsWith('/api/credentials')) {
      return respond(200, [{ id: 'cred-1', provider: 'hetzner', status: 'valid', isActive: true }]);
    }
    if (path === '/api/trial/status' || path === '/api/trial-status') {
      return respond(200, { available: false });
    }
    if (path === '/api/providers/catalog') {
      return respond(200, {
        catalogs: [
          {
            provider: 'hetzner',
            defaultLocation: 'fsn1',
            locations: [
              { id: 'fsn1', name: 'Falkenstein', country: 'DE' },
              { id: 'nbg1', name: 'Nuremberg', country: 'DE' },
              { id: 'hel1', name: 'Helsinki', country: 'FI' },
            ],
            sizes: {
              small: { type: 'cx22', price: '€3.99/mo', vcpu: 2, ramGb: 4, diskGb: 40 },
              medium: { type: 'cx32', price: '€7.99/mo', vcpu: 4, ramGb: 8, diskGb: 80 },
              large: { type: 'cx42', price: '€15.99/mo', vcpu: 8, ramGb: 16, diskGb: 160 },
            },
          },
        ],
      });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] ?? '';
      if (!subPath) return respond(200, project);
      if (subPath.startsWith('/activity')) {
        return respond(200, { events: activityEvents, hasMore: true });
      }
      if (subPath === '/runtime-config') return respond(200, runtimeConfig);
      if (subPath === '/members') {
        return respond(200, { members: [], inviteLinks: [], accessRequests: [] });
      }
      if (subPath === '/credential-attribution-health') {
        return respond(200, {
          projectId: PROJECT_ID,
          multiplayerActive: false,
          counts: {
            resources: 0,
            personalResources: 0,
            personalCredentials: 0,
            projectCoveredCredentials: 0,
            unknownCredentials: 0,
          },
          resources: [],
        });
      }
      if (subPath.startsWith('/agent-profiles')) return respond(200, []);
      if (subPath === '/sessions') return respond(200, { sessions: [], total: 0 });
      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
      if (subPath.startsWith('/deployment')) return respond(404, { error: 'Not found' });
      return respond(200, project);
    }
    return undefined;
  });
}

async function visit(page: Page, path: string, name: string) {
  await page.goto(path);
  await page.waitForTimeout(900);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await screenshot(page, name);
  await assertNoOverflow(page);
}

test.describe('Uncovered pages sweep', () => {
  test('workspaces list — populated states', async ({ page }) => {
    await setupMocks(page);
    await visit(page, '/workspaces', 'sweep-workspaces-list');
  });

  test('workspaces list — empty state', async ({ page }) => {
    await setupMocks(page, { emptyWorkspaces: true });
    await visit(page, '/workspaces', 'sweep-workspaces-empty');
  });

  test('create workspace form', async ({ page }) => {
    await setupMocks(page);
    await visit(page, '/workspaces/new', 'sweep-create-workspace');
  });

  test('project activity feed', async ({ page }) => {
    await setupMocks(page);
    await visit(page, `/projects/${PROJECT_ID}/activity`, 'sweep-project-activity');
  });

  test('project notifications', async ({ page }) => {
    await setupMocks(page);
    await visit(page, `/projects/${PROJECT_ID}/notifications`, 'sweep-project-notifications');
  });

  test('project settings runtime', async ({ page }) => {
    await setupMocks(page);
    await visit(page, `/projects/${PROJECT_ID}/settings/runtime`, 'sweep-settings-runtime');
  });
});
