import { expect, test } from './fixtures';

const mermaidPosts = [
  {
    name: 'an existing archive post',
    path: '/blog/sams-journal-making-room-for-old-conversations/',
    screenshotName: 'existing-archive',
  },
  {
    name: 'the new archive drain journal',
    path: '/blog/sams-journal-the-archive-got-a-clock/',
    screenshotName: 'archive-drain',
  },
];

for (const post of mermaidPosts) {
  test(`${post.name} has a visible Mermaid viewport`, async ({ page }, testInfo) => {
    await page.goto(post.path);

    const diagram = page.locator('.mermaid-shell svg');
    await expect(diagram).toBeVisible();

    await expect
      .poll(() =>
        diagram.evaluate((svg) => {
          const values = svg
            .getAttribute('viewBox')
            ?.split(/[\s,]+/)
            .map(Number);
          return values && values.length === 4 && values[2] > 0 && values[3] > 0;
        })
      )
      .toBe(true);

    const surface = page.locator('.mermaid-surface');
    await expect(surface).toBeVisible();
    const surfaceBox = await surface.boundingBox();
    expect(surfaceBox?.width).toBeGreaterThan(0);
    expect(surfaceBox?.height).toBeGreaterThan(0);

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);

    const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/www-blog-mermaid-${post.screenshotName}-${project}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });
}
