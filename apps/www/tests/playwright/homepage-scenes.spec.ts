import { readdirSync, readFileSync } from 'node:fs';

import { STEP_SETTLE_MS } from '../../src/lib/motion';
import { captureScreenshot } from './capture-screenshot';
import { expect, type Locator, type Page, test } from './fixtures';

/**
 * Homepage feature scenes: animated real-UI previews beside each feature section.
 * Every case reaches a scene the way a visitor does — scrolling it into the middle of the
 * screen, the reduced-motion preference, the hero's pause control, the theme toggle, resizing,
 * JavaScript off — and never sets a scene's state directly. A paused fake clock makes each
 * story step on demand.
 */

const SCENE_IMAGES = '/images/scenes/';
const DATA = new URL('../../src/data/', import.meta.url);

interface SceneFile {
  slug: string;
  description: string;
}

/** Scene specs on disk (src/data/scenes/*.json): what the homepage must render. */
const sceneSpecs = readdirSync(new URL('scenes/', DATA))
  .filter((file) => file.endsWith('.json'))
  .map((file) => JSON.parse(readFileSync(new URL(`scenes/${file}`, DATA), 'utf8')) as SceneFile);

/** The section's existing screenshot caption, which the scene shows unchanged. */
const sectionCaption = (slug: string) =>
  (
    JSON.parse(readFileSync(new URL(`features/${slug}.json`, DATA), 'utf8')) as {
      details: { screenshot: { caption: string } }[];
    }
  ).details[0]?.screenshot.caption ?? '';

const sceneLocator = (page: Page, slug: string) => page.locator(`[data-scene="${slug}"]`);

async function renderedSlugs(page: Page) {
  return page
    .locator('[data-scene]')
    .evaluateAll((elements) => elements.map((el) => (el as HTMLElement).dataset.scene ?? ''));
}

async function sceneBeats(scene: Locator): Promise<number[]> {
  return JSON.parse((await scene.getAttribute('data-beats')) ?? '[]') as number[];
}

/**
 * Scrolls a scene into the middle of the viewport, where its story starts, and waits for the
 * frame in which it becomes near enough to load its images. The jump is instant: the page
 * otherwise scrolls smoothly, and a scene measured mid-scroll is somewhere else.
 */
async function bringIntoView(scene: Locator) {
  await scene.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(scene).toHaveAttribute('data-near', '');
}

/** Installs a fake clock and holds it still, so story steps fire only when the test says so. */
async function gotoWithHeldClock(page: Page) {
  await page.clock.install();
  await page.goto('/');
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
}

/**
 * Brings a scene to the middle of the screen and waits until its story has started (step 1,
 * which is due at once): the start is the scene's IntersectionObserver callback, which lands a
 * frame after the scroll, so the paused clock is nudged until the first step has fired.
 */
async function startStory(scene: Locator) {
  await bringIntoView(scene);
  const page = scene.page();
  await expect
    .poll(async () => {
      await page.clock.runFor(0);
      return scene.getAttribute('data-step');
    })
    .toBe('1');
}

/** Opacity of every element that takes part in the story, split by whether it is transient. */
async function storyOpacities(scene: Locator) {
  return scene.evaluate((root) => {
    const read = (selector: string) =>
      Array.from(
        root.querySelectorAll<HTMLElement>(selector),
        (el) => getComputedStyle(el).opacity
      );
    return { lasting: read('[data-at]:not([data-until])'), transient: read('[data-until]') };
  });
}

/** The resting frame: everything that lasts is shown, every transient highlight or light is gone. */
async function expectFinalFrame(scene: Locator) {
  await expect(scene).not.toHaveAttribute('data-playing');
  await expect(scene).not.toHaveAttribute('data-pose');
  const { lasting, transient } = await storyOpacities(scene);
  expect(lasting.length).toBeGreaterThan(0);
  expect(new Set(lasting)).toEqual(new Set(['1']));
  expect(new Set(transient)).toEqual(new Set(transient.length > 0 ? ['0'] : []));
}

