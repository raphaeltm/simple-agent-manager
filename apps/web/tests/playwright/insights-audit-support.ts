/**
 * Shared scaffolding for the Insights page audits (`insights-audit.spec.ts`, Flow and Accounts;
 * `insights-people-audit.spec.ts`, People): the mocked viewer and project, the app-shell API
 * routes every Insights page loads, the phone and desktop projects they run on, and the capture
 * step with its overflow and page-root checks (`.claude/rules/56`).
 */
import { expect, type Page, type Route, test, type TestInfo } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';

export const PROJECT_ID = 'proj-insights';
export const USER_ID = 'user-insights';
export const BASE = `/projects/${PROJECT_ID}/insights`;

export const MOCK_USER = makeMockUser({
  email: 'raph@example.com',
  name: 'Raph',
  sessionId: 'session-insights',
  userId: USER_ID,
});

export const MOCK_PROJECT = {
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

export type Respond = (status: number, body: unknown) => Promise<void>;

/**
 * Mock every API route an Insights page needs. `own` answers a page's own reads first (return
 * undefined to fall through); `members` is the project member list.
 */
export async function routeInsightsApi(
  page: Page,
  own: (url: URL, route: Route, respond: Respond) => Promise<void> | undefined,
  members: unknown[] = []
): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true');
  }, USER_ID);
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond: Respond = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const handled = own(url, route, respond);
    if (handled) return handled;
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
      return respond(200, { members, inviteLinks: [], accessRequests: [] });
    if (path === '/api/trial-status')
      return respond(200, { available: false, hasInfraCredential: true });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    if (path === `/api/projects/${PROJECT_ID}`) return respond(200, MOCK_PROJECT);
    if (path.includes('/sessions')) return respond(200, { sessions: [], total: 0, hasMore: false });
    return respond(200, {});
  });
}

/** Run the audit on the phone and desktop projects only. */
export function auditOnPhoneAndDesktop(): void {
  test.beforeEach(({ page: _page }: { page: Page }, testInfo: TestInfo) => {
    test.skip(
      !['iPhone SE (375x667)', 'Desktop (1280x800)'].includes(testInfo.project.name),
      'audited on a phone and desktop'
    );
  });
}

/** Check for crashes and overflow, then screenshot the whole Insights page. */
export async function capture(page: Page, name: string): Promise<void> {
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
