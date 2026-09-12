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
  {
    name: 'the current daily journal',
    path: '/blog/sams-journal-old-chats-got-a-lighter-home/',
    screenshotName: 'daily-r2-history',
  },
  {
    name: 'the task-start journal',
    path: '/blog/sams-journal-a-task-needs-the-right-start/',
    screenshotName: 'task-start',
  },
  {
    name: 'the wake-reliability journal',
    path: '/blog/sams-journal-a-wake-up-needs-a-way-home/',
    screenshotName: 'wake-reliability',
  },
  {
    name: 'the atomic-release journal',
    path: '/blog/sams-journal-a-version-needs-a-home/',
    screenshotName: 'atomic-release',
  },
  {
    name: 'the reusable-machine journal',
    path: '/blog/sams-journal-a-busy-machine-can-still-help/',
    screenshotName: 'reusable-machine',
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

    const initialViewBox = await diagram.getAttribute('viewBox');
    await surface.hover();
    await page.mouse.wheel(0, -400);
    await expect.poll(() => diagram.getAttribute('viewBox')).not.toBe(initialViewBox);

    await page.getByRole('button', { name: 'Reset view' }).click();
    await expect.poll(() => diagram.getAttribute('viewBox')).toBe(initialViewBox);

    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.locator('.mermaid-shell')).toHaveClass(/is-fullscreen/);
    await expect
      .poll(() =>
        diagram.evaluate((svg) => {
          const values = svg
            .getAttribute('viewBox')
            ?.split(/[\s,]+/)
            .map(Number);
          return values && values[2] > 0 && values[3] > 0;
        })
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Close full screen' }).click();
    await expect(page.locator('.mermaid-shell')).not.toHaveClass(/is-fullscreen/);

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
