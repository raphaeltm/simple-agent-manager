import { expect, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

test('GitHub queue admin limits save and reset through runtime settings', async ({ page }) => {
  const user = makeMockUser({
    email: 'operator@example.com',
    name: 'Operator',
    role: 'superadmin',
    sessionId: 'queue-settings-session',
    userId: 'queue-settings-admin',
  });
  const settings = [
    {
      name: 'operations.githubTriggerQueueMaxPendingLimit',
      defaultValue: 1000,
      description:
        'Most pending events allowed when someone creates an automation or changes its queue limit. Saved automations and waiting events keep their settings.',
    },
    {
      name: 'operations.githubTriggerQueueTtlSecondsLimit',
      defaultValue: 2592000,
      description:
        'Longest wait allowed, in seconds (default: 30 days). Applies when someone creates an automation or changes its maximum wait. Saved automations and waiting events keep their settings.',
    },
  ].map((setting) => ({
    ...setting,
    value: setting.defaultValue,
    type: 'integer',
    category: 'Operations',
    secret: false,
    risky: false,
    configured: false,
    source: 'default',
    updatedAt: null,
    updatedBy: null,
    range: { min: 1, max: Number.MAX_SAFE_INTEGER },
  }));
  let revision = 1;
  const writes: { expectedRevision: number; changes: { name: string; value: number | null }[] }[] =
    [];
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-queue-settings-admin', 'true')
  );
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path.includes('/auth/get-session')) return route.fulfill({ json: user });
    if (path === '/api/admin/settings') {
      if (route.request().method() === 'PATCH') {
        const payload = route.request().postDataJSON();
        expect(payload.expectedRevision).toBe(revision);
        writes.push(payload);
        for (const change of payload.changes) {
          const setting = settings.find((entry) => entry.name === change.name)!;
          setting.value = change.value ?? setting.defaultValue;
          setting.configured = change.value !== null;
          setting.source = setting.configured ? 'database' : 'default';
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
  await expect(page.getByRole('heading', { name: 'Runtime settings' })).toBeVisible();
  await expect(page.locator('article')).toHaveCount(2);
  for (const card of await page.locator('article').all())
    await expect(card).not.toContainText('9007199254740991');
  await expect(page.getByText(/Minimum: 1/)).toHaveCount(2);
  await expect(page.getByText(/default: 30 days/)).toBeVisible();
  for (const setting of settings)
    await expect(page.locator(`[id="setting-${setting.name}"]`)).toHaveValue(
      String(setting.defaultValue)
    );
  await assertNoOverflow(page);
  const captureCards = async (state: string) => {
    for (const [index, setting] of settings.entries()) {
      const card = page
        .locator(`[id="setting-${setting.name}"]`)
        .locator('xpath=ancestor::article');
      await card.scrollIntoViewIfNeeded();
      await assertNoOverflow(page);
      await screenshot(page, `opus-fix-admin-${index === 0 ? 'pending' : 'ttl'}-${state}`);
    }
  };
  await captureCards('default');
  for (const [index, setting] of settings.entries()) {
    const input = page.locator(`[id="setting-${setting.name}"]`);
    await expect(input).toHaveAttribute('type', 'number');
    await input.fill(String(index === 0 ? 2000 : 5184000));
    await input
      .locator('xpath=ancestor::article')
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect.poll(() => writes.length).toBe(index + 1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes.at(-1)?.changes).toEqual([
      { name: setting.name, value: index === 0 ? 2000 : 5184000 },
    ]);
    await expect(input).toHaveValue(String(index === 0 ? 2000 : 5184000));
  }
  await assertNoOverflow(page);
  await captureCards('override');
  for (const setting of settings) {
    const input = page.locator(`[id="setting-${setting.name}"]`);
    await input
      .locator('xpath=ancestor::article')
      .getByRole('button', { name: 'Reset override' })
      .click();
    await screenshot(
      page,
      `opus-fix-admin-${setting.name.includes('MaxPending') ? 'pending' : 'ttl'}-reset-confirmation`
    );
    await page.getByRole('button', { name: 'Apply change' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes.at(-1)?.changes).toEqual([{ name: setting.name, value: null }]);
    await expect(input).toHaveValue(String(setting.defaultValue));
  }
  expect(writes).toHaveLength(4);
  await captureCards('reset');
  if (page.viewportSize()?.width === 375) {
    await page.setViewportSize({ width: 320, height: 667 });
    await assertNoOverflow(page);
    await captureCards('narrow');
  }
});
