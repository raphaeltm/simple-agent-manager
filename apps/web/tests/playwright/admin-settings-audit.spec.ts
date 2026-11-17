import { expect, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';
const user = makeMockUser({
  email: 'operator@example.com',
  name: 'Operator',
  role: 'superadmin',
  sessionId: 'settings-session',
  userId: 'settings-admin',
});
const makeSettings = () =>
  Array.from({ length: 32 }, (_, i) => ({
    name: i === 1 ? 'connector.invalidStoredSetting' : `connector.stressSetting${i}`,
    type: i === 0 ? 'boolean' : 'string',
    defaultValue: i === 0 ? true : '',
    value:
      i === 0
        ? true
        : i === 1
          ? ''
          : '<script>alert("x")</script> & Unicode 🔒 ' + 'long-value-'.repeat(25),
    category: i < 16 ? 'Connector' : 'Operations',
    description: 'Long operator description with Unicode 🔒 & <script>inert text</script>. '.repeat(
      4
    ),
    secret: false,
    risky: true,
    configured: i !== 1,
    source: i === 1 ? 'default' : 'database',
    ...(i === 1
      ? { storedValueInvalid: true, storedValue: '<script>invalid</script>' + 'x'.repeat(240) }
      : {}),
    updatedAt: null,
    updatedBy: null,
  }));
test('settings real app stress, search, risky confirmation and error recovery', async ({
  page,
}) => {
  page.on('pageerror', (error) => console.error('Browser error:', error.message));
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-settings-admin', 'true')
  );
  let fail = false;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/credentials' || path === '/api/github/installations')
      return route.fulfill({ json: [] });
    if (path === '/api/credentials/agent') return route.fulfill({ json: { credentials: [] } });
    if (path === '/api/trial-status') return route.fulfill({ json: { isTrial: false } });
    if (path === '/api/dashboard/active-tasks') return route.fulfill({ json: { tasks: [] } });
    let body: unknown = {};
    if (path.includes('/auth/get-session')) body = user;
    else if (path === '/api/admin/settings') {
      if (route.request().method() === 'PATCH') {
        fail = true;
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'CONFLICT', message: 'stale' }),
        });
      }
      body = {
        revision: fail ? 2 : 1,
        settings: makeSettings(),
        history: [
          {
            name: 'connector.enabled',
            action: 'set',
            actorUserId: 'operator-' + 'x'.repeat(220),
            createdAt: '2026-10-16T10:00:00Z',
            revision: 1,
          },
        ],
      };
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
  await expect(page.locator('article')).toHaveCount(32);
  await expect(page.getByText('Default in effect, stored value invalid.')).toBeVisible();
  const invalidCard = page
    .locator('article')
    .filter({ hasText: 'Default in effect, stored value invalid.' });
  await expect(invalidCard.getByRole('button', { name: 'Reset override' })).toBeEnabled();
  await assertNoOverflow(page);
  await screenshot(page, 'admin-settings-stress');
  await page.getByRole('searchbox').fill('invalidStoredSetting');
  await expect(page.locator('article')).toHaveCount(1);
  await invalidCard.scrollIntoViewIfNeeded();
  await screenshot(page, 'admin-settings-invalid-stored');
  await page.evaluate(() => document.documentElement.setAttribute('data-ui-theme', 'sam-light'));
  await screenshot(page, 'admin-settings-invalid-stored-light');
  await page.evaluate(() => document.documentElement.setAttribute('data-ui-theme', 'sam'));
  const invalidReset = invalidCard.getByRole('button', { name: 'Reset override' });
  await invalidReset.scrollIntoViewIfNeeded();
  await expect(invalidReset).toBeInViewport();
  await screenshot(page, 'admin-settings-invalid-reset-actions');
  await invalidReset.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await screenshot(page, 'admin-settings-invalid-reset-confirmation');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  if (test.info().project.name.startsWith('iPhone SE')) {
    await page.setViewportSize({ width: 320, height: 667 });
    await assertNoOverflow(page);
    await invalidReset.scrollIntoViewIfNeeded();
    await expect(invalidReset).toBeInViewport();
    await screenshot(page, 'admin-settings-invalid-reset-actions-narrow');
    await page.setViewportSize({ width: 375, height: 667 });
  }
  await page.getByRole('searchbox').fill('stressSetting0');
  await page.getByLabel('connector · stress Setting0').selectOption('false');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, 'admin-settings-confirmation');
  await page.getByRole('button', { name: 'Apply change' }).click();
  await expect(page.getByRole('alert')).toContainText('Settings changed');
  await page.getByRole('alert').scrollIntoViewIfNeeded();
  await screenshot(page, 'admin-settings-conflict');
  await page.getByRole('button', { name: 'Reload current settings' }).click();
  await expect(page.getByText('1 settings · Revision 2')).toBeVisible();
  await expect(page.getByLabel('connector · stress Setting0')).toHaveValue('false');
  await page.getByRole('searchbox').fill('missing setting');
  await expect(page.getByText('No settings match your search.')).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, 'admin-settings-empty');
  if (test.info().project.name.startsWith('iPhone SE')) {
    await page.setViewportSize({ width: 320, height: 667 });
    await page.getByRole('searchbox').fill('stressSetting0');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'admin-settings-confirmation-narrow');
  }
});

