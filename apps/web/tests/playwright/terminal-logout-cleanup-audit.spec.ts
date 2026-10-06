import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, getProjectSuffix, jsonResponse, makeMockUser, screenshot } from './audit-helpers';

const USER_A = makeMockUser({
  email: 'user-a@example.com',
  name: 'User A',
  sessionId: 'session-user-a',
  userId: 'user-a-id',
});

const MOCK_PROJECT = {
  id: 'proj-terminal-audit',
  name: 'Terminal Audit Project',
  repoUrl: 'https://github.com/test/audit',
  repoName: 'test/audit',
  repoProvider: 'github',
  installationId: 'inst-1',
  defaultProvider: 'hetzner',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  defaultNodeSize: 'cpx21',
  defaultAgentType: 'claude-code',
};

let currentUser: ReturnType<typeof makeMockUser> | null = USER_A;

async function setupMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);

    if (path.includes('/api/auth/get-session') || path.includes('/api/auth/session')) {
      if (currentUser) return respond(200, currentUser);
      return respond(200, { session: null, user: null });
    }
    if (path === '/api/auth/sign-out') {
      currentUser = null;
      return respond(200, { success: true });
    }
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/projects') {
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    }
    if (path.startsWith('/api/chats')) {
      return respond(200, { sessions: [], totalActive: 0 });
    }
    if (path.includes('/api/dashboard/active-tasks')) {
      return respond(200, { tasks: [] });
    }
    if (path.includes('/api/credentials')) {
      return respond(200, { credentials: [] });
    }
    if (path.includes('/api/github/installations')) {
      return respond(200, { installations: [] });
    }
    if (path.includes('/api/config/login-providers')) {
      return respond(200, { github: true, google: false, gitlab: false });
    }
    if (path.includes('/api/report-issue/config')) {
      return respond(200, { enabled: false });
    }

    return respond(200, {});
  });
}

function seedTerminalKeys(page: Page) {
  return page.evaluate(() => {
    sessionStorage.setItem(
      'sam-terminal-sessions-ws-terminal-audit',
      JSON.stringify({
        sessions: [{ name: 'Terminal 1', order: 0, serverSessionId: 's1' }],
        counter: 2,
        wsUrl: 'wss://ws-terminal-audit.sammy.party/terminal/ws/multi?token=deterministic-test-token',
      })
    );
    sessionStorage.setItem(
      'sam-terminal-sessions-ws-other',
      JSON.stringify({ sessions: [], counter: 1 })
    );
    sessionStorage.setItem('unrelated-key', 'should-persist');
  });
}

function getSessionStorageSnapshot(page: Page) {
  return page.evaluate(() => {
    const result: Record<string, string | null> = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key) result[key] = sessionStorage.getItem(key);
    }
    return result;
  });
}

function checkForTokenLeaks(page: Page, tokenSubstring: string) {
  return page.evaluate((tok) => {
    const leaks: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      const value = sessionStorage.getItem(key) ?? '';
      if (value.includes(tok)) leaks.push(`sessionStorage[${key}]`);
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      const value = localStorage.getItem(key) ?? '';
      if (value.includes(tok)) leaks.push(`localStorage[${key}]`);
    }
    return leaks;
  }, tokenSubstring);
}

/**
 * Execute sign-out using the viewport-appropriate control.
 * Mobile (<768px): hamburger → drawer → "Sign out".
 * Desktop/Tablet (>=768px): "User menu" button → dropdown → "Sign out".
 *
 * Assertions are non-optional — if the sign-out control is not found,
 * the test fails rather than silently passing.
 */
async function executeSignOut(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  const isMobileWidth = viewport ? viewport.width < 768 : false;

  if (isMobileWidth) {
    // Mobile: open the navigation drawer first
    const hamburger = page.getByRole('button', { name: /open navigation menu/i });
    await expect(hamburger).toBeVisible({ timeout: 5000 });
    await hamburger.click();
    await page.waitForTimeout(300);
  }
  // Both mobile (drawer) and desktop (sidebar) expose a "Sign out" button directly
  const signOutButton = page.getByRole('button', { name: /sign out/i });
  await expect(signOutButton).toBeVisible({ timeout: 5000 });
  await signOutButton.click();
}

