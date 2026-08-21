/**
 * Visual + behavioural audit for the commenting prototype.
 *
 * Run against a DEV server (prototype routes are dev-only):
 *   npx vite --host 0.0.0.0 --port 5173 &
 *   npx playwright test --config=playwright.prototype.config.ts
 *
 * Per rule 62, these do not just assert markup is present — they drive the real
 * affordances (click Comment, type, submit, resolve, select text) and assert the
 * user-visible outcome. Per rule 56, overflow is checked with the blocking
 * clipped-overflow walk, not just the document-level scrollWidth check.
 */

import { expect, type Page, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, screenshot } from './audit-helpers';

const ROUTE = '/prototype/comments';

/**
 * The comment-count marker's accessible name, anchored at both ends.
 * Unanchored, `/comments? on this block/` ALSO matches the "Add a comment on
 * this block" affordance present on every uncommented block — which silently
 * makes any anchoring assertion unfalsifiable.
 */
const COUNT_MARKER_BLOCK = /^\d+ comments? on this block$/;
const COUNT_MARKER_MESSAGE = /^\d+ comments? on this message$/;

/**
 * The prototype is unauthed and has no backend, but it still mounts inside the
 * real App shell — so `AuthProvider` fires a session request at the API origin
 * (`VITE_API_URL` || http://localhost:8787) and gets ERR_CONNECTION_REFUSED.
 * That is expected and unrelated to the surface under test. Everything else,
 * including any uncaught render error, is still a failure.
 */
function isExpectedBackendAbsence(text: string): boolean {
  return text.includes('ERR_CONNECTION_REFUSED') || text.includes('Failed to fetch');
}

async function open(page: Page, opts: { surface?: 'chat' | 'file'; dataset?: string } = {}) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !isExpectedBackendAbsence(m.text())) errors.push(m.text());
  });
  // Uncaught exceptions are never expected — collect them unfiltered.
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(ROUTE);
  await expect(page.getByTestId('comments-prototype')).toBeVisible();
  if (opts.surface === 'file') {
    await page.getByRole('button', { name: 'Markdown file' }).click();
  }
  if (opts.dataset) {
    await page.getByRole('button', { name: opts.dataset, exact: true }).click();
  }
  await page.waitForTimeout(400);
  return errors;
}

async function assertClean(page: Page) {
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

/**
 * The prototype owns an inner `height:100vh; overflow:auto` scroll container
 * (rule 37 + project policy), so Playwright's `fullPage` cannot capture past the
 * fold — every screenshot is one viewport at whatever scroll position the last
 * interaction left behind. Screenshots must therefore be aimed deliberately, or
 * they silently capture the wrong region while the assertions still pass
 * (rule 62: `toBeVisible()` does NOT require the element to be in the viewport).
 */
async function scrollPrototypeToTop(page: Page) {
  await page.getByTestId('comments-prototype').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);
}

/** Brings the subject of the screenshot into the viewport, then asserts it is really there. */
async function focusForShot(page: Page, locator: ReturnType<Page['getByText']>) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await expect(locator).toBeInViewport();
}

