import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const PROJECT_ID = 'proj-slice-e';

const MOCK_USER = makeMockUser({
  email: 'slice-e@example.com',
  name: 'Slice E User',
  role: 'superadmin',
  sessionId: 'session-slice-e',
  userId: 'user-slice-e',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Slice E Project With A Very Long Name That Must Wrap Without Overflow',
  repository: 'raphaeltm/simple-agent-manager',
  defaultBranch: 'main',
  userId: 'user-slice-e',
  githubInstallationId: 'inst-slice-e',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
};

const longName = 'Very long Slice E item name that keeps going through multiple clauses and includes symbols <>& "quotes" to stress wrapping';

const files = Array.from({ length: 34 }, (_, index) => ({
  id: `file-${index}`,
  projectId: PROJECT_ID,
  filename: index === 0 ? `${longName}.markdown` : `research-note-${index}.md`,
  mimeType: 'text/markdown',
  sizeBytes: 1024 + index,
  description: index === 0 ? 'A'.repeat(260) : null,
  uploadedBy: 'user-slice-e',
  uploadSource: index % 3 === 0 ? 'agent' : 'user',
  uploadSessionId: null,
  uploadTaskId: null,
  replacedAt: null,
  replacedBy: null,
  status: 'ready',
  extractedTextPreview: null,
  directory: '/',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  tags: [
    { fileId: `file-${index}`, tag: 'slice-e', tagSource: 'user' },
    { fileId: `file-${index}`, tag: index === 0 ? 'long-tag-name-for-wrapping-check' : 'audit', tagSource: 'agent' },
  ],
}));

const directories = Array.from({ length: 8 }, (_, index) => ({
  path: `/directory-${index}`,
  name: index === 0 ? longName : `directory-${index}`,
  fileCount: index + 1,
  totalSizeBytes: 2048 * (index + 1),
  updatedAt: '2026-06-01T00:00:00Z',
}));

const tasks = Array.from({ length: 32 }, (_, index) => ({
  id: `task-${index}`,
  projectId: PROJECT_ID,
  title: index === 0 ? longName : `Idea ${index}`,
  description: index === 0 ? 'B'.repeat(420) : 'A normal idea description for visual audit coverage.',
  status: index % 5 === 0 ? 'failed' : index % 4 === 0 ? 'completed' : index % 3 === 0 ? 'in_progress' : 'queued',
  priority: index % 4,
  parentTaskId: null,
  agentProfileId: null,
  workspaceId: null,
  outputSummary: index === 0 ? 'C'.repeat(260) : null,
  error: index % 5 === 0 ? 'Synthetic failure state for visual audit.' : null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
  startedAt: null,
  completedAt: null,
}));

const triggers = Array.from({ length: 18 }, (_, index) => ({
  id: `trigger-${index}`,
  projectId: PROJECT_ID,
  userId: 'user-slice-e',
  name: index === 0 ? longName : `Trigger ${index}`,
  description: index === 0 ? 'D'.repeat(340) : 'Runs a scheduled project check.',
  status: index % 5 === 0 ? 'paused' : 'active',
  sourceType: index % 2 === 0 ? 'cron' : 'github',
  cronExpression: index % 2 === 0 ? '0 9 * * 1' : null,
  cronTimezone: 'UTC',
  githubConfig: index % 2 === 0 ? null : { eventType: 'issue_comment', filters: { actions: ['created'], commandPrefix: '/sam' } },
  skipIfRunning: false,
  promptTemplate: 'Review the trigger payload and create a task.',
  agentProfileId: null,
  taskMode: 'task',
  vmSizeOverride: null,
  maxConcurrent: 1,
  lastTriggeredAt: index % 2 === 0 ? '2026-06-05T00:00:00Z' : null,
  triggerCount: index,
  nextFireAt: '2026-06-07T00:00:00Z',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
}));

const notifications = Array.from({ length: 24 }, (_, index) => ({
  id: `notification-${index}`,
  projectId: PROJECT_ID,
  taskId: `task-${index}`,
  sessionId: null,
  type: index % 4 === 0 ? 'error' : index % 3 === 0 ? 'needs_input' : 'progress',
  urgency: index % 4 === 0 ? 'high' : 'low',
  title: index === 0 ? longName : `Notification ${index}`,
  body: index === 0 ? 'E'.repeat(360) : 'A project notification body.',
  actionUrl: `/projects/${PROJECT_ID}/ideas`,
  metadata: index === 0 ? { fullMessage: 'F'.repeat(500) } : null,
  readAt: index % 2 === 0 ? null : '2026-06-06T00:00:00Z',
  dismissedAt: null,
  createdAt: '2026-06-06T00:00:00Z',
}));

const entities = Array.from({ length: 30 }, (_, index) => ({
  id: `entity-${index}`,
  projectId: PROJECT_ID,
  name: index === 0 ? longName : `Entity ${index}`,
  entityType: index % 2 === 0 ? 'preference' : 'context',
  description: index === 0 ? 'G'.repeat(360) : 'A stored project memory item.',
  observationCount: index + 1,
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now(),
}));

const policies = Array.from({ length: 12 }, (_, index) => ({
  id: `policy-${index}`,
  category: index % 2 === 0 ? 'rule' : 'preference',
  title: index === 0 ? longName : `Policy ${index}`,
  content: index === 0 ? 'H'.repeat(420) : 'A project policy for agents.',
  active: index % 3 !== 0,
  confidence: 0.9,
  source: 'explicit',
  sourceSessionId: null,
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now(),
}));

const actions = Array.from({ length: 30 }, (_, index) => ({
  id: `activity-${index}`,
  eventType: index % 4 === 0 ? 'error.reported' : index % 3 === 0 ? 'task.completed' : 'knowledge.created',
  actorType: 'agent',
  actorId: 'agent-slice-e',
  workspaceId: null,
  sessionId: null,
  taskId: null,
  payload: { summary: index === 0 ? 'I'.repeat(360) : 'Activity summary' },
  createdAt: Date.now() - index * 60000,
}));

async function seedTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('sam-theme', value);
  }, theme);
}

