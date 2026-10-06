import { expect, type Page, type Route, test } from '@playwright/test';
import type { ProjectDetailResponse, ProjectSummary } from '@simple-agent-manager/shared';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'cache-audit@example.com',
  name: 'Cache Audit User',
  sessionId: 'cache-session-1',
  userId: 'cache-user-1',
});

const BASE_PROJECT = {
  id: 'cache-project-1',
  name: 'Responsive Cache Project',
  repository: 'acme/responsive-cache-project',
  githubRepoId: 101,
  defaultBranch: 'main',
  repoProvider: 'github',
  status: 'active',
  activeWorkspaceCount: 2,
  activeSessionCount: 1,
  lastActivityAt: '2026-08-07T20:00:00.000Z',
  taskCountsByStatus: { in_progress: 1 },
  linkedWorkspaces: 2,
  createdAt: '2026-08-07T19:00:00.000Z',
} satisfies ProjectSummary;

const BASE_PROJECT_DETAIL = {
  id: BASE_PROJECT.id,
  userId: 'cache-user-1',
  name: BASE_PROJECT.name,
  description: 'A project used to verify cached responsive navigation.',
  installationId: 'installation-1',
  repository: BASE_PROJECT.repository,
  defaultBranch: BASE_PROJECT.defaultBranch,
  repoProvider: 'github',
  status: 'active',
  createdAt: BASE_PROJECT.createdAt,
  updatedAt: '2026-08-07T20:00:00.000Z',
  summary: {
    repoProvider: 'github',
    activeWorkspaceCount: 2,
    activeSessionCount: 1,
    lastActivityAt: '2026-08-07T20:00:00.000Z',
    taskCountsByStatus: { in_progress: 1 },
    linkedWorkspaces: 2,
  },
} satisfies ProjectDetailResponse;

interface MockOptions {
  backgroundRefreshDelayMs?: number;
  projectListError?: boolean;
  projects?: ProjectSummary[];
}

async function setupApiMocks(page: Page, options: MockOptions = {}) {
  const projects = options.projects ?? [BASE_PROJECT];
  let listRequestCount = 0;
  let detailRequestCount = 0;

  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects' && method === 'GET') {
      listRequestCount += 1;
      if (options.projectListError) {
        return respond(500, {
          error: 'PROJECT_LIST_UNAVAILABLE',
          message: 'Project list unavailable',
        });
      }
      if (listRequestCount > 1 && options.backgroundRefreshDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.backgroundRefreshDelayMs));
      }
      return respond(200, { projects, nextCursor: null });
    }
    if (path === `/api/projects/${BASE_PROJECT.id}` && method === 'GET') {
      detailRequestCount += 1;
      return respond(200, BASE_PROJECT_DETAIL);
    }
    if (path === `/api/projects/${BASE_PROJECT.id}` && method === 'DELETE') {
      return respond(200, { success: true });
    }
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path.includes('/sessions')) return respond(200, { sessions: [], total: 0 });
    if (path.includes('/tasks')) return respond(200, { tasks: [], nextCursor: null });
    if (path.includes('/agent-profiles')) return respond(200, { items: [] });
    if (path.includes('/commands')) return respond(200, { commands: [] });
    return respond(200, {});
  });

  return {
    get detailRequestCount() {
      return detailRequestCount;
    },
    get listRequestCount() {
      return listRequestCount;
    },
  };
}

test('phone rotation preserves the loaded project list without another request', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iPhone 14 (390x844)');
  const requests = await setupApiMocks(page);

  await page.goto('/projects');
  await expect(page.locator('#main-content').getByText(BASE_PROJECT.name)).toBeVisible();
  expect(requests.listRequestCount).toBe(1);
  await screenshot(page, 'frontend-cache-projects-portrait');

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#main-content').getByText(BASE_PROJECT.name)).toBeVisible();
  await page.waitForTimeout(300);

  expect(requests.listRequestCount).toBe(1);
  await assertNoOverflow(page);
  await screenshot(page, 'frontend-cache-projects-landscape');
});