test.describe('Commenting prototype', () => {
  test('chat surface renders messages and existing threads', async ({ page }) => {
    const errors = await open(page);

    // Liveness: something positive rendered (rule 62 — absence assertions need a
    // positive counterpart).
    await expect(page.getByTestId('message-m-2')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Commenting prototype' })).toBeVisible();

    // The commented message advertises its thread count.
    await expect(page.getByRole('button', { name: COUNT_MARKER_MESSAGE }).first()).toBeVisible();

    await assertClean(page);
    await scrollPrototypeToTop(page);
    await screenshot(page, 'comments-chat-default');
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('adding a comment on a message shows it in the thread', async ({ page }) => {
    await open(page);

    const message = page.getByTestId('message-m-6');
    await message.getByRole('button', { name: 'Comment' }).click();

    const composer = page.getByPlaceholder('Add a comment…');
    await expect(composer).toBeVisible();
    await composer.fill('Please open a SAM idea for the shared idle predicate.');

    await screenshot(page, 'comments-chat-composer');
    await assertClean(page);

    await page.getByRole('button', { name: 'Comment', exact: true }).last().click();

    // The user-visible outcome: the new thread body is on screen. `toBeVisible`
    // alone would pass for a thread parked below the rail's scroll fold, so
    // assert it is genuinely in the viewport.
    const added = page.getByText('Please open a SAM idea for the shared idle predicate.');
    await expect(added).toBeVisible();
    await focusForShot(page, added);
    await screenshot(page, 'comments-chat-after-add');
  });

  test('"send to agent" marks the comment as an instruction', async ({ page }) => {
    await open(page);

    await page.getByTestId('message-m-6').getByRole('button', { name: 'Comment' }).click();
    await page.getByPlaceholder('Add a comment…').fill('Fix this and push.');
    await page.getByLabel(/Send to agent as an instruction/).check();

    // The submit label changes to reflect the compound action.
    const submit = page.getByRole('button', { name: 'Comment & send' });
    await expect(submit).toBeVisible();
    await submit.click();

    await expect(page.getByText('Fix this and push.')).toBeVisible();
    await expect(page.getByText('Sent to agent').first()).toBeVisible();
    // The agent acknowledgement reply is what makes this different from a note.
    const ack = page.getByText(/Picked this up/);
    await expect(ack).toBeVisible();

    await assertClean(page);
    await focusForShot(page, ack);
    await screenshot(page, 'comments-chat-sent-to-agent');
  });

  test('selecting text offers a quoted comment', async ({ page }) => {
    await open(page);

    // A user selects text they can see, so scroll it into view first.
    await page.getByTestId('message-m-4').scrollIntoViewIfNeeded();

    // Drag across the text with a real pointer rather than dispatching a synthetic
    // mouseup. The synthetic version passed while the feature was dead on a phone,
    // because it fabricated the one event the mobile path never produces.
    const p = page.locator('[data-comment-anchor="m-4"] p').first();
    const box = await p.boundingBox();
    if (!box) throw new Error('paragraph has no layout box');
    // Aim at the FIRST line, not the vertical centre. The paragraph wraps to two
    // lines at 1280px and six at 375px, so `height / 2` lands in the inter-line
    // gap on desktop and selects nothing — which failed only on one viewport.
    const lineY = box.y + 10;
    await page.mouse.move(box.x + 6, lineY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, lineY, { steps: 12 });
    await page.mouse.up();

    const affordance = page.getByRole('dialog', { name: 'Comment on selection' });
    await expect(affordance).toBeVisible();
    await screenshot(page, 'comments-selection-chip');

    await affordance.getByRole('button', { name: /Comment/ }).click();
    // The quoted span is carried into the composer.
    await expect(page.locator('blockquote').first()).toBeVisible();
    await assertClean(page);
    await screenshot(page, 'comments-selection-composer');
  });

  /**
   * REGRESSION — the bug Raphaël hit on his phone.
   *
   * A touch long-press settles the selection *after* `touchend`, and dragging the
   * native selection handles afterwards emits no `touchend` on document at all.
   * `selectionchange` is the only event that covers those paths. This test makes a
   * selection and dispatches NOTHING — no mouseup, no touchend — so it passes only
   * if the hook is driven by `selectionchange`.
   *
   * Verified to fail against the mouseup/keyup/touchend-only implementation.
   */
  test('selection with no mouse or touch event still offers to comment', async ({ page }) => {
    await open(page);
    await page.getByTestId('message-m-4').scrollIntoViewIfNeeded();

    await page.evaluate(() => {
      const p = document.querySelector('[data-comment-anchor="m-4"] p');
      if (!p?.firstChild) throw new Error('no text node to select');
      const range = document.createRange();
      range.setStart(p.firstChild, 0);
      range.setEnd(p.firstChild, Math.min(40, p.firstChild.textContent?.length ?? 0));
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });

    await expect(page.getByRole('dialog', { name: 'Comment on selection' })).toBeVisible({
      timeout: 3000,
    });
  });

  /**
   * The affordance must match the input type. On touch the OS draws its own
   * selection callout directly above the selection, so a floating chip there is
   * covered or fights it for the tap; touch gets a bottom bar instead.
   */
  test('touch gets the bottom bar, mouse gets the floating chip', async ({ page }) => {
    await open(page);
    const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);

    await page.getByTestId('message-m-4').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const p = document.querySelector('[data-comment-anchor="m-4"] p');
      if (!p?.firstChild) throw new Error('no text node to select');
      const range = document.createRange();
      range.setStart(p.firstChild, 0);
      range.setEnd(p.firstChild, Math.min(40, p.firstChild.textContent?.length ?? 0));
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });

    const affordance = page.getByRole('dialog', { name: 'Comment on selection' });
    await expect(affordance).toBeVisible({ timeout: 3000 });

    if (coarse) {
      // Bottom bar: pinned to the viewport floor and showing the captured quote.
      await expect(affordance.getByRole('button', { name: 'Comment on selection' })).toBeVisible();
      const boxes = await Promise.all([
        affordance.boundingBox(),
        page.evaluate(() => window.innerHeight),
      ]);
      const [bar, viewportH] = boxes as [{ y: number; height: number } | null, number];
      if (!bar) throw new Error('no bar box');
      expect(bar.y + bar.height).toBeGreaterThanOrEqual(viewportH - 2);
    } else {
      await expect(affordance.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
    }
    await assertClean(page);
    await screenshot(
      page,
      coarse ? 'comments-selection-touch-bar' : 'comments-selection-chip-mouse'
    );
  });

  test('resolving a thread collapses it', async ({ page }) => {
    await open(page);

    await page.getByRole('button', { name: COUNT_MARKER_MESSAGE }).first().click();
    const resolve = page.getByRole('button', { name: 'Resolve' }).first();
    await resolve.click();

    await expect(page.getByRole('button', { name: /Show resolved thread/ }).first()).toBeVisible();
    await assertClean(page);
    await screenshot(page, 'comments-resolved');
  });

  test('markdown surface anchors comments to blocks', async ({ page }) => {
    const errors = await open(page, { surface: 'file' });

    await expect(page.getByTestId('md-block-0')).toBeVisible();
    // Real markdown rendering, not a mock: the GFM table must be present.
    await expect(page.locator('table').first()).toBeVisible();
    await expect(page.getByRole('button', { name: COUNT_MARKER_BLOCK }).first()).toBeVisible();

    await assertClean(page);
    await scrollPrototypeToTop(page);
    await screenshot(page, 'comments-markdown-default');
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  /**
   * Block ids are positional (`block-N` from `splitMarkdownBlocks`), so editing
   * MARKDOWN_DOC silently re-points every mock comment. Two of them were already
   * off by one when this was written — the comment about the states table landed
   * on the table's *heading*. Pin the mapping so an edit fails loudly.
   */
  test('mock comments anchor to the blocks they describe', async ({ page }) => {
    await open(page, { surface: 'file' });

    // NOTE: match the count marker's label exactly. A loose /comments? on this
    // block/ also matches the "Add a comment on this block" button that renders
    // on every *uncommented* block, which made an earlier version of this test
    // pass with the anchor deliberately broken.
    await expect(page.getByTestId('md-block-3').locator('table')).toBeVisible();
    await expect(
      page.getByTestId('md-row-block-3').getByRole('button', { name: COUNT_MARKER_BLOCK })
    ).toBeVisible();
    // Discriminating control: the table's heading must NOT own the thread.
    await expect(
      page.getByTestId('md-row-block-2').getByRole('button', { name: COUNT_MARKER_BLOCK })
    ).toHaveCount(0);

    // The quoted span must actually exist in the block it claims to quote.
    await expect(page.getByTestId('md-block-7')).toContainText(
      '"The user is not typing" is not idleness.'
    );
    await expect(page.getByTestId('md-block-10')).toContainText('MAX_RECOVERY_ATTEMPTS = 3');
  });

  test('markdown code fence and long URL do not overflow', async ({ page }) => {
    await open(page, { surface: 'file' });
    // The doc contains an unbroken 130-char GitHub URL and a fenced ts block.
    const fence = page.locator('pre').first();
    await expect(fence).toBeVisible();
    await assertClean(page);
    // Aim the shot at the fence — otherwise this captures the same top-of-doc
    // viewport as the previous test and proves nothing about either.
    await fence.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await expect(fence).toBeInViewport();
    await screenshot(page, 'comments-markdown-code-and-url');
  });

  test('empty state', async ({ page }) => {
    await open(page, { dataset: 'Empty' });
    // Positive assertion alongside the absence: messages still render.
    await expect(page.getByTestId('message-m-2')).toBeVisible();
    await expect(page.getByRole('button', { name: COUNT_MARKER_MESSAGE })).toHaveCount(0);
    await assertClean(page);
    await screenshot(page, 'comments-empty');
  });

  test('32 threads stay scannable', async ({ page }) => {
    await open(page, { dataset: '32 threads' });
    await page.getByRole('button', { name: COUNT_MARKER_MESSAGE }).first().click();
    await page.waitForTimeout(400);
    await assertClean(page);
    await screenshot(page, 'comments-many-threads');
  });
});
