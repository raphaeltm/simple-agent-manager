import { expect, type Locator, type Page, test } from './fixtures';

/**
 * Code blocks, as readers see them on the built site (Expressive Code, configured in
 * src/lib/expressive-code.ts).
 *
 * Blog code blocks once rendered as bare text: their frame takes colours and fonts from
 * Starlight variables that only docs pages define, the marketing CSS reset zeroed their
 * padding, and the page CSP blocked their inline SVG icons. Each guard has its own test, and
 * every test runs in both site themes, set the way a visitor's choice is stored.
 */

// A blog post with untitled JSON and Go blocks and a shell block.
const BLOG_POST = '/blog/sams-journal-killing-docker-in-docker/';
// A blog post whose code block is titled with its source file.
const TITLED_POST = '/blog/sams-journal-making-agent-choice-explicit/';
const DOCS_PAGE = '/docs/guides/secret-execution/';
const DOCS_MERMAID_PAGE = '/docs/architecture/overview/';

const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];

async function openInTheme(page: Page, path: string, theme: Theme): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem('starlight-theme', value);
  }, theme);
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/** The first code block with line numbers that is not a terminal window. */
function codeBlock(page: Page): Locator {
  return page.locator('.expressive-code', { has: page.locator('.ln') }).first();
}

type BlockStyles = {
  borderWidth: number;
  borderAlpha: number;
  background: [number, number, number, number];
  pageBackground: [number, number, number, number];
  codeFont: string;
  siteMonoFont: string;
  codePaddingEnd: number;
  lineNumberPadding: number;
  lineNumberContrast: number;
};

