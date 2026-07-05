import { expect, test, type Page } from '@playwright/test';

/**
 * Virtualization jump benchmark: react-virtuoso (production) vs
 * @tanstack/react-virtual (end-anchored). Drives a scripted bottom→top scroll
 * over a stress dataset of collapsed tool cards + variable-height agent text
 * and measures, per library:
 *
 *   - totalJump (px): cumulative INVOLUNTARY content displacement of on-screen
 *     rows during the post-scroll settle window (no scroll commanded → any row
 *     movement is a jump the user sees). This is the primary metric — it maps
 *     directly to "the text I'm reading jumps while I scroll".
 *   - cls: browser Layout Instability score (independent second opinion;
 *     accounts for scroll, so scrollbar-only compensation is NOT penalized).
 *   - fps during the scroll traversal.
 *
 * Run: npx playwright test virtual-scroll-bench --project="Desktop (1280x800)"
 */

const COUNTS = [1500, 3000];
const MODES = ['virtuoso', 'tanstack'] as const;

// Injected into the page. Returns jump / cls / fps for one loaded bench mode.
async function measure(page: Page): Promise<{
  totalJump: number;
  avgStepJump: number;
  maxStepJump: number;
  maxFrameJump: number;
  cls: number;
  fps: number;
  samples: number;
}> {
  return page.evaluate(async () => {
    const scroller = document.querySelector('[data-bench-scroller]') as HTMLElement | null;
    if (!scroller) throw new Error('no [data-bench-scroller]');
    const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

    const snapshot = (): Map<string, number> => {
      const m = new Map<string, number>();
      document.querySelectorAll('[data-bench-row]').forEach((el) => {
        const id = el.getAttribute('data-item-id');
        if (id) m.set(id, (el as HTMLElement).getBoundingClientRect().top);
      });
      return m;
    };

    // Layout Instability observer (excludes shifts attributed to user input).
    let cls = 0;
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const ls = e as PerformanceEntry & { value: number; hadRecentInput: boolean };
        if (!ls.hadRecentInput) cls += ls.value;
      }
    });
    po.observe({ type: 'layout-shift', buffered: false } as PerformanceObserverInit);

    // Start pinned to the bottom.
    scroller.scrollTop = scroller.scrollHeight;
    await raf();
    await raf();

    const nSteps = 80;
    const settleFrames = 6;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    const step = -maxScroll / nSteps;

    let totalJump = 0;
    let maxStepJump = 0;
    let maxFrameJump = 0;
    let samples = 0;
    let frames = 0;
    const t0 = performance.now();

    for (let s = 0; s < nSteps; s++) {
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.max(0, before + step);
      await raf(); // native scroll + first virtualizer reaction lands ("mid")

      let prev = snapshot();
      let stepJump = 0;
      // Settle window: NO scroll commanded, so any row movement is involuntary.
      // We do NOT subtract scrollTop — scrollbar-only compensation (content
      // stable) yields 0 here, real content shifts are counted.
      for (let f = 0; f < settleFrames; f++) {
        await raf();
        frames++;
        const cur = snapshot();
        let frameSum = 0;
        let cnt = 0;
        for (const [id, top] of cur) {
          const p = prev.get(id);
          if (p !== undefined) {
            frameSum += Math.abs(top - p);
            cnt++;
          }
        }
        const avg = cnt ? frameSum / cnt : 0; // visible rows move together → avg = shift
        stepJump += avg;
        maxFrameJump = Math.max(maxFrameJump, avg);
        samples += cnt;
        prev = cur;
      }
      totalJump += stepJump;
      maxStepJump = Math.max(maxStepJump, stepJump);
      if (scroller.scrollTop <= 0) break;
    }

    const elapsed = performance.now() - t0;
    po.disconnect();

    return {
      totalJump: Number(totalJump.toFixed(1)),
      avgStepJump: Number((totalJump / nSteps).toFixed(2)),
      maxStepJump: Number(maxStepJump.toFixed(2)),
      maxFrameJump: Number(maxFrameJump.toFixed(2)),
      cls: Number(cls.toFixed(4)),
      fps: Number((frames / (elapsed / 1000)).toFixed(1)),
      samples,
    };
  });
}

test.describe('virtualization jump benchmark', () => {
  // One viewport is enough for a benchmark; invoked with the Desktop project.
  test.skip(({ isMobile }) => isMobile === true, 'benchmark runs on desktop only');

  for (const count of COUNTS) {
    test(`jump comparison @ ${count} items`, async ({ page }) => {
      const results: Record<string, Awaited<ReturnType<typeof measure>>> = {};

      for (const mode of MODES) {
        await page.goto(`/__bench/virtual-scroll?mode=${mode}&count=${count}`);
        await page.waitForFunction(
          () => (window as unknown as Record<string, unknown>).__benchReady === true,
          { timeout: 20_000 },
        );
        await page.waitForFunction(() => document.querySelectorAll('[data-bench-row]').length > 3, {
          timeout: 20_000,
        });
        // Let initial measurement/bottom-anchor settle.
        await page.waitForTimeout(600);
        results[mode] = await measure(page);
        expect(results[mode].samples, `${mode} produced measurement samples`).toBeGreaterThan(0);
      }

      const v = results.virtuoso!;
      const t = results.tanstack!;
      const pct = (a: number, b: number) => (a === 0 ? 'n/a' : `${(((a - b) / a) * 100).toFixed(0)}% less`);

      // eslint-disable-next-line no-console
      console.log(`\n===== VIRTUAL SCROLL JUMP BENCHMARK — ${count} items =====`);
      // eslint-disable-next-line no-console
      console.table({
        virtuoso: v,
        tanstack: t,
      });
      // eslint-disable-next-line no-console
      console.log(
        `tanstack totalJump: ${pct(v.totalJump, t.totalJump)} · ` +
          `maxStepJump: ${pct(v.maxStepJump, t.maxStepJump)} · ` +
          `CLS: ${pct(v.cls, t.cls)} · ` +
          `fps virtuoso=${v.fps} tanstack=${t.fps}`,
      );
    });
  }
});
