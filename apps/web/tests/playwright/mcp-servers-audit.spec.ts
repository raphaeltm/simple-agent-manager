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
  headerNames?: string[];
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
    headerNames: [],
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
    headerNames: ['x-api-key'],
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
  // Header names are bounded at 64 characters of [A-Za-z0-9_-], so the widest realistic row is
  // several maximum-length names with no break opportunity between hyphens.
  makeConnection({
    id: 'l3',
    name: 'many-headers',
    authType: 'none',
    hasToken: false,
    headerNames: [
      `x-${'a'.repeat(62)}`,
      'X-Composio-Consumer-Api-Key',
      'x_org_id',
      'x-team',
      `X_${'Z'.repeat(62)}`,
    ],
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
    headerNames: i % 5 === 0 ? ['x-api-key', 'x-org-id'] : [],
  })
);

const SPECIAL = [
  makeConnection({ id: 's1', name: 'emoji-host', urlHost: 'https://xn--ls8h.example.com' }),
  makeConnection({
    id: 's2',
    name: 'script-tag',
    urlHost: 'https://<script>alert(1)</script>.com',
  }),
  makeConnection({ id: 's3', name: 'unicode', urlHost: 'https://日本語ドメイン.example.com' }),
];

async function setupMocks(page: Page, options: { connections?: unknown[]; error?: boolean } = {}) {
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

const PROJECT = {
  id: 'proj-mcp-1',
  name: 'Composio Project',
  repository: 'acme/app',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: 'user-test-1',
  createdAt: '2026-08-23T00:00:00Z',
  updatedAt: '2026-08-23T00:00:00Z',
};

/** The same manager, rendered in its project scope under Project Settings → Runtime. */
async function gotoProjectRuntime(page: Page, connections: unknown[]) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);
  await setupAuditRoutes(page, (path, respond) => {
    if (path.includes('/api/auth/get-session')) return respond(200, MOCK_USER);
    if (path === `/api/projects/${PROJECT.id}/mcp-connections`) {
      return respond(200, { items: connections });
    }
    if (path === `/api/projects/${PROJECT.id}/runtime-config`) {
      return respond(200, { envVars: [], files: [] });
    }
    if (path === `/api/projects/${PROJECT.id}`) return respond(200, PROJECT);
    if (path === '/api/projects') return respond(200, { projects: [PROJECT], nextCursor: null });
    if (path.includes('/sessions')) return respond(200, { sessions: [], total: 0 });
    if (path.includes('/api/credentials')) return respond(200, []);
    return undefined;
  });
  await page.goto(`/projects/${PROJECT.id}/settings/runtime`);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-testid="onboarding-wizard"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'MCP servers' })).toBeVisible();
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

    // Five header names, two of them 64 unbroken characters, on one row.
    const headersLine = page.getByText(/^Headers:/);
    await headersLine.scrollIntoViewIfNeeded();
    await expect(headersLine).toBeVisible();
    const box = await headersLine.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await audit(page, `mcp-servers-long-headers-row-${label}`);
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

  test('add form with custom headers keeps every row inside the viewport', async ({ page }) => {
    await setupMocks(page, { connections: NORMAL });
    await gotoMcpServers(page);

    await page.getByRole('button', { name: /^add$/i }).click();
    await page.getByLabel(/Authentication/i).selectOption('none');
    await page.getByRole('button', { name: /add header/i }).click();
    await page.getByLabel('Header 1 name').fill('x-api-key');
    await page.getByLabel('x-api-key value').fill('ak_live_1234567890');
    await page.getByRole('button', { name: /add header/i }).click();
    await page.getByLabel('Header 2 name').fill(`x-${'a'.repeat(62)}`);

    // The row's layout claim, measured (rule 17): on a phone the value takes its own line
    // under the name; from `sm` up the name, value and remove button share one line.
    const name = await page.getByLabel('Header 1 name').boundingBox();
    const value = await page.getByLabel('x-api-key value').boundingBox();
    const remove = await page.getByRole('button', { name: 'Remove x-api-key' }).boundingBox();
    expect(name && value && remove).toBeTruthy();
    const viewportWidth = page.viewportSize()!.width;
    if (viewportWidth < 640) {
      expect(value!.y).toBeGreaterThanOrEqual(name!.y + name!.height - 1);
      expect(remove!.y).toBeLessThan(value!.y);
    } else {
      expect(Math.abs(value!.y - name!.y)).toBeLessThanOrEqual(2);
      expect(value!.x).toBeGreaterThanOrEqual(name!.x + name!.width);
      expect(remove!.x).toBeGreaterThanOrEqual(value!.x + value!.width);
    }
    expect(remove!.x + remove!.width).toBeLessThanOrEqual(viewportWidth);
    await audit(page, `mcp-servers-add-form-headers-${label}`);
  });

  test('edit form shows saved header names with blank, keep-by-default values', async ({
    page,
  }) => {
    await setupMocks(page, { connections: LONG_TEXT });
    await gotoMcpServers(page);

    await page.getByRole('button', { name: 'Edit many-headers' }).click();
    const form = page.getByRole('form', { name: 'Edit many-headers' });
    await expect(form).toBeVisible();
    await expect(form.getByText('X-Composio-Consumer-Api-Key', { exact: true })).toBeVisible();
    await expect(form.getByLabel('X-Composio-Consumer-Api-Key value')).toHaveValue('');
    await expect(form.getByLabel('X-Composio-Consumer-Api-Key value')).toHaveAttribute(
      'placeholder',
      'Leave blank to keep'
    );
    // Only one form at a time: the header Add button is withdrawn while editing.
    await expect(page.getByRole('button', { name: /^add$/i })).toHaveCount(0);
    await audit(page, `mcp-servers-edit-form-${label}`);
  });

  test('project runtime settings list header names for a shared server', async ({ page }) => {
    const shared = NORMAL.map((connection) => ({ ...connection, projectId: PROJECT.id }));
    await gotoProjectRuntime(page, shared);

    const headerNames = page.getByText('x-api-key', { exact: true });
    await headerNames.scrollIntoViewIfNeeded();
    await expect(headerNames).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit composio' })).toBeVisible();
    await audit(page, `mcp-servers-project-runtime-${label}`);
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
