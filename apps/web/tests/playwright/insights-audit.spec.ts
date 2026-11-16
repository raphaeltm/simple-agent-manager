/**
 * Visual and layout audit for the Insights page (Insights slice F) at 375×667 and 1280×800.
 * The Flow read is served exactly as the API answers it (`insights-fixtures.ts`). Scenes: a
 * realistic month, a stressed project (long names, every stop reason, 13 weeks, a capped idea
 * sample), an empty project, a failed read, the range switch, and the coming-soon tabs.
 */
import { expect, type Page, type Route, test, type TestInfo } from '@playwright/test';
import { isInsightsRange } from '@simple-agent-manager/shared';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';
import { type FlowScene, makeFlow } from './insights-fixtures';

const PROJECT_ID = 'proj-insights';
const USER_ID = 'user-insights';
const BASE = `/projects/${PROJECT_ID}/insights`;

const MOCK_USER = makeMockUser({
  email: 'raph@example.com',
  name: 'Raph',
  sessionId: 'session-insights',
  userId: USER_ID,
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Acme Billing',
  repository: 'acme/billing',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: USER_ID,
  installationId: 'inst-1',
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: '',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-11-15T00:00:00Z',
  multiplayerActive: false,
  summary: {
    activeWorkspaceCount: 0,
    activeSessionCount: 0,
    lastActivityAt: null,
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
};

async function setupScene(page: Page, scene: FlowScene | 'error', requests: string[] = []) {
  await page.addInitScript((id) => {
    localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true');
  }, USER_ID);
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/cc/credentials') return respond(200, { credentials: [] });
    if (path === '/api/cc/configurations') return respond(200, { configurations: [] });
    if (path === '/api/cc/attachments') return respond(200, { attachments: [] });
    if (path === '/api/cc/profile-attachments') return respond(200, { attachments: [] });
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path === '/api/credentials/limits')
      return respond(200, { credentials: [], generatedAt: Date.now() });
    if (path === '/api/credentials') return respond(200, []);
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === `/api/projects/${PROJECT_ID}/overview`)
      return respond(200, {
        projectId: PROJECT_ID,
        running: { items: [], total: 0, waitingOnViewerTotal: 0 },
        recent: { ideas: [], mergedPullRequests: [] },
        unavailable: [],
        generatedAt: new Date().toISOString(),
      });
    if (path === `/api/projects/${PROJECT_ID}/agent-profiles`) return respond(200, { items: [] });
    if (path === `/api/projects/${PROJECT_ID}/skills`) return respond(200, { items: [] });
    if (path === `/api/projects/${PROJECT_ID}/triggers`) return respond(200, { triggers: [] });
    if (path === `/api/projects/${PROJECT_ID}/members`)
      return respond(200, { members: [], inviteLinks: [], accessRequests: [] });
    if (path === '/api/trial-status')
      return respond(200, { available: false, hasInfraCredential: true });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    if (path === `/api/projects/${PROJECT_ID}`) return respond(200, MOCK_PROJECT);
    if (path === `/api/projects/${PROJECT_ID}/insights/flow`) {
      const range = url.searchParams.get('range');
      requests.push(range ?? '');
      if (scene === 'error')
        return respond(500, { error: 'INTERNAL_ERROR', message: 'Insights are unavailable' });
      return respond(200, makeFlow(PROJECT_ID, isInsightsRange(range) ? range : '30d', scene));
    }
    if (path.includes('/sessions')) return respond(200, { sessions: [], total: 0, hasMore: false });
    return respond(200, {});
  });
}

function onlyOn(names: string[]) {
  return ({ page: _page }: { page: Page }, testInfo: TestInfo) => {
    test.skip(!names.includes(testInfo.project.name), 'audited on a phone and desktop');
  };
}
test.beforeEach(onlyOn(['iPhone SE (375x667)', 'Desktop (1280x800)']));

async function capture(page: Page, name: string) {
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  // The page root fits the viewport (rule 56): it is never sized by its own content.
  const rootWidth = await page
    .getByTestId('project-insights')
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(rootWidth).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  // The app shell scrolls inside <main>: grow every scroller to its content so the
  // screenshot shows the whole page, not the first screen.
  await page.evaluate(() => {
    let node = document.querySelector<HTMLElement>('[data-testid="project-insights"]');
    while (node) {
      node.style.overflow = 'visible';
      node.style.height = 'auto';
      node.style.maxHeight = 'none';
      node = node.parentElement;
    }
  });
  await screenshot(page, name);
}