test('intent prefetch feeds navigation and stale data stays visible during refresh', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'Desktop (1280x800)');
  const requests = await setupApiMocks(page, { backgroundRefreshDelayMs: 900 });

  await page.goto('/projects');
  await expect(page.locator('#main-content').getByText(BASE_PROJECT.name)).toBeVisible();
  expect(requests.listRequestCount).toBe(1);

  const projectCard = page
    .locator('#main-content')
    .getByText(BASE_PROJECT.name)
    .locator('xpath=ancestor::*[@role="button"][1]');
  await projectCard.hover();
  await expect.poll(() => requests.detailRequestCount).toBe(1);

  await page.getByRole('button', { name: `Actions for ${BASE_PROJECT.name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();

  const indicator = page.getByTestId('background-fetch-indicator');
  await expect(indicator).toHaveAttribute('data-refreshing', 'true');
  await page.waitForTimeout(220);
  await expect(page.locator('#main-content').getByText(BASE_PROJECT.name)).toBeVisible();
  await screenshot(page, 'frontend-cache-background-refresh');
  await expect(indicator).toHaveAttribute('data-refreshing', 'false');

  await projectCard.click({ position: { x: 12, y: 12 } });
  await expect(page).toHaveURL(new RegExp(`/projects/${BASE_PROJECT.id}/chat`));
  expect(requests.detailRequestCount).toBe(1);
  await assertNoOverflow(page);
});

test('mobile background refresh stays delayed and preserves the loaded project card', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iPhone 14 (390x844)');
  await setupApiMocks(page, { backgroundRefreshDelayMs: 900 });

  await page.goto('/projects');
  await expect(page.locator('#main-content').getByText(BASE_PROJECT.name)).toBeVisible();
  await page.getByRole('button', { name: `Actions for ${BASE_PROJECT.name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();

  const indicator = page.getByTestId('background-fetch-indicator');
  await expect(indicator).toHaveAttribute('data-refreshing', 'false');
  await page.waitForTimeout(170);
  await expect(indicator).toHaveAttribute('data-refreshing', 'true');
  await expect(page.locator('#main-content').getByText(BASE_PROJECT.name)).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, 'frontend-cache-mobile-background-refresh');
});

const MANY_PROJECTS = Array.from({ length: 30 }, (_, index) => ({
  ...BASE_PROJECT,
  id: `cache-project-${index + 1}`,
  name: `Cached Project ${index + 1}`,
  repository: `acme/cached-project-${index + 1}`,
}));

const VISUAL_STATES = [
  { name: 'normal', projects: [BASE_PROJECT] },
  { name: 'single-character', projects: [{ ...BASE_PROJECT, name: 'A', repository: 'a/b' }] },
  {
    name: 'long-special',
    projects: [{
      ...BASE_PROJECT,
      name: `日本語 🚀 <script>alert("cache")</script> ${'very-long-project-name-'.repeat(8)}`,
      repository: `acme/${'unbroken'.repeat(30)}`,
    }],
  },
  { name: 'empty', projects: [] },
  { name: 'many', projects: MANY_PROJECTS },
] as const;

for (const state of VISUAL_STATES) {
  test(`project cache surface: ${state.name}`, async ({ page }, testInfo) => {
    test.skip(
      !['iPhone SE (375x667)', 'Desktop (1280x800)'].includes(testInfo.project.name),
    );
    await setupApiMocks(page, { projects: [...state.projects] });

    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    if (state.name === 'empty') {
      await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
    }

    await assertNoOverflow(page);
    await screenshot(page, `frontend-cache-projects-${state.name}`);
  });
}

test('project cache surface: initial error', async ({ page }, testInfo) => {
  test.skip(!['iPhone SE (375x667)', 'Desktop (1280x800)'].includes(testInfo.project.name));
  await setupApiMocks(page, { projectListError: true });

  await page.goto('/projects');
  await expect(page.getByText('Project list unavailable')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toHaveCount(0);
  if (testInfo.project.name === 'Desktop (1280x800)') {
    await expect(page.getByText('Projects unavailable', { exact: true })).toBeVisible();
    await expect(page.getByText('No projects yet', { exact: true })).toHaveCount(0);
  }
  await assertNoOverflow(page);
  await screenshot(page, 'frontend-cache-projects-error');
});
