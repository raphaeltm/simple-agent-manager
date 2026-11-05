import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow } from './audit-helpers';

test.use({
  video: process.env.ZEN_RECORD_VIDEO ? { mode: 'on', size: { width: 1280, height: 800 } } : 'off',
});

// ---------------------------------------------------------------------------
// Visual audit for desktop Focus Mode sidebar collapse.
//
// Focus Mode is a three-state control (default -> focus -> zen) that collapses
// the main nav sidebar and the project-chat session sidebar:
//   - default: full nav (220px) + full sessions (288px)
//   - focus:   icon nav rail (56px) + session status strip (64px)
//   - zen:     both collapsed to 0 with glowing peek seams
//
// Focus Mode is desktop-only (forced to 'default' on mobile). These tests drive
// the segmented toggle and the "F" cycle key at desktop (1280x800) and assert
// no horizontal overflow in any state. They also confirm mobile stays default.
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'user',
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
  id: 'proj-1',
  name: 'Focus Mode Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const NOW = Date.now();

function makeSession(
  id: string,
  taskId: string,
  topic: string,
  status = 'active',
  lastMessageAt = NOW - 30000
) {
  return {
    id,
    workspaceId: null,
    taskId,
    topic,
    status,
    messageCount: 3,
    startedAt: lastMessageAt - 30000,
    endedAt: status === 'stopped' ? lastMessageAt + 30000 : null,
    createdAt: lastMessageAt - 90000,
    lastMessageAt,
    isIdle: false,
    isTerminated: status === 'stopped',
  };
}

function makeTask(id: string, title: string, status = 'running') {
  return {
    id,
    title,
    description: null,
    projectId: 'proj-1',
    userId: 'user-test-1',
    status,
    blocked: false,
    parentTaskId: null,
    triggeredBy: 'user',
    createdAt: new Date(NOW - 120000).toISOString(),
    updatedAt: new Date(NOW - 30000).toISOString(),
  };
}

// A varied set: long topic, special chars, several attention states so the
// collapsed status-strip exercises every ATTENTION_ICON branch.
const SESSIONS = [
  makeSession('s-1', 't-1', 'Implement authentication flow', 'active'),
  makeSession(
    's-2',
    't-2',
    'Refactor the credential resolution layer with a deliberately long topic that should wrap and never push controls off the canvas in any focus state',
    'needs_input'
  ),
  makeSession('s-3', 't-3', 'Fix overflow bug <>& in sidebar', 'stopped'),
  makeSession('s-4', 't-4', 'Add collapse peek seams', 'completed'),
];
const TASKS = [
  makeTask('t-1', 'Implement authentication flow', 'running'),
  makeTask('t-2', 'Refactor credential resolution', 'running'),
  makeTask('t-3', 'Fix overflow bug', 'completed'),
  makeTask('t-4', 'Add collapse peek seams', 'completed'),
];

async function setupApiMocks(
  page: Page,
  options: { projects?: (typeof MOCK_PROJECT)[]; projectError?: boolean; theme?: string } = {}
) {
  await page.addInitScript(() => {
    localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true');
  });
  if (options.theme)
    await page.addInitScript((theme) => localStorage.setItem('sam-theme', theme), options.theme);
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });
    if (path.startsWith('/api/github/installations')) return respond(200, []);
    if (path.startsWith('/api/trial-status')) {
      return respond(200, {
        available: false,
        agentType: null,
        hasInfraCredential: false,
        hasAgentCredential: false,
        dailyTokenBudget: null,
        dailyTokenUsage: null,
      });
    }
    if (path === '/api/agents') return respond(200, { agents: [] });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/sessions') {
        return respond(200, { sessions: SESSIONS, total: SESSIONS.length });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) return respond(200, []);
      if (subPath === '/tasks') return respond(200, { tasks: TASKS, nextCursor: null });
      if (subPath === '/agents') return respond(200, { agents: [] });
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath === '/cached-commands') return respond(200, { items: [] });
      if (subPath === '/triggers') return respond(200, { items: [] });
      if (subPath === '/knowledge') return respond(200, { entities: [], total: 0 });
      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects') {
      return options.projectError
        ? respond(500, { error: 'INTERNAL_ERROR', message: 'Project list unavailable' })
        : respond(200, { projects: options.projects ?? [MOCK_PROJECT], nextCursor: null });
    }
    return respond(200, {});
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(700);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertChatPageRendered(page: Page) {
  const body = await page.evaluate(() => document.body.innerText);
  expect(body).not.toContain('Something went wrong');
  expect(body).not.toContain('Cannot read properties of undefined');
}

async function gotoProject(page: Page) {
  await setupApiMocks(page);
  await page.goto('/projects/proj-1');
  await page.waitForTimeout(1500);
  await assertChatPageRendered(page);
}

// ---------------------------------------------------------------------------
// Desktop tests (1280x800) — Focus Mode is desktop-only.
// ---------------------------------------------------------------------------

