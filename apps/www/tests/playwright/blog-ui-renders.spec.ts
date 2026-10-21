import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type Page, test } from './fixtures';

/**
 * UI renders in blog posts ("UI Renders" in src/content/CLAUDE.md).
 *
 * The first test checks the markup of every render in every post, so a post that embeds one
 * wrongly fails CI before it publishes. The others check one post in a real browser.
 */

const BLOG_DIR = fileURLToPath(new URL('../../src/content/blog', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));
const RENDER_POST = 'sams-journal-making-agent-choice-explicit';

function attributes(tag: string): Map<string, string> {
  return new Map(
    [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name!, value!])
  );
}

/** Pixel size from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  if (bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function renderProblems(slug: string, markdown: string): string[] {
  const problems: string[] = [];
  for (const [, target] of markdown.matchAll(/!\[[^\]]*\]\((\/images\/blog\/[^)\s]+)/g)) {
    problems.push(`${target} uses Markdown image syntax; embed renders in a <figure>`);
  }
  for (const [figure] of markdown.matchAll(/<figure>[\s\S]*?<\/figure>/g)) {
    const images = [...figure.matchAll(/<img\b[^>]*>/g)].map(([tag]) => attributes(tag));
    const themes = images.map((image) => image.get('class') ?? '').sort();
    if (images.length === 0) problems.push(`a figure has no image`);
    if (images.length > 1 && themes.join() !== 'shot-dark,shot-light') {
      problems.push(`a figure pairs ${themes.join(' + ')}; use one shot-dark and one shot-light`);
    }
    if (!/<figcaption>[^<]+<\/figcaption>/.test(figure)) problems.push(`a figure has no caption`);
    for (const image of images) {
      const src = image.get('src') ?? '';
      const label = src || '<img>';
      if (!src.startsWith(`/images/blog/${slug}/`)) {
        problems.push(`${label} must live in /images/blog/${slug}/`);
        continue;
      }
      if (!image.get('alt')?.trim()) problems.push(`${label} has no alt text`);
      const file = path.join(PUBLIC_DIR, src);
      if (!existsSync(file)) {
        problems.push(`${label} does not exist`);
        continue;
      }
      // blogShot() captures at 2x; width/height are the CSS size it printed.
      const pixels = pngSize(file);
      const width = Number(image.get('width'));
      const height = Number(image.get('height'));
      if (Math.abs(pixels.width - 2 * width) > 2 || Math.abs(pixels.height - 2 * height) > 2) {
        problems.push(
          `${label} is ${pixels.width}x${pixels.height}px but declares ${width}x${height}; ` +
            'use the CSS size blogShot() printed'
        );
      }
    }
  }
  return problems;
}

test('every blog UI render is a captioned, theme-paired 2x figure', () => {
  const posts = readdirSync(BLOG_DIR).filter((name) => name.endsWith('.md'));
  expect(posts).toContain(`${RENDER_POST}.md`);

  const problems = posts.flatMap((name) => {
    const slug = name.replace(/\.md$/, '');
    return renderProblems(slug, readFileSync(path.join(BLOG_DIR, name), 'utf8')).map(
      (problem) => `${name}: ${problem}`
    );
  });
  expect(problems).toEqual([]);
  // Liveness: the check above read real figures, not an empty set.
  const figures = readFileSync(path.join(BLOG_DIR, `${RENDER_POST}.md`), 'utf8').match(/<figure>/g);
  expect(figures?.length).toBe(2);
});

/**
 * Posts are written by an agent and may now carry raw HTML (render figures). Outside code,
 * nothing in a post may be able to run script.
 */
const SCRIPTABLE_HTML =
  /<\s*(?:script|iframe|object|embed|form|style|link|meta|base)\b|<[^>]*\son[a-z]+\s*=|<[^>]*=\s*["']?\s*javascript:|\]\(\s*javascript:/i;

function withoutCode(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*/g, '\n')
    .replace(/(`+)[^`\n]*?\1/g, '');
}

test('blog posts contain no script-capable raw HTML outside code', () => {
  const posts = readdirSync(BLOG_DIR).filter((name) => name.endsWith('.md'));
  expect(posts.length).toBeGreaterThan(0);
  const offenders = posts.flatMap((name) => {
    const match = SCRIPTABLE_HTML.exec(
      withoutCode(readFileSync(path.join(BLOG_DIR, name), 'utf8'))
    );
    return match ? [`${name}: ${match[0]}`] : [];
  });
  expect(offenders).toEqual([]);
  // Liveness: the same check catches a handler attribute and a script link in a paragraph,
  // and leaves prose and code alone.
  expect(
    SCRIPTABLE_HTML.test(withoutCode('A post.\n\n<img src="x.png" onerror="alert(1)">\n'))
  ).toBe(true);
  expect(SCRIPTABLE_HTML.test(withoutCode('[click](javascript:alert(1))'))).toBe(true);
  expect(SCRIPTABLE_HTML.test(withoutCode('Use only = one sign; javascript: the language.'))).toBe(
    false
  );
  expect(
    SCRIPTABLE_HTML.test(withoutCode('Use `<script>` here.\n\n```html\n<script></script>\n```\n'))
  ).toBe(false);
});

async function visibleRenders(page: Page) {
  return page.locator('.post-body > figure img').evaluateAll((images) =>
    images
      .filter((image) => getComputedStyle(image).display !== 'none')
      .map((image) => {
        const img = image as HTMLImageElement;
        const box = img.getBoundingClientRect();
        return {
          file: img.src.split('/').pop() ?? '',
          loaded: img.complete && img.naturalWidth > 0,
          width: box.width,
          declaredWidth: Number(img.getAttribute('width')),
          bodyWidth: img.closest('.post-body')?.getBoundingClientRect().width ?? 0,
        };
      })
  );
}

for (const theme of ['dark', 'light'] as const) {
  test(`renders follow the ${theme} site theme and fit the column`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => {
      localStorage.setItem('starlight-theme', value);
    }, theme);
    await page.goto(`/blog/${RENDER_POST}/`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const figures = page.locator('.post-body > figure');
    await expect(figures).toHaveCount(2);
    for (const figure of await figures.all()) {
      await figure.scrollIntoViewIfNeeded();
      await expect(figure.locator('figcaption')).toBeVisible();
    }

    await expect.poll(async () => (await visibleRenders(page)).every((r) => r.loaded)).toBe(true);
    const renders = await visibleRenders(page);
    expect(renders.map((render) => render.file)).toEqual([
      `composer-to-control-${theme}.png`,
      `profile-picker-${theme}.png`,
    ]);
    for (const render of renders) {
      expect(render.width).toBeLessThanOrEqual(render.declaredWidth + 0.5);
      expect(render.width).toBeLessThanOrEqual(render.bodyWidth + 0.5);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);

    const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
    await figures.last().screenshot({
      path: `../../.codex/tmp/playwright-screenshots/www-blog-ui-render-${theme}-${project}.png`,
      animations: 'disabled',
    });
  });
}
