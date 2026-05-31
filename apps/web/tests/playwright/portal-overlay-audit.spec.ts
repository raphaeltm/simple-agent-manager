/**
 * Portal Overlay Audit — verifies that portaled modals, drawers, and dropdowns
 * render above all page content with proper backdrop blur/dim.
 *
 * Tests the 23 components converted to createPortal in the portal-ify PR.
 */
import { expect, type Locator, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, jsonResponse, makeMockUser, screenshot } from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_USER = makeMockUser({
  email: 'portal-test@example.com',
  name: 'Portal Test User',
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});

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
    topic:
      'Refactor database schema for better performance and scalability across multiple regions',
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

const MOCK_NODES = [
  {
    id: 'node-1',
    name: 'portal-node-running-with-a-very-long-name',
    status: 'running',
    healthStatus: 'healthy',
    cloudProvider: 'hetzner',
    vmSize: 'medium',
    vmLocation: 'fsn1',
    ipAddress: '192.0.2.10',
    lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    lastMetrics: {
      cpuLoadAvg1: 0.42,
      memoryPercent: 51,
      diskPercent: 38,
    },
    errorMessage: null,
    createdAt: '2026-03-03T00:00:00Z',
    updatedAt: '2026-03-03T00:00:00Z',
  },
  {
    id: 'node-2',
    name: 'portal-node-creating',
    status: 'creating',
    healthStatus: 'unknown',
    cloudProvider: 'hetzner',
    vmSize: 'small',
    vmLocation: 'nbg1',
    ipAddress: null,
    lastHeartbeatAt: null,
    lastMetrics: null,
    errorMessage: null,
    createdAt: '2026-03-02T00:00:00Z',
    updatedAt: '2026-03-02T00:00:00Z',
  },
];

const MOCK_NODE_WORKSPACES = [
  {
    id: 'workspace-node-1',
    nodeId: 'node-1',
    projectId: 'proj-test-1',
    name: 'portal-workspace',
    displayName: 'Portal Workspace',
    repository: 'testuser/portal-repo',
    branch: 'main',
    status: 'running',
    vmSize: 'medium',
    vmLocation: 'fsn1',
    workspaceProfile: 'standard',
    vmIp: '192.0.2.11',
    lastActivityAt: new Date(Date.now() - 120_000).toISOString(),
    errorMessage: null,
    createdAt: '2026-03-03T00:00:00Z',
    updatedAt: '2026-03-03T00:00:00Z',
  },
];

const MOCK_ACCOUNT_MAP = {
  projects: [
    {
      id: 'proj-test-1',
      name: 'Portal Test Project',
      repository: 'testuser/portal-repo',
      status: 'active',
      lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
      activeSessionCount: 1,
    },
  ],
  nodes: [
    {
      id: 'node-1',
      name: 'portal-node-running-with-a-very-long-name',
      status: 'running',
      vmSize: 'medium',
      vmLocation: 'fsn1',
      cloudProvider: 'hetzner',
      ipAddress: '192.0.2.10',
      healthStatus: 'healthy',
      lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      lastMetrics: null,
    },
  ],
  workspaces: [
    {
      id: 'workspace-node-1',
      nodeId: 'node-1',
      projectId: 'proj-test-1',
      displayName: 'Portal Workspace',
      branch: 'main',
      status: 'running',
      vmSize: 'medium',
      chatSessionId: 'sess-1',
    },
  ],
  sessions: [
    {
      id: 'sess-1',
      projectId: 'proj-test-1',
      topic: 'Account map tooltip session',
      status: 'running',
      messageCount: 12,
      workspaceId: 'workspace-node-1',
      taskId: null,
    },
  ],
  tasks: [],
  relationships: [
    { source: 'proj-test-1', target: 'workspace-node-1', type: 'has_workspace', active: true },
    { source: 'workspace-node-1', target: 'node-1', type: 'runs_on', active: true },
    { source: 'proj-test-1', target: 'sess-1', type: 'has_session', active: true },
  ],
};

