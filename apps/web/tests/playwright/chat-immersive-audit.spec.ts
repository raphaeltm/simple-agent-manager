/**
 * Visual and behavioural audit for project chat's open agent messages and the phone-only
 * immersive view ("Show only the conversation").
 *
 * Drives the REAL project chat page with mocked API data (`setupGlassChatMocks`) and reaches
 * every behaviour the way a user does: the toggle is clicked, never called. Layout claims are
 * asserted as measured coordinates, not screenshots (`apps/web/.claude/rules/17-ui-visual-testing.md`).
 *
 * Screenshots land in `.codex/tmp/playwright-screenshots/` as `chat-immersive-*`.
 */
import { expect, type Locator, type Page, type Route, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeIdleSessionState,
  screenshot,
} from './audit-helpers';
import {
  GLASS_MESSAGES,
  GLASS_NOW,
  GLASS_PROJECT_ID,
  GLASS_SESSION_ID,
  GLASS_SESSIONS,
  setupGlassChatMocks,
} from './sam-glass-fixtures';

test.use({ timezoneId: 'UTC', locale: 'en-US' });

type Theme = 'dark' | 'light';
const MINUTE = 60_000;

/** A wide table and an unbroken URL: the content that was cut off inside an 80% bubble. */
const WIDE_REPLY = [
  'All three PRs have merged in order. PR1 and PR2 are in production; PR3 should deploy within the hour.',
  '',
  '| PR | Merged | In production | Notes |',
  '| --- | --- | --- | --- |',
  '| PR1 #2501, Foundations | 18:00 yesterday | ✅ | Clean deploy, no follow-ups |',
  '| PR2 #2504, Eyes | 04:36 | ✅ deployed 07:12 along with the fix for the deploy blocker | The deploy blocker was a stale migration tag |',
  '| PR3 #2502, Hands + memory | 07:40 | ⏳ next after the current run | Waiting on Deploy Production |',
  '',
  'Health check: https://api.example.com/health/this-is-a-very-long-unbroken-path-segment-that-keeps-going-and-going',
  '',
  'Nothing needs you right now. I will check the PR3 deploy when it finishes.',
].join('\n');

const MESSAGES = [
  ...GLASS_MESSAGES,
  {
    id: 'msg-immersive-user',
    sessionId: GLASS_SESSION_ID,
    role: 'user',
    content: 'ok',
    toolMetadata: null,
    createdAt: GLASS_NOW - 3 * MINUTE,
    sequence: GLASS_MESSAGES.length + 1,
  },
  {
    id: 'msg-immersive-wide',
    sessionId: GLASS_SESSION_ID,
    role: 'assistant',
    content: WIDE_REPLY,
    toolMetadata: null,
    createdAt: GLASS_NOW - 2 * MINUTE,
    sequence: GLASS_MESSAGES.length + 2,
  },
];

function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 768;
}

async function openChat(page: Page, theme: Theme) {
  await setupGlassChatMocks(page, { theme });
  // Registered after the shared mocks, so these win for the open chat's transcript.
  const open = GLASS_SESSIONS.find((s) => s.id === GLASS_SESSION_ID);
  await page.route(
    (url) => url.pathname === `/api/projects/${GLASS_PROJECT_ID}/sessions/${GLASS_SESSION_ID}`,
    (route: Route) =>
      route.fulfill({
        json: { session: open, messages: MESSAGES, hasMore: false, state: makeIdleSessionState() },
      })
  );
  await page.route(
    (url) =>
      url.pathname === `/api/projects/${GLASS_PROJECT_ID}/sessions/${GLASS_SESSION_ID}/messages`,
    (route: Route) => route.fulfill({ json: { messages: MESSAGES, hasMore: false } })
  );
  await page.goto(`/projects/${GLASS_PROJECT_ID}/chat/${GLASS_SESSION_ID}`);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByText(/Nothing needs you right now/)).toBeVisible({ timeout: 20_000 });
  // Bring the newest reply fully into view, as a reader at the bottom of the chat sees it.
  const scroll = page.getByRole('button', { name: 'Scroll to bottom' });
  if ((await scroll.count()) > 0) await scroll.click();
  await page.waitForTimeout(400);
}

