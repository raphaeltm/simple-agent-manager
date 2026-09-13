import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

const path = '/blog/how-sam-scheduler-works/';
test.beforeEach(async ({ page }) => {
  await page.route('**/api/t**', (route) => route.fulfill({ status: 204 }));
  await page.goto(path);
});
test('mixed burst, shortage recovery, deadline, and sleep reuse', async ({ page }) => {
  const lab = page.locator('scheduler-explorer');
  const step = lab.getByRole('button', { name: 'Step →', exact: true });
  await lab.getByRole('button', { name: 'Send mixed burst' }).click();
  await step.click();
  await expect(lab.locator('.task[data-status="running"]')).toHaveCount(4);
  await expect(lab.locator('[data-nodes]')).toContainText('1 running · separate runtime');
  await lab.getByRole('button', { name: '03 No capacity' }).click();
  await lab.getByRole('button', { name: 'Send mixed burst' }).click();
  await step.click();
  await expect(lab.locator('.task[data-status="queued"]')).toContainText('provider capacity');
  await lab.getByLabel('Provider has capacity').check();
  for (let i = 0; i < 4; i++) await step.click();
  await expect(lab.locator('.task[data-status="queued"]')).toHaveCount(0);
  await lab.getByRole('button', { name: 'Reset', exact: true }).click();
  await lab.getByRole('button', { name: '⌘ Code', exact: true }).click();
  for (let i = 0; i < 12; i++) await step.click();
  await expect(lab.locator('.task[data-status="failed"]')).toContainText('deadline expired');
  await lab.getByRole('button', { name: '04 Sleep & reuse' }).click();
  await lab.getByRole('button', { name: 'Sleep idle chat' }).click();
  await expect(lab.locator('.task[data-status="sleeping"]')).toContainText(
    'Conversation preserved'
  );
  await lab.getByRole('button', { name: '◌ Chat', exact: true }).click();
  await step.click();
  await expect(lab.locator('.task[data-status="running"]')).toContainText('Warm reuse');
});
test('cold start is serialized, play pauses, and reset is deterministic', async ({ page }) => {
  const lab = page.locator('scheduler-explorer');
  await lab.getByRole('button', { name: '02 Cold start' }).click();
  await lab.getByRole('button', { name: 'Send mixed burst' }).click();
  await lab.getByRole('button', { name: 'Step →' }).click();
  await expect(lab.locator('[data-rack][data-state="booting"]')).toHaveCount(1);
  await expect(lab.locator('[data-tasks]')).toContainText('provisioning lease held');
  await lab.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(lab.locator('[data-clock]')).toHaveText('STEP 02');
  await lab.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(lab).toHaveAttribute('data-playing', 'false');
  await lab.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(lab.locator('[data-clock]')).toHaveText('STEP 00');
  await expect(lab.locator('.task')).toHaveCount(0);
});
test('visual, keyboard, accessibility, stress, and reduced-motion audit', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const lab = page.locator('scheduler-explorer');
  await page.screenshot({
    animations: 'disabled',
    path: `.codex/tmp/playwright-screenshots/scheduler-article-${testInfo.project.name.includes('Mobile') ? 'mobile' : 'desktop'}.png`,
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await lab.getByRole('button', { name: 'Send mixed burst' }).focus();
  await page.keyboard.press('Enter');
  await lab.getByRole('button', { name: 'Step →' }).click();
  await expect(lab.locator('.task')).toHaveCount(4);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    animations: 'disabled',
    path: `.codex/tmp/playwright-screenshots/scheduler-${testInfo.project.name.includes('Mobile') ? 'mobile' : 'desktop'}.png`,
    fullPage: true,
  });
  await lab.screenshot({
    animations: 'disabled',
    style: '.header { visibility: hidden !important; }',
    path: `.codex/tmp/playwright-screenshots/scheduler-lab-${testInfo.project.name.includes('Mobile') ? 'mobile' : 'desktop'}.png`,
  });
  const results = await new AxeBuilder({ page })
    .include('scheduler-explorer')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
  for (let i = 0; i < 7; i++) await lab.getByRole('button', { name: 'Send mixed burst' }).click();
  await expect(lab.locator('.task')).toHaveCount(32);
  await expect(lab.getByRole('button', { name: 'Send mixed burst' })).toBeDisabled();
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await lab.screenshot({
    animations: 'disabled',
    style: '.header { visibility: hidden !important; }',
    path: `.codex/tmp/playwright-screenshots/scheduler-stress-${testInfo.project.name.includes('Mobile') ? 'mobile' : 'desktop'}.png`,
  });
  const stressResults = await new AxeBuilder({ page })
    .include('scheduler-explorer')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(stressResults.violations).toEqual([]);
  expect(errors).toEqual([]);
});
test('article remains understandable without JavaScript', async ({
  browser,
  page: currentPage,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(currentPage.url());
  await expect(page.locator('scheduler-explorer noscript p')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'When the cloud says “full”' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send mixed burst' })).toBeHidden();
  await context.close();
});

test('blog discovery and compact 320px layout', async ({ page }, testInfo) => {
  await page.goto('/blog/');
  const post = page
    .getByRole('link')
    .filter({ hasText: 'How SAM’s scheduler makes room for your agents' });
  await expect(post).toHaveCount(1);
  await page.screenshot({
    animations: 'disabled',
    path: `.codex/tmp/playwright-screenshots/scheduler-index-${testInfo.project.name.includes('Mobile') ? 'mobile' : 'desktop'}.png`,
  });
  await post.click();
  await expect(page.locator('scheduler-explorer')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 667 });
  const lab = page.locator('scheduler-explorer');
  await lab.getByRole('button', { name: 'Send mixed burst' }).click();
  await lab.getByRole('button', { name: 'Step →' }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await lab.locator('[data-tasks]').focus();
  await expect(lab.locator('[data-tasks]')).toBeFocused();
});
