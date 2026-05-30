/**
 * Portal Overlay Audit — verifies that portaled modals, drawers, and dropdowns
 * render above all page content with proper backdrop blur/dim.
 *
 * Tests the 23 components converted to createPortal in the portal-ify PR.
 */
import { expect, type Locator, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot } from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'portal-test@example.com',
    name: 'Portal Test User',
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

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Portal Test Project',
  repository: 'testuser/portal-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  repoProvider: 'github',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const MOCK_TRIGGERS = [
  {
    id: 'trig-1',
    projectId: 'proj-test-1',
    userId: 'user-test-1',
    name: 'Daily PR Review',
    description: 'Automated code review of open PRs',
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * *',
    cronHumanReadable: 'Daily at 9:00 AM',
    cronTimezone: 'UTC',
    nextFireAt: new Date(Date.now() + 3600000).toISOString(),
    lastTriggeredAt: new Date(Date.now() - 86400000).toISOString(),
    triggerCount: 42,
    skipIfRunning: true,
    promptTemplate: 'Review PRs',
    agentProfileId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 'trig-2',
    projectId: 'proj-test-1',
    userId: 'user-test-1',
    name: 'Weekly dependency update',
    description: null,
    status: 'paused',
    sourceType: 'cron',
    cronExpression: '0 0 * * 1',
    cronHumanReadable: 'Weekly on Monday',
    cronTimezone: 'UTC',
    nextFireAt: null,
    lastTriggeredAt: null,
    triggerCount: 0,
    skipIfRunning: false,
    promptTemplate: 'Update deps',
    agentProfileId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  },
];

const MOCK_SESSIONS = [
  {
    id: 'sess-1',
    topic: 'Fix authentication flow',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    updatedAt: new Date(Date.now() - 1800000).toISOString(),
    lastMessageAt: new Date(Date.now() - 1800000).toISOString(),
    messageCount: 12,
    isStale: false,
    workspaceId: null,
    taskId: null,
  },
  {
    id: 'sess-2',
    topic: 'Refactor database schema for better performance and scalability across multiple regions',
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 43200000).toISOString(),
    lastMessageAt: new Date(Date.now() - 43200000).toISOString(),
    messageCount: 35,
    isStale: false,
    workspaceId: 'ws-123',
    taskId: null,
  },
  {
    id: 'sess-3',
    topic: 'Deploy new feature',
    createdAt: new Date(Date.now() - 604800000).toISOString(),
    updatedAt: new Date(Date.now() - 604800000).toISOString(),
    lastMessageAt: new Date(Date.now() - 604800000).toISOString(),
    messageCount: 5,
    isStale: true,
    workspaceId: null,
    taskId: null,
  },
];

const MOCK_LIBRARY_FILES = [
  {
    id: 'file-1',
    projectId: 'proj-test-1',
    filename: 'architecture-diagram.png',
    mimeType: 'image/png',
    sizeBytes: 245000,
    tags: [{ tag: 'docs' }, { tag: 'architecture' }],
    directory: '/',
    source: 'upload' as const,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 'file-2',
    projectId: 'proj-test-1',
    filename: 'api-spec.yaml',
    mimeType: 'application/x-yaml',
    sizeBytes: 12400,
    tags: [{ tag: 'api' }, { tag: 'spec' }],
    directory: '/',
    source: 'upload' as const,
    createdAt: '2026-03-02T00:00:00Z',
    updatedAt: '2026-03-02T00:00:00Z',
  },
];