/**
 * Mid-story: once transitions settle, each element that takes part in the story is visible
 * exactly while its own step window ([data-at], [data-until]) contains the current step.
 */
async function expectStepFrame(scene: Locator, step: number) {
  await expect
    .poll(
      () =>
        scene.evaluate((root, current) => {
          const wrong: string[] = [];
          for (const el of root.querySelectorAll<HTMLElement>('[data-at]')) {
            const at = Number(el.dataset.at);
            const until = el.dataset.until === undefined ? Infinity : Number(el.dataset.until);
            const opacity = getComputedStyle(el).opacity;
            const expected = current >= at && current < until ? '1' : '0';
            if (opacity !== expected) wrong.push(`${el.className} [${at}, ${until}) is ${opacity}`);
          }
          return wrong;
        }, step),
      { message: `step ${step}`, timeout: 4000 }
    )
    .toEqual([]);
}

/** The window's own image is drawn (liveness: the scene is not an empty frame). */
async function expectWindowImage(scene: Locator) {
  const image = scene.locator('.is-window .scene-img').first();
  await expect
    .poll(() => image.evaluate((el) => getComputedStyle(el).backgroundImage))
    .toContain(SCENE_IMAGES);
}

test.describe('homepage feature scenes', () => {
  test('the homepage renders one scene per scene spec', async ({ page }) => {
    await page.goto('/');
    expect((await renderedSlugs(page)).sort()).toEqual(sceneSpecs.map((spec) => spec.slug).sort());
  });

  for (const { slug } of sceneSpecs) {
    test(`${slug}: waits in its intro, plays step by step from the middle of the screen, then rests`, async ({
      page,
    }) => {
      await gotoWithHeldClock(page);
      const scene = sceneLocator(page, slug);
      const beats = await sceneBeats(scene);

      // Before it is seen: the intro frame, with everything that arrives later hidden.
      await expect(scene).toHaveAttribute('data-playing', '');
      await expect(scene).toHaveAttribute('data-pose', 'exploded');
      await expect(scene).toHaveAttribute('data-step', '0');
      await expectStepFrame(scene, 0);

      await startStory(scene);
      await expectWindowImage(scene);
      await expect(scene).not.toHaveAttribute('data-pose');
      await expectStepFrame(scene, 1);
      for (let step = 2; step <= beats.length; step++) {
        await page.clock.runFor((beats[step - 1] ?? 0) - (beats[step - 2] ?? 0));
        await expect(scene).toHaveAttribute('data-step', String(step));
        await expectStepFrame(scene, step);
      }
      await page.clock.runFor(STEP_SETTLE_MS);
      await expectFinalFrame(scene);
    });
  }

  test('a moving highlight hands over from one real control to the next and is gone at rest', async ({
    page,
  }) => {
    await gotoWithHeldClock(page);
    const scene = sceneLocator(page, 'chat');
    const rings = scene.locator('.is-chip .scene-ring');
    const stops = await rings.evaluateAll((elements) =>
      elements.map((el) => ({
        at: Number((el as HTMLElement).dataset.at),
        left: (el as HTMLElement).style.left,
      }))
    );
    // One highlight that visits several controls, each stop at its own place.
    expect(stops.length).toBeGreaterThan(1);
    expect(new Set(stops.map((stop) => stop.left)).size).toBeGreaterThan(1);
    const beats = await sceneBeats(scene);

    await startStory(scene);
    let now = beats[0] ?? 0;
    for (const [index, stop] of stops.entries()) {
      const at = beats[stop.at - 1] ?? 0;
      await page.clock.runFor(at - now);
      now = at;
      // Exactly this stop's highlight is up.
      await expect(rings.nth(index)).toHaveClass(/is-on/);
      await expect(scene.locator('.is-chip .scene-ring.is-on')).toHaveCount(1);
    }
    await page.clock.runFor(5000);
    await expect(scene.locator('.scene-ring.is-on')).toHaveCount(0);
    await expect(rings.first()).toHaveCSS('opacity', '0');
  });

  test('the sleeping session crossfades to its real waking capture at its step', async ({
    page,
  }) => {
    await gotoWithHeldClock(page);
    const scene = sceneLocator(page, 'durable-sessions');
    const swap = scene.locator('.scene-swap');
    const base = scene.locator('.is-window .scene-img').first();
    const swapStep = Number(await swap.getAttribute('data-at'));
    const beats = await sceneBeats(scene);
    expect(swapStep).toBeGreaterThan(1);

    await startStory(scene);
    await page.clock.runFor((beats[swapStep - 2] ?? 0) - (beats[0] ?? 0));
    await expect(scene).toHaveAttribute('data-step', String(swapStep - 1));
    await expect(swap).toHaveCSS('opacity', '0');

    await page.clock.runFor((beats[swapStep - 1] ?? 0) - (beats[swapStep - 2] ?? 0));
    await expect(scene).toHaveAttribute('data-step', String(swapStep));
    await expect(swap).toHaveCSS('opacity', '1');
    const [swapImage, baseImage] = await Promise.all([
      swap.evaluate((el) => getComputedStyle(el).backgroundImage),
      base.evaluate((el) => getComputedStyle(el).backgroundImage),
    ]);
    expect(swapImage).toContain('durable-sessions-window-swap');
    expect(baseImage).not.toContain('-swap');
  });

  test('a scene taller than the screen still starts its story', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 220 });
    await gotoWithHeldClock(page);
    const scene = sceneLocator(page, 'chat');
    const height = (await scene.boundingBox())?.height ?? 0;
    // Taller than twice the screen: a visibility ratio of 45% or more could never be reached.
    expect(height).toBeGreaterThan(2 * 220);
    await startStory(scene);
  });

  test('a story that leaves the screen rests at once instead of playing out unseen', async ({
    page,
  }) => {
    await gotoWithHeldClock(page);
    const scene = sceneLocator(page, 'events');
    const beats = await sceneBeats(scene);
    await startStory(scene);
    await page.clock.runFor((beats[1] ?? 0) - (beats[0] ?? 0));
    await expect(scene).toHaveAttribute('data-step', '2');

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    // No clock time passes: leaving the screen alone ends the story.
    await expectFinalFrame(scene);
  });

  test('hiding the tab rests a playing story', async ({ page }) => {
    await gotoWithHeldClock(page);
    const scene = sceneLocator(page, 'comments');
    await startStory(scene);
    // Playwright cannot background a tab, so report the page hidden the way the browser does.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expectFinalFrame(scene);
  });

  test('reduced motion shows every final frame and never plays a story', async ({
    page,
  }, testInfo) => {
    const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
    await page.addInitScript(() => {
      const record = window as unknown as { __scenePlays: number };
      record.__scenePlays = 0;
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if ((mutation.target as Element).hasAttribute?.('data-playing')) record.__scenePlays += 1;
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-playing'] });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    for (const slug of await renderedSlugs(page)) {
      const scene = sceneLocator(page, slug);
      await bringIntoView(scene);
      await expectWindowImage(scene);
      await expectFinalFrame(scene);
      // Review evidence: each scene's resting frame, uploaded by CI with the other public-site shots.
      await captureScreenshot(() =>
        scene.screenshot({
          path: `../../.codex/tmp/playwright-screenshots/www-scene-${slug}-${project}.png`,
          animations: 'disabled',
        })
      );
    }
    // Liveness: the page rendered and scrolled, yet no scene ever entered its story.
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    expect(
      await page.evaluate(() => (window as unknown as { __scenePlays: number }).__scenePlays)
    ).toBe(0);
  });

  test('turning reduced motion off lets an unseen scene play', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoWithHeldClock(page);
    const scene = sceneLocator(page, 'agent-context');
    await expectFinalFrame(scene);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(scene).toHaveAttribute('data-pose', 'exploded');
    await startStory(scene);
  });

  test("the hero's pause control rests the scenes, and play resumes the ones not yet watched", async ({
    page,
  }) => {
    await gotoWithHeldClock(page);

    // Pausing mid-story jumps that scene to its final frame.
    const playing = sceneLocator(page, 'multiplayer');
    const beats = await sceneBeats(playing);
    await startStory(playing);
    await page.clock.runFor((beats[1] ?? 0) - (beats[0] ?? 0));
    await expect(playing).toHaveAttribute('data-step', '2');
    await page.getByRole('button', { name: 'Pause animation' }).click();
    await expectFinalFrame(playing);

    // Paused pauses everything, so a scene arriving now shows its final frame and stays there.
    const unseen = sceneLocator(page, 'events');
    await bringIntoView(unseen);
    await page.clock.runFor(1000);
    await expectFinalFrame(unseen);

    // Play from where the visitor is (a keyboard press does not scroll): the scene in view, never
    // watched, plays from its intro; the one already watched stays at rest.
    await page.getByRole('button', { name: 'Play animation' }).dispatchEvent('click');
    await expect(page.getByRole('button', { name: 'Pause animation' })).toBeAttached();
    await expect
      .poll(async () => {
        await page.clock.runFor(0);
        return unseen.getAttribute('data-step');
      })
      .toBe('1');
    await expectFinalFrame(playing);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`downloads only the ${theme} theme's scene images, and only as scenes approach`, async ({
      page,
    }) => {
      const requested: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith(SCENE_IMAGES)) requested.push(url.pathname);
      });
      await page.addInitScript(
        (value) => window.localStorage.setItem('starlight-theme', value),
        theme
      );
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      const slugs = await renderedSlugs(page);
      // The last scene is several screens below the first: nothing of it loads up front.
      const last = slugs.at(-1) ?? '';
      expect(requested.filter((file) => file.startsWith(`${SCENE_IMAGES}${last}-`))).toEqual([]);

      for (const slug of slugs) {
        await bringIntoView(sceneLocator(page, slug));
        await expect
          .poll(() => requested.some((file) => file.startsWith(`${SCENE_IMAGES}${slug}-window`)), {
            message: slug,
          })
          .toBe(true);
      }
      expect(
        requested.filter((file) => file.endsWith('-light.webp') !== (theme === 'light'))
      ).toEqual([]);
    });
  }

  test('without JavaScript every scene shows its final frame with its images', async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');
    for (const slug of await renderedSlugs(page)) {
      const scene = sceneLocator(page, slug);
      await scene.scrollIntoViewIfNeeded();
      await expectWindowImage(scene);
      await expectFinalFrame(scene);
    }
    await context.close();
  });

  test('pointer tilt follows a fine pointer and stays off under reduced motion', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'tilt needs a fine pointer');
    await page.goto('/');
    const scene = sceneLocator(page, 'comments');
    const stack = scene.locator('[data-scene-stack]');
    await bringIntoView(scene);
    const box = await scene.boundingBox();
    if (!box) throw new Error('scene has no box');
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.2);
    await expect
      .poll(() => stack.evaluate((el) => el.style.getPropertyValue('--tilt-y')))
      .not.toBe('');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await bringIntoView(scene);
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.8);
    await page.waitForTimeout(300);
    expect(await stack.evaluate((el) => el.style.getPropertyValue('--tilt-y'))).toBe('');
  });

  test('each scene links to its feature page, keeps its caption and describes its animation', async ({
    page,
  }) => {
    await page.goto('/');
    for (const { slug, description } of sceneSpecs) {
      const scene = sceneLocator(page, slug);
      await expect(scene.getByRole('link')).toHaveAttribute('href', `/features/${slug}/`);
      const caption = scene.locator('figcaption');
      await expect(caption).toContainText(sectionCaption(slug));
      await expect(caption).toContainText(description);
    }
  });
});

