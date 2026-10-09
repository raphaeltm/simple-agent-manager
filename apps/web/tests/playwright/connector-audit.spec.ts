import { expect, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';
const user = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin',
  role: 'superadmin',
  sessionId: 'connector-audit',
  userId: 'user-connector',
});
const settings = Object.fromEntries(
  Object.entries({
    enabled: true,
    writeEnabled: true,
    clientRegistration: 'open',
    allowedRedirectHosts: ['claude.ai', 'chatgpt.com', 'loopback'],
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2592000,
    readRateLimitPerMinute: 120,
    writeRateLimitPerMinute: 30,
    maxStartsPerUserPerHour: 10,
    maxStartsPerUserPerDay: 50,
  }).map(([key, value]) => [key, { value, source: 'default', updatedAt: null, updatedBy: null }])
);
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-user-connector', 'true')
  );
  await setupAuditRoutes(page, (path, respond, route) => {
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/auth/get-session') return respond(200, user);
    if (
      path === '/api/credentials' ||
      path === '/api/auth/api-tokens' ||
      path === '/api/github/installations'
    )
      return respond(200, []);
    if (path === '/api/projects') return respond(200, { projects: [], total: 0 });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/connector/settings')
      return respond(200, {
        enabled: true,
        writeEnabled: true,
        url: 'https://api.example.com/connect/mcp',
      });
    if (path === '/api/connector/connections' || path === '/api/admin/connector/connections')
      return respond(200, {
        connections: [
          {
            id: 'grant-1',
            userId: 'user-connector',
            clientName: 'Claude — Research & planning',
            scopes: ['sam.read', 'sam.write', 'offline_access'],
            createdAt: '2026-10-09',
            lastUsedAt: null,
            revokedAt: null,
          },
        ],
      });
    if (path === '/api/connector/consent')
      return respond(
        200,
        route.request().method() === 'POST'
          ? { redirectTo: '/settings/access' }
          : {
              handle: 'bound',
              clientName: 'Claude',
              redirectHost: 'claude.ai',
              loopback: false,
              scopes: ['sam.read', 'sam.write', 'offline_access'],
            }
      );
    if (path === '/api/admin/connector/settings') return respond(200, { settings });
    if (path === '/api/admin/connector/clients')
      return respond(200, {
        clients: [
          {
            id: 'client-1',
            clientName: 'Claude',
            redirectHosts: ['claude.ai'],
            createdAt: '2026-10-09',
            blocked: false,
          },
        ],
      });
    if (path === '/api/admin/platform-config') return respond(200, { status: null });
    return undefined;
  });
});
test('Access has connection instructions and revocation confirmation', async ({ page }) => {
  await page.goto('/settings/access');
  await expect(page.getByRole('heading', { name: 'Connect an AI app' })).toBeVisible();
  await page.getByText('Claude Code and Codex', { exact: true }).click();
  await assertNoOverflow(page);
  await screenshot(page, 'connector-access', { scopeToProject: true });
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, 'connector-revoke', { scopeToProject: true });
});
test('consent names redirect host and denies without granting', async ({ page }) => {
  await page.goto('/oauth/consent?request=client_id%3Dtest');
  await expect(page.getByText('claude.ai', { exact: true })).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, 'connector-consent', { scopeToProject: true });
  const request = page.waitForRequest(
    (r) => r.url().includes('/api/connector/consent') && r.method() === 'POST'
  );
  await page.getByRole('button', { name: 'Deny' }).click();
  expect((await request).postDataJSON()).toEqual({ handle: 'bound', approve: false });
});
test('admin connector settings and clients fit viewport', async ({ page }) => {
  await page.goto('/admin/integrations');
  await expect(page.getByRole('heading', { name: 'Connector', exact: true })).toBeVisible();
  await page.getByRole('heading', { name: 'Connector', exact: true }).scrollIntoViewIfNeeded();
  await assertNoOverflow(page);
  await screenshot(page, 'connector-admin', { scopeToProject: true });
});

test('long untrusted app names, many connections and empty state remain usable at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 667 });
  const name = 'Research 🧪 <script>alert(1)</script> & '.repeat(8);
  await page.route('**/api/connector/connections', (route) =>
    route.fulfill({
      json: {
        connections: Array.from({ length: 30 }, (_, i) => ({
          id: `grant-${i}`,
          clientName: `${name}${i}`,
          scopes: ['sam.read', 'offline_access'],
          createdAt: '2026-10-09',
          lastUsedAt: null,
          revokedAt: null,
        })),
      },
    })
  );
  await page.goto('/settings/access');
  await expect(page.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(30);
  await assertNoOverflow(page);
  await screenshot(page, 'connector-access-long-320', { scopeToProject: true });
  await page.route('**/api/connector/connections', (route) =>
    route.fulfill({ json: { connections: [] } })
  );
  await page.reload();
  await expect(page.getByText('No connected apps.')).toBeVisible();
  await assertNoOverflow(page);
});

test('consent errors are readable without an approval action', async ({ page }) => {
  await page.route('**/api/connector/consent?*', (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: 'invalid_request',
        message: 'This connection request has expired. Start again from your app.',
      },
    })
  );
  await page.goto('/oauth/consent?request=expired');
  await expect(page.getByText(/connection request has expired/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await assertNoOverflow(page);
  await screenshot(page, 'connector-consent-error', { scopeToProject: true });
});