test.describe('Focus Mode sidebars — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  test.beforeEach(({ browserName }, testInfo) => {
    test.skip(
      !testInfo.project.name.includes('Desktop'),
      `Desktop audit skipped for ${testInfo.project.name} on ${browserName}`
    );
  });

  test('default mode shows the segmented toggle and full sidebars', async ({ page }) => {
    await gotoProject(page);
    // The segmented toggle group exposes all three modes as buttons.
    await expect(page.getByRole('group', { name: 'Focus Mode' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Default', exact: true, pressed: true })
    ).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'focus-mode-default-desktop');
  });

  test('selecting Focus collapses nav rail + session strip without overflow', async ({ page }) => {
    await gotoProject(page);
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    await page.waitForTimeout(400);
    // The collapsed nav shows the compact cycle control instead of the segmented group.
    await expect(
      page.getByRole('button', { name: /Focus Mode: Focus\. Activate to switch to Zen/ })
    ).toBeVisible();
    // The session strip exposes a compact New chat affordance.
    await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'focus-mode-focus-desktop');
  });

  test('selecting Zen collapses both sidebars to peek seams', async ({ page }) => {
    await gotoProject(page);
    await page.getByRole('button', { name: 'Zen', exact: true }).click();
    await page.waitForTimeout(400);
    // Both zen peek seams render as expand buttons parented to the grid edges.
    await expect(
      page.getByRole('button', { name: /Navigation \(Zen mode\)\. Activate to expand\./ })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Chats \(Zen mode\)\. Activate to expand\./ })
    ).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'focus-mode-zen-desktop');
  });

  test('Zen peek keeps layout controls and stays open when switching navigation', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await gotoProject(page);
    await page.getByRole('button', { name: 'Zen', exact: true }).click();
    const seam = page.getByRole('button', { name: /Navigation \(Zen mode\)/ });
    await seam.hover();
    await expect(
      page.getByRole('button', { name: 'Zen', exact: true, pressed: true })
    ).toBeVisible();
    await assertNoClippedOverflow(page);
    await screenshot(page, 'zen-navigation-project-desktop');
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Show global navigation' }).click();
      await expect(
        page.getByRole('navigation', { name: 'Primary navigation', exact: true })
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /Back to .* navigation/ })).toBeInViewport();
      expect(
        await page
          .locator('[data-intentional-clip]')
          .first()
          .evaluate((el) => el.scrollLeft)
      ).toBe(0);
      await page.getByRole('button', { name: /Back to .* navigation/ }).click();
      await expect(
        page.getByRole('navigation', { name: 'Project navigation', exact: true })
      ).toBeVisible();
    }
    await page.getByRole('button', { name: 'Show global navigation' }).click();
    await assertNoClippedOverflow(page);
    await screenshot(page, 'zen-navigation-global-desktop');
    await page.getByRole('button', { name: 'Default', exact: true }).click();
    await expect(seam).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Default', exact: true, pressed: true })
    ).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'zen-navigation-exited-desktop');
  });

  for (const mode of ['Default', 'Focus'] as const) {
    test(`leaving Zen preserves keyboard focus on ${mode}`, async ({ page }) => {
      await gotoProject(page);
      await page.getByRole('button', { name: 'Zen', exact: true }).click();
      await page.mouse.move(700, 400);
      await page.getByRole('button', { name: /Navigation \(Zen mode\)/ }).focus();
      await page.getByRole('button', { name: mode, exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: /Navigation \(Zen mode\)/ })).toHaveCount(0);
      const replacement =
        mode === 'Default'
          ? page.getByRole('button', { name: 'Default', exact: true, pressed: true })
          : page.getByRole('button', { name: /Focus Mode: Focus\. Activate to switch to Zen/ });
      await expect(replacement).toBeFocused();
    });
  }

  test('keyboard switching retains focus and Escape dismisses the Zen peek', async ({ page }) => {
    await gotoProject(page);
    await page.getByRole('button', { name: 'Zen', exact: true }).click();
    await page.mouse.move(700, 400);
    const seam = page.getByRole('button', { name: /Navigation \(Zen mode\)/ });
    await seam.focus();
    const toGlobal = page.getByRole('button', { name: 'Show global navigation' });
    await toGlobal.focus();
    await page.keyboard.press('Enter');
    const toProject = page.getByRole('button', { name: /Back to .* navigation/ });
    await expect(toProject).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toGlobal).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: 'Focus Mode' })).toHaveCount(0);
    await expect(seam).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('group', { name: 'Focus Mode' })).toHaveCount(0);
    await seam.hover();
    await expect(page.getByRole('group', { name: 'Focus Mode' })).toBeVisible();
    await page.mouse.move(700, 400);
    await expect(page.getByRole('group', { name: 'Focus Mode' })).toHaveCount(0);
  });

  for (const scenario of ['many', 'empty', 'error', 'light'] as const) {
    test(`Zen navigation handles ${scenario} project data`, async ({ page }) => {
      await setupApiMocks(page, {
        projects:
          scenario === 'empty'
            ? []
            : Array.from({ length: 35 }, (_, i) => ({
                ...MOCK_PROJECT,
                id: `stress-${i}`,
                name: i === 0 ? 'Long project 🚀 <script> & '.repeat(12) : `Project ${i}`,
              })),
        projectError: scenario === 'error',
        theme: scenario === 'light' ? 'light' : 'dark',
      });
      await page.goto('/projects/proj-1/chat');
      await expect(page.locator('html')).toHaveAttribute(
        'data-ui-theme',
        scenario === 'light' ? 'sam-light' : 'sam'
      );
      await page.getByRole('button', { name: 'Zen', exact: true }).click();
      await page.getByRole('button', { name: /Navigation \(Zen mode\)/ }).hover();
      await page.getByRole('button', { name: 'Show global navigation' }).click();
      await expect(
        page.getByRole('navigation', { name: 'Primary navigation', exact: true })
      ).toBeVisible();
      await expect(page.getByRole('group', { name: 'Focus Mode' })).toBeVisible();
      if (scenario === 'empty') {
        await expect(page.getByRole('status').filter({ hasText: 'No projects yet' })).toBeVisible();
      } else if (scenario === 'error') {
        await expect(
          page.getByRole('status').filter({ hasText: 'Projects unavailable' })
        ).toBeVisible();
      } else {
        await expect(page.getByText('Project 1', { exact: true })).toBeVisible();
      }
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await screenshot(page, `zen-navigation-${scenario}-desktop`);
    });
  }

  test('the F key cycles default -> focus -> zen -> default', async ({ page }) => {
    await gotoProject(page);
    await expect(
      page.getByRole('button', { name: 'Default', exact: true, pressed: true })
    ).toBeVisible();

    await page.keyboard.press('f');
    await page.waitForTimeout(300);
    await expect(
      page.getByRole('button', { name: /Focus Mode: Focus\. Activate to switch to Zen/ })
    ).toBeVisible();
    await assertNoOverflow(page);

    await page.keyboard.press('f');
    await page.waitForTimeout(300);
    await expect(
      page.getByRole('button', { name: /Navigation \(Zen mode\)\. Activate to expand\./ })
    ).toBeVisible();
    await assertNoOverflow(page);

    await page.keyboard.press('f');
    await page.waitForTimeout(300);
    await expect(
      page.getByRole('button', { name: 'Default', exact: true, pressed: true })
    ).toBeVisible();
    await assertNoOverflow(page);
  });

  test('expanding a zen peek seam restores the full sidebar', async ({ page }) => {
    await gotoProject(page);
    await page.getByRole('button', { name: 'Zen', exact: true }).click();
    await page.waitForTimeout(400);
    await page
      .getByRole('button', { name: /Navigation \(Zen mode\)\. Activate to expand\./ })
      .click();
    await page.waitForTimeout(400);
    // Back to default: the segmented toggle is visible again.
    await expect(
      page.getByRole('button', { name: 'Default', exact: true, pressed: true })
    ).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'focus-mode-zen-expanded-desktop');
  });
});

