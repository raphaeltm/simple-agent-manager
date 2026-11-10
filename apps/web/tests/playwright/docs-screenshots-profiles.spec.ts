/**
 * Documentation screenshots for a project's Profiles page (Agents guide, "Agent Profiles"):
 * each profile's model, what it asks for, and the usage of the account it runs on.
 *
 * Uses the Profiles audit's mocked API (`profiles-page-fixtures.ts`) with the profiles renamed,
 * a fictional user and project, so the image shows ordinary names.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-profiles \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser } from './audit-helpers';
import { docsShot } from './docs-shot';
import { NORMAL, openProfiles, USER } from './profiles-page-fixtures';

const DOCS_NAMES: Record<string, string> = {
  'Astra High': 'Code Reviewer',
  'Backend Implementation': 'Backend Builder',
  Claudiii: 'Careful Builder',
  'Fable chat': 'Brainstormer',
  Instant: 'Quick Questions',
  OC: 'OpenCode Explorer',
};

const DANA = makeMockUser({
  email: 'dana@example.com',
  name: 'Dana Reyes',
  sessionId: 'session-docs-profiles',
  userId: USER.user.id,
});

test('docs: the Profiles page with resources and usage', async ({ page }) => {
  await openProfiles(page, {
    profiles: NORMAL.map((p) => ({ ...p, name: DOCS_NAMES[p.name] ?? p.name })),
    user: DANA,
    projects: [{ id: 'p-web', name: 'Payments API' }],
  });
  await expect(page.getByTestId('profile-usage-strip')).toHaveCount(5);
  const row = (name: string) =>
    page.getByTestId('profile-row').filter({ has: page.getByRole('button', { name }) });
  await expect(row('Careful Builder')).toContainText('4 vCPU · 7.5 GB');
  await expect(row('Backend Builder')).toContainText('Medium VM');
  await expect(row('Quick Questions')).toContainText('Instant container');
  await expect(row('OpenCode Explorer')).toContainText('No account connected');
  await assertNoOverflow(page);
  await page.mouse.move(2, 2);
  if ((page.viewportSize()?.width ?? 0) < 500) {
    await page.setViewportSize({ width: 375, height: 900 });
    await docsShot(page, 'profiles-page-mobile');
    return;
  }
  // Keep to the page itself: from the heading down to the last row, without the sidebar.
  const heading = (await page.getByRole('heading', { name: 'Agent Profiles' }).boundingBox())!;
  const last = (await row('OpenCode Explorer').boundingBox())!;
  const top = heading.y - 24;
  await docsShot(page, 'profiles-page', {
    clip: {
      x: last.x - 24,
      y: top,
      width: last.width + 48,
      height: last.y + last.height + 24 - top,
    },
  });
});