/**
 * Scenes tilt in 3D and lean chips toward the viewer, so a layer can project past the screen
 * edge even when its box fits; body clips horizontal overflow, which would hide that from a
 * document-level check (rule 56). Measure every visible layer, in the intro and at rest.
 */
const LAYOUT_VIEWPORTS = [1920, 1440, 1280, 1200, 1024, 900, 768, 700, 390, 375, 360];

async function cutOffLayers(page: Page) {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const cut: string[] = [];
    for (const layer of document.querySelectorAll<HTMLElement>('[data-scene] .scene-layer')) {
      if (getComputedStyle(layer).opacity === '0') continue;
      const box = layer.getBoundingClientRect();
      if (box.width === 0) continue;
      if (box.left < -1 || box.right > width + 1) {
        const scene = layer.closest<HTMLElement>('[data-scene]')?.dataset.scene;
        cut.push(
          `${scene} ${layer.className.split(' ')[0]} spans ${Math.round(box.left)}..${Math.round(box.right)} of ${width}`
        );
      }
    }
    return { cut, documentOverflow: document.documentElement.scrollWidth > width };
  });
}

/** The stage's drawn width ÷ height, beside the wide and phone aspect ratios it may use. */
async function stageAspects(scene: Locator) {
  return scene.evaluate((root) => {
    const stage = root.querySelector<HTMLElement>('.scene-stage')?.getBoundingClientRect();
    const style = getComputedStyle(root);
    return {
      drawn: stage ? stage.width / stage.height : 0,
      wide: Number(style.getPropertyValue('--aspect')),
      narrow: Number(style.getPropertyValue('--aspect-narrow')),
    };
  });
}

