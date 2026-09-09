import AxeBuilder from '@axe-core/playwright';

import { expect, test, type Page } from './fixtures';

const POST = '/blog/choosing-a-placement-strategy/';

/**
 * Document-level overflow checks are blind to overflow clipped by an ancestor with
 * `overflow: hidden` — and `.placement-lab` is exactly such an ancestor (see
 * `.claude/rules/56`). So walk the DOM for any element that clips horizontally while its content
 * is wider than its box, excluding real scrollers (`auto` / `scroll`) and ellipsis truncation.
 */
async function assertNoClippedOverflow(page: Page): Promise<void> {
  // Scoped to the explorer. The site's own off-canvas mobile nav drawer is deliberately parked
  // outside the viewport, which makes `body` a permanent offender at mobile widths — that belongs
  // to the layout, not to this component.
  const offenders = await page.evaluate(() => {
    const root = document.querySelector('placement-explorer');
    if (!root) return ['placement-explorer not found'];
    const bad: string[] = [];
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      const style = getComputedStyle(element);
      const overflowX = style.overflowX;
      if (overflowX !== 'hidden' && overflowX !== 'clip') continue;
      if (style.textOverflow === 'ellipsis') continue;
      if (element.clientWidth < 4) continue;
      if (element.scrollWidth > element.clientWidth + 1) {
        bad.push(
          `${element.tagName.toLowerCase()}.${element.className || '(no class)'} ` +
            `scrollWidth=${element.scrollWidth} clientWidth=${element.clientWidth}`
        );
      }
    }
    return bad;
  });
  expect(offenders, 'elements clipping horizontal overflow').toEqual([]);
}

async function assertNoOverflow(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await assertNoClippedOverflow(page);
}

/** The lab body is hidden until the custom element upgrades, so this proves JS actually booted
 * rather than that the markup merely exists. */
async function openExplorer(page: Page): Promise<void> {
  await page.goto(POST);
  await expect(page.locator('placement-explorer [data-lab-body]')).toBeVisible();
}

