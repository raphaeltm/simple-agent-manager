import { expect, test } from '@playwright/test';

import { audit } from './automation-audit-helpers';
import { PROJECT_ID, setupAutomationMocks, TRIGGERS } from './automation-fixtures';

test('new GitHub automation leaves default queue values for server clamping', async ({ page }) => {
  await setupAutomationMocks(page);
  const trigger = {
    ...TRIGGERS.github,
    githubConfig: {
      ...TRIGGERS.github.githubConfig!,
      subjectAffinity: false,
      queueMaxPending: 20,
      queueTtlSeconds: 43200,
    },
  };
  let submitted: Record<string, unknown> | undefined;
  await page.route(`**/api/projects/${PROJECT_ID}/triggers`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    submitted = route.request().postDataJSON();
    trigger.name = String(submitted!.name);
    return route.fulfill({ status: 201, json: trigger });
  });
  await page.route(`**/api/projects/${PROJECT_ID}/triggers/${trigger.id}`, (route) =>
    route.fulfill({ json: trigger })
  );
  await page.goto(`/projects/${PROJECT_ID}/automation/new?start=github`);
  await page.getByTestId('automation-editor-next').click();
  await page.getByLabel('What should it do?', { exact: true }).fill('Review the issue safely.');
  await page.getByLabel('Agent', { exact: true }).selectOption('profile-codex');
  await page.getByTestId('automation-editor-next').click();
  await page.getByLabel('Name', { exact: true }).fill('Server bounded defaults');
  await page.getByTestId('automation-editor-next').click();
  await expect.poll(() => submitted).toBeTruthy();
  const config = submitted!.githubConfig as Record<string, unknown>;
  expect(config).not.toHaveProperty('queueMaxPending');
  expect(config).not.toHaveProperty('queueTtlSeconds');
  await expect(page).toHaveURL(new RegExp(`/trigger/${trigger.id}$`));
  await page.getByText('Advanced', { exact: true }).click();
  await expect(page.getByText('20', { exact: true })).toBeVisible();
  await expect(page.getByText('12 hours', { exact: true })).toBeVisible();
  await audit(page, 'opus-fix-queue-clamped-defaults');
});

test('filter-only editing preserves a saved queue above the current ceiling', async ({ page }) => {
  await setupAutomationMocks(page);
  const trigger = {
    ...TRIGGERS.github,
    githubConfig: {
      ...TRIGGERS.github.githubConfig!,
      subjectAffinity: true,
      queueMaxPending: 500,
      queueTtlSeconds: 86400,
    },
  };
  let submitted: Record<string, unknown> | undefined;
  await page.route(`**/api/projects/${PROJECT_ID}/triggers/${trigger.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      submitted = route.request().postDataJSON();
      trigger.githubConfig.filters = { ...trigger.githubConfig.filters, commandPrefix: '/help' };
      return route.fulfill({ json: trigger });
    }
    return route.fulfill({ json: trigger });
  });
  await page.goto(`/projects/${PROJECT_ID}/automation/trigger/${trigger.id}/edit`);
  await page.getByLabel('Command prefix', { exact: true }).fill('/help');
  await page.getByTestId('automation-editor-next').click();
  await page.getByTestId('automation-editor-next').click();
  await page.getByTestId('automation-editor-next').click();
  await expect.poll(() => submitted).toBeTruthy();
  const config = submitted!.githubConfig as Record<string, unknown>;
  expect(config).not.toHaveProperty('queueMaxPending');
  expect(config).not.toHaveProperty('queueTtlSeconds');
  expect(config).not.toHaveProperty('subjectAffinity');
  expect(config.filters).toMatchObject({ commandPrefix: '/help' });
  await expect(page).toHaveURL(new RegExp(`/trigger/${trigger.id}$`));
  await page.getByText('Advanced', { exact: true }).click();
  await expect(page.getByText('500', { exact: true })).toBeVisible();
  await audit(page, 'opus-fix-queue-preserved-filter-edit');
});

for (const field of ['queueMaxPending', 'queueTtlSeconds'] as const) {
  test(`server ${field} limit appears beside its editor field`, async ({ page }) => {
    await setupAutomationMocks(page);
    let submitted: Record<string, unknown> | undefined;
    await page.route(`**/api/projects/${PROJECT_ID}/triggers/${TRIGGERS.github.id}`, (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      submitted = route.request().postDataJSON();
      return route.fulfill({
        status: 400,
        json: {
          error: 'BAD_REQUEST',
          message: `${field} must be between 1 and ${field === 'queueMaxPending' ? 100 : 43200}`,
        },
      });
    });
    await page.goto(`/projects/${PROJECT_ID}/automation/trigger/${TRIGGERS.github.id}/edit`);
    await page.getByTestId('automation-editor-next').click();
    await page.getByTestId('automation-editor-next').click();
    await page.getByText('Advanced options', { exact: true }).click();
    const input = page.getByLabel(
      field === 'queueMaxPending' ? 'Pending event limit' : 'Maximum wait (hours)',
      { exact: true }
    );
    await input.fill(field === 'queueMaxPending' ? '500' : '48');
    await page.getByText('Advanced options', { exact: true }).click();
    await page.getByTestId('automation-editor-next').click();
    await expect.poll(() => submitted).toBeTruthy();
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAttribute('aria-describedby', /.+/);
    const alert = page.getByRole('alert');
    await expect(alert).not.toContainText(field);
    await expect(alert).toContainText(field === 'queueMaxPending' ? '100' : '12');
    if (field === 'queueTtlSeconds') await expect(alert).toContainText(/hours/);
    await audit(page, `opus-fix-queue-${field}-server-error`);
  });
}