test.describe('Insights', () => {
  test('flow with a realistic month', async ({ page }) => {
    await setupScene(page, 'realistic');
    await page.goto(BASE);
    await expect(page).toHaveURL(new RegExp(`${BASE}/flow`));
    await expect(page.getByRole('heading', { name: 'Insights', level: 1 })).toBeVisible();
    await expect(page.getByText('Acme Billing · how work moves from idea to merged')).toBeVisible();
    await expect(page.getByTestId('insights-tile-idea-to-merged')).toContainText('1.6 days');
    await expect(page.getByTestId('insights-tile-ci-first-try')).toContainText('64%');
    await expect(page.getByTestId('insights-tile-waiting')).toContainText('22 min');
    await expect(page.getByTestId('insights-tile-rework')).toContainText('11%');
    await expect(page.getByTestId('insights-runs-chart')).toBeVisible();
    await expect(page.getByTestId('insights-stop-reasons')).toContainText(
      'Pull request waiting to merge'
    );
    await expect(page.getByTestId('insights-flaky-checks')).toContainText(
      'apps/api › snapshot-retry.test.ts'
    );
    await expect(
      page.getByTestId('insights-waiting-ideas').getByRole('link', { name: /Tax ID validation/ })
    ).toHaveAttribute('href', `/projects/${PROJECT_ID}/ideas/idea-c`);
    await expect(page.getByTestId('insights-waiting-ideas')).toContainText('PR open, CI red');
    await capture(page, 'insights-flow-realistic');
  });

  test('flow under stress', async ({ page }) => {
    await setupScene(page, 'stress');
    await page.goto(`${BASE}/flow?range=90d`);
    await expect(page.getByTestId('insights-stop-reasons').locator('li')).toHaveCount(13);
    await expect(page.getByText('Showing 5 of 14 flaky checks.')).toBeVisible();
    await expect(page.getByText(/34 more open ideas/)).toBeVisible();
    await expect(page.getByText(/looked at the 100 most recently updated ideas/)).toBeVisible();
    // Untrusted text renders as text, never as markup.
    await expect(
      page.getByText('<script>alert("x")</script> Tax ID validation for UK 🇬🇧')
    ).toBeVisible();
    await capture(page, 'insights-flow-stress');
  });

  test('flow for an empty project', async ({ page }) => {
    await setupScene(page, 'empty');
    await page.goto(`${BASE}/flow`);
    await expect(page.getByTestId('insights-tile-ci-first-try')).toContainText('Not recorded');
    await expect(page.getByTestId('insights-tile-waiting')).toContainText('No asks');
    await expect(page.getByText('No run stopped before finishing.')).toBeVisible();
    await expect(page.getByText(/No flaky checks/)).toBeVisible();
    await expect(page.getByText('No open ideas filed in this range.')).toBeVisible();
    await capture(page, 'insights-flow-empty');
  });

  test('a failed read says so and offers a retry', async ({ page }) => {
    await setupScene(page, 'error');
    await page.goto(`${BASE}/flow`);
    await expect(page.getByRole('alert')).toContainText('Could not load Insights');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await capture(page, 'insights-flow-error');
  });

  test('switching range reads that range and keeps the numbers on screen', async ({ page }) => {
    const requests: string[] = [];
    await setupScene(page, 'realistic', requests);
    await page.goto(`${BASE}/flow`);
    await expect(page.getByTestId('insights-tile-ci-first-try')).toContainText('64%');
    await page.getByRole('button', { name: '7 days' }).click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.getByText('Runs per day by outcome')).toBeVisible();
    expect(requests).toEqual(['30d', '7d']);
    await capture(page, 'insights-flow-7d');
  });

  test('the other tabs say they are coming', async ({ page }) => {
    await setupScene(page, 'realistic');
    await page.goto(`${BASE}/flow`);
    for (const [tab, id] of [
      ['Agent setups', 'agent-setups'],
      ['Accounts', 'accounts'],
      ['People', 'people'],
    ] as const) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${BASE}/${id}`));
      await expect(page.getByTestId(`insights-coming-soon-${id}`)).toContainText('coming soon');
    }
    await capture(page, 'insights-coming-soon');
  });

  test('the nav item opens Insights', async ({ page }, testInfo) => {
    await setupScene(page, 'realistic');
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    if (testInfo.project.name.startsWith('iPhone')) {
      // The phone drawer lists the same PROJECT_NAV_ITEMS as the sidebar, as buttons.
      await page.getByRole('button', { name: 'Open navigation menu' }).click();
      const drawer = page.getByTestId('mobile-nav-panel');
      await expect(drawer).toBeVisible();
      await drawer.getByRole('button', { name: /^Insights/ }).click();
    } else {
      await page
        .getByRole('link', { name: /^Insights/ })
        .first()
        .click();
    }
    await expect(page).toHaveURL(new RegExp(`${BASE}/flow`));
    await expect(page.getByTestId('insights-flow')).toBeVisible();
  });
});
