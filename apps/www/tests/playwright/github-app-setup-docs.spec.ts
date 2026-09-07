import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from './fixtures';
import { expectNoHorizontalOverflow } from './self-host-overflow-helpers';

const screenshotDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../.codex/tmp/playwright-screenshots'
);
const events = [
  'check_run',
  'check_suite',
  'issue_comment',
  'issues',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'push',
  'repository',
  'workflow_run',
];
const cases = [
  { name: 'personal', domain: 'example.com', app: 'Release review', org: null },
  { name: 'organization', domain: 'example.com', app: 'Team review', org: 'acme-corp' },
  {
    name: 'long',
    domain: `${'long-domain-'.repeat(4)}example.internal.example-company.org`,
    app: `日本語 🚀 <img src=x onerror="alert(1)"> ${'unbroken'.repeat(40)}`,
    org: 'review-ü-<script>alert(1)</script>',
  },
];

async function auditPreview(page: Page, name: string) {
  await expectNoHorizontalOverflow(page);
  const measurements = await page
    .locator('#url-preview, #settings-preview, #settings-preview dd')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: element.id || element.tagName,
          right: rect.right,
          left: rect.left,
          client: element.clientWidth,
          scroll: element.scrollWidth,
        };
      })
    );
  expect(measurements.length).toBeGreaterThan(2);
  for (const measure of measurements) {
    expect(measure.left, `${measure.name} left edge`).toBeGreaterThanOrEqual(0);
    expect(measure.right, `${measure.name} right edge`).toBeLessThanOrEqual(
      page.viewportSize()!.width
    );
    expect(
      measure.scroll,
      `${measure.name} must not hide clipped preview text`
    ).toBeLessThanOrEqual(measure.client + 1);
  }
  await capture(page, `github-app-setup-docs-${name}`);
}

async function capture(page: Page, name: string) {
  mkdirSync(screenshotDir, { recursive: true });
  const viewport = page.viewportSize()!;
  await page.screenshot({
    path: resolve(screenshotDir, `${name}-${viewport.width}x${viewport.height}.png`),
  });
}

test.describe('Embedded docs GitHub App setup', () => {
  test.use({ reducedMotion: 'reduce' });
  test('scheduled actions guide is reachable from the real documentation sidebar', async ({
    page,
  }) => {
    await page.goto('/docs/guides/self-hosting/');
    if (page.viewportSize()!.width < 800)
      await page.locator('button[aria-controls="starlight__sidebar"]').click();
    const guide = page
      .locator('#starlight__sidebar')
      .getByRole('link', { name: 'Scheduled actions and event watches', exact: true });
    await guide.scrollIntoViewIfNeeded();
    await expect(guide).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await capture(page, 'scheduled-actions-docs-sidebar');
    await guide.click();
    await expect(page).toHaveURL(/\/docs\/guides\/scheduled-actions\/?$/);
    const title = page.getByRole('heading', {
      level: 1,
      name: 'Scheduled actions and event watches',
    });
    await expect(title).toBeInViewport();
    await expect(page.getByRole('heading', { name: 'Schedule once', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, 'scheduled-actions-docs-guide');
  });
  for (const example of cases) {
    test(`${example.name} generates event permissions and a readable settings preview`, async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      const dialogs: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      await page.goto('/docs/guides/self-hosting/');
      const wizard = page.locator('#github-app-wizard');
      await wizard.scrollIntoViewIfNeeded();
      await expect(wizard).toBeInViewport();
      await expect(
        wizard.getByRole('button', { name: 'Generate Setup Link', exact: true })
      ).toBeDisabled();
      await wizard.locator('#domain-input').fill(example.domain);
      await wizard.getByLabel('App name', { exact: false }).fill(example.app);
      if (example.org) {
        await wizard.getByRole('radio', { name: 'GitHub Organization' }).check();
        await wizard.getByLabel('Organization name', { exact: true }).fill(example.org);
      }
      await wizard.getByRole('button', { name: 'Generate Setup Link', exact: true }).click();
      const preview = wizard.locator('#url-preview');
      await expect(preview).toBeVisible();
      await expect(preview).toBeInViewport();
      const link = wizard.getByRole('link', { name: 'Create GitHub App on GitHub' });
      const href = await link.getAttribute('href');
      expect(href).toBeTruthy();
      const url = new URL(href!);
      expect(url.origin).toBe('https://github.com');
      expect(url.pathname).toBe(
        example.org
          ? `/organizations/${encodeURIComponent(example.org)}/settings/apps/new`
          : '/settings/apps/new'
      );
      expect(url.searchParams.get('name')).toBe(example.app);
      for (const permission of [
        'issues',
        'checks',
        'actions',
        'metadata',
        'pull_requests',
        'email_addresses',
      ])
        expect(url.searchParams.get(permission)).toBe('read');
      expect(url.searchParams.get('contents')).toBe('write');
      expect(url.searchParams.getAll('events[]').sort()).toEqual(events);
      expect(url.searchParams.get('webhook_url')).toBe(
        `https://api.${example.domain}/api/github/webhook`
      );
      await expect(preview).toContainText(
        'Issues (read), Pull requests (read), Checks (read), Actions (read)'
      );
      for (const event of events) await expect(preview).toContainText(event);
      await expect(wizard.locator('#webhook-secret')).toHaveText(/^[a-f0-9]{64}$/);
      await expect(preview.locator('script, img, iframe')).toHaveCount(0);
      await preview.evaluate((element) =>
        element.scrollIntoView({ block: 'start', behavior: 'instant' })
      );
      await auditPreview(page, `${example.name}-preview`);
      await preview.locator('dd').last().scrollIntoViewIfNeeded();
      await expect(preview.locator('dd').last()).toBeInViewport();
      await auditPreview(page, `${example.name}-events`);
      expect(pageErrors).toEqual([]);
      expect(dialogs).toEqual([]);
    });
  }
});
