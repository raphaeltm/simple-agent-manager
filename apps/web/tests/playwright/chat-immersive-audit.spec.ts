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
// Each case loads the real chat and drives at least one full slide (two in the round trips),
// which does not fit the config's 15s CI default.
test.describe.configure({ timeout: 60_000 });

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

const WIDE_MESSAGES = [
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

/**
 * The same transcript ending in a tail of short turns, like a real chat: when the
 * conversation's width and height change together these reflow, and the list must still end
 * on the newest one.
 */
const TAIL_MESSAGES = [
  ...WIDE_MESSAGES,
  ...['Thanks. Check the deploy again?', 'Checking now.', 'ok', 'HELLO'].map((content, i) => ({
    id: `msg-immersive-tail-${i}`,
    sessionId: GLASS_SESSION_ID,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content,
    toolMetadata: null,
    createdAt: GLASS_NOW - (60 - i * 10) * 1000,
    sequence: WIDE_MESSAGES.length + 1 + i,
  })),
];

function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 768;
}

async function openChat(page: Page, theme: Theme, transcript: 'wide' | 'tail' = 'wide') {
  const MESSAGES = transcript === 'wide' ? WIDE_MESSAGES : TAIL_MESSAGES;
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
  const newest = transcript === 'wide' ? /Nothing needs you right now/ : /^HELLO$/;
  await expect(page.getByText(newest)).toBeVisible({ timeout: 20_000 });
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

/** Width of the newest agent reply on screen. */
async function newestReplyWidth(page: Page) {
  return page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.glass-msg-agent')).at(-1);
    if (!el) throw new Error('no agent reply rendered');
    return el.getBoundingClientRect().width;
  });
}

/** How far the conversation is scrolled up from its newest content, in px. */
async function distanceFromBottom(page: Page) {
  return conversation(page)
    .getByTestId('virtuoso-scroller')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** Playback rate for inspecting a slide mid-flight. */
const SLOW_MOTION = 0.2;

/** Each chrome piece's box, optionally with the slide's current translation taken out. */
async function chromeSlots(page: Page, options: { withoutTransform?: boolean } = {}) {
  return page.evaluate(({ withoutTransform }) => {
    const out: Record<string, { x: number; y: number }> = {};
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>('[data-immersive-chrome]')
    )) {
      if (el.getClientRects().length === 0) continue;
      const r = el.getBoundingClientRect();
      const t = withoutTransform ? new DOMMatrix(getComputedStyle(el).transform) : new DOMMatrix();
      out[el.dataset.immersiveChrome ?? '?'] = { x: r.x - t.m41, y: r.y - t.m42 };
    }
    return out;
  }, options);
}

async function waitForSlideToFinish(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.playState === 'running' || a.playState === 'paused').length
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

    // Liveness: your own message is still a bubble. The conversation opens on the tall reply, so
    // scroll to the top, where the transcript starts with your message, and let the virtualized
    // list render it.
    await conversation(page)
      .getByTestId('virtuoso-scroller')
      .evaluate((el) => el.scrollTo({ top: 0 }));
    const userBubble = page.locator('.glass-msg-user').first();
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
      await openChat(page, theme, 'tail');
      const viewport = page.viewportSize()!;

      const before = {
        appBar: await box(chrome(page, 'app-bar')),
        header: await box(chrome(page, 'session-header')),
        rail: await box(chrome(page, 'tool-rail')),
        composer: await box(chrome(page, 'composer')),
        log: await box(conversation(page)),
        reply: await newestReplyWidth(page),
      };

      // The reader is at the newest message before the tap.
      await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toHaveCount(0);

      await page.getByRole('button', { name: 'Show only the conversation' }).click();
      await waitForSlideToFinish(page);

      // ...and still is after it: growing the conversation must not scroll the newest message
      // away (the list otherwise keeps its top fixed as it grows).
      await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toHaveCount(0);
      expect(await distanceFromBottom(page)).toBeLessThanOrEqual(2);

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
      const reply = await newestReplyWidth(page);
      expect(reply).toBeGreaterThan(before.reply + 40);
      // Liveness: the newest message is still on screen.
      await expect(page.getByText(/^HELLO$/)).toBeVisible();
      await assertNoOverflow(page);
      await screenshot(page, `chat-immersive-on-${theme}`);

      await toggle.click();
      await waitForSlideToFinish(page);
      // Shrinking back keeps the reader at the newest message too.
      await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toHaveCount(0);
      expect(await distanceFromBottom(page)).toBeLessThanOrEqual(2);

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
    // Where each piece sits in the normal layout, before anything is pinned.
    const slots = await chromeSlots(page);

    // Slow the slide right down so it can be inspected mid-flight.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: SLOW_MOTION });

    for (const name of ['Show only the conversation', 'Show the rest of the app']) {
      await page.getByRole('button', { name }).click();
      if (name === 'Show only the conversation') {
        // Pinned exactly where it was: with the slide's own translation taken out, every piece
        // sits on its normal-layout slot, so pinning (and the layout change behind it) does
        // not make anything jump. This is what correctPins() is for: `<main>` contains layout.
        const pinned = await chromeSlots(page, { withoutTransform: true });
        for (const key of Object.keys(slots)) {
          expect(Math.abs(pinned[key]!.x - slots[key]!.x), `${key} left`).toBeLessThanOrEqual(1);
          expect(Math.abs(pinned[key]!.y - slots[key]!.y), `${key} top`).toBeLessThanOrEqual(1);
        }
      }
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
      if (name === 'Show only the conversation') {
        // Pinned over the conversation, the rail carries a fill so its icons do not sit on the
        // message text while it slides.
        const railFill = await chrome(page, 'tool-rail').evaluate(
          (el) => getComputedStyle(el).backgroundColor
        );
        expect(railFill).not.toBe('rgba(0, 0, 0, 0)');
      }
      // Mid-slide, the conversation already has its final size: the layout changed once, up
      // front, and the slide does not resize it.
      const midSlide = await box(conversation(page));
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
      await waitForSlideToFinish(page);
      const settled = await box(conversation(page));
      expect(Math.abs(settled.y - midSlide.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(settled.height - midSlide.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(settled.width - midSlide.width)).toBeLessThanOrEqual(1);
      await cdp.send('Animation.setPlaybackRate', { playbackRate: SLOW_MOTION });
    }
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
    await cdp.detach();
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