test.describe('Terminal logout cleanup — baseline', () => {
  test.beforeEach(() => {
    currentUser = USER_A;
  });

  test('dashboard renders without console errors after terminal cleanup changes', async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await setupMocks(page);
    await page.goto('/');
    await page.waitForTimeout(1500);

    await screenshot(page, `terminal-dashboard-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);

    const terminalCleanupErrors = consoleErrors.filter((e) =>
      e.includes('terminal-cleanup')
    );
    expect(terminalCleanupErrors).toEqual([]);
  });

  test('no terminal token data persists in DOM after fresh authenticated load', async ({
    page,
  }, testInfo) => {
    await setupMocks(page);
    await page.goto('/');
    await page.waitForTimeout(1000);

    const domLeaks = await page.evaluate(() => {
      const body = document.body?.innerHTML ?? '';
      return body.includes('deterministic-test-token') || body.includes('?token=');
    });
    expect(domLeaks).toBe(false);

    await screenshot(page, `terminal-no-dom-tokens-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });

  test('no network requests to terminal token endpoints when unauthenticated', async ({
    page,
  }, testInfo) => {
    currentUser = null;
    const tokenRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/terminal/token')) {
        tokenRequests.push(req.url());
      }
    });

    await setupMocks(page);
    await page.goto('/');
    await page.waitForTimeout(2000);

    expect(tokenRequests).toEqual([]);

    await screenshot(page, `terminal-no-unauth-requests-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });

  test('sessionStorage sam-terminal-sessions-* keys use the shared prefix constant', async ({
    page,
  }, testInfo) => {
    await setupMocks(page);
    await page.goto('/');
    await page.waitForTimeout(500);

    await seedTerminalKeys(page);

    const snapshot = await getSessionStorageSnapshot(page);
    const terminalKeys = Object.keys(snapshot).filter((k) =>
      k.startsWith('sam-terminal-sessions-')
    );
    expect(terminalKeys.length).toBe(2);
    expect(terminalKeys).toContain('sam-terminal-sessions-ws-terminal-audit');
    expect(terminalKeys).toContain('sam-terminal-sessions-ws-other');
    expect(snapshot['unrelated-key']).toBe('should-persist');

    await screenshot(page, `terminal-storage-prefix-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });
});

test.describe('Terminal logout cleanup — sign-out security (non-optional)', () => {
  test.beforeEach(() => {
    currentUser = USER_A;
  });

  test('sign-out clears terminal sessionStorage keys', async ({ page }, testInfo) => {
    await setupMocks(page);
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Seed bearer-containing terminal data
    await seedTerminalKeys(page);

    // Discriminatory control: verify data IS present before sign-out
    const before = await getSessionStorageSnapshot(page);
    expect(before['sam-terminal-sessions-ws-terminal-audit']).toBeDefined();
    expect(before['sam-terminal-sessions-ws-other']).toBeDefined();

    // Execute sign-out — MUST succeed, not skip
    await executeSignOut(page);

    // Wait for sign-out redirect — the page navigates to '/'
    // sessionStorage is same-origin so persists across navigation
    await page.waitForURL('**/');
    await page.waitForTimeout(500);

    // All terminal session keys MUST be gone
    const afterSignOut = await getSessionStorageSnapshot(page);
    expect(afterSignOut['sam-terminal-sessions-ws-terminal-audit']).toBeUndefined();
    expect(afterSignOut['sam-terminal-sessions-ws-other']).toBeUndefined();

    // Unrelated keys MUST survive
    expect(afterSignOut['unrelated-key']).toBe('should-persist');

    // No token substring leaks
    const leaks = await checkForTokenLeaks(page, 'deterministic-test-token');
    expect(leaks).toEqual([]);

    await screenshot(page, `terminal-signout-cleanup-${getProjectSuffix(testInfo.project.name)}`);
  });

  test('no terminal token data leaks in any storage after sign-out', async ({
    page,
  }, testInfo) => {
    await setupMocks(page);
    await page.goto('/');
    await page.waitForTimeout(1000);

    await seedTerminalKeys(page);
    await executeSignOut(page);
    await page.waitForURL('**/');
    await page.waitForTimeout(500);

    const leaks = await checkForTokenLeaks(page, 'deterministic-test-token');
    expect(leaks).toEqual([]);

    const domLeaks = await page.evaluate(() => {
      return (document.body?.innerHTML ?? '').includes('?token=');
    });
    expect(domLeaks).toBe(false);

    await screenshot(page, `terminal-no-leaks-post-signout-${getProjectSuffix(testInfo.project.name)}`);
  });
});
