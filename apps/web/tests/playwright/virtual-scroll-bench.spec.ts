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
    // Locate the scroll container. Virtuoso tags its scroller via scrollerRef;
    // the clean TanStack VirtualMessageList has no tag, so fall back to walking
    // up from a rendered row to the nearest actually-scrollable ancestor.
    let scroller = document.querySelector('[data-bench-scroller]') as HTMLElement | null;
    if (!scroller) {
      const firstRow = document.querySelector('[data-bench-row]') as HTMLElement | null;
      scroller = firstRow?.parentElement ?? null;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) {
        scroller = scroller.parentElement;
      }
    }
    if (!scroller) throw new Error('no scrollable container found');
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
        await page.waitForFunction(() => document.querySelectorAll('[data-bench-row]').length > 0, {
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

  // Isolate the ACTUAL production cause: does a 1 Hz re-render (mimicking the
  // idle-countdown timer) + inline components.Header turn a static, smooth list
  // jumpy — with the SAME virtualizer and SAME data?
  test('virtuoso: static vs simulated-live (1 Hz re-render)', async ({ page }) => {
    test.setTimeout(120_000);
    const run = async (live: boolean) => {
      await page.goto(`/__bench/virtual-scroll?mode=virtuoso&count=1500${live ? '&live=1' : ''}`);
      await page.waitForFunction(
        () => (window as unknown as Record<string, unknown>).__benchReady === true,
        { timeout: 20_000 },
      );
      await page.waitForFunction(() => document.querySelectorAll('[data-bench-row]').length > 0, {
        timeout: 20_000,
      });
      await page.waitForTimeout(600);
      return measure(page);
    };

    const staticRun = await run(false);
    const liveRun = await run(true);

    // eslint-disable-next-line no-console
    console.log('\n===== VIRTUOSO — STATIC vs SIMULATED-LIVE (1 Hz re-render) =====');
    // eslint-disable-next-line no-console
    console.table({ 'virtuoso (static)': staticRun, 'virtuoso (live 1Hz)': liveRun });
    // eslint-disable-next-line no-console
    console.log(
      `live/static totalJump ratio: ${(liveRun.totalJump / Math.max(1, staticRun.totalJump)).toFixed(1)}x · ` +
        `CLS static=${staticRun.cls} live=${liveRun.cls}`,
    );
  });

  // Does periodic DATA CHURN (items array rebuilt with new object identities,
  // like conversationItems rebuilding on every message update) cause the jump —
  // and does the stable-getItemKey TanStack list resist it better than virtuoso?
  test('static vs data-churn — virtuoso and tanstack', async ({ page }) => {
    test.setTimeout(120_000);
    const run = async (mode: 'virtuoso' | 'tanstack', churn: boolean) => {
      await page.goto(`/__bench/virtual-scroll?mode=${mode}&count=1500${churn ? '&churn=1' : ''}`);
      await page.waitForFunction(
        () => (window as unknown as Record<string, unknown>).__benchReady === true,
        { timeout: 20_000 },
      );
      await page.waitForFunction(() => document.querySelectorAll('[data-bench-row]').length > 0, {
        timeout: 20_000,
      });
      await page.waitForTimeout(600);
      return measure(page);
    };

    const table = {
      'virtuoso (static)': await run('virtuoso', false),
      'virtuoso (churn 1.5s)': await run('virtuoso', true),
      'tanstack (static)': await run('tanstack', false),
      'tanstack (churn 1.5s)': await run('tanstack', true),
    };
    // eslint-disable-next-line no-console
    console.log('\n===== STATIC vs DATA-CHURN =====');
    // eslint-disable-next-line no-console
    console.table(table);
  });

  // Reproduce a LIVE session: append a message every 1s (triggers followOutput /
  // followOnAppend auto-scroll toward the bottom while the user scrolls up).
  test('static vs live-append — virtuoso and tanstack', async ({ page }) => {
    test.setTimeout(120_000);
    const run = async (mode: 'virtuoso' | 'tanstack', append: boolean) => {
      await page.goto(`/__bench/virtual-scroll?mode=${mode}&count=1500${append ? '&append=1' : ''}`);
      await page.waitForFunction(
        () => (window as unknown as Record<string, unknown>).__benchReady === true,
        { timeout: 20_000 },
      );
      await page.waitForFunction(() => document.querySelectorAll('[data-bench-row]').length > 0, {
        timeout: 20_000,
      });
      await page.waitForTimeout(600);
      return measure(page);
    };

    const table = {
      'virtuoso (static)': await run('virtuoso', false),
      'virtuoso (append 1s)': await run('virtuoso', true),
      'tanstack (static)': await run('tanstack', false),
      'tanstack (append 1s)': await run('tanstack', true),
    };
    // eslint-disable-next-line no-console
    console.log('\n===== STATIC vs LIVE-APPEND (followOutput / followOnAppend) =====');
    // eslint-disable-next-line no-console
    console.table(table);
  });
});