test.describe('homepage feature scene layout', () => {
  test.skip(({ isMobile }) => isMobile, 'viewports are set explicitly; one project is enough');

  for (const width of LAYOUT_VIEWPORTS) {
    test(`no scene layer is cut off at ${width}px, in the intro or at rest`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const last = sceneLocator(page, (await renderedSlugs(page)).at(-1) ?? '');
      // Scenes below the fold wait in their exploded intro pose.
      await expect(last).toHaveAttribute('data-pose', 'exploded');
      expect(await cutOffLayers(page)).toEqual({ cut: [], documentOverflow: false });

      // Pausing rests every scene on its final frame at once.
      await page.getByRole('button', { name: 'Pause animation' }).click();
      await expect(last).not.toHaveAttribute('data-playing');
      expect(await cutOffLayers(page)).toEqual({ cut: [], documentOverflow: false });
    });
  }

  test("resizing across a scene's own width breakpoint switches between its compositions", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const scene = sceneLocator(page, 'chat');
    await bringIntoView(scene);
    let aspects = await stageAspects(scene);
    expect(aspects.drawn).toBeCloseTo(aspects.wide, 1);

    // The preview column narrows below the scene's 560px container breakpoint.
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(async () => (await stageAspects(scene)).drawn).toBeCloseTo(aspects.narrow, 1);
    expect(await cutOffLayers(page)).toEqual({ cut: [], documentOverflow: false });

    await page.setViewportSize({ width: 1280, height: 900 });
    aspects = await stageAspects(scene);
    await expect.poll(async () => (await stageAspects(scene)).drawn).toBeCloseTo(aspects.wide, 1);
  });

  test('switching theme on the page swaps scene images to the other theme', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('starlight-theme', 'dark'));
    await page.goto('/');
    const scene = sceneLocator(page, 'chat');
    const image = scene.locator('.is-window .scene-img').first();
    await bringIntoView(scene);
    await expect
      .poll(() => image.evaluate((el) => getComputedStyle(el).backgroundImage))
      .toContain('/images/scenes/chat-window.webp');

    const light = page.waitForRequest((request) =>
      request.url().includes('/images/scenes/chat-window-light.webp')
    );
    await page.locator('.header').getByRole('button', { name: 'Light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect
      .poll(() => image.evaluate((el) => getComputedStyle(el).backgroundImage))
      .toContain('/images/scenes/chat-window-light.webp');
    await light;
  });
});
