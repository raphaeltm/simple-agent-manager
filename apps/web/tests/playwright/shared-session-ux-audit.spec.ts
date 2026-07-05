import { expect, type Page, type Route, test } from '@playwright/test';

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'alice@example.com',
    name: 'Alice',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'auth-session-test',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Shared Project',
  repository: 'team/shared-repo',
  defaultBranch: 'main',
  userId: 'owner-user',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  defaultLocation: null,
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: null,
  multiplayerActive: true,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const NOW = Date.now();

function makeSession(index: number, mine: boolean) {
  const userId = mine ? 'user-test-1' : 'user-test-2';
  return {
    id: index === 0 ? 'session-mine-1' : index === 1 ? 'session-bob-1' : `session-${index}`,
    workspaceId: null,
    taskId: index % 2 === 0 ? `task-${index}` : null,
    createdByUserId: userId,
    createdBy: mine
      ? { id: 'user-test-1', name: 'Alice', email: 'alice@example.com', image: null, avatarUrl: null }
      : { id: 'user-test-2', name: 'Bob Collaborator', email: 'bob@example.com', image: null, avatarUrl: null },
    isMine: mine,
    topic: index === 1
      ? `Investigate Bob's very long shared session title with unicode ☕ and HTML-ish <safe> content ${'wrap '.repeat(24)}`
      : mine
        ? `Alice session ${index}`
        : `Bob session ${index}`,
    status: index % 5 === 0 ? 'stopped' : 'active',
    messageCount: 12 + index,
    startedAt: NOW - index * 60_000,
    endedAt: index % 5 === 0 ? NOW - index * 30_000 : null,
    createdAt: NOW - index * 60_000,
    lastMessageAt: NOW - index * 30_000,
    agentCompletedAt: null,
    isIdle: false,
    isTerminated: index % 5 === 0,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: null,
    agentType: 'openai-codex',
  };
}

const ALL_SESSIONS = Array.from({ length: 34 }, (_, index) => makeSession(index, index % 3 !== 1));
const MY_SESSIONS = ALL_SESSIONS.filter((session) => session.isMine);
const MESSAGES = [
  { id: 'msg-1', sessionId: 'session-bob-1', role: 'user', content: 'Can you inspect this shared workflow?', toolMetadata: null, createdAt: NOW - 3000 },
  { id: 'msg-2', sessionId: 'session-bob-1', role: 'assistant', content: 'I checked the shared state and left notes for the team.', toolMetadata: null, createdAt: NOW - 2000 },
];

async function setupApiMocks(page: Page, options: { multiplayerActive?: boolean } = {}) {
  const mockProject = {
    ...MOCK_PROJECT,
    multiplayerActive: options.multiplayerActive ?? MOCK_PROJECT.multiplayerActive,
  };

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/agents') return respond(200, { agents: [{ id: 'openai-codex', name: 'Codex', configured: true, supportsAcp: true }] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/workspaces') return respond(200, []);

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/sessions') {
        const sessions = url.searchParams.get('scope') === 'my' ? MY_SESSIONS : ALL_SESSIONS;
        return respond(200, { sessions, total: sessions.length, hasMore: false });
      }
      const sessionDetailMatch = subPath.match(/^\/sessions\/([^/]+)$/);
      if (sessionDetailMatch) {
        const session = ALL_SESSIONS.find((candidate) => candidate.id === sessionDetailMatch[1]) ?? ALL_SESSIONS[0];
        return respond(200, { session, messages: MESSAGES, hasMore: false, state: null });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) return respond(200, { messages: MESSAGES, hasMore: false });
      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
      if (subPath === '/agent-profiles') return respond(200, { items: [{ id: 'profile-1', name: 'Codex', agentType: 'openai-codex', taskMode: 'task' }] });
      if (subPath.match(/\/commands/)) return respond(200, { commands: [] });
      return respond(200, mockProject);
    }

    if (path === '/api/projects') return respond(200, { projects: [mockProject], nextCursor: null });
    return respond(200, {});
  });
}

async function capture(page: Page, name: string) {
  await page.waitForTimeout(600);
  const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasOverflow).toBe(false);
  await page.screenshot({ path: `../../.codex/tmp/playwright-screenshots/${name}.png`, fullPage: true });
}

test.describe('shared project session UX', () => {
  test('desktop renders owner labels, filter, and read-only composer', async ({ page }) => {
    test.setTimeout(30_000);
    await setupApiMocks(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/projects/proj-test-1/chat/session-bob-1');

    await expect(page.getByRole('button', { name: 'All sessions' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Bob Collaborator').first()).toBeVisible();
    await expect(page.getByText('Read-only session')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();

    const sessionNav = page.getByRole('navigation', { name: 'Chat sessions' });
    await page.getByRole('button', { name: 'My sessions' }).click();
    await expect(sessionNav.getByText('Bob Collaborator').first()).not.toBeVisible();
    await expect(sessionNav.getByText('You').first()).toBeVisible();
    await capture(page, 'shared-session-ux-desktop');
  });

  test('desktop hides multiplayer controls and owner labels for solo projects', async ({ page }) => {
    test.setTimeout(30_000);
    await setupApiMocks(page, { multiplayerActive: false });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/projects/proj-test-1/chat/session-bob-1');

    await expect(page.getByRole('button', { name: 'All sessions' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'My sessions' })).toHaveCount(0);
    const sessionNav = page.getByRole('navigation', { name: 'Chat sessions' });
    await expect(sessionNav.getByText('Bob Collaborator')).toHaveCount(0);
    await expect(sessionNav.getByText('You')).toHaveCount(0);
    await expect(page.getByText('Read-only session')).toBeVisible();
    await capture(page, 'solo-session-ux-desktop');
  });

  test('mobile drawer keeps filter and owner labels usable', async ({ page }) => {
    test.setTimeout(30_000);
    await setupApiMocks(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/projects/proj-test-1/chat/session-bob-1');

    await page.getByRole('button', { name: 'Open chat list' }).click();
    await expect(page.getByRole('dialog', { name: 'Chat sessions' })).toBeVisible();
    const dialog = page.getByRole('dialog', { name: 'Chat sessions' });
    await expect(page.getByRole('button', { name: 'All sessions' })).toBeVisible();
    await expect(dialog.getByText('Bob Collaborator').first()).toBeVisible();
    await page.getByRole('button', { name: 'My sessions' }).click();
    await expect(dialog.getByText('Bob Collaborator').first()).not.toBeVisible();
    await capture(page, 'shared-session-ux-mobile');
  });

  test('mobile drawer hides multiplayer controls and owner labels for solo projects', async ({ page }) => {
    test.setTimeout(30_000);
    await setupApiMocks(page, { multiplayerActive: false });
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/projects/proj-test-1/chat/session-bob-1');

    await page.getByRole('button', { name: 'Open chat list' }).click();
    const dialog = page.getByRole('dialog', { name: 'Chat sessions' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'All sessions' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'My sessions' })).toHaveCount(0);
    await expect(dialog.getByText('Bob Collaborator')).toHaveCount(0);
    await expect(dialog.getByText('You')).toHaveCount(0);
    await capture(page, 'solo-session-ux-mobile');
  });
});