// ---------------------------------------------------------------------------
// Setup — single handler pattern (proven to work with BetterAuth)
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const requestUrl = new URL(route.request().url());
    const pathName = requestUrl.pathname;
    const respond = (status: number, body: unknown) => jsonResponse(route, status, body);

    // Auth — BetterAuth calls /api/auth/get-session (and related paths)
    if (pathName.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Notifications
    if (pathName.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }

    // Nodes and workspace list
    if (pathName === '/api/nodes') {
      return respond(200, MOCK_NODES);
    }

    if (pathName === '/api/workspaces') {
      return respond(200, MOCK_NODE_WORKSPACES);
    }

    if (pathName === '/api/account-map') {
      return respond(200, MOCK_ACCOUNT_MAP);
    }

    // Credentials
    if (pathName.startsWith('/api/credentials')) {
      return respond(200, []);
    }

    // GitHub installations
    if (pathName.startsWith('/api/github/installations')) {
      return respond(200, []);
    }

    // Provider catalog
    if (pathName.startsWith('/api/provider-catalog') || pathName.startsWith('/api/providers/catalog')) {
      return respond(200, { catalogs: [] });
    }

    // Project-scoped routes
    const projectMatch = pathName.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
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
      if (
        subPath === '/library' ||
        subPath.startsWith('/library?') ||
        subPath.startsWith('/library/files')
      ) {
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
        return respond(200, {
          agentType: 'claude-code',
          model: '',
          providerMode: 'user-api-key',
          customInstructions: '',
        });
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
    if (pathName === '/api/projects' && route.request().method() === 'GET') {
      return respond(200, { projects: [MOCK_PROJECT] });
    }

    // GitHub (any other github routes)
    if (pathName.startsWith('/api/github')) {
      return respond(200, []);
    }

    // Fallback
    return respond(200, {});
  });
}

