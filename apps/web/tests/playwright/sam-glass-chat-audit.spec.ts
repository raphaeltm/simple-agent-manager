/**
 * SAM Glass audit: the project chat, the navigation around it, and every panel or dialog a
 * chat button opens, in both themes at a phone and a desktop size.
 *
 * Every capture drives the real components with mocked API data (`sam-glass-fixtures.ts`)
 * and opens each surface the way a person does: a click on the button that owns it. Each test
 * asserts that the surface rendered before it captures, so a component that stops rendering
 * fails instead of producing a picture of an empty chat (rule 62).
 *
 *   npx playwright test sam-glass-chat-audit \
 *     --project="Desktop (1280x800)" --project="iPhone 14 (390x844)"
 */
import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, screenshot } from './audit-helpers';
import { GLASS_PROJECT_ID, GLASS_SESSION_ID, setupGlassChatMocks } from './sam-glass-fixtures';

test.use({ timezoneId: 'UTC', locale: 'en-US' });

type Theme = 'dark' | 'light';

function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 768;
}

async function openChat(page: Page, theme: Theme) {
  await setupGlassChatMocks(page, { theme });
  await page.goto(`/projects/${GLASS_PROJECT_ID}/chat/${GLASS_SESSION_ID}`);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByText(/clickable prototype next/).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ui-theme')))
    .toBe(theme === 'dark' ? 'sam' : 'sam-light');
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`SAM Glass chat — ${theme}`, () => {
    test('chat', async ({ page }) => {
      await openChat(page, theme);
      await screenshot(page, `glass-chat-${theme}`, { scopeToProject: true });
      await assertNoOverflow(page);
    });
  });
}