async function setupMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/agents') return respond(200, []);
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/workspaces')) return respond(200, []);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications, total: notifications.length, unreadCount: notifications.filter((n) => !n.readAt).length });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/library/directories') return respond(200, { directories });
      if (subPath === '/library') return respond(200, { files, total: files.length, cursor: null });
      if (subPath === '/runtime-config') return respond(200, { envVars: [{ key: 'LONG_ENV_KEY_FOR_SLICE_E', value: 'secret', isSecret: true }], files: [{ path: '/etc/sam/very-long-config-file-name.env', content: 'hidden', isSecret: true }] });
      if (subPath === '/knowledge/entity-0') return respond(200, { entity: { ...entities[0], observations: [{ id: 'obs-0', entityId: 'entity-0', content: 'J'.repeat(380), confidence: 0.91, sourceType: 'explicit', sourceSessionId: null, createdAt: Date.now(), lastConfirmedAt: Date.now(), supersededBy: null, isActive: true }], relations: [] }, observations: [], relations: [] });
      if (subPath.startsWith('/knowledge')) return respond(200, { entities, total: entities.length });
      if (subPath.startsWith('/policies/') && (method === 'PATCH' || method === 'DELETE')) return respond(200, { ok: true });
      if (subPath === '/policies') return respond(200, { policies, total: policies.length });
      if (subPath === '/activity') return respond(200, { events: actions, hasMore: false });
      if (subPath === '/sessions') return respond(200, { sessions: [], total: 0 });
      if (subPath === '/tasks') return respond(200, { tasks, nextCursor: null });
      if (subPath.match(/^\/tasks\/[^/]+$/)) return respond(200, tasks[0]);
      if (subPath === '/triggers') return respond(200, { triggers });
      if (subPath.match(/^\/triggers\/[^/]+\/executions/)) return respond(200, { executions: [], nextCursor: null });
      if (subPath.match(/^\/triggers\/[^/]+$/)) return respond(200, triggers[0]);
      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], total: 1 });
    if (path.startsWith('/api/usage')) return respond(200, {});

    return respond(200, {});
  });
}

async function expectTheme(page: Page, theme: 'dark' | 'light') {
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'))).toBe(theme === 'light' ? 'sam-light' : 'sam');
}

async function visitAndCapture(page: Page, path: string, name: string, theme: 'dark' | 'light') {
  await page.goto(path);
  await expectTheme(page, theme);
  await page.waitForTimeout(700);
  await screenshot(page, name);
  await assertNoOverflow(page);
}

async function runSliceEAudit(page: Page, theme: 'dark' | 'light') {
  await seedTheme(page, theme);
  await setupMocks(page);
  const suffix = `${theme}-${page.viewportSize()?.width ?? 'unknown'}`;

  await visitAndCapture(page, `/projects/${PROJECT_ID}/library`, `slice-e-library-many-${suffix}`, theme);
  await page.getByRole('button', { name: 'Toggle filters' }).click();
  await screenshot(page, `slice-e-library-filters-${suffix}`);
  await assertNoOverflow(page);

  await visitAndCapture(page, `/projects/${PROJECT_ID}/ideas`, `slice-e-ideas-many-${suffix}`, theme);
  await visitAndCapture(page, `/projects/${PROJECT_ID}/triggers`, `slice-e-triggers-many-${suffix}`, theme);
  await page.getByRole('button', { name: /New Trigger|Create your first trigger/ }).first().click();
  await screenshot(page, `slice-e-trigger-form-${suffix}`);
  await assertNoOverflow(page);

  await visitAndCapture(page, `/projects/${PROJECT_ID}/settings/general`, `slice-e-project-settings-form-${suffix}`, theme);
  await visitAndCapture(page, `/projects/${PROJECT_ID}/notifications`, `slice-e-notifications-many-${suffix}`, theme);

  await visitAndCapture(page, `/projects/${PROJECT_ID}/agent-context`, `slice-e-agent-context-overview-${suffix}`, theme);
  await page.getByRole('tab', { name: 'Memory' }).click();
  await page.getByRole('button', { name: new RegExp(longName.slice(0, 24)) }).click();
  await page.getByRole('button', { name: 'Edit memory entity' }).first().click();
  await screenshot(page, `slice-e-memory-form-${suffix}`);
  await assertNoOverflow(page);
  await page.getByRole('button', { name: 'Delete memory entity' }).first().click();
  await screenshot(page, `slice-e-memory-dialog-${suffix}`);
  await assertNoOverflow(page);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Slice E theme audit — ${theme}`, () => {
    test('surfaces', async ({ page }) => {
      await runSliceEAudit(page, theme);
    });
  });
}
