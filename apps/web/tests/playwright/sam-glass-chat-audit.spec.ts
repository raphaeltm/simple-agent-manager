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
import { expect, type Locator, type Page, test } from '@playwright/test';

import { assertNoOverflow, screenshot } from './audit-helpers';
import { GLASS_PROJECT_ID, GLASS_SESSION_ID, setupGlassChatMocks } from './sam-glass-fixtures';

test.use({ timezoneId: 'UTC', locale: 'en-US' });

type Theme = 'dark' | 'light';

function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 768;
}

async function openChat(page: Page, theme: Theme, path = `chat/${GLASS_SESSION_ID}`) {
  await setupGlassChatMocks(page, { theme });
  await page.goto(`/projects/${GLASS_PROJECT_ID}/${path}`);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ui-theme')))
    .toBe(theme === 'dark' ? 'sam' : 'sam-light');
  if (path.startsWith('chat/')) {
    await expect(page.getByText(/clickable prototype next/).first()).toBeVisible({
      timeout: 20_000,
    });
  }
}

/** Count of elements with a live backdrop blur: SAM Glass allows at most one. */
async function liveBlurCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('body *')).filter((el) => {
        const style = getComputedStyle(el);
        const filter = style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter');
        return Boolean(filter && filter !== 'none' && el.getClientRects().length > 0);
      }).length
  );
}

async function capture(page: Page, name: string, theme: Theme, surface?: Locator) {
  if (surface) await expect(surface).toBeVisible({ timeout: 15_000 });
  // One live blur at a time: the open overlay, or none.
  expect(await liveBlurCount(page)).toBeLessThanOrEqual(1);
  await screenshot(page, `glass-${name}-${theme}`, { scopeToProject: true });
}

interface Surface {
  name: string;
  /** Limit to one form factor when the surface only exists there. */
  only?: 'phone' | 'desktop';
  path?: string;
  open: (page: Page) => Promise<Locator | undefined>;
}

const tool = (id: string) => (page: Page) => page.getByTestId(`session-tool-${id}`).click();

const SURFACES: Surface[] = [
  {
    name: 'chat',
    open: async (page) => {
      await assertNoOverflow(page);
      return page.getByTestId('session-floating-header');
    },
  },
  {
    name: 'new-chat',
    path: 'chat',
    open: async (page) => page.getByText('What do you want to build?'),
  },
  {
    name: 'chat-list-drawer',
    only: 'phone',
    open: async (page) => {
      await page.getByRole('button', { name: 'Open chat list' }).click();
      return page.getByRole('dialog', { name: 'Chat sessions' });
    },
  },
  {
    name: 'menu-drawer',
    only: 'phone',
    open: async (page) => {
      await page.getByRole('button', { name: 'Open navigation menu' }).click();
      return page.getByTestId('mobile-nav-panel');
    },
  },
  {
    name: 'details',
    open: async (page) => {
      await tool('details')(page);
      return page.getByText('Initial prompt');
    },
  },
  {
    name: 'tool-rail-labels',
    only: 'desktop',
    open: async (page) => {
      await page.getByTestId('session-tool-rail-cycle').click();
      return page.getByTestId('session-tool-rail');
    },
  },
  {
    name: 'files',
    open: async (page) => {
      await tool('files')(page);
      return page.getByRole('dialog', { name: 'File viewer' });
    },
  },
  {
    name: 'git',
    open: async (page) => {
      await tool('git')(page);
      return page.getByRole('dialog', { name: 'File viewer' });
    },
  },
  {
    name: 'timeline',
    open: async (page) => {
      await tool('timeline')(page);
      return page.getByRole('dialog', { name: 'Session timeline' });
    },
  },
  {
    name: 'related',
    open: async (page) => {
      await tool('related')(page);
      return page.getByRole('dialog', { name: 'Related work' });
    },
  },
  {
    name: 'resources',
    open: async (page) => {
      await tool('resources')(page);
      return page.getByRole('dialog', { name: 'Session resources' });
    },
  },
  {
    name: 'automation',
    open: async (page) => {
      await tool('automation')(page);
      return page.getByRole('dialog', { name: 'Automation for this chat' });
    },
  },
  {
    name: 'comments',
    open: async (page) => {
      await tool('comments')(page);
      return isPhone(page)
        ? page.getByRole('dialog', { name: 'Session comments' })
        : page.getByRole('complementary', { name: 'Session comments' });
    },
  },
  {
    name: 'share',
    open: async (page) => {
      await tool('share')(page);
      return page.getByRole('dialog', { name: 'Share chat access' });
    },
  },
  {
    name: 'report',
    open: async (page) => {
      await tool('report')(page);
      return page.getByRole('dialog', { name: 'Report an issue' });
    },
  },
  {
    name: 'complete',
    open: async (page) => {
      await tool('complete')(page);
      return page.getByRole('dialog').filter({ hasText: /complete/i });
    },
  },
  {
    name: 'hierarchy',
    open: async (page) => {
      if (isPhone(page)) {
        await page.getByRole('button', { name: 'Open chat list' }).click();
      }
      await page.getByRole('button', { name: 'Has subtasks', exact: true }).first().click();
      return page.getByRole('tree', { name: 'Task hierarchy' });
    },
  },
  {
    name: 'recent-chats',
    open: async (page) => {
      await page.getByRole('button', { name: /^Recent chats/ }).click();
      return page.getByRole('menu', { name: 'Recent chats' });
    },
  },
  {
    name: 'notifications',
    open: async (page) => {
      await page.getByRole('button', { name: /^Notifications/ }).click();
      return page.getByRole('dialog', { name: 'Notifications' });
    },
  },
  {
    name: 'automation-triggers',
    only: 'desktop',
    open: async (page) => {
      await page.getByRole('button', { name: 'Automation triggers' }).click();
      return page.locator('section[aria-label="Automation triggers"]');
    },
  },
  {
    name: 'command-palette',
    open: async (page) => {
      if (isPhone(page)) {
        await page.getByRole('button', { name: 'Open navigation menu' }).click();
      }
      await page.getByRole('button', { name: 'Open command palette' }).click();
      return page.getByRole('dialog', { name: 'Command palette' });
    },
  },
  {
    name: 'focus-mode',
    only: 'desktop',
    open: async (page) => {
      await page.getByRole('group', { name: 'Focus Mode' }).getByText('Focus').click();
      return page.getByRole('button', { name: /Focus Mode: Focus/ });
    },
  },
  {
    name: 'zen-mode',
    only: 'desktop',
    open: async (page) => {
      await page.getByRole('group', { name: 'Focus Mode' }).getByText('Zen').click();
      return page.getByRole('button', { name: /Navigation \(Zen mode\)/ });
    },
  },
  {
    // An ordinary page in the shell's content pane, to show the generalized wrapper.
    name: 'content-pane',
    path: 'settings/general',
    open: async (page) => page.getByRole('heading', { name: 'Project Settings' }),
  },
];

for (const theme of ['dark', 'light'] as const) {
  test.describe(`SAM Glass chat — ${theme}`, () => {
    for (const surface of SURFACES) {
      test(surface.name, async ({ page }) => {
        const phone = isPhone(page);
        test.skip(surface.only === 'phone' && !phone, 'phone-only surface');
        test.skip(surface.only === 'desktop' && phone, 'desktop-only surface');
        await openChat(page, theme, surface.path);
        const target = await surface.open(page);
        await page.waitForTimeout(350);
        await capture(page, surface.name, theme, target);
      });
    }
  });
}