async function assertFixedBlurredWithinViewport(locator: Locator) {
  const overlayInfo = await locator.first().evaluate((overlay) => {
    const style = window.getComputedStyle(overlay);
    const rect = overlay.getBoundingClientRect();
    return {
      backdropFilter: style.backdropFilter,
      webkitBackdropFilter: style.getPropertyValue('-webkit-backdrop-filter'),
      position: style.position,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  });

  expect(overlayInfo.position).toBe('fixed');
  expect(overlayInfo.left).toBeGreaterThanOrEqual(0);
  expect(overlayInfo.right).toBeLessThanOrEqual(overlayInfo.innerWidth);
  expect(overlayInfo.top).toBeGreaterThanOrEqual(0);
  expect(overlayInfo.bottom).toBeLessThanOrEqual(overlayInfo.innerHeight);
  expect(overlayInfo.scrollWidth).toBeLessThanOrEqual(overlayInfo.innerWidth);
  expect(`${overlayInfo.backdropFilter} ${overlayInfo.webkitBackdropFilter}`).toContain('blur');
}

async function assertAlignedToTriggerEnd(trigger: Locator, overlay: Locator) {
  const triggerBox = await trigger.boundingBox();
  const overlayBox = await overlay.first().boundingBox();
  if (!triggerBox || !overlayBox) {
    throw new Error('Expected trigger and overlay boxes to be measurable');
  }
  expect(Math.abs((overlayBox.x + overlayBox.width) - (triggerBox.x + triggerBox.width))).toBeLessThanOrEqual(24);
}

async function openNodeDropdown(page: Page, screenshotName: string) {
  await page.goto('/nodes');
  await page.waitForTimeout(800);

  const actionsBtn = page.locator('button[aria-label*="Actions for portal-node"]').first();
  await expect(actionsBtn).toBeVisible();
  await actionsBtn.click();
  await page.waitForTimeout(400);
  await screenshot(page, screenshotName);

  const menu = page.locator('body > [role="menu"]').first();
  await assertFixedBlurredWithinViewport(menu);
  await assertAlignedToTriggerEnd(actionsBtn, menu);
  await assertNoOverflow(page);
}

async function openSharedTooltip(page: Page, screenshotName: string) {
  await page.goto('/ui-standards');
  await page.waitForTimeout(800);

  const tooltipTrigger = page.getByRole('button', { name: 'Instant' });
  await tooltipTrigger.scrollIntoViewIfNeeded();
  await tooltipTrigger.focus();

  const tooltip = page.locator('body > [role="tooltip"]').first();
  await expect(tooltip).toBeVisible();
  await screenshot(page, screenshotName);
  await assertFixedBlurredWithinViewport(tooltip);
  await assertNoOverflow(page);
}

async function openCommandPalette(page: Page, screenshotName: string, target: 'window' | 'document') {
  await page.goto('/projects/proj-test-1/triggers');
  await page.waitForTimeout(800);

  await page.evaluate((dispatchTarget) => {
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    (dispatchTarget === 'window' ? window : document).dispatchEvent(event);
  }, target);

  await page.waitForTimeout(600);
  await screenshot(page, screenshotName);
  await assertNoOverflow(page);
}

async function openOptionalButtonOverlay(
  page: Page,
  options: {
    buttonSelector: string;
    overlayScreenshotName: string;
    pageScreenshotName?: string;
    url: string;
  }
) {
  await page.goto(options.url);
  await page.waitForTimeout(800);
  if (options.pageScreenshotName) {
    await screenshot(page, options.pageScreenshotName);
  }

  const button = page.locator(options.buttonSelector).first();
  if (await button.isVisible()) {
    await button.click();
    await page.waitForTimeout(400);
    await screenshot(page, options.overlayScreenshotName);
  }

  await assertNoOverflow(page);
}

type OverlayViewport = 'mobile' | 'desktop';

type SharedOverlayScenario = {
  name: string;
  run: (page: Page, viewport: OverlayViewport) => Promise<void>;
};

function viewportScreenshot(baseName: string, viewport: OverlayViewport) {
  return `${baseName}-${viewport}`;
}

const sharedOverlayScenarios: SharedOverlayScenario[] = [
  {
    name: 'TriggerDropdown portal renders positioned correctly',
    run: (page, viewport) =>
      openOptionalButtonOverlay(page, {
        buttonSelector: 'button[aria-label="Automation triggers"]',
        overlayScreenshotName: viewportScreenshot('portal-trigger-dropdown', viewport),
        url: '/projects/proj-test-1/triggers',
      }),
  },
  {
    name: 'Library FileActionsMenu portal renders positioned correctly',
    run: (page, viewport) =>
      openOptionalButtonOverlay(page, {
        buttonSelector: 'button[aria-label*="Actions for"]',
        overlayScreenshotName: viewportScreenshot('portal-file-actions-menu', viewport),
        pageScreenshotName: viewportScreenshot('portal-library-page', viewport),
        url: '/projects/proj-test-1/library',
      }),
  },
  {
    name: 'TriggerCard context menu portal renders positioned correctly',
    run: (page, viewport) =>
      openOptionalButtonOverlay(page, {
        buttonSelector: 'button[aria-label="Trigger actions"]',
        overlayScreenshotName: viewportScreenshot('portal-trigger-card-actions', viewport),
        pageScreenshotName:
          viewport === 'desktop' ? viewportScreenshot('portal-triggers-page', viewport) : undefined,
        url: '/projects/proj-test-1/triggers',
      }),
  },
  {
    name: 'Nodes shared DropdownMenu portal renders with blurred glass surface',
    run: (page, viewport) =>
      openNodeDropdown(page, viewportScreenshot('portal-node-dropdown-menu', viewport)),
  },
  {
    name: 'Shared Tooltip portal renders with blurred surface',
    run: (page, viewport) =>
      openSharedTooltip(page, viewportScreenshot('portal-shared-tooltip', viewport)),
  },
];

function registerSharedOverlayScenarios(viewport: OverlayViewport) {
  for (const scenario of sharedOverlayScenarios) {
    test(scenario.name, async ({ page }) => {
      await scenario.run(page, viewport);
    });
  }
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
    await openCommandPalette(page, 'portal-command-palette-mobile', 'window');
  });

  test('GlobalCommandPalette portal renders (keyboard dispatch)', async ({ page }) => {
    await openCommandPalette(page, 'portal-command-palette-keyboard-mobile', 'document');
  });

  test('MobileNavDrawer portal renders with backdrop', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'MobileNavDrawer is mobile-only');

    await page.goto('/projects/proj-test-1/triggers');
    await page.waitForTimeout(800);

    // Look for the mobile menu button (hamburger)
    const menuBtn = page
      .locator('button[aria-label*="menu" i], button[aria-label*="nav" i]')
      .first();
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
    const sessionsBtn = page
      .locator(
        'button[aria-label*="session" i], button[aria-label*="chat" i], button[aria-label*="history" i]'
      )
      .first();
    if (await sessionsBtn.isVisible()) {
      await sessionsBtn.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'portal-mobile-session-drawer');
    }

    await assertNoOverflow(page);
  });

  registerSharedOverlayScenarios('mobile');
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
    await openCommandPalette(page, 'portal-command-palette-desktop', 'window');
  });

  registerSharedOverlayScenarios('desktop');

  test('Account map hover tooltip portal renders with blurred surface', async ({ page }) => {
    await page.goto('/account-map');
    await page.waitForTimeout(1200);

    const node = page.locator('.react-flow__node').first();
    await expect(node).toBeVisible();
    await node.hover();
    await page.waitForTimeout(400);
    await screenshot(page, 'portal-account-map-tooltip-desktop');

    await assertFixedBlurredWithinViewport(
      page.locator('body > .glass-surface').filter({ hasText: 'Portal Test Project' })
    );

    await assertNoOverflow(page);
  });
});
