/**
 * Account Map visual audit: the connections view at every viewport, with realistic, long,
 * hostile, many-item, empty and failing data.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import type { AccountMapResponse } from '../../src/lib/api';
import { accountMapFixture } from '../unit/components/account-map/fixtures';
import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const user = makeMockUser({
  email: 'map@example.com',
  name: 'Map user',
  userId: 'map-user',
  sessionId: 'map-session',
});

const LONG =
  'Improve the account onboarding flow for people with several active projects and many related chats — '.repeat(
    3
  );
const UNBROKEN = 'feature/' + 'x'.repeat(160);

function longTextMap(): AccountMapResponse {
  const base = accountMapFixture();
  return {
    ...base,
    projects: base.projects.map((p, i) =>
      i === 0 ? { ...p, name: LONG, repository: `owner/${'r'.repeat(120)}` } : p
    ),
    sessions: base.sessions.map((s, i) =>
      i === 1
        ? { ...s, topic: '<script>alert(1)</script> 🔐 Ünïcödé &amp; entities' }
        : i === 2
          ? { ...s, topic: LONG }
          : s
    ),
    workspaces: base.workspaces.map((w, i) => (i === 0 ? { ...w, branch: UNBROKEN } : w)),
    ideas: [{ ...base.ideas[0]!, title: LONG }],
  };
}

function manyMap(): AccountMapResponse {
  const base = accountMapFixture();
  const projects = Array.from({ length: 8 }, (_, i) => ({
    id: `mp-${i}`,
    name: i === 3 ? 'X' : `Project ${i}`,
    repository: `acme/project-${i}`,
    status: 'active',
    lastActivityAt: null,
    activeSessionCount: 4,
  }));
  const nodes = Array.from({ length: 12 }, (_, i) => ({
    ...base.nodes[0]!,
    id: `mn-${i}`,
    name: `acme-fsn1-${10 + i}`,
    healthStatus: i === 5 ? 'unhealthy' : 'healthy',
  }));
  const workspaces = Array.from({ length: 36 }, (_, i) => ({
    ...base.workspaces[0]!,
    id: `mw-${i}`,
    nodeId: `mn-${i % 12}`,
    projectId: `mp-${i % 8}`,
    branch: `sam/change-${i}`,
    chatSessionId: `ms-${i}`,
  }));
  const sessions = workspaces.map((w, i) => ({
    ...base.sessions[1]!,
    id: `ms-${i}`,
    projectId: w.projectId as string,
    topic: `Refactor module ${i}`,
    workspaceId: w.id,
    attention: i % 9 === 0 ? { kind: 'needs_input', reason: 'Pick one', createdAt: 1 } : null,
  }));
  return {
    ...base,
    projects,
    nodes,
    workspaces,
    sessions,
    tasks: [],
    ideas: [],
    relationships: [],
  };
}

const EMPTY: AccountMapResponse = {
  ...accountMapFixture(),
  projects: [],
  nodes: [],
  workspaces: [],
  sessions: [],
  tasks: [],
  ideas: [],
  relationships: [],
};

async function setup(page: Page, map: AccountMapResponse | 'error') {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-map-user', 'true')
  );
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/account-map') {
      return map === 'error'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'MAP_UNAVAILABLE',
              message: 'Map temporarily unavailable',
            }),
          })
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(map),
          });
    }
    const body = path.includes('/api/auth/')
      ? user
      : path === '/api/projects'
        ? { projects: [] }
        : path === '/api/dashboard/active-tasks'
          ? { tasks: [] }
          : path === '/api/notifications'
            ? { notifications: [], unreadCount: 0 }
            : [
                  '/api/agents',
                  '/api/nodes',
                  '/api/workspaces',
                  '/api/credentials',
                  '/api/github/installations',
                ].includes(path)
              ? []
              : {};
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

/** The page switches from the grouped list to columns at 1024px. */
const hasColumns = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