function chrome(page: Page, name: 'app-bar' | 'session-header' | 'tool-rail' | 'composer') {
  return page.locator(`[data-immersive-chrome="${name}"]`).first();
}

function conversation(page: Page): Locator {
  return page.getByRole('log', { name: 'Conversation' });
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no layout box');
  return b;
}

/** The wide agent reply's container and the row it sits in. */
async function wideReplyGeometry(page: Page) {
  return page.evaluate(() => {
    const replies = Array.from(document.querySelectorAll('.glass-msg-agent'));
    const reply = replies.find((el) => el.textContent?.includes('Nothing needs you right now'));
    if (!reply || !reply.parentElement) return null;
    const r = reply.getBoundingClientRect();
    const row = reply.parentElement.getBoundingClientRect();
    const cs = getComputedStyle(reply);
    return {
      width: r.width,
      rowWidth: row.width,
      left: r.left,
      rowLeft: row.left,
      background: cs.backgroundColor,
      borderWidth: cs.borderTopWidth,
      boxShadow: cs.boxShadow,
    };
  });
}

async function waitForSlideToFinish(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.getAnimations().filter((a) => a.playState === 'running' || a.playState === 'paused')
          .length
      )
    )
    .toBe(0);
  // The finished enter slide leaves its last frame held; wait out the settle + slide either way.
  await page.waitForTimeout(150);
}

for (const theme of ['dark', 'light'] as const) {
  test(`agent replies lie on the surface at the full row width; your messages stay bubbles (${theme})`, async ({
    page,
  }) => {
    await openChat(page, theme);
    const geometry = await wideReplyGeometry(page);
    expect(geometry, 'the wide agent reply must be laid out').not.toBeNull();
    // No bubble: no fill, no border, no shadow.
    expect(geometry!.background).toBe('rgba(0, 0, 0, 0)');
    expect(geometry!.borderWidth).toBe('0px');
    expect(geometry!.boxShadow).toBe('none');
    expect(Math.abs(geometry!.left - geometry!.rowLeft)).toBeLessThanOrEqual(1);
    if (isPhone(page)) {
      // The whole row, not 80% of it.
      expect(Math.abs(geometry!.width - geometry!.rowWidth)).toBeLessThanOrEqual(1);
    } else {
      // Capped for reading on wider screens (46rem), never wider than the row.
      expect(geometry!.width).toBeLessThanOrEqual(Math.min(geometry!.rowWidth, 736) + 1);
    }

    // Liveness: your own message is still a bubble. It sits above the tall reply, so scroll up
    // until the virtualized list renders it.
    const userBubble = page.locator('.glass-msg-user').last();
    await expect
      .poll(async () => {
        await page.getByTestId('virtuoso-scroller').evaluate((el) => el.scrollBy(0, -300));
        return userBubble.count();
      })
      .toBeGreaterThan(0);
    await expect(userBubble).toBeVisible();
    const userBorder = await userBubble.evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(userBorder).not.toBe('0px');

    await assertNoOverflow(page);
    // At 768px the session header already clips its title on main, unrelated to messages:
    // tasks/backlog/2026-11-04-session-header-title-clipped-at-tablet-width.md
    if (page.viewportSize()?.width !== 768) await assertNoClippedOverflow(page);
    await screenshot(page, `chat-immersive-open-messages-${theme}`);
  });
}

