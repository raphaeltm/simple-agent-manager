import { test, expect, type Page, type Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECTS = [
  { id: 'proj-1', name: 'Test Project', repository: 'testuser/test-repo', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-20T00:00:00Z', taskCounts: { active: 2, total: 15 }, lastActivityAt: '2026-03-20T10:00:00Z' },
];

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/projects' && !path.includes('/projects/')) return respond(200, { projects: MOCK_PROJECTS });
    if (path.includes('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0, total: 0, hasMore: false });
    if (path.includes('/api/tts/synthesize')) return respond(200, { audioUrl: '/api/tts/audio/mock', summarized: false });
    if (path.includes('/api/tts/audio/')) {
      // Return a minimal valid WAV
      const buffer = Buffer.alloc(44);
      buffer.write('RIFF', 0); buffer.writeUInt32LE(36, 4); buffer.write('WAVE', 8);
      buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
      buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(8000, 28);
      buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34);
      buffer.write('data', 36); buffer.writeUInt32LE(0, 40);
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: buffer });
    }
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

/** Wait for page to fully load (auth redirect -> dashboard) */
async function waitForDashboard(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 });
  // Wait for something that exists in both mobile and desktop
  await page.waitForTimeout(1000);
}

// ---------------------------------------------------------------------------
// Tests — Mobile (375x667)
// ---------------------------------------------------------------------------

test.describe('GlobalAudioPlayer — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('player hidden when no audio is playing', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await waitForDashboard(page);

    // No audio player should be visible
    const player = page.locator('[role="region"][aria-label="Audio player"]');
    await expect(player).toHaveCount(0);

    await screenshot(page, 'global-player-hidden-mobile');
    await assertNoOverflow(page);
  });

  test('dashboard renders correctly on mobile', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await waitForDashboard(page);

    await screenshot(page, 'global-player-dashboard-mobile');
    await assertNoOverflow(page);
  });

  test('no overflow on mobile with content', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await waitForDashboard(page);

    await screenshot(page, 'global-player-with-content-mobile');
    await assertNoOverflow(page);
  });

  test('page navigation does not break layout', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await waitForDashboard(page);

    // Navigate to projects
    await page.goto('/projects');
    await waitForDashboard(page);

    await screenshot(page, 'global-player-projects-mobile');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Tests — Desktop (1280x800)
// ---------------------------------------------------------------------------

test.describe('GlobalAudioPlayer — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('player hidden when no audio is playing', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await waitForDashboard(page);

    const player = page.locator('[role="region"][aria-label="Audio player"]');
    await expect(player).toHaveCount(0);

    await screenshot(page, 'global-player-hidden-desktop');
    await assertNoOverflow(page);
  });

  test('dashboard layout renders correctly on desktop', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await waitForDashboard(page);

    await screenshot(page, 'global-player-dashboard-desktop');
    await assertNoOverflow(page);
  });

  test('no overflow on desktop', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await waitForDashboard(page);

    await screenshot(page, 'global-player-no-overflow-desktop');
    await assertNoOverflow(page);
  });

  test('page navigation does not break layout', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await waitForDashboard(page);

    // Navigate to projects
    await page.goto('/projects');
    await waitForDashboard(page);

    await screenshot(page, 'global-player-projects-desktop');
    await assertNoOverflow(page);
  });
});
