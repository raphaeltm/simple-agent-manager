import { readdirSync, readFileSync } from 'node:fs';

import { captureScreenshot } from './capture-screenshot';
import { expect, type Locator, type Page, test } from './fixtures';

/**
 * Homepage feature scenes: animated real-UI previews beside each feature section.
 * Every case reaches a scene the way a visitor does — scrolling it into the middle of the
 * screen, the reduced-motion preference, the hero's pause control, the theme, JavaScript off —
 * and never sets a scene's state directly. A paused fake clock makes each story step on demand.
 */

const SCENE_IMAGES = '/images/scenes/';
const SCENE_DATA = new URL('../../src/data/scenes/', import.meta.url);

/** Scene specs on disk (src/data/scenes/*.json): what the homepage must render. */
const sceneSpecs = readdirSync(SCENE_DATA)
  .filter((file) => file.endsWith('.json'))
  .map(
    (file) =>
      JSON.parse(readFileSync(new URL(file, SCENE_DATA), 'utf8')) as {
        slug: string;
        description: string;
      }
  );

interface RenderedScene {
  slug: string;
  beats: number[];
}

/** The scenes as the page renders them, in page order, with their step timings. */
async function renderedScenes(page: Page): Promise<RenderedScene[]> {
  return page.locator('[data-scene]').evaluateAll((elements) =>
    elements.map((el) => ({
      slug: (el as HTMLElement).dataset.scene ?? '',
      beats: JSON.parse((el as HTMLElement).dataset.beats ?? '[]') as number[],
    }))
  );
}

const sceneLocator = (page: Page, slug: string) => page.locator(`[data-scene="${slug}"]`);
const lastScene = async (page: Page) => (await renderedScenes(page)).at(-1)?.slug ?? '';

/**
 * Scrolls a scene into the middle of the viewport, where its story starts, and waits for the
 * frame in which it becomes near enough to load its images. The jump is instant: the page
 * otherwise scrolls smoothly, and a scene measured mid-scroll is somewhere else.
 */
async function bringIntoView(scene: Locator) {
  await scene.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(scene).toHaveAttribute('data-near', '');
}

/** Holds the page's clock still so story steps fire only when the test advances time. */
async function holdClock(page: Page) {
  await page.clock.install();
}