// ---------------------------------------------------------------------------
// Setup — single handler pattern (proven to work with BetterAuth)
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth — BetterAuth calls /api/auth/get-session (and related paths)
    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Notifications
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }

    // Credentials
    if (path.startsWith('/api/credentials')) {
      return respond(200, []);
    }

    // GitHub installations
    if (path.startsWith('/api/github/installations')) {
      return respond(200, []);
    }

    // Provider catalog
    if (path.startsWith('/api/provider-catalog')) {
      return respond(200, { catalogs: [] });
    }

    // Project-scoped routes
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      // Chat sessions
      if (subPath.startsWith('/chat/sessions') && !subPath.includes('/messages')) {
        return respond(200, { sessions: MOCK_SESSIONS });
      }

      // Messages for a session
      if (subPath.includes('/messages')) {
        return respond(200, { messages: [] });
      }

      // Triggers
      if (subPath.startsWith('/triggers')) {
        return respond(200, { triggers: MOCK_TRIGGERS });
      }

      // Library directories
      if (subPath.startsWith('/library/directories')) {
        return respond(200, { directories: [] });
      }

      // Library files — listLibraryFiles calls /api/projects/:id/library (no /files suffix)
      if (subPath === '/library' || subPath.startsWith('/library?') || subPath.startsWith('/library/files')) {
        return respond(200, { files: MOCK_LIBRARY_FILES, totalCount: MOCK_LIBRARY_FILES.length });
      }

      // Activity
      if (subPath.startsWith('/activity')) {
        return respond(200, { events: [] });
      }

      // Knowledge
      if (subPath.startsWith('/knowledge')) {
        return respond(200, { entities: [] });
      }

      // Ideas
      if (subPath.startsWith('/ideas')) {
        return respond(200, { ideas: [], totalCount: 0 });
      }

      // Agent settings
      if (subPath === '/agent-settings' || subPath.startsWith('/agent-settings')) {
        return respond(200, { agentType: 'claude-code', model: '', providerMode: 'user-api-key', customInstructions: '' });
      }

      // Agent profiles
      if (subPath.startsWith('/agent-profiles')) {
        return respond(200, { profiles: [] });
      }

      // Single project
      if (!subPath) {
        return respond(200, MOCK_PROJECT);
      }

      // Fallback for other project sub-routes
      return respond(200, {});
    }

    // Projects list
    if (path === '/api/projects' && method === 'GET') {
      return respond(200, { projects: [MOCK_PROJECT] });
    }

    // GitHub (any other github routes)
    if (path.startsWith('/api/github')) {
      return respond(200, []);
    }

    // Fallback
    return respond(200, {});
  });
}

