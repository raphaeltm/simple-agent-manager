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

/**
 * Panes are frosted: each one blurs the void behind it (on its ::after; overlays on themselves).
 * Returns how many visible panes blur, how many blurring elements sit inside another blurring
 * element without being an overlay (they would blur the same backdrop twice), and which panes
 * would trap a `position: fixed` child: a dialog rendered inside a pane must not be confined to
 * the pane, which a backdrop-filter on the pane itself would do.
 */
async function frostedPanes(
  page: Page
): Promise<{ frosted: number; nested: string[]; trapping: string[] }> {
  return page.evaluate(() => {
    const has = (style: CSSStyleDeclaration) => {
      const filter = style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter');
      return Boolean(filter && filter !== 'none' && filter.includes('blur'));
    };
    const blurs = (el: Element) =>
      has(getComputedStyle(el)) ||
      (getComputedStyle(el, '::after').content !== 'none' && has(getComputedStyle(el, '::after')));
    const visible = (el: Element) => el.getClientRects().length > 0;
    const label = (el: Element) =>
      `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`;
    const panes = Array.from(document.querySelectorAll<HTMLElement>('.sam-glass')).filter(visible);
    const frosted = panes.filter(blurs).length;
    const nested = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => visible(el) && blurs(el) && !el.classList.contains('sam-glass-live'))
      .filter((el) => {
        for (let p = el.parentElement; p; p = p.parentElement) if (blurs(p)) return true;
        return false;
      })
      .map(label);
    // The pane itself must not become the containing block for fixed children: a fixed probe
    // inside the pane lands where the same probe inside the pane's parent does.
    const fixedBox = (host: Element) => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;inset:0;pointer-events:none;visibility:hidden';
      host.appendChild(probe);
      const r = probe.getBoundingClientRect();
      probe.remove();
      return r;
    };
    const trapping = panes
      .filter((pane) => !pane.classList.contains('sam-glass-live') && pane.parentElement)
      .filter((pane) => {
        const inside = fixedBox(pane);
        const outside = fixedBox(pane.parentElement!);
        return (
          Math.abs(inside.x - outside.x) > 1 ||
          Math.abs(inside.y - outside.y) > 1 ||
          Math.abs(inside.width - outside.width) > 1 ||
          Math.abs(inside.height - outside.height) > 1
        );
      })
      .map(label);
    return { frosted, nested, trapping };
  });
}

async function capture(page: Page, name: string, theme: Theme, surface?: Locator) {
  if (surface) await expect(surface).toBeVisible({ timeout: 15_000 });
  const { frosted, nested, trapping } = await frostedPanes(page);
  expect(frosted).toBeGreaterThan(0);
  expect(nested).toEqual([]);
  expect(trapping).toEqual([]);
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

test.describe('SAM Glass chat — failed chat', () => {
  // A short phone (browser toolbars or the keyboard showing), where the header, the failure
  // card, the conversation's minimum height and the message box cannot all fit.
  test.use({ viewport: { width: 375, height: 560 } });

  for (const theme of ['dark', 'light'] as const) {
    test(`the failure card gives up height before the session header (${theme})`, async ({
      page,
    }) => {
      await setupGlassChatMocks(page, {
        theme,
        openSessionError: 'The agent process exited before it reported a result.',
      });
      await page.goto(`/projects/${GLASS_PROJECT_ID}/chat/${GLASS_SESSION_ID}`);
      await expect(page.getByText(/clickable prototype next/).first()).toBeVisible({
        timeout: 20_000,
      });
      // Liveness: the failure card is on screen, sharing the column with the header.
      await expect(page.getByTestId('failure-card-shell')).toBeVisible();
      const header = page.getByTestId('session-header');
      await expect(header).toBeVisible();
      // Nothing in the collapsed header is clipped: its title and chips fit inside it.
      const clipped = await header.evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(clipped).toBeLessThanOrEqual(1);
      // ...and the failure card keeps at least its first line; the rest scrolls.
      const failureHeight = (await page.getByTestId('failure-card-shell').boundingBox())!.height;
      expect(failureHeight).toBeGreaterThanOrEqual(40);
      await capture(page, 'failed-chat', theme);
    });
  }
});

test.describe('SAM Glass chat — pane edges', () => {
  test('no container between a chat pane and the void clips its shadow', async ({ page }) => {
    await openChat(page, 'light');
    const clipping = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.sam-glass'))
        .filter((pane) => pane.getClientRects().length > 0)
        .flatMap((pane) => {
          const found: string[] = [];
          for (
            let a = pane.parentElement;
            a && !a.classList.contains('sam-void');
            a = a.parentElement
          ) {
            const s = getComputedStyle(a);
            if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
              found.push(`${a.tagName.toLowerCase()}.${String(a.className).slice(0, 50)}`);
            }
          }
          return found;
        })
    );
    // Liveness: the chat's panes are on screen.
    await expect(page.getByTestId('session-floating-header')).toBeVisible();
    expect([...new Set(clipping)]).toEqual([]);
  });

  test('the message box draws no outline inside its slab', async ({ page }) => {
    await openChat(page, 'light');
    const footer = page.getByTestId('session-footer');
    // Liveness: the dock's centre button sits on the slab.
    await expect(
      footer.getByRole('button', { name: /sleep|archive|interrupt|stop/i }).first()
    ).toBeVisible();
    // Icons are small SVGs; the old dock outline was an SVG as wide as the slab.
    const wideSvgs = await footer
      .locator('svg')
      .evaluateAll((svgs) => svgs.filter((svg) => svg.getBoundingClientRect().width > 120).length);
    expect(wideSvgs).toBe(0);
  });

  test('the chat list header carries only the project name', async ({ page }) => {
    test.skip(isPhone(page), 'the desktop chat list pane');
    await openChat(page, 'light');
    await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Automation triggers' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Project settings' })).toHaveCount(0);
  });

  test('a page in the content pane paints no background over the glass', async ({ page }) => {
    await setupGlassChatMocks(page, { theme: 'light' });
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'Projects' }).first()).toBeAttached({
      timeout: 15_000,
    });
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    const root = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      const first = main.firstElementChild as HTMLElement;
      return {
        background: getComputedStyle(first).backgroundColor,
        fills: first.getBoundingClientRect().height >= main.clientHeight - 1,
      };
    });
    expect(root.background).toBe('rgba(0, 0, 0, 0)');
    expect(root.fills).toBe(true);
  });
});
