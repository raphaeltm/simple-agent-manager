/**
 * Visual and behaviour audit for Insights · People (slice P) at 375×667 and 1280×800. The People
 * read is served exactly as the API answers it (`insights-people-fixtures.ts`). Scenes: a
 * realistic project, a stressed one (long and hostile names and titles, eight people, 30+ open
 * items each, a capped review scan), an empty project, a failed read, and a reassign through the
 * Inbox's own route that refreshes the list.
 */
import { expect, type Page, type Route, test, type TestInfo } from '@playwright/test';
import { isInsightsRange } from '@simple-agent-manager/shared';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';
import { makePeople, type PeopleScene } from './insights-people-fixtures';

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

const MEMBERS = [
  { userId: USER_ID, name: 'Raph', email: 'raph@example.com' },
  { userId: 'user-priya', name: 'Priya Natarajan', email: 'priya@example.com' },
  { userId: 'user-sam', name: 'Sam Okafor', email: 'sam@example.com' },
].map((m) => ({
  projectId: PROJECT_ID,
  userId: m.userId,
  role: 'member',
  status: 'active',
  user: { id: m.userId, name: m.name, email: m.email, avatarUrl: null, image: null },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}));

interface Recorder {
  people: string[];
  reassigns: Array<{ path: string; body: unknown }>;
}

async function setupScene(page: Page, scene: PeopleScene | 'error', rec?: Recorder) {
  let current: PeopleScene | 'error' = scene;
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
    if (path === `/api/projects/${PROJECT_ID}/agent-profiles`) return respond(200, { items: [] });
    if (path === `/api/projects/${PROJECT_ID}/skills`) return respond(200, { items: [] });
    if (path === `/api/projects/${PROJECT_ID}/triggers`) return respond(200, { triggers: [] });
    if (path === `/api/projects/${PROJECT_ID}/members`)
      return respond(200, { members: MEMBERS, inviteLinks: [], accessRequests: [] });
    if (path === '/api/trial-status')
      return respond(200, { available: false, hasInfraCredential: true });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    if (path === `/api/projects/${PROJECT_ID}`) return respond(200, MOCK_PROJECT);
    if (path === `/api/projects/${PROJECT_ID}/insights/people`) {
      const range = url.searchParams.get('range');
      rec?.people.push(range ?? '');
      if (current === 'error')
        return respond(500, { error: 'INTERNAL_ERROR', message: 'Insights are unavailable' });
      return respond(200, makePeople(PROJECT_ID, isInsightsRange(range) ? range : '30d', current));
    }
    if (path.startsWith(`/api/projects/${PROJECT_ID}/inbox/items/`) && path.endsWith('/reassign')) {
      rec?.reassigns.push({ path, body: route.request().postDataJSON() });
      // After the move the task is no longer the viewer's: serve the empty scene next.
      current = 'empty';
      return respond(200, { ref: 'ask:t-2', status: 'open', agentNotified: true });
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

test.describe('Insights · People', () => {
  test('a realistic project', async ({ page }) => {
    await setupScene(page, 'realistic');
    await page.goto(`${BASE}/people`);
    await expect(page.getByRole('tab', { name: 'People', exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByTestId('insights-tile-waiting')).toContainText('6');
    await expect(page.getByTestId('insights-tile-oldest')).toContainText('3.2 days');
    await expect(page.getByTestId('insights-tile-review-pickup')).toContainText('2.4 h');
    await expect(page.getByTestId('insights-tile-first-person')).toContainText('83%');
    const priya = page.getByTestId('insights-waiting-group-user-priya');
    await expect(priya).toContainText('Priya Natarajan');
    await expect(priya).toContainText('3 open · oldest 3.2 days · 1 blocking');
    // Another member's private question shows its kind and age, never a title.
    await expect(priya).toContainText('Question for someone else');
    await expect(page.getByTestId('insights-waiting-group-user-insights')).toContainText('You');
    await expect(page.getByTestId('insights-waiting-group-unassigned')).toContainText(
      'Not taken yet'
    );
    await expect(page.getByTestId('insights-review-pickup')).toContainText('19 h');
    // No per-person output count anywhere: groups say what waits, not what anyone did.
    await expect(page.getByTestId('insights-people')).not.toContainText(
      /merged|produced|completed by/i
    );
    await capture(page, 'insights-people-realistic');
  });

  test('reassign hands a task on through the Inbox route and refreshes the list', async ({
    page,
  }) => {
    const rec: Recorder = { people: [], reassigns: [] };
    await setupScene(page, 'realistic', rec);
    await page.goto(`${BASE}/people`);
    const own = page.getByTestId('insights-waiting-group-user-insights');
    await own
      .getByRole('button', { name: 'Reassign Confirm the new tax table with accounting' })
      .click();
    const form = page.getByTestId('insights-reassign-form-ask:t-2');
    await expect(form).toBeVisible();
    await capture(page, 'insights-people-reassign-open');
    await form.getByRole('combobox').selectOption({ label: 'Sam Okafor' });
    await form.getByRole('button', { name: 'Reassign' }).click();
    await expect(page.getByTestId('insights-waiting-list')).toHaveCount(0);
    await expect(page.getByTestId('insights-section-waiting')).toContainText(
      'Nothing is waiting on anyone'
    );
    expect(rec.reassigns).toEqual([
      {
        path: `/api/projects/${PROJECT_ID}/inbox/items/ask%3At-2/reassign`,
        body: { assigneeUserId: 'user-sam' },
      },
    ]);
    expect(rec.people.length).toBeGreaterThanOrEqual(2);
  });

  test('a stressed project wraps and stays in bounds', async ({ page }) => {
    await setupScene(page, 'stress');
    await page.goto(`${BASE}/people?range=90d`);
    await expect(page.getByTestId('insights-tile-waiting')).toContainText('290');
    await expect(page.getByTestId('insights-waiting-group-user-0')).toContainText(
      'Maximiliana Wolfeschlegelsteinhausenbergerdorff'
    );
    await expect(page.getByTestId('insights-waiting-group-user-0')).toContainText(
      '24 more, oldest shown first.'
    );
    await expect(page.getByTestId('insights-review-pickup')).toContainText(
      'only the most recent requests were examined'
    );
    // Hostile titles render as text.
    await expect(page.getByText('<script>alert(3)</script> & “quotes” 🚀 3').first()).toBeVisible();
    await capture(page, 'insights-people-stress');
  });

  test('an empty project', async ({ page }) => {
    await setupScene(page, 'empty');
    await page.goto(`${BASE}/people`);
    await expect(page.getByTestId('insights-section-waiting')).toContainText(
      'Nothing is waiting on anyone'
    );
    await expect(page.getByTestId('insights-review-pickup')).toContainText('Not recorded yet');
    await expect(page.getByTestId('insights-tile-first-person')).toContainText('—');
    await capture(page, 'insights-people-empty');
  });

  test('a failed read offers a retry', async ({ page }) => {
    await setupScene(page, 'error');
    await page.goto(`${BASE}/people`);
    await expect(page.getByText(/could not load people insights/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await capture(page, 'insights-people-error');
  });
});