function readBlockStyles(block: Locator): Promise<BlockStyles> {
  return block.evaluate((element) => {
    const canvas = document.createElement('canvas').getContext('2d');
    const rgba = (color: string): [number, number, number, number] => {
      if (!canvas) throw new Error('no canvas');
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      return [r ?? 0, g ?? 0, b ?? 0, a ?? 0];
    };
    const luminance = ([r, g, b]: number[]) =>
      [r ?? 0, g ?? 0, b ?? 0]
        .map((channel) => channel / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index]!, 0);

    const pre = element.querySelector('pre');
    const code = element.querySelector('.ec-line .code');
    const lineNumber = element.querySelector('.ln');
    if (!pre || !code || !lineNumber) throw new Error('code block markup is missing');
    const preStyle = getComputedStyle(pre);
    const background = rgba(preStyle.backgroundColor);
    const numberColor = rgba(getComputedStyle(lineNumber).color);
    const [light, dark] = [luminance(numberColor), luminance(background)].sort((a, b) => b - a);
    return {
      borderWidth: parseFloat(preStyle.borderLeftWidth),
      borderAlpha: rgba(preStyle.borderLeftColor)[3],
      background,
      pageBackground: rgba(getComputedStyle(document.body).backgroundColor),
      codeFont: getComputedStyle(code).fontFamily,
      siteMonoFont: getComputedStyle(document.documentElement)
        .getPropertyValue('--font-mono')
        .trim(),
      codePaddingEnd: parseFloat(getComputedStyle(code).paddingInlineEnd),
      lineNumberPadding: parseFloat(getComputedStyle(lineNumber).paddingInlineStart),
      lineNumberContrast: ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05),
    };
  });
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test('a blog code block has a visible frame, its own background and the site mono font', async ({
      page,
    }) => {
      await openInTheme(page, BLOG_POST, theme);
      const block = codeBlock(page);
      await block.scrollIntoViewIfNeeded();
      await expect(block).toBeVisible();

      const styles = await readBlockStyles(block);
      expect(styles.borderWidth).toBeGreaterThanOrEqual(1);
      expect(styles.borderAlpha).toBeGreaterThan(0);
      expect(styles.background[3]).toBe(255);
      expect(styles.background).not.toEqual(styles.pageBackground);
      expect(styles.siteMonoFont).not.toBe('');
      expect(styles.codeFont).toBe(styles.siteMonoFont);
    });

    test('code block padding survives the marketing CSS reset', async ({ page }) => {
      await openInTheme(page, BLOG_POST, theme);
      const styles = await readBlockStyles(codeBlock(page));
      expect(styles.codePaddingEnd).toBeGreaterThan(0);
      expect(styles.lineNumberPadding).toBeGreaterThan(0);
    });

    test('line numbers are hidden from screen readers and meet WCAG AA contrast', async ({
      page,
    }) => {
      await openInTheme(page, BLOG_POST, theme);
      const block = codeBlock(page);
      const numbers = block.locator('.ln');
      await expect(numbers.first()).toHaveText('1');
      await expect(numbers.first()).toHaveAttribute('aria-hidden', 'true');
      expect(await numbers.count()).toBe(await block.locator('.ec-line').count());
      const styles = await readBlockStyles(block);
      // Measured against the code background, which must be opaque for the ratio to mean anything.
      expect(styles.background[3]).toBe(255);
      expect(styles.lineNumberContrast).toBeGreaterThanOrEqual(4.5);
    });

    test('blocks are labelled: language tab, file tab, or terminal window', async ({ page }) => {
      await openInTheme(page, BLOG_POST, theme);
      const go = page.locator('.expressive-code', { has: page.locator('pre[data-language="go"]') });
      await expect(go.locator('.frame.has-title .title')).toHaveText('Go');

      // A shell block stays a terminal window: no tab, no line numbers, code still shown.
      const shell = page
        .locator('.expressive-code', { has: page.locator('pre[data-language="bash"]') })
        .first();
      await expect(shell.locator('.frame.is-terminal')).toBeVisible();
      await expect(shell.locator('.ec-line').first()).toBeVisible();
      await expect(shell.locator('.ln')).toHaveCount(0);
      await expect(shell.locator('.title')).toHaveText('');

      await openInTheme(page, TITLED_POST, theme);
      const titled = codeBlock(page);
      await expect(titled.locator('.title')).toHaveText('apps/api/src/services/skills.ts');
      await expect(titled.locator('.ln')).toHaveCount(9);
    });

    test('code block icons load under the page Content Security Policy', async ({ page }) => {
      await page.addInitScript(() => {
        const violations: string[] = [];
        Object.assign(window, { cspViolations: violations });
        document.addEventListener('securitypolicyviolation', (event) => {
          violations.push(`${event.violatedDirective} ${event.blockedURI}`);
        });
      });
      await openInTheme(page, BLOG_POST, theme);
      // The terminal title bar and copy buttons draw their icons from inline SVG data URLs.
      const shell = page.locator('.frame.is-terminal').first();
      await shell.scrollIntoViewIfNeeded();
      await expect(shell).toBeVisible();
      await expect(shell.locator('.copy button')).toHaveCount(1);
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => Reflect.get(window, 'cspViolations'))).toEqual([]);
    });

    test('docs code blocks get the same tab and line numbers', async ({ page }) => {
      await openInTheme(page, DOCS_PAGE, theme);
      const block = codeBlock(page);
      await expect(block.locator('.title')).toHaveText('JSON');
      await expect(block.locator('.ln').first()).toHaveText('1');
      const styles = await readBlockStyles(block);
      expect(styles.background[3]).toBe(255);
      expect(styles.lineNumberContrast).toBeGreaterThanOrEqual(4.5);
    });
  });
}

test('docs Mermaid diagrams still render: their source carries no line numbers', async ({
  page,
}) => {
  await page.goto(DOCS_MERMAID_PAGE);
  // docs-mermaid.ts reads each source line's text; a line number would break the parse and
  // leave the source in a <pre> instead of a diagram.
  await expect(page.locator('div.mermaid svg').first()).toBeVisible();
  await expect(page.locator('div.mermaid > pre')).toHaveCount(0);
});

test('a blog post with code blocks fits the screen', async ({ page }, testInfo) => {
  await page.goto(BLOG_POST);
  await expect(codeBlock(page)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);

  const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
  const block = codeBlock(page);
  await block.scrollIntoViewIfNeeded();
  await block.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/www-blog-code-block-${project}.png`,
    animations: 'disabled',
  });
});
