/**
 * Visual and layout audit for the Insights page (Insights slice F) at 375×667 and 1280×800.
 * The Flow read is served exactly as the API answers it (`insights-fixtures.ts`). Scenes: a
 * realistic month, a stressed project (long names, every stop reason, 13 weeks, a capped idea
 * sample), an empty project, a failed read, the range switch, and the coming-soon tabs.
 * Accounts (slice A, `insights-accounts-fixtures.ts`): a realistic month, a stressed project
 * (long and hostile names, eight accounts, 13 weeks, a capped stall scan), an empty project, a
 * failed read, a failed stall section, and a range switch held mid-flight.
 */
import { expect, type Page, type Route, test, type TestInfo } from '@playwright/test';
import { isInsightsRange } from '@simple-agent-manager/shared';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';
import { type AccountsScene, makeAccounts } from './insights-accounts-fixtures';
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

async function setupScene(
  page: Page,
  scene: FlowScene | 'error',
  requests: string[] = [],
  accountsScene: AccountsScene | 'error' = 'realistic'
) {
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
    if (path === `/api/projects/${PROJECT_ID}/insights/accounts`) {
      const range = url.searchParams.get('range');
      requests.push(`accounts:${range ?? ''}`);
      if (accountsScene === 'error')
        return respond(500, { error: 'INTERNAL_ERROR', message: 'Insights are unavailable' });
      return respond(
        200,
        makeAccounts(PROJECT_ID, isInsightsRange(range) ? range : '30d', accountsScene)
      );
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

  test('a pull request with no check result yet is not called a running check', async ({
    page,
  }) => {
    // Staging found this shape: a repository without CI reports no checks at all, so the
    // pull request stays undecided and the tile must not claim checks are running.
    await setupScene(page, 'undecided');
    await page.goto(`${BASE}/flow`);
    const tile = page.getByTestId('insights-tile-ci-first-try');
    await expect(tile).toContainText('No result yet');
    await expect(tile).toContainText('1 pull request recorded, checks not reported yet');
    await expect(tile).not.toContainText('running');
    await capture(page, 'insights-flow-undecided');
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
      ['People', 'people'],
    ] as const) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${BASE}/${id}`));
      await expect(page.getByTestId(`insights-coming-soon-${id}`)).toContainText('coming soon');
    }
    await capture(page, 'insights-coming-soon');
  });

  test('accounts with a realistic month', async ({ page }) => {
    await setupScene(page, 'realistic');
    await page.goto(`${BASE}/flow`);
    await page.getByRole('tab', { name: 'Accounts', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/accounts`));
    const own = page.getByTestId('insights-account-cred:cc-max');
    await expect(own).toContainText('Personal Max');
    await expect(own).toContainText('3× · 1.9 h');
    await expect(own).toContainText('Paused now');
    // Your own account shows its current limits through the shared chip.
    await expect(own.getByTestId('credential-limit-chip')).toBeVisible();
    // A teammate's accounts are described, never named.
    await expect(
      page.getByTestId('insights-account-teammate:openai-codex:subscription')
    ).toContainText('Teammates’ accounts (2)');
    const key = page.getByTestId('insights-account-cred:cc-key');
    await expect(key).toContainText('API key · pay as you go');
    await expect(key.getByText('Not reported')).toHaveCount(1);
    await expect(page.getByTestId('insights-accounts-chart')).toBeVisible();
    await expect(page.getByTestId('insights-stall-list').locator('li')).toHaveCount(6);
    await expect(page.getByTestId('insights-stall-list')).toContainText(
      'the run ended while it waited'
    );
    await expect(page.getByTestId('insights-stall-list')).toContainText(
      'stopped retrying, needs a person'
    );
    await capture(page, 'insights-accounts-realistic');
  });

  test('accounts under stress', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'stress');
    await page.goto(`${BASE}/accounts?range=90d`);
    await expect(page.locator('[data-testid^="insights-account-"]')).toHaveCount(8);
    // Untrusted names render as text, never as markup.
    await expect(page.getByText('<script>alert("x")</script> 🔑 key').first()).toBeVisible();
    // Five accounts get a colour; the other three fold into "Other".
    await expect(page.getByTestId('insights-accounts-chart')).toContainText('Other (3)');
    await expect(
      page.getByText('Showing the 10 most recent of 47. Older limit waits were not examined.')
    ).toBeVisible();
    await capture(page, 'insights-accounts-stress');
  });

  test('accounts for an empty project', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'empty');
    await page.goto(`${BASE}/accounts`);
    await expect(page.getByTestId('insights-accounts-empty')).toContainText(
      'No runs in this range'
    );
    await expect(page.getByText('No agent waited on a usage limit in this range.')).toBeVisible();
    await capture(page, 'insights-accounts-empty');
  });

  test('a failed accounts read says so and offers a retry', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'error');
    await page.goto(`${BASE}/accounts`);
    await expect(page.getByRole('alert')).toContainText('Could not load account insights');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await capture(page, 'insights-accounts-error');
  });

  test('accounts with the stall read unavailable says so instead of "none"', async ({ page }) => {
    await setupScene(page, 'realistic', [], 'partial');
    await page.goto(`${BASE}/accounts`);
    await expect(page.getByText('Some numbers could not be loaded: limit stalls.')).toBeVisible();
    await expect(page.getByText('Limit stalls could not be loaded.')).toBeVisible();
    await expect(page.getByText('No agent waited on a usage limit in this range.')).toHaveCount(0);
    // Liveness: the accounts still show.
    await expect(page.getByTestId('insights-account-cred:cc-max')).toBeVisible();
    await capture(page, 'insights-accounts-partial');
  });

  test('switching range on accounts keeps the cards on screen until the new range arrives', async ({
    page,
  }) => {
    const requests: string[] = [];
    await setupScene(page, 'realistic', requests);
    // Hold the 7-day answer so the in-between state is observable.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/insights\/accounts\?range=7d/, async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto(`${BASE}/accounts`);
    await expect(page.getByText('Runs per week by account')).toBeVisible();
    await page.getByRole('button', { name: '7 days' }).click();
    await expect(page).toHaveURL(/range=7d/);
    // In flight: the 30-day cards and chart stay, nothing blanks.
    await expect(page.getByTestId('insights-account-cred:cc-max')).toBeVisible();
    await expect(page.getByText('Runs per week by account')).toBeVisible();
    await expect(page.getByText('Loading accounts…')).toHaveCount(0);
    release();
    await expect(page.getByText('Runs per day by account')).toBeVisible();
    await expect(page.getByTestId('insights-account-cred:cc-max')).toBeVisible();
    expect(requests.filter((r) => r.startsWith('accounts:'))).toEqual([
      'accounts:30d',
      'accounts:7d',
    ]);
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