test.describe('placement explorer', () => {
  test('boots, accepts work, and steps the simulation', async ({ page }) => {
    await openExplorer(page);

    const workloads = page.locator('[data-workloads]');
    await expect(workloads).toContainText('Submit some work');

    await page.locator('button[data-shape="standard"]').click();
    await expect(workloads.locator('li').first()).toContainText('Standard #');
    await expect(workloads).toContainText('queued');

    await page.locator('button[data-action="step"]').click();
    await expect(page.locator('[data-clock]')).toHaveText('STEP 01');
    // A positive outcome, not just "the queued text went away": the workload must be placed on a
    // real host from the seeded fleet.
    await expect(workloads.locator('li').first()).toContainText('placed on');
    await assertNoOverflow(page);
  });

  test('switching strategy changes the stated ordering key and the highlighted row', async ({
    page,
  }) => {
    await openExplorer(page);
    await page.locator('button[data-action="batch"]').click();

    const ordering = page.locator('[data-ordering]');
    await expect(ordering).toHaveText('lowest projected utilization first');
    await expect(page.locator('tr[data-current="true"] td').first()).toHaveText('balanced');

    await page.locator('button[data-strategy="pack"]').click();
    await expect(ordering).toHaveText('highest projected utilization first');
    await expect(page.locator('tr[data-current="true"] td').first()).toHaveText('pack');
    await expect(page.locator('button[data-strategy="pack"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  test('compares all four strategies over the submitted batch', async ({ page }) => {
    await openExplorer(page);
    const compareRows = page.locator('[data-compare] tbody tr');
    await expect(compareRows).toHaveCount(1);
    await expect(compareRows.first()).toContainText('Submit some work');

    await page.locator('button[data-action="batch"]').click();
    await expect(compareRows).toHaveCount(4);
    for (const strategy of ['pack', 'spread', 'balanced', 'smallest-fit']) {
      await expect(compareRows.filter({ hasText: strategy })).toHaveCount(1);
    }
    await expect(page.locator('[data-compare-note]')).toContainText('different placement');
    await assertNoOverflow(page);
  });

  test('a stocked-out region under the fail policy rejects the work', async ({ page }) => {
    await openExplorer(page);

    // Reduce the pool to a single region so the stocked-out one is necessarily top-ranked.
    for (const region of ['nbg1', 'hel1']) {
      await page.locator(`input[data-region][value="${region}"]`).uncheck();
    }
    await page.locator('[data-policy]').selectOption('fail');
    await page.locator('button[data-stockout="fsn1"]').click();
    await expect(page.locator('button[data-stockout="fsn1"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // Heavy needs more than the seeded fleet can offer, so placement must buy hardware — and the
    // only region that could sell it has no stock.
    await page.locator('button[data-shape="heavy"]').click();
    for (let i = 0; i < 6; i++) await page.locator('button[data-action="step"]').click();

    const workloads = page.locator('[data-workloads]');
    await expect(workloads).toContainText('412');
    await expect(workloads.locator('li[data-state="rejected"]')).toHaveCount(1);
  });

  test('fallback-chain reaches the same machine in another region', async ({ page }) => {
    await openExplorer(page);
    await page.locator('[data-policy]').selectOption('fallback-chain');
    await page.locator('button[data-stockout="fsn1"]').click();

    await page.locator('button[data-shape="heavy"]').click();
    await page.locator('button[data-shape="heavy"]').click();
    for (let i = 0; i < 8; i++) await page.locator('button[data-action="step"]').click();

    // Positive assertion: work actually ran somewhere, and nothing was rejected.
    await expect(page.locator('[data-workloads] li[data-state="rejected"]')).toHaveCount(0);
    await expect(page.locator('[data-fleet]')).toContainText('node');
  });

  test('switching provider reloads the catalog and its regions', async ({ page }) => {
    await openExplorer(page);
    await expect(page.locator('[data-catalog-note]')).toContainText('cx23');

    await page.locator('[data-provider]').selectOption('digitalocean');
    await expect(page.locator('[data-catalog-note]')).toContainText('s-2vcpu-4gb');
    await expect(page.locator('input[data-region][value="fra1"]')).toBeChecked();
    await assertNoOverflow(page);
  });

  test('play advances the clock on its own, pause stops it, reset returns to step zero', async ({
    page,
  }) => {
    await openExplorer(page);
    const clock = page.locator('[data-clock]');
    const play = page.locator('button[data-action="play"]');
    await page.locator('button[data-action="batch"]').click();
    await expect(clock).toHaveText('STEP 00');

    await play.click();
    await expect(play).toHaveText('Pause ▮▮');
    // Advances with no further clicks — the point of the control.
    await expect(clock).not.toHaveText('STEP 00', { timeout: 10_000 });

    await play.click();
    await expect(play).toHaveText('Play ▸▸');
    const stopped = await clock.textContent();
    await page.waitForTimeout(2500); // longer than one tick, so a still-running timer would show
    await expect(clock).toHaveText(stopped ?? '');

    await page.locator('button[data-action="reset"]').click();
    await expect(clock).toHaveText('STEP 00');
    await expect(page.locator('[data-workloads]')).toContainText('Submit some work');
    // Positive control: reset rebuilds the seeded fleet rather than emptying the widget.
    await expect(page.locator('[data-fleet] li')).toHaveCount(3);
  });

  test('switching provider clears stockouts that belonged to the previous catalog', async ({
    page,
  }) => {
    await openExplorer(page);
    const flame = page.locator('button[data-stockout="fsn1"]');
    await flame.click();
    await expect(flame).toHaveAttribute('aria-pressed', 'true');

    await page.locator('[data-provider]').selectOption('digitalocean');
    await expect(page.locator('input[data-region][value="fra1"]')).toBeChecked();
    await page.locator('[data-provider]').selectOption('hetzner');

    // Without the reset the flame would come back pressed with no user action.
    await expect(page.locator('button[data-stockout="fsn1"]')).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  test('a warm host is reused instead of provisioning a replacement', async ({ page }) => {
    await openExplorer(page);
    const fleet = page.locator('[data-fleet] li');
    await expect(fleet).toHaveCount(3);

    // `spread` picks the host with the fewest co-tenants, which is the seeded fleet's idle small
    // host — the only one that can drain to warm, since the other two carry steady-state load.
    // Under `balanced` the work lands on the medium host instead and nothing ever goes warm, which
    // would make this assertion depend on the default strategy rather than on warm reuse.
    await page.locator('button[data-strategy="spread"]').click();
    await page.locator('button[data-shape="chat"]').click();
    for (let i = 0; i < 10; i++) await page.locator('button[data-action="step"]').click();
    // The host that took the work must have gone warm once it drained.
    await expect(page.locator('[data-fleet] .state[data-state="warm"]').first()).toBeVisible();

    await page.locator('button[data-shape="chat"]').click();
    await page.locator('button[data-action="step"]').click();
    // Reuse, not replacement: still the same three hosts.
    await expect(fleet).toHaveCount(3);
  });

  test('the stockout toggle keeps a visible focus ring in BOTH states', async ({ page }) => {
    // axe passes this widget with zero violations and still missed it: `filter` on the button
    // rasterized its focus outline along with the emoji, dimming the ring to 45% opacity in the
    // in-stock state — which is the default, so it was the normal experience. The assertion is on
    // the button carrying no filter, because that is the actual mechanism; a screenshot or an axe
    // scan cannot see it.
    await openExplorer(page);
    const flame = page.locator('button[data-stockout="fsn1"]');

    for (const expectedPressed of ['false', 'true']) {
      await expect(flame).toHaveAttribute('aria-pressed', expectedPressed);
      const style = await flame.evaluate((el) => {
        const computed = getComputedStyle(el);
        const glyph = el.querySelector('.flame-glyph');
        return {
          buttonFilter: computed.filter,
          glyphFilter: glyph ? getComputedStyle(glyph).filter : null,
        };
      });
      // The button itself must never be filtered — that is what dimmed the ring.
      expect(style.buttonFilter, `button filter while pressed=${expectedPressed}`).toBe('none');
      if (expectedPressed === 'false') {
        // The dim still has to happen, just on the glyph. Otherwise this "fix" is only a deletion.
        expect(style.glyphFilter).not.toBe('none');
      }
      if (expectedPressed === 'false') await flame.click();
    }
  });

  test('changing the pool says the simulation restarted instead of silently wiping it', async ({
    page,
  }) => {
    await openExplorer(page);
    await page.locator('button[data-action="batch"]').click();
    for (let i = 0; i < 3; i++) await page.locator('button[data-action="step"]').click();
    await expect(page.locator('[data-clock]')).toHaveText('STEP 03');

    await page.locator('input[data-region][value="nbg1"]').uncheck();
    await expect(page.locator('[data-clock]')).toHaveText('STEP 00');
    await expect(page.locator('[data-events]')).toContainText('simulation restarted');
  });

  test('surfaces the same-price-across-regions tie in the UI', async ({ page }) => {
    // The teaching moment the whole post is built around, and the condition behind the incident:
    // identical machine, identical price, several regions, so nothing prefers the one with stock.
    // The arithmetic is model-tested; this asserts a reader actually SEES it.
    await openExplorer(page);
    const note = page.locator('[data-catalog-note]');
    await expect(note).toContainText('cx33');
    await expect(note).toContainText('the same price in every region');
    await expect(note).toContainText('region is a tie no strategy breaks');

    // And it tracks the selected provider rather than being static prose.
    await page.locator('[data-provider]').selectOption('vultr');
    await expect(note).toContainText('vc2-2c-4gb');
    await expect(note).toContainText('the same price in every region');
  });

  test('has no serious accessibility violations', async ({ page }, testInfo) => {
    await openExplorer(page);
    await page.locator('button[data-action="batch"]').click();

    const results = await new AxeBuilder({ page })
      .include('placement-explorer')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    const serious = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical'
    );
    // Contrast axe cannot resolve is reported as `incomplete`, not as a violation. Checking only
    // `violations` let a genuinely unreadable row through: the site's table rule painted the last
    // comparison row #f8fbf8 and left light text on it, and axe stayed quiet.
    //
    // Axe cannot compute contrast over a gradient, so the heading elements sitting on the panel's
    // radial-gradient header are permanently unresolvable. They are allowlisted BY SELECTOR with
    // that reason rather than by dropping the check, so any NEW unresolvable node still fails.
    const GRADIENT_BACKED = ['.eyebrow', '.lab-heading > div > h2', '.lab-badge', '.model-note'];
    const unresolvedContrast = results.incomplete
      .filter((entry) => entry.id === 'color-contrast')
      .flatMap((entry) => entry.nodes.map((node) => node.target.join(' ')))
      .filter((target) => !GRADIENT_BACKED.includes(target));
    await testInfo.attach('axe-violations', {
      body: JSON.stringify(serious, null, 2),
      contentType: 'application/json',
    });
    expect(serious.map((violation) => violation.id)).toEqual([]);
    expect(
      unresolvedContrast,
      'axe could not resolve contrast for these nodes — treat as a failure, not a pass'
    ).toEqual([]);
  });
});
