import { expect, type Page, test } from '@playwright/test';

import {
  assertNoOverflow,
  makeMockUser,
  screenshot,
  seedTheme,
  setupAuditRoutes,
} from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const SUPERADMIN = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-cp-1',
  userId: 'user-cp-1',
});

const NORMAL_PROJECTS = [
  { id: 'proj-test-1', name: 'My API Worker' },
  { id: 'proj-test-2', name: 'Frontend Dashboard' },
  { id: 'proj-test-3', name: 'Infra Automation' },
];

const LONG_NAME =
  'This Is An Extremely Long Project Name That Should Truncate Cleanly Without Causing Any Horizontal Overflow In The Command Palette Context Actions Or Project List Rows Even On The Narrowest Mobile Viewport We Support';

const LONG_TEXT_PROJECTS = [
  { id: 'proj-test-1', name: LONG_NAME },
  { id: 'proj-test-2', name: 'Frontend Dashboard' },
];

function makeSession(overrides: {
  id: string;
  topic: string;
  projectId?: string;
  projectName?: string;
  status?: string;
  workspaceId?: string | null;
  taskId?: string | null;
}) {
  return {
    id: overrides.id,
    topic: overrides.topic,
    projectId: overrides.projectId ?? 'proj-test-1',
    projectName: overrides.projectName ?? 'My API Worker',
    userId: 'user-cp-1',
    status: overrides.status ?? 'active',
    messageCount: 5,
    startedAt: 1000,
    lastMessageAt: 2000,
    agentCompletedAt: null,
    endedAt: null,
    updatedAt: 2000,
    workspaceId: overrides.workspaceId ?? 'ws-1',
    taskId: overrides.taskId ?? 'task-1',
  };
}

const NORMAL_CHATS = {
  sessions: [
    makeSession({ id: 'sess-1', topic: 'Fix auth bug' }),
    makeSession({ id: 'sess-2', topic: 'Code review', status: 'stopped' }),
    makeSession({
      id: 'sess-3',
      topic: 'Refactor layout',
      projectId: 'proj-test-2',
      projectName: 'Frontend Dashboard',
    }),
  ],
  total: 3,
};

const MANY_CHATS = {
  sessions: Array.from({ length: 18 }, (_, i) =>
    makeSession({
      id: `sess-${i + 1}`,
      topic: `Conversation about feature number ${i + 1} and its edge cases`,
    }),
  ),
  total: 18,
};

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

interface MockOptions {
  projects?: Array<{ id: string; name: string }>;
  chats?: { sessions: unknown[]; total: number };
}

async function setupMocks(page: Page, options: MockOptions = {}) {
  const { projects = NORMAL_PROJECTS, chats = NORMAL_CHATS } = options;

  await setupAuditRoutes(page, (path, respond) => {
    if (path.includes('/api/auth/')) return respond(200, SUPERADMIN);
    if (path === '/api/projects') return respond(200, { projects });
    if (path === '/api/nodes') return respond(200, []);
    if (path === '/api/chats') return respond(200, chats);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/credentials') return respond(200, []);
    if (path === '/api/agents') return respond(200, []);
    if (path.includes('/sessions')) return respond(200, { sessions: [], total: 0 });
    if (path.includes('/tasks')) return respond(200, { tasks: [], total: 0 });
    // Everything else falls through to an empty 200 so the page never hangs.
    return undefined;
  });
}

/**
 * Opens the global command palette via the keyboard shortcut. Playwright's
 * Chromium runs on Linux, so navigator.platform is not "mac" and the palette
 * listens for Ctrl+K (see useGlobalCommandPalette). Waits for the portaled
 * dialog before returning.
 */
async function openPalette(page: Page) {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[role="dialog"][aria-label="Command palette"]', {
    timeout: 5000,
  });
  // Let the async project/node/chat fetches settle so all categories render.
  await page.waitForTimeout(400);
}

async function gotoApp(page: Page, path: string) {
  await seedTheme(page, 'dark');
  await page.goto(path);
  // The AppShell must mount (it owns the Ctrl+K listener). The sidebar trigger
  // is a stable marker that the shell rendered.
  await page.waitForSelector('button[aria-label="Open command palette"], header', {
    timeout: 8000,
  });
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Shared scenario bodies — each is run once per viewport (mobile + desktop).
// Keeping the bodies here (rather than copy-pasted into both describe blocks)
// avoids duplicated audit logic.
// ---------------------------------------------------------------------------

async function auditGlobalCommands(page: Page, suffix: string) {
  await setupMocks(page);
  await gotoApp(page, '/dashboard');
  await openPalette(page);
  await screenshot(page, `command-palette-global-${suffix}`);
  await assertNoOverflow(page);
}

async function auditContextActions(page: Page, suffix: string) {
  await setupMocks(page);
  await gotoApp(page, '/projects/proj-test-1/chat');
  await openPalette(page);
  await expect(page.locator('#gcp-category-Context')).toBeVisible();
  await screenshot(page, `command-palette-context-${suffix}`);
  await assertNoOverflow(page);
}

async function auditLongProjectName(page: Page, suffix: string) {
  await setupMocks(page, { projects: LONG_TEXT_PROJECTS });
  await gotoApp(page, '/projects/proj-test-1/chat');
  await openPalette(page);
  await screenshot(page, `command-palette-long-text-${suffix}`);
  await assertNoOverflow(page);
}

async function auditManyChats(page: Page, suffix: string) {
  await setupMocks(page, { chats: MANY_CHATS });
  await gotoApp(page, '/projects/proj-test-1/chat');
  await openPalette(page);
  await screenshot(page, `command-palette-many-chats-${suffix}`);
  await assertNoOverflow(page);
}

async function auditFilteredQuery(page: Page, query: string, screenshotName: string) {
  await setupMocks(page);
  await gotoApp(page, '/dashboard');
  await openPalette(page);
  await page.fill('[role="combobox"]', query);
  await page.waitForTimeout(200);
  await screenshot(page, screenshotName);
  await assertNoOverflow(page);
}

// ---------------------------------------------------------------------------
// Tests — Mobile (default project: 375x667)
// ---------------------------------------------------------------------------

test.describe('Command Palette — Mobile', () => {
  test('global commands on dashboard (superadmin)', ({ page }) =>
    auditGlobalCommands(page, 'mobile'));

  test('context actions inside a project', ({ page }) =>
    auditContextActions(page, 'mobile'));

  test('long project name does not overflow', ({ page }) =>
    auditLongProjectName(page, 'mobile'));

  test('many chats', ({ page }) => auditManyChats(page, 'mobile'));

  test('filtered query (settings)', ({ page }) =>
    auditFilteredQuery(page, 'settings', 'command-palette-filtered-mobile'));
});

// ---------------------------------------------------------------------------
// Tests — Desktop (1280x800)
// ---------------------------------------------------------------------------

test.describe('Command Palette — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('global commands on dashboard (superadmin)', ({ page }) =>
    auditGlobalCommands(page, 'desktop'));

  test('context actions inside a project', ({ page }) =>
    auditContextActions(page, 'desktop'));

  test('long project name does not overflow', ({ page }) =>
    auditLongProjectName(page, 'desktop'));

  test('many chats', ({ page }) => auditManyChats(page, 'desktop'));

  test('filtered query (admin)', ({ page }) =>
    auditFilteredQuery(page, 'admin', 'command-palette-filtered-admin-desktop'));
});