test.describe('immersive view on a phone', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`the toggle slides the chrome away and the conversation fills the screen (${theme})`, async ({
      page,
    }) => {
      test.skip(!isPhone(page), 'phone-only control');
      await openChat(page, theme);
      const viewport = page.viewportSize()!;

      const before = {
        appBar: await box(chrome(page, 'app-bar')),
        header: await box(chrome(page, 'session-header')),
        rail: await box(chrome(page, 'tool-rail')),
        composer: await box(chrome(page, 'composer')),
        log: await box(conversation(page)),
        reply: (await wideReplyGeometry(page))!.width,
      };

      await page.getByRole('button', { name: 'Show only the conversation' }).click();
      await waitForSlideToFinish(page);

      for (const name of ['app-bar', 'session-header', 'tool-rail', 'composer'] as const) {
        await expect(chrome(page, name), `${name} slides away`).toBeHidden();
      }
      const toggle = page.getByRole('button', { name: 'Show the rest of the app' });
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');

      // The conversation takes the screen: within the 6px frame on every side.
      const log = await box(conversation(page));
      expect(log.y).toBeLessThanOrEqual(8);
      expect(log.y + log.height).toBeGreaterThanOrEqual(viewport.height - 8);
      expect(log.x).toBeLessThanOrEqual(8);
      expect(log.x + log.width).toBeGreaterThanOrEqual(viewport.width - 8);
      // The reply gained the rail's and the frame's width.
      const reply = (await wideReplyGeometry(page))!.width;
      expect(reply).toBeGreaterThan(before.reply + 40);
      // Liveness: the conversation still renders its content.
      await expect(page.getByText(/Nothing needs you right now/)).toBeVisible();
      await assertNoOverflow(page);
      await screenshot(page, `chat-immersive-on-${theme}`);

      await toggle.click();
      await waitForSlideToFinish(page);

      // Everything is back where it was, with nothing left pinned.
      const after = {
        appBar: await box(chrome(page, 'app-bar')),
        header: await box(chrome(page, 'session-header')),
        rail: await box(chrome(page, 'tool-rail')),
        composer: await box(chrome(page, 'composer')),
        log: await box(conversation(page)),
      };
      for (const key of ['appBar', 'header', 'rail', 'composer', 'log'] as const) {
        expect(Math.abs(after[key].y - before[key].y), `${key} top`).toBeLessThanOrEqual(1);
        expect(Math.abs(after[key].x - before[key].x), `${key} left`).toBeLessThanOrEqual(1);
        expect(Math.abs(after[key].width - before[key].width), `${key} width`).toBeLessThanOrEqual(
          1
        );
      }
      await expect(page.locator('[data-immersive-pinned]')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Show only the conversation' })
      ).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByRole('combobox')).toBeVisible();
      await assertNoOverflow(page);
      await screenshot(page, `chat-immersive-off-${theme}`);
    });
  }

  test('the slide animates only transform and opacity', async ({ page }) => {
    test.skip(!isPhone(page), 'phone-only control');
    await openChat(page, 'dark');
    // Slow the slide right down so it can be inspected mid-flight.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.05 });

    for (const name of ['Show only the conversation', 'Show the rest of the app']) {
      await page.getByRole('button', { name }).click();
      await expect
        .poll(() => page.evaluate(() => document.getAnimations().length), { timeout: 5000 })
        .toBeGreaterThan(0);
      const animated = await page.evaluate(() =>
        Array.from(
          new Set(
            document
              .getAnimations()
              .flatMap((a) =>
                (a.effect as KeyframeEffect)
                  .getKeyframes()
                  .flatMap((frame) =>
                    Object.keys(frame).filter(
                      (k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)
                    )
                  )
              )
          )
        ).sort()
      );
      expect(animated).toEqual(['opacity', 'transform']);
      // Mid-slide, the conversation already has its final size: the layout changed once, up
      // front, and the slide does not resize it.
      const midSlide = await box(conversation(page));
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
      await waitForSlideToFinish(page);
      const settled = await box(conversation(page));
      expect(Math.abs(settled.y - midSlide.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(settled.height - midSlide.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(settled.width - midSlide.width)).toBeLessThanOrEqual(1);
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
    }
  });
});

test('there is no immersive toggle off the phone layout', async ({ page }) => {
  test.skip(isPhone(page), 'checks the tablet and desktop layouts');
  await openChat(page, 'dark');
  // Liveness: the conversation rendered, so the absence below is not a blank page.
  await expect(conversation(page)).toBeVisible();
  await expect(page.getByTestId('chat-immersive-toggle')).toHaveCount(0);
  await expect(page.locator('[data-chat-immersive]')).toHaveCount(0);
  await assertNoOverflow(page);
  await screenshot(page, 'chat-immersive-desktop-dark');
});
