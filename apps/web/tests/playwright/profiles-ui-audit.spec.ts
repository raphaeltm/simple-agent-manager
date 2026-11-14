/**
 * Visual audit for the project Agent Profiles list: a table on desktop, three-line
 * rows on phones, with each profile's resource request and the usage of the
 * account it runs on.
 *
 * Account rows come from the unit-test fixtures, so which account a profile
 * resolves to is computed by the real account model and shared resolver.
 */
import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, screenshot, seedTheme } from './audit-helpers';
import { NORMAL, openProfiles, type Profile, profile } from './profiles-page-fixtures';

const LONG = 'Overnight-Migration-Reviewer-With-An-Unbroken-Name-'.repeat(3);

const LONG_TEXT: Profile[] = [
  profile('long', `${LONG} <script>alert("x")</script> 日本語 🚀`, {
    description: `A long description with a URL https://example.com/${LONG}`,
    model: 'gemini-3.5-pro-preview-2026-10-experimental-extended-context-window',
    agentType: 'claude-code',
    effort: 'max',
    taskMode: 'task',
    permissionMode: 'acceptEdits',
    resourceRequirementsJson: JSON.stringify({
      minVcpu: 8,
      minMemoryGb: 15.5,
      minDiskGb: 160,
      exclusiveNode: true,
    }),
    isBuiltin: true,
  }),
  profile('a', 'A'),
  ...NORMAL.slice(0, 2),
];

const MANY: Profile[] = Array.from({ length: 30 }, (_, index) =>
  profile(`many-${index}`, `Profile ${index + 1}`, {
    agentType: index % 2 === 0 ? 'claude-code' : 'openai-codex',
    model: index % 3 === 0 ? null : 'claude-opus-5-5',
    vmSizeOverride: index % 4 === 0 ? 'large' : null,
    taskMode: index % 2 === 0 ? 'task' : 'conversation',
  })
);

function audits(viewport: 'mobile' | 'desktop') {
  const shot = (page: Page, name: string) => screenshot(page, `profiles-list-${name}-${viewport}`);

  test('shows each profile with its requests and its account usage', async ({ page }) => {
    await openProfiles(page, { profiles: NORMAL });
    await expect(page.getByTestId('profile-usage-strip')).toHaveCount(5);
    const row = (name: string) =>
      page.getByTestId('profile-row').filter({ has: page.getByRole('button', { name }) });
    // Astra is pinned to the team seat, whose 5h window reset after the sample: all of it left.
    await expect(row('Astra High').getByTestId('profile-usage-strip')).toHaveText(
      /5h\s*100%\s*left\s*↻/
    );
    // Percent LEFT, like the new-chat picker: 94% used reads 6% left.
    await expect(row('Backend Implementation').getByTestId('profile-usage-strip')).toHaveText(
      /5h\s*6%\s*left/
    );
    await expect(row('Claudiii')).toContainText('4 vCPU · 7.5 GB');
    await expect(row('Backend Implementation')).toContainText('Medium VM');
    await expect(row('Instant')).toContainText('Instant container');
    await expect(row('OC')).toContainText('No account connected');
    // Column labels belong to the desktop table only; phones stack each row instead.
    const usageHeader = page.getByText('Usage', { exact: true });
    if (viewport === 'desktop') await expect(usageHeader).toBeVisible();
    else await expect(usageHeader).toBeHidden();
    await assertNoOverflow(page);
    await shot(page, 'normal');
  });

  test('reads in the light theme', async ({ page }) => {
    await seedTheme(page, 'light');
    await openProfiles(page, { profiles: NORMAL });
    await expect(page.getByTestId('profile-usage-strip')).toHaveCount(5);
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'sam-light');
    await assertNoOverflow(page);
    await shot(page, 'light');
  });

  test('opens the usage breakdown from the strip', async ({ page }) => {
    await openProfiles(page, { profiles: NORMAL });
    const strip = page
      .getByTestId('profile-row')
      .filter({ has: page.getByRole('button', { name: 'Astra High' }) })
      .getByTestId('profile-usage-strip');
    await strip.click();
    const details = page.getByTestId('credential-limit-details');
    await expect(details).toBeVisible();
    await expect(details).toContainText('reset 2h ago · no sample since');
    await assertNoOverflow(page);
    await shot(page, 'usage-details');
  });

  test('sorts by most room left', async ({ page }) => {
    await openProfiles(page, { profiles: NORMAL });
    await expect(page.getByTestId('profile-usage-strip')).toHaveCount(5);
    await page.getByRole('button', { name: 'Most room' }).click();
    // Codex Team seat: 42% left on the week; Raph Max: 12% left on Opus week.
    await expect(page.getByTestId('profile-row').first()).toContainText('Astra High');
    await shot(page, 'sorted');
  });

  test('long and special-character text wraps without overflow', async ({ page }) => {
    await openProfiles(page, { profiles: LONG_TEXT });
    await expect(page.getByTestId('profile-row')).toHaveCount(LONG_TEXT.length);
    await expect(page.getByText('own node')).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'long-text');
  });

  test('delete asks for confirmation from the actions menu', async ({ page }) => {
    await openProfiles(page, { profiles: LONG_TEXT });
    await page.getByRole('button', { name: /^Actions for Overnight/ }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: /^Confirm delete Overnight/ })).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'delete-confirm');
  });

  test('many profiles', async ({ page }) => {
    await openProfiles(page, { profiles: MANY });
    await expect(page.getByTestId('profile-row')).toHaveCount(30);
    await assertNoOverflow(page);
    await shot(page, 'many');
  });

  test('empty state', async ({ page }) => {
    await openProfiles(page, { profiles: [] });
    await expect(page.getByText(/No profiles yet/)).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'empty');
  });

  test('error state', async ({ page }) => {
    await openProfiles(page, { profiles: [], failProfiles: true });
    await expect(page.locator('.text-danger')).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'error');
  });
}

test.describe('Profiles list — mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });
  audits('mobile');
});

test.describe('Profiles list — desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });
  audits('desktop');
});
