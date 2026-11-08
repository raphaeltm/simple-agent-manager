/**
 * Visual and behavioural audit for "I already deleted this server" on the Node page
 * (rule 17).
 *
 * The node is in the state the 2026-11-02 production node was in: `destroying`,
 * with strict deletion's "exact provider credential binding is missing" error and a
 * long name. The test clicks the real button, accepts the native confirmation, and
 * asserts the request the API receives, so it proves the action and not only the
 * render (rule 62).
 */

import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'owner@example.com',
  name: 'Node Owner',
  role: 'user',
  sessionId: 'session-node-1',
  userId: 'user-node-1',
});

const STUCK_NODE = {
  id: '01KXAR1T3XCQKKPBEJEERQ2PSZ',
  name: 'node-with-an-extremely-long-generated-name-that-keeps-going-01KXAR1T3XCQKKPBEJEERQ2PSZ',
  status: 'destroying',
  healthStatus: 'stale',
  nodeRole: 'workspace',
  nodeClass: 'managed',
  vmSize: 'medium',
  vmLocation: 'fsn1',
  ipAddress: null,
  cloudProvider: 'hetzner',
  heartbeatStaleAfterSeconds: 180,
  lastHeartbeatAt: '2026-10-25T08:00:00.000Z',
  errorMessage:
    'Cannot strictly delete node 01KXAR1T3XCQKKPBEJEERQ2PSZ: exact provider credential binding is missing',
  createdAt: '2026-10-20T09:00:00.000Z',
  updatedAt: '2026-11-02T10:05:00.000Z',
};

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupMocks(
  page: Page,
  node: Record<string, unknown>,
  manualDeletion: { status: number; body: unknown } = { status: 200, body: { success: true } }
) {
  const manualDeletionRequests: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.includes('/api/auth/')) return fulfill(route, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return fulfill(route, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects') return fulfill(route, { projects: [], nextCursor: null });
    if (path === '/api/workspaces') return fulfill(route, []);
    if (path === '/api/nodes') return fulfill(route, []);
    if (path === `/api/nodes/${node.id}/manual-deletion`) {
      manualDeletionRequests.push(route.request().postDataJSON());
      return fulfill(route, manualDeletion.body, manualDeletion.status);
    }
    if (path === `/api/nodes/${node.id}`) return fulfill(route, node);
    // A node this audit treats as running is not really there: answer as the API
    // does for an unreachable node agent, not with a shape the page cannot read.
    if (path === `/api/nodes/${node.id}/system-info`)
      return fulfill(route, { error: 'NODE_UNREACHABLE', message: 'Node agent unreachable' }, 502);
    if (path === `/api/nodes/${node.id}/events`)
      return fulfill(route, { events: [], nextCursor: null });
    if (path === `/api/nodes/${node.id}/logs`)
      return fulfill(route, { entries: [], nextCursor: null, hasMore: false });
    // App-shell requests, in the shapes the other audit specs serve.
    if (path === '/api/providers/catalog') return fulfill(route, { catalogs: [] });
    if (path === '/api/agents') return fulfill(route, { agents: [] });
    if (path === '/api/github/installations') return fulfill(route, []);
    if (path === '/api/credentials') return fulfill(route, []);
    if (path === '/api/credentials/agent') return fulfill(route, { credentials: [] });
    return fulfill(route, {});
  });
  await page.route('**/api/nodes/*/logs/stream**', (route) => route.abort());
  return manualDeletionRequests;
}

/**
 * Node names are generated IDs with no break opportunities. `assertNoOverflow`
 * did not flag them running off a 375px screen, so measure where the long name
 * actually ends (rule 56).
 */
async function assertNodeNameFitsViewport(page: Page) {
  const ends = await page
    .getByText(STUCK_NODE.name)
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().right));
  expect(ends.length).toBeGreaterThanOrEqual(2); // breadcrumb + overview heading
  const viewportWidth = page.viewportSize()?.width ?? 0;
  for (const right of ends) expect(right).toBeLessThanOrEqual(viewportWidth);
}

async function dismissOnboarding(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-node-1', 'true');
  });
}

for (const viewport of [
  { name: 'mobile', width: 375, height: 667, isMobile: true },
  { name: 'desktop', width: 1280, height: 800, isMobile: false },
]) {
  test.describe(`Node manual deletion — ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
    });

    test('a node SAM failed to delete offers removal and removes it on confirm', async ({
      page,
    }) => {
      await dismissOnboarding(page);
      const requests = await setupMocks(page, STUCK_NODE);
      await page.goto(`/nodes/${STUCK_NODE.id}`);

      const button = page.getByRole('button', { name: 'I already deleted this server' });
      await expect(button).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/exact provider credential binding is missing/)).toBeVisible();
      await assertNoOverflow(page);
      await assertNodeNameFitsViewport(page);
      await screenshot(page, `node-manual-deletion-${viewport.name}`);

      let dialogText = '';
      page.once('dialog', (dialog) => {
        dialogText = dialog.message();
        void dialog.accept();
      });
      await button.click();

      await expect(page).toHaveURL(/\/nodes$/, { timeout: 10_000 });
      expect(dialogText).toContain("this node's hetzner server");
      expect(requests).toEqual([{ confirmed: true }]);
    });

    test('a refusal keeps the node page and shows why', async ({ page }) => {
      await dismissOnboarding(page);
      const requests = await setupMocks(page, STUCK_NODE, {
        status: 409,
        body: {
          error: 'CONFLICT',
          message: 'Server 123456 still exists at hetzner. Delete it there first, then try again.',
        },
      });
      await page.goto(`/nodes/${STUCK_NODE.id}`);

      page.once('dialog', (dialog) => void dialog.accept());
      await page.getByRole('button', { name: 'I already deleted this server' }).click();

      await expect(page.getByText(/still exists at hetzner/).first()).toBeVisible({
        timeout: 10_000,
      });
      expect(requests).toHaveLength(1);
      await expect(page).toHaveURL(new RegExp(`/nodes/${STUCK_NODE.id}$`));
      await assertNoOverflow(page);
      await screenshot(page, `node-manual-deletion-refused-${viewport.name}`);
    });

    test('a running node does not offer manual removal', async ({ page }) => {
      await dismissOnboarding(page);
      await setupMocks(page, {
        ...STUCK_NODE,
        status: 'running',
        healthStatus: 'healthy',
        errorMessage: null,
      });
      await page.goto(`/nodes/${STUCK_NODE.id}`);

      // Liveness first: the page rendered its actions, so the absence below means
      // something (rule 62).
      await expect(page.getByRole('button', { name: 'Delete Node' })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('button', { name: 'I already deleted this server' })).toHaveCount(
        0
      );
    });
  });
}
