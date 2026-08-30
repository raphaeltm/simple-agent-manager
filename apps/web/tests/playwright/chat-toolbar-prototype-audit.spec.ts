/**
 * Visual + behavioral audit for the chat tool-strip prototype.
 *
 * Captures the "before" baseline (`variant=none` — today's production behaviour, every
 * tool behind the header chevron) alongside both variations across the three strip
 * modes, session states, and stress data, at mobile and desktop.
 *
 * The interaction tests drive the REAL controls — the header's own chevron, the strip's
 * own cycle button, the strip's own tool buttons — rather than setting state directly
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`).
 */
import { expect, type Page, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, screenshot } from './audit-helpers';

const ROUTE = '/prototype/chat-toolbar';

async function open(page: Page, query: string) {
  // `chrome=0` suppresses the scenario switcher so it never lands in a screenshot.
  await page.goto(`${ROUTE}?chrome=0&${query}`);
  await expect(page.getByTestId('harness-scenario')).toBeAttached();
  // Liveness: a crashed page also has no overflow and no strip, so assert the real
  // surface rendered before trusting any other assertion.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByTestId('prototype-message-list')).toBeVisible();
  await page.waitForTimeout(500);
}

async function capture(page: Page, query: string, name: string) {
  await open(page, query);
  await screenshot(page, name);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

test.describe('Chat toolbar prototype — baseline (today)', () => {
  test('collapsed: every tool is invisible', async ({ page }) => {
    await capture(page, 'variant=none&state=sleeping', 'toolbar-before-collapsed');
    // The point of the whole exercise: with the disclosure shut, none of the nine
    // controls are reachable or even discoverable.
    await expect(page.getByRole('button', { name: 'Timeline' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Comments', exact: true })).toHaveCount(0);
  });

  test('expanded via the real chevron: the buried action row', async ({ page }) => {
    await open(page, 'variant=none&state=active');
    // `exact` matters: the rail's own Details action is named "Show session details,
    // IDs and infrastructure", which substring-matches the header chevron. That
    // collision is itself a finding — if the rail ships, the chevron should go away.
    await page.getByRole('button', { name: 'Show session details', exact: true }).click();
    await page.waitForTimeout(400);
    await expect(page.getByRole('button', { name: 'Timeline' })).toBeVisible();
    await screenshot(page, 'toolbar-before-expanded');
    await assertNoOverflow(page);
  });
});

test.describe('Variation A — right rail', () => {
  for (const mode of ['icons', 'labels', 'hidden'] as const) {
    test(`sleeping · ${mode}`, async ({ page }) => {
      await capture(page, `variant=rail&mode=${mode}&state=sleeping`, `toolbar-a-rail-${mode}`);
      const target = mode === 'hidden' ? 'tool-rail-tab' : 'tool-rail';
      await expect(page.getByTestId(target)).toBeVisible();
    });
  }

  test('active session exposes the workspace tools', async ({ page }) => {
    await capture(page, 'variant=rail&mode=labels&state=active', 'toolbar-a-rail-labels-active');
    for (const id of ['files', 'git', 'workspace', 'timeline', 'comments', 'complete']) {
      await expect(page.getByTestId(`tool-${id}`)).toBeVisible();
    }
  });

  test('long title and unbroken tokens', async ({ page }) => {
    await capture(page, 'variant=rail&mode=labels&state=active&long=1', 'toolbar-a-rail-long');
  });

  test('empty conversation', async ({ page }) => {
    await capture(page, 'variant=rail&mode=icons&empty=1', 'toolbar-a-rail-empty');
  });

  test('rail survives an expanded session-details disclosure', async ({ page }) => {
    await open(page, 'variant=rail&mode=icons&state=active');
    // `exact` matters: the rail's own Details action is named "Show session details,
    // IDs and infrastructure", which substring-matches the header chevron. That
    // collision is itself a finding — if the rail ships, the chevron should go away.
    await page.getByRole('button', { name: 'Show session details', exact: true }).click();
    await page.waitForTimeout(400);
    await expect(page.getByText('References')).toBeVisible();

    // The disclosure makes the header taller than the viewport. The rail hangs off the
    // measured header height, so without the `min(…, 45%)` clamp it is pushed entirely
    // below the fold. Assert it is still ON SCREEN, not merely still in the DOM —
    // `toBeVisible()` alone passes for an element parked at top: 1200px.
    const box = await page.getByTestId('tool-rail').boundingBox();
    const viewportHeight = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    expect(box!.y).toBeLessThan(viewportHeight * 0.6);
    expect(box!.height).toBeGreaterThan(100);

    await screenshot(page, 'toolbar-a-rail-details-open');
    await assertNoOverflow(page);
  });
});

test.describe('Variation B — bottom dock', () => {
  for (const mode of ['icons', 'labels', 'hidden'] as const) {
    test(`sleeping · ${mode}`, async ({ page }) => {
      await capture(page, `variant=dock&mode=${mode}&state=sleeping`, `toolbar-b-dock-${mode}`);
      const target = mode === 'hidden' ? 'tool-dock-tab' : 'tool-dock';
      await expect(page.getByTestId(target)).toBeVisible();
    });
  }

  test('active session exposes the workspace tools', async ({ page }) => {
    await capture(page, 'variant=dock&mode=labels&state=active', 'toolbar-b-dock-labels-active');
    for (const id of ['files', 'git', 'workspace', 'timeline', 'comments', 'complete']) {
      await expect(page.getByTestId(`tool-${id}`)).toBeVisible();
    }
  });

  test('long title and unbroken tokens', async ({ page }) => {
    await capture(page, 'variant=dock&mode=labels&state=active&long=1', 'toolbar-b-dock-long');
  });
});

test.describe('Behavior — driven through the real controls', () => {
  test('rail cycle button steps icons → labels → hidden → icons', async ({ page }) => {
    await open(page, 'variant=rail&mode=icons');

    // icons: no visible label text
    await expect(page.getByTestId('tool-rail')).toHaveAttribute('data-mode', 'icons');
    await expect(page.getByTestId('tool-timeline')).not.toContainText('Timeline');

    await page.getByTestId('tool-rail-cycle').click();
    await expect(page.getByTestId('tool-rail')).toHaveAttribute('data-mode', 'labels');
    await expect(page.getByTestId('tool-timeline')).toContainText('Timeline');

    await page.getByTestId('tool-rail-cycle').click();
    await expect(page.getByTestId('tool-rail')).toHaveCount(0);
    await expect(page.getByTestId('tool-rail-tab')).toBeVisible();

    await page.getByTestId('tool-rail-tab').click();
    await expect(page.getByTestId('tool-rail')).toHaveAttribute('data-mode', 'icons');
  });

  test('dock cycle button steps icons → labels → hidden → icons', async ({ page }) => {
    await open(page, 'variant=dock&mode=icons');

    await expect(page.getByTestId('tool-dock')).toHaveAttribute('data-mode', 'icons');
    await page.getByTestId('tool-dock-cycle').click();
    await expect(page.getByTestId('tool-dock')).toHaveAttribute('data-mode', 'labels');
    await expect(page.getByTestId('tool-timeline')).toContainText('Timeline');

    await page.getByTestId('tool-dock-cycle').click();
    await expect(page.getByTestId('tool-dock')).toHaveCount(0);
    await expect(page.getByTestId('tool-dock-tab')).toBeVisible();

    await page.getByTestId('tool-dock-tab').click();
    await expect(page.getByTestId('tool-dock')).toHaveAttribute('data-mode', 'icons');
  });

  test('every rail tool button activates its action', async ({ page }) => {
    // `chrome` left on: the switcher renders the "Tool activated" readout that proves
    // the click reached a handler rather than merely hitting a styled div.
    await page.goto(`${ROUTE}?variant=rail&mode=icons&state=active`);
    await expect(page.getByTestId('prototype-message-list')).toBeVisible();

    for (const id of ['files', 'git', 'timeline', 'comments', 'retry', 'fork', 'complete']) {
      await page.getByTestId(`tool-${id}`).click();
      await expect(page.getByTestId('tool-activation-readout')).toContainText(id);
    }
  });

  test('icon-only buttons still name themselves to assistive tech', async ({ page }) => {
    await open(page, 'variant=rail&mode=icons&state=active');
    // An unlabeled icon is exactly the problem being fixed — every control must carry
    // a full-sentence accessible name in icon mode, not just in label mode.
    for (const [id, name] of [
      ['files', 'Browse workspace files'],
      ['timeline', 'Jump through session history'],
      ['complete', 'Mark this task complete'],
      ['details', 'Show session details, IDs and infrastructure'],
    ] as const) {
      await expect(page.getByTestId(`tool-${id}`)).toHaveAttribute('aria-label', name);
    }
  });

  test('labels rail overlays on mobile and pushes on desktop', async ({ page }) => {
    // The visual audit showed a 158px labels rail collapsing 375px message bubbles to
    // ~200px, so on mobile the rail floats and the list keeps only the icon-width
    // gutter. Asserting the gutter (not just "the rail is visible") is what makes this
    // discriminating: a rail rendered at the wrong width would still be "visible".
    await open(page, 'variant=rail&mode=labels&state=active');
    const paddingRight = await page
      .getByTestId('prototype-message-list')
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));

    const width = page.viewportSize()?.width ?? 0;
    if (width <= 767) {
      expect(paddingRight).toBeLessThan(80); // icon-width gutter — rail overlays
    } else {
      expect(paddingRight).toBeGreaterThan(150); // full labels width — rail pushes
    }
  });

  test('comment badge reflects the unresolved count', async ({ page }) => {
    await open(page, 'variant=rail&mode=labels&comments=7');
    await expect(page.getByTestId('tool-comments')).toContainText('7');

    await open(page, 'variant=rail&mode=labels&comments=0');
    await expect(page.getByTestId('tool-comments')).toBeVisible();
    await expect(page.getByTestId('tool-comments')).not.toContainText('0');
  });
});