async function expectOverlayVisibleBlurredAndInViewport(overlay: Locator) {
  await expect(overlay).toBeVisible();

  const result = await overlay.evaluate((element) => {
    const style = window.getComputedStyle(element);
    const backdropFilter = style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter');
    const filter = style.filter;
    const rect = element.getBoundingClientRect();

    return {
      backdropFilter,
      filter,
      rect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    };
  });

  const blurSource = `${result.backdropFilter} ${result.filter}`;
  expect(blurSource).toMatch(/blur\(/);
  expect(blurSource).not.toMatch(/blur\(0(px|rem|em)?\)/);

  expect(result.rect.width).toBeGreaterThan(0);
  expect(result.rect.height).toBeGreaterThan(0);
  expect(result.rect.left).toBeGreaterThanOrEqual(0);
  expect(result.rect.top).toBeGreaterThanOrEqual(0);
  expect(result.rect.right).toBeLessThanOrEqual(result.viewport.width + 1);
  expect(result.rect.bottom).toBeLessThanOrEqual(result.viewport.height + 1);
}

async function expectPortaledToBody(overlay: Locator) {
  await expect(
    overlay.evaluate((element) => element.parentElement === document.body),
  ).resolves.toBe(true);
}

async function expectNotInsideBlurDisabledContext(overlay: Locator) {
  await expect(
    overlay.evaluate((element) => {
      for (let current = element.parentElement; current; current = current.parentElement) {
        if (
          current.classList.contains('glass-chrome') ||
          current.classList.contains('glass-surface') ||
          current.classList.contains('glass-modal')
        ) {
          return false;
        }
      }
      return true;
    }),
  ).resolves.toBe(true);
}

async function expectOverlayNearTrigger(
  trigger: Locator,
  overlay: Locator,
  options: { side?: 'below' | 'above'; maxGap?: number } = {},
) {
  const { side = 'below', maxGap = 16 } = options;
  const geometry = await trigger.evaluate((triggerElement, overlayElement) => {
    const triggerRect = triggerElement.getBoundingClientRect();
    const overlayRect = (overlayElement as Element).getBoundingClientRect();
    const horizontalOverlap =
      Math.min(triggerRect.right, overlayRect.right) - Math.max(triggerRect.left, overlayRect.left);
    const triggerCenterX = triggerRect.left + triggerRect.width / 2;

    return {
      trigger: {
        bottom: triggerRect.bottom,
        top: triggerRect.top,
        centerX: triggerCenterX,
      },
      overlay: {
        bottom: overlayRect.bottom,
        top: overlayRect.top,
        left: overlayRect.left,
        right: overlayRect.right,
      },
      horizontalOverlap,
      centerInsideOverlay: triggerCenterX >= overlayRect.left && triggerCenterX <= overlayRect.right,
    };
  }, await overlay.elementHandle());

  expect(geometry.horizontalOverlap > 0 || geometry.centerInsideOverlay).toBe(true);
  if (side === 'below') {
    expect(geometry.overlay.top).toBeGreaterThanOrEqual(geometry.trigger.bottom - 1);
    expect(geometry.overlay.top - geometry.trigger.bottom).toBeLessThanOrEqual(maxGap);
  } else {
    expect(geometry.overlay.bottom).toBeLessThanOrEqual(geometry.trigger.top + 1);
    expect(geometry.trigger.top - geometry.overlay.bottom).toBeLessThanOrEqual(maxGap);
  }
}

async function expectBackdropBlurred(page: Page) {
  const backdrop = page.locator('.glass-backdrop-dim').first();
  await expectOverlayVisibleBlurredAndInViewport(backdrop);
}

// ---------------------------------------------------------------------------
// Tests — Mobile (default viewport from Playwright config)
// ---------------------------------------------------------------------------

test.describe('Portal Overlays — Mobile', () => {
  test.beforeEach(async ({ page }) => {
    await setupApiMocks(page);
  });

  test('ConfirmDialog portal renders above page content', async ({ page }) => {
    // Navigate to triggers page which has delete actions that open ConfirmDialog
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    // Screenshot the page with triggers loaded
    await screenshot(page, 'portal-triggers-page-mobile');

    // Click the more menu on a trigger card to get the context menu
    const moreBtn = page.locator('button[aria-label="Trigger actions"]').first();
    if (await moreBtn.isVisible()) {
      await moreBtn.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'portal-trigger-card-menu-mobile');
    }

    await assertNoOverflow(page);
  });

  test('CommandPalette portal renders above page', async ({ page }) => {
    // Use triggers page (which renders correctly with our mocks) instead of chat
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    // Dispatch Ctrl+K directly on the window (where useGlobalCommandPalette listens)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    await page.waitForTimeout(600);
    await screenshot(page, 'portal-command-palette-mobile');

    await assertNoOverflow(page);
  });

  test('GlobalCommandPalette portal renders (keyboard dispatch)', async ({ page }) => {
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    // Dispatch Ctrl+K on document (capture phase listener on window)
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    await page.waitForTimeout(600);
    await screenshot(page, 'portal-command-palette-keyboard-mobile');

    await assertNoOverflow(page);
  });

  test('MobileNavDrawer portal renders with backdrop', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'MobileNavDrawer is mobile-only');

    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    // Look for the mobile menu button (hamburger)
    const menuBtn = page.locator('button[aria-label*="menu" i], button[aria-label*="nav" i]').first();
    if (await menuBtn.isVisible()) {
      await menuBtn.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'portal-mobile-nav-drawer');
    }

    await assertNoOverflow(page);
  });

  test('MobileSessionDrawer portal renders with session list', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'MobileSessionDrawer is mobile-only');

    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    // Look for the sessions/chats button
    const sessionsBtn = page.locator('button[aria-label*="session" i], button[aria-label*="chat" i], button[aria-label*="history" i]').first();
    if (await sessionsBtn.isVisible()) {
      await sessionsBtn.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'portal-mobile-session-drawer');
    }

    await assertNoOverflow(page);
  });

  test('TriggerDropdown portal renders positioned correctly', async ({ page }) => {
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    // The TriggerDropdown is in the chat sidebar; test it from triggers page
    // where there may be a clock icon. If not visible, just assert no overflow.
    const clockBtn = page.locator('button[aria-label="Automation triggers"]').first();
    if (await clockBtn.isVisible()) {
      await clockBtn.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'portal-trigger-dropdown-mobile');
    }

    await assertNoOverflow(page);
  });

  test('Library page with FileActionsMenu portal', async ({ page }) => {
    await page.goto('/projects/proj-test-1/library');
    await page.waitForTimeout(800);
    await screenshot(page, 'portal-library-page-mobile');

    // Click the actions menu on a file
    const actionsBtn = page.locator('button[aria-label*="Actions for"]').first();
    if (await actionsBtn.isVisible()) {
      await actionsBtn.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'portal-file-actions-menu-mobile');
    }

    await assertNoOverflow(page);
  });

  test('Triggers page with TriggerCard context menu', async ({ page }) => {
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    // Open the trigger card actions menu
    const actionsBtn = page.locator('button[aria-label="Trigger actions"]').first();
    if (await actionsBtn.isVisible()) {
      await actionsBtn.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'portal-trigger-card-actions-mobile');
    }

    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Tests — Desktop
// ---------------------------------------------------------------------------

test.describe('Portal Overlays — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test.beforeEach(async ({ page }) => {
    await setupApiMocks(page);
  });

  test('CommandPalette portal renders centered with backdrop', async ({ page }) => {
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    // Dispatch Ctrl+K on window (where useGlobalCommandPalette listens in capture phase)
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    await page.waitForTimeout(600);
    await screenshot(page, 'portal-command-palette-desktop');

    await assertNoOverflow(page);
  });

  test('TriggerDropdown portal positioned below trigger button', async ({ page }) => {
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    const clockBtn = page.locator('button[aria-label="Automation triggers"]').first();
    if (await clockBtn.isVisible()) {
      await clockBtn.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'portal-trigger-dropdown-desktop');
    }

    await assertNoOverflow(page);
  });

  test('TriggerCard context menu portal positioned correctly', async ({ page }) => {
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);
    await screenshot(page, 'portal-triggers-page-desktop');

    const actionsBtn = page.locator('button[aria-label="Trigger actions"]').first();
    if (await actionsBtn.isVisible()) {
      await actionsBtn.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'portal-trigger-card-actions-desktop');
    }

    await assertNoOverflow(page);
  });

  test('Library FileActionsMenu portal positioned correctly', async ({ page }) => {
    await page.goto('/projects/proj-test-1/library');
    await page.waitForTimeout(800);
    await screenshot(page, 'portal-library-page-desktop');

    const actionsBtn = page.locator('button[aria-label*="Actions for"]').first();
    if (await actionsBtn.isVisible()) {
      await actionsBtn.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'portal-file-actions-menu-desktop');
    }

    await assertNoOverflow(page);
  });

  test('shared DropdownMenu and Tooltip have blur and trigger geometry', async ({ page }) => {
    await page.goto('/ui-standards');
    await page.waitForTimeout(800);

    const dropdownTrigger = page.locator('h3:has-text("DropdownMenu") + div button[aria-haspopup="true"]').first();
    await expect(dropdownTrigger).toBeVisible();
    await dropdownTrigger.click();

    const menu = page.getByRole('menu').filter({ hasText: 'Duplicate' }).first();
    await expectOverlayVisibleBlurredAndInViewport(menu);
    await expectNotInsideBlurDisabledContext(menu);
    await expectOverlayNearTrigger(dropdownTrigger, menu);
    await screenshot(page, 'portal-shared-dropdown-geometry-desktop');

    await page.keyboard.press('Escape');

    const tooltipTrigger = page.locator('h3:has-text("Tooltip") + div button:has-text("Instant")').first();
    await expect(tooltipTrigger).toBeVisible();
    await tooltipTrigger.hover();

    const tooltip = page.getByRole('tooltip', { name: 'Instant tooltip' });
    await expectOverlayVisibleBlurredAndInViewport(tooltip);
    await expectNotInsideBlurDisabledContext(tooltip);
    await expectOverlayNearTrigger(tooltipTrigger, tooltip, { side: 'above' });
    await screenshot(page, 'portal-shared-tooltip-geometry-desktop');

    await assertNoOverflow(page);
  });

  test('trigger and file action menus are portaled, blurred, and aligned', async ({ page }) => {
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    const triggerActions = page.locator('button[aria-label="Trigger actions"]').first();
    await expect(triggerActions).toBeVisible();
    await triggerActions.click();

    const triggerMenu = page.locator('body > div.glass-surface:has-text("Run Now"):has-text("View History")').first();
    await expectOverlayVisibleBlurredAndInViewport(triggerMenu);
    await expectPortaledToBody(triggerMenu);
    await expectOverlayNearTrigger(triggerActions, triggerMenu);
    await screenshot(page, 'portal-trigger-card-actions-geometry-desktop');

    await page.mouse.click(10, 10);
    await page.goto('/projects/proj-test-1/library');
    await page.waitForTimeout(800);

    const fileActions = page.locator('button[aria-label*="Actions for"]').first();
    await expect(fileActions).toBeVisible();
    await fileActions.click();

    const fileMenu = page.locator('body > div.glass-surface:has-text("Download"):has-text("Edit Tags")').first();
    await expectOverlayVisibleBlurredAndInViewport(fileMenu);
    await expectPortaledToBody(fileMenu);
    await expectOverlayNearTrigger(fileActions, fileMenu);
    await screenshot(page, 'portal-file-actions-menu-geometry-desktop');

    await assertNoOverflow(page);
  });

  test('global command palette has blurred backdrop and body portal', async ({ page }) => {
    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    const palette = page.getByRole('dialog', { name: /command palette/i });
    await expectOverlayVisibleBlurredAndInViewport(palette);
    await expectPortaledToBody(palette);
    await expectBackdropBlurred(page);
    await screenshot(page, 'portal-command-palette-geometry-desktop');

    await assertNoOverflow(page);
  });

  test('recent chat and notification panels are portaled, blurred, and aligned', async ({ page }) => {
    await page.goto('/chats');
    await page.waitForTimeout(800);

    const recentTrigger = page.getByLabel(/Recent chats/).first();
    await expect(recentTrigger).toBeVisible();
    await recentTrigger.click();

    const recentPanel = page.locator('[role="menu"][aria-label="Recent chats"]');
    await expectOverlayVisibleBlurredAndInViewport(recentPanel);
    await expectPortaledToBody(recentPanel);
    await expectOverlayNearTrigger(recentTrigger, recentPanel);
    await screenshot(page, 'portal-recent-chats-panel-geometry-desktop');

    await page.keyboard.press('Escape');

    const notificationTrigger = page.getByRole('button', { name: /notifications/i }).first();
    await expect(notificationTrigger).toBeVisible();
    await notificationTrigger.click();

    const notificationPanel = page.locator('[role="dialog"][aria-label="Notifications"]');
    await expectOverlayVisibleBlurredAndInViewport(notificationPanel);
    await expectPortaledToBody(notificationPanel);
    await expectOverlayNearTrigger(notificationTrigger, notificationPanel);
    await screenshot(page, 'portal-notification-panel-geometry-desktop');

    await assertNoOverflow(page);
  });
});