async function pauseClock(page: Page) {
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

/** The window's own image is drawn (liveness: the scene is not an empty frame). */
async function expectWindowImage(scene: Locator) {
  const image = scene.locator('.is-window .scene-img').first();
  await expect
    .poll(() => image.evaluate((el) => getComputedStyle(el).backgroundImage))
    .toContain(SCENE_IMAGES);
}

test.describe('homepage feature scenes', () => {
  test('each scene waits in its intro, plays when it reaches the middle of the screen, and rests', async ({
    page,
  }) => {
    await holdClock(page);
    await page.goto('/');
    await pauseClock(page);
    const scenes = await renderedScenes(page);
    expect(scenes.map((scene) => scene.slug).sort()).toEqual(
      sceneSpecs.map((spec) => spec.slug).sort()
    );

    for (const { slug, beats } of scenes) {
      const scene = sceneLocator(page, slug);
      // Before it is seen: the intro frame, with everything that arrives later hidden.
      await expect(scene).toHaveAttribute('data-playing', '');
      await expect(scene).toHaveAttribute('data-pose', 'exploded');
      await expect(scene).toHaveAttribute('data-step', '0');
      const { lasting } = await storyOpacities(scene);
      expect(lasting, slug).toContain('0');

      await startStory(scene);
      await expectWindowImage(scene);
      await expect(scene).not.toHaveAttribute('data-pose');
      let now = beats[0] ?? 0;
      for (const [index, at] of beats.entries()) {
        if (index === 0) continue;
        await page.clock.runFor(at - now);
        now = at;
        await expect(scene, `${slug} step ${index + 1}`).toHaveAttribute(
          'data-step',
          String(index + 1)
        );
      }
      await page.clock.runFor(1000);
      await expectFinalFrame(scene);
    }
  });

  test('a moving highlight visits each real control in turn and is gone at rest', async ({
    page,
  }) => {
    await holdClock(page);
    await page.goto('/');
    await pauseClock(page);
    const scene = sceneLocator(page, 'chat');
    const ring = scene.locator('.scene-ring').first();
    const stops = await ring.evaluate(
      (el) => JSON.parse(el.dataset.stops ?? '[]') as { at: number; box: number[] }[]
    );
    expect(stops.length).toBeGreaterThan(1);
    const beats =
      (await renderedScenes(page)).find((candidate) => candidate.slug === 'chat')?.beats ?? [];

    await startStory(scene);
    let now = 0;
    for (const stop of stops) {
      const at = beats[stop.at - 1] ?? 0;
      await page.clock.runFor(at - now);
      now = at;
      await expect(ring).toHaveClass(/is-on/);
      expect(
        await ring.evaluate((el) => getComputedStyle(el).getPropertyValue('--ring-left').trim())
      ).toBe(`${stop.box[0]}%`);
    }
    await page.clock.runFor(5000);
    await expect(ring).not.toHaveClass(/is-on/);
    await expect(ring).toHaveCSS('opacity', '0');
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

    for (const { slug } of await renderedScenes(page)) {
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

  test("the hero's pause control rests the scenes, and play lets unseen scenes play again", async ({
    page,
  }) => {
    await holdClock(page);
    await page.goto('/');
    await pauseClock(page);
    const scenes = await renderedScenes(page);

    // Pausing mid-story jumps that scene to its final frame.
    const playing = sceneLocator(page, 'multiplayer');
    await startStory(playing);
    await page.clock.runFor(scenes.find((scene) => scene.slug === 'multiplayer')?.beats[1] ?? 0);
    await expect(playing).toHaveAttribute('data-step', '2');
    await page.getByRole('button', { name: 'Pause animation' }).click();
    await expectFinalFrame(playing);

    // While paused, a scene that has not been seen shows its final frame when it arrives.
    const unseen = sceneLocator(page, 'events');
    await expectFinalFrame(unseen);
    await bringIntoView(unseen);
    await page.clock.runFor(1000);
    await expectFinalFrame(unseen);

    // Playing again only re-arms scenes nobody has watched yet.
    await page.getByRole('button', { name: 'Play animation' }).click();
    await expectFinalFrame(playing);
    const later = sceneLocator(page, scenes.at(-1)?.slug ?? '');
    await expect(later).toHaveAttribute('data-playing', '');
    await startStory(later);
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
      const scenes = await renderedScenes(page);
      // The last scene is several screens below the first: nothing of it loads up front.
      const last = scenes.at(-1)?.slug ?? '';
      expect(requested.filter((file) => file.startsWith(`${SCENE_IMAGES}${last}-`))).toEqual([]);

      for (const { slug } of scenes) {
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
    for (const { slug } of await renderedScenes(page)) {
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

  test('each scene links to its feature page and describes its animation', async ({ page }) => {
    await page.goto('/');
    for (const { slug, description } of sceneSpecs) {
      const scene = sceneLocator(page, slug);
      await expect(scene.getByRole('link')).toHaveAttribute('href', `/features/${slug}/`);
      await expect(scene.locator('figcaption')).toContainText(description);
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

test.describe('homepage feature scene layout', () => {
  test.skip(({ isMobile }) => isMobile, 'viewports are set explicitly; one project is enough');

  for (const width of LAYOUT_VIEWPORTS) {
    test(`no scene layer is cut off at ${width}px, in the intro or at rest`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const last = sceneLocator(page, await lastScene(page));
      // Scenes below the fold wait in their exploded intro pose.
      await expect(last).toHaveAttribute('data-pose', 'exploded');
      expect(await cutOffLayers(page)).toEqual({ cut: [], documentOverflow: false });

      // Pausing rests every scene on its final frame at once.
      await page.getByRole('button', { name: 'Pause animation' }).click();
      await expect(last).not.toHaveAttribute('data-playing');
      expect(await cutOffLayers(page)).toEqual({ cut: [], documentOverflow: false });
    });
  }
});