test('all OAuth providers save and reset pairs without revealing secrets or duplicate writes', async ({
  page,
}) => {
  const providers = ['github', 'google', 'googleInfrastructure', 'gitlab'];
  const settings = providers.flatMap((provider) =>
    ['clientId', 'clientSecret'].map((suffix) => ({
      name: `integration.${provider}.${suffix}`,
      type: 'string',
      defaultValue: null,
      value: suffix === 'clientSecret' ? null : '',
      category: 'OAuth',
      description: `Configure ${provider} OAuth credential.`,
      secret: suffix === 'clientSecret',
      risky: true,
      configured: false,
      source: 'default',
      updatedAt: null,
      updatedBy: null,
    }))
  );
  let revision = 1;
  const writes: { revision: number; changes: { name: string; value: string | null }[] }[] = [];
  let failNext = false;
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-settings-admin', 'true')
  );
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path.includes('/auth/get-session')) return route.fulfill({ json: user });
    if (path === '/api/admin/settings') {
      if (route.request().method() === 'PATCH') {
        const payload = route.request().postDataJSON();
        writes.push(payload);
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (failNext) {
          failNext = false;
          return route.fulfill({ status: 500, json: { message: 'untrusted-secret-detail' } });
        }
        for (const change of payload.changes) {
          const setting = settings.find((item) => item.name === change.name)!;
          setting.configured = change.value !== null;
          setting.source = setting.configured ? 'database' : 'default';
          setting.value = setting.secret ? null : (change.value ?? '');
        }
        revision++;
      }
      return route.fulfill({ json: { revision, settings, history: [] } });
    }
    if (path === '/api/credentials' || path === '/api/github/installations')
      return route.fulfill({ json: [] });
    if (path === '/api/credentials/agent') return route.fulfill({ json: { credentials: [] } });
    if (path === '/api/projects')
      return route.fulfill({ json: { projects: [], nextCursor: null } });
    if (path === '/api/setup/status')
      return route.fulfill({ json: { completed: true, open: false } });
    return route.fulfill({ json: { tasks: [], notifications: [], unreadCount: 0, count: 0 } });
  });
  await page.goto('/admin/settings');
  await expect(page.locator('article')).toHaveCount(8);
  for (const provider of providers) {
    const id = page.locator(`[id="setting-integration.${provider}.clientId"]`);
    const secret = page.locator(`[id="setting-integration.${provider}.clientSecret"]`);
    const card = id.locator('xpath=ancestor::article');
    await id.fill(`${provider}-client-id`);
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Enter both');
    await secret.fill(`${provider}-private-secret`);
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toContainText('private-secret');
    await assertNoOverflow(page);
    if (provider === 'googleInfrastructure')
      await screenshot(page, 'admin-settings-oauth-confirmation');
    const count = writes.length;
    await page.getByRole('button', { name: 'Apply change' }).dblclick();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes).toHaveLength(count + 1);
    expect(writes.at(-1)?.changes).toEqual([
      { name: `integration.${provider}.clientId`, value: `${provider}-client-id` },
      { name: `integration.${provider}.clientSecret`, value: `${provider}-private-secret` },
    ]);
    await expect(secret).toHaveValue('');
    await expect(secret).toHaveAttribute('type', 'password');
    await card.getByRole('button', { name: 'Reset override' }).click();
    await page.getByRole('button', { name: 'Apply change' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes.at(-1)?.changes).toEqual([
      { name: `integration.${provider}.clientId`, value: null },
      { name: `integration.${provider}.clientSecret`, value: null },
    ]);
  }
  await page.getByRole('heading', { name: 'Runtime settings' }).scrollIntoViewIfNeeded();
  await screenshot(page, 'admin-settings-oauth');
  const id = page.locator('[id="setting-integration.github.clientId"]');
  const secret = page.locator('[id="setting-integration.github.clientSecret"]');
  await id.fill('retry-client-id');
  await secret.fill('retry-private-secret');
  failNext = true;
  await id
    .locator('xpath=ancestor::article')
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await page.getByRole('button', { name: 'Apply change' }).click();
  await expect(page.getByRole('alert')).toContainText('Save could not be confirmed');
  await expect(page.getByRole('alert')).not.toContainText('untrusted-secret-detail');
  await expect(secret).toHaveValue('retry-private-secret');
  await page.getByRole('alert').scrollIntoViewIfNeeded();
  await screenshot(page, 'admin-settings-network-error');
  await page.getByRole('button', { name: 'Reload current settings' }).click();
  await expect(
    id.locator('xpath=ancestor::article').getByRole('button', { name: 'Save', exact: true })
  ).toBeEnabled();
  await expect(secret).toHaveValue('retry-private-secret');
  await assertNoOverflow(page);
});
