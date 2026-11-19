import { expect, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const user = makeMockUser({
  email: 'operator@example.com',
  name: 'Operator',
  role: 'superadmin',
  sessionId: 'ops-settings-session',
  userId: 'ops-settings-admin',
});

// Mirrors apps/api/src/services/admin-settings-operator-definitions.ts.
const debuggerTools = {
  name: 'operations.debuggerTools',
  type: 'enum',
  defaultValue: 'off',
  choices: ['off', 'read', 'read_ask', 'read_auto_safe'],
  category: 'Operations',
  description:
    'Which debugger tools agents in the Operations project may use. off: none. read: read-only tools. read_ask: read-only tools, plus actions that each need a human approval. read_auto_safe: like read_ask, but low-risk actions run without approval. Only tasks owned by an active superadmin can use them.',
  secret: false,
  risky: true,
  configured: false,
  source: 'default',
  updatedAt: null,
  updatedBy: null,
};

function makeSettings(mode: string) {
  return [
    {
      ...debuggerTools,
      value: mode,
      configured: mode !== 'off',
      source: mode === 'off' ? 'default' : 'database',
    },
    {
      name: 'operations.auditRetentionDays',
      type: 'integer',
      defaultValue: 90,
      value: 90,
      range: { min: 1, max: 3650 },
      category: 'Operations',
      description:
        'Days an Operations debugger tool audit row is kept before the daily purge deletes it.',
      secret: false,
      risky: false,
      configured: false,
      source: 'default',
      updatedAt: null,
      updatedBy: null,
    },
    ...Array.from({ length: 30 }, (_, i) => ({
      name: `operations.stressSetting${i}`,
      type: 'integer',
      defaultValue: i,
      value: i,
      range: { min: 0, max: 2_147_483_647 },
      category: 'Operations',
      description: 'Long operator description with Unicode 🔒 & <script>inert</script>. '.repeat(3),
      secret: false,
      risky: false,
      configured: false,
      source: 'default',
      updatedAt: null,
      updatedBy: null,
    })),
  ];
}

test('superadmin turns on Operations debugger tools from Admin → Settings', async ({ page }) => {
  page.on('pageerror', (error) => console.error('Browser error:', error.message));
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-ops-settings-admin', 'true')
  );
  let mode = 'off';
  let revision = 1;
  const patches: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/credentials' || path === '/api/github/installations')
      return route.fulfill({ json: [] });
    if (path === '/api/credentials/agent') return route.fulfill({ json: { credentials: [] } });
    if (path === '/api/trial-status') return route.fulfill({ json: { isTrial: false } });
    if (path === '/api/dashboard/active-tasks') return route.fulfill({ json: { tasks: [] } });
    let body: unknown = {};
    if (path.includes('/auth/get-session')) body = user;
    else if (path === '/api/admin/settings') {
      if (route.request().method() === 'PATCH') {
        const payload = route.request().postDataJSON() as {
          changes: { name: string; value: string }[];
        };
        patches.push(payload);
        mode = payload.changes[0]?.value ?? mode;
        revision += 1;
      }
      body = { revision, settings: makeSettings(mode), history: [] };
    } else if (path === '/api/projects') body = { projects: [], nextCursor: null };
    else if (path === '/api/notifications/unread-count') body = { count: 0 };
    else if (path === '/api/notifications')
      body = { notifications: [], unreadCount: 0, nextCursor: null };
    else if (path === '/api/setup/status')
      body = { completed: true, open: false, forced: false, tokenConfigured: true };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'Runtime settings' })).toBeVisible();
  await page.getByRole('searchbox').fill('debugger');
  const select = page.getByLabel('operations · debugger Tools');
  await expect(select).toHaveValue('off');
  await expect(select.locator('option')).toHaveText(['off', 'read', 'read_ask', 'read_auto_safe']);
  await assertNoOverflow(page);
  await screenshot(page, 'admin-operations-debugger-tools-off');

  await select.selectOption('read_ask');
  await page
    .locator('article', { has: select })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, 'admin-operations-debugger-tools-confirm');
  await page.getByRole('button', { name: 'Apply change' }).click();

  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({
    expectedRevision: 1,
    changes: [{ name: 'operations.debuggerTools', value: 'read_ask' }],
  });
  await expect(page.getByLabel('operations · debugger Tools')).toHaveValue('read_ask');
  await assertNoOverflow(page);
  await screenshot(page, 'admin-operations-debugger-tools-read-ask');

  await page.getByRole('searchbox').fill('');
  await expect(page.locator('article')).toHaveCount(32);
  await assertNoOverflow(page);
  await screenshot(page, 'admin-operations-settings-many');
});
