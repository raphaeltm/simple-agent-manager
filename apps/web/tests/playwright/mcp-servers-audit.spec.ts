import { expect, type Page, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});

interface ConnectionOverrides {
  id: string;
  name: string;
  urlHost?: string;
  authType?: 'none' | 'bearer';
  hasToken?: boolean;
  enabled?: boolean;
  projectId?: string | null;
}

function makeConnection(overrides: ConnectionOverrides) {
  return {
    userId: 'user-test-1',
    projectId: null,
    urlHost: 'https://mcp.zapier.com',
    authType: 'bearer',
    hasToken: true,
    enabled: true,
    createdAt: '2026-08-23T00:00:00Z',
    updatedAt: '2026-08-23T00:00:00Z',
    ...overrides,
  };
}

const NORMAL = [
  makeConnection({ id: 'c1', name: 'zapier' }),
  makeConnection({
    id: 'c2',
    name: 'executor',
    urlHost: 'http://127.0.0.1:4788',
  }),
  makeConnection({
    id: 'c3',
    name: 'composio',
    urlHost: 'https://backend.composio.dev',
    authType: 'none',
    hasToken: false,
  }),
  makeConnection({ id: 'c4', name: 'notion', urlHost: 'https://mcp.notion.com', enabled: false }),
];

// The name charset is bounded server-side, so the realistic overflow risk is the HOST, which
// can be a long pre-signed subdomain, plus the copy around it.
const LONG_TEXT = [
  makeConnection({
    id: 'l1',
    name: 'a-very-long-server-name-here',
    urlHost:
      'https://extremely-long-subdomain-name-for-a-hosted-mcp-gateway-instance.tool-router.composio.dev',
  }),
  makeConnection({
    id: 'l2',
    name: 'x',
    urlHost: 'https://a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r.s.t.u.v.w.x.y.z.example.com',
  }),
];

const MANY = Array.from({ length: 30 }, (_, i) =>
  makeConnection({
    id: `m${i}`,
    name: `server-${i}`,
    urlHost: `https://mcp-${i}.example.com`,
    enabled: i % 3 !== 0,
    authType: i % 4 === 0 ? 'none' : 'bearer',
    hasToken: i % 4 !== 0,
  })
);

const SPECIAL = [
  makeConnection({ id: 's1', name: 'emoji-host', urlHost: 'https://xn--ls8h.example.com' }),
  makeConnection({ id: 's2', name: 'script-tag', urlHost: 'https://<script>alert(1)</script>.com' }),
  makeConnection({ id: 's3', name: 'unicode', urlHost: 'https://日本語ドメイン.example.com' }),
];

async function setupMocks(
  page: Page,
  options: { connections?: unknown[]; error?: boolean } = {}
) {
  // Without this the first-run onboarding wizard covers the page. Playwright would still
  // report the settings content "visible" (it is in the DOM), so every screenshot would
  // capture the modal and every overflow check would measure the modal's layout — the exact
  // failure mode in .claude/rules/62.
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  await setupAuditRoutes(page, (path, respond) => {
    if (path.includes('/api/auth/get-session')) return respond(200, MOCK_USER);
    if (path.includes('/api/mcp-connections')) {
      if (options.error) return respond(500, { error: 'INTERNAL_ERROR', message: 'boom' });
      return respond(200, { items: options.connections ?? [] });
    }
    if (path.includes('/api/credentials')) return respond(200, []);
    return undefined;
  });
}

async function gotoMcpServers(page: Page) {
  await page.goto('/settings/mcp-servers');
  await page.waitForLoadState('networkidle');
  // Fail loudly if the wizard suppression ever stops working, rather than silently
  // screenshotting the modal.
  await expect(page.locator('[data-testid="onboarding-wizard"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'MCP servers' })).toBeVisible();
}

async function audit(page: Page, name: string) {
  await screenshot(page, name);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

function runScenarios(label: string) {
  test('normal data', async ({ page }) => {
    await setupMocks(page, { connections: NORMAL });
    await gotoMcpServers(page);
    await expect(page.getByText('zapier', { exact: true })).toBeVisible();
    await audit(page, `mcp-servers-normal-${label}`);
  });

  test('long host names wrap without overflowing', async ({ page }) => {
    await setupMocks(page, { connections: LONG_TEXT });
    await gotoMcpServers(page);
    await expect(page.getByText('a-very-long-server-name-here', { exact: true })).toBeVisible();
    await audit(page, `mcp-servers-long-text-${label}`);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, { connections: [] });
    await gotoMcpServers(page);
    await expect(page.getByText(/No MCP servers yet/i)).toBeVisible();
    await audit(page, `mcp-servers-empty-${label}`);
  });

  test('many servers', async ({ page }) => {
    await setupMocks(page, { connections: MANY });
    await gotoMcpServers(page);
    await expect(page.getByText('server-0', { exact: true })).toBeVisible();
    await audit(page, `mcp-servers-many-${label}`);
  });

  test('special characters are rendered as text, not markup', async ({ page }) => {
    await setupMocks(page, { connections: SPECIAL });
    await gotoMcpServers(page);
    await expect(page.getByText('script-tag', { exact: true })).toBeVisible();
    // React escapes by default; assert no injected element materialised.
    expect(await page.locator('script:not([src])').count()).toBe(0);
    await audit(page, `mcp-servers-special-${label}`);
  });

  test('error state', async ({ page }) => {
    await setupMocks(page, { error: true });
    await gotoMcpServers(page);
    await audit(page, `mcp-servers-error-${label}`);
  });

  test('add form is usable', async ({ page }) => {
    await setupMocks(page, { connections: NORMAL });
    await gotoMcpServers(page);

    await page.getByRole('button', { name: /^add$/i }).click();
    await expect(page.getByLabel(/MCP endpoint URL/i)).toBeVisible();
    // Selecting "none" must hide the token field so the form cannot ask for a secret the
    // endpoint does not take.
    await page.getByLabel(/Authentication/i).selectOption('none');
    await expect(page.getByLabel(/Bearer token/i)).toHaveCount(0);
    await audit(page, `mcp-servers-add-form-${label}`);
  });
}

test.describe('MCP servers — Mobile', () => {
  runScenarios('mobile');
});

test.describe('MCP servers — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });
  runScenarios('desktop');
});