// ---------------------------------------------------------------------------
// Mobile tests (375x667 default) — Focus Mode must stay disabled.
// ---------------------------------------------------------------------------

test.describe('Focus Mode sidebars — Mobile', () => {
  test.beforeEach(({ browserName }, testInfo) => {
    test.skip(
      testInfo.project.name.includes('Desktop'),
      `Mobile audit skipped for ${testInfo.project.name} on ${browserName}`
    );
  });

  test('mobile navigation still switches global and project menus', async ({ page }) => {
    await gotoProject(page);
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('button', { name: 'Show global navigation' }).click();
    await expect(
      page.getByRole('navigation', { name: 'Primary navigation', exact: true })
    ).toBeVisible();
    await screenshot(page, 'zen-navigation-global-mobile');
    await page.getByRole('button', { name: /Back to .* navigation/ }).click();
    await expect(
      page.getByRole('navigation', { name: 'Project navigation', exact: true })
    ).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'zen-navigation-project-mobile');
  });

  test('mobile never renders the Focus Mode toggle and has no overflow', async ({ page }) => {
    await gotoProject(page);
    // Focus Mode is desktop-only; the toggle group must not exist on mobile.
    await expect(page.getByRole('group', { name: 'Focus Mode' })).toHaveCount(0);
    // Pressing F is a no-op on mobile — no zen seams appear.
    await page.keyboard.press('f');
    await page.waitForTimeout(300);
    await expect(
      page.getByRole('button', { name: /Zen mode\)\. Activate to expand\./ })
    ).toHaveCount(0);
    await assertNoOverflow(page);
    await screenshot(page, 'focus-mode-mobile');
  });
});