test.describe('Account Map', () => {
  test('normal account: selection, path links and lines', async ({ page }) => {
    await setup(page, accountMapFixture());
    await page.goto('/account-map');
    await expect(page.getByRole('heading', { name: 'How it all connects' })).toBeVisible();
    const waiting = page.getByRole('button', { name: /Show wake progress/ });
    await expect(waiting).toHaveAttribute('aria-pressed', 'true');
    const path = page.getByRole('list', { name: 'How this connects' });
    await expect(path).toBeVisible();
    await expect(path.getByRole('link', { name: '#12' })).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/12'
    );
    await assertNoOverflow(page);
    await screenshot(page, 'account-map-normal', { scopeToProject: true });

    if (hasColumns(page)) {
      // Lines start at the row's right edge and end at the workspace's left edge.
      const ends = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="account-map-columns"]') as HTMLElement;
        const box = root.getBoundingClientRect();
        const edge = root.querySelector('path[data-edge="s-1>w-1"]') as SVGPathElement;
        const [x1, , , , , , x2] = (edge.getAttribute('d') ?? '').match(/-?[\d.]+/g)!.map(Number);
        const from = root.querySelector('[data-node="s-1"]')!.getBoundingClientRect();
        const to = root.querySelector('[data-node="w-1"]')!.getBoundingClientRect();
        return {
          x1,
          x2,
          fromRight: from.right - box.left,
          toLeft: to.left - box.left,
          lit: edge.dataset.lit,
        };
      });
      expect(Math.abs(ends.x1! - ends.fromRight)).toBeLessThan(1);
      expect(Math.abs(ends.x2! - ends.toLeft)).toBeLessThan(1);
      expect(ends.lit).toBe('true');
      await expect(page.locator('path[data-lit="true"]')).toHaveCount(2);
    }

    // The idea link opens the idea.
    await path.getByRole('link', { name: 'Wake progress you can see' }).click();
    await expect(page).toHaveURL(/\/projects\/p-sam\/ideas\/i-1$/);
  });

  test('long and hostile text wraps without overflow', async ({ page }) => {
    await setup(page, longTextMap());
    await page.goto('/account-map');
    await expect(
      page.getByText('<script>alert(1)</script> 🔐 Ünïcödé &amp; entities')
    ).toBeVisible();
    await assertNoOverflow(page);
    const rootWidth = await page
      .getByTestId('account-map-root')
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(rootWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
    await screenshot(page, 'account-map-long-text', { scopeToProject: true });
  });

  test('many chats and machines stay usable, and filters narrow them', async ({ page }) => {
    await setup(page, manyMap());
    await page.goto('/account-map');
    await expect(page.getByRole('button', { name: /Refactor module 35/ })).toBeAttached();
    await assertNoOverflow(page);
    await screenshot(page, 'account-map-many', { scopeToProject: true });
    await page
      .getByRole('group', { name: 'Show' })
      .getByRole('button', { name: 'Needs you, 4' })
      .click();
    await expect(page.getByRole('button', { name: /Refactor module/ })).toHaveCount(4);
    await page.getByRole('textbox', { name: 'Search the map' }).fill('module 27');
    await expect(page.getByRole('button', { name: /Refactor module/ })).toHaveCount(1);
    await assertNoOverflow(page);
  });

  test('empty account', async ({ page }) => {
    await setup(page, EMPTY);
    await page.goto('/account-map');
    await expect(page.getByText('Nothing to connect yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show finished' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'account-map-empty', { scopeToProject: true });
  });

  test('a failed load offers a retry', async ({ page }) => {
    await setup(page, 'error');
    await page.goto('/account-map');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'account-map-error', { scopeToProject: true });
  });
});

test.describe('Account Map — light theme', () => {
  test.use({ colorScheme: 'light' });

  test('normal account renders legibly in light mode', async ({ page }) => {
    await setup(page, accountMapFixture());
    await page.goto('/account-map');
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'sam-light');
    await expect(page.getByRole('list', { name: 'How this connects' })).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'account-map-light', { scopeToProject: true });
  });
});
