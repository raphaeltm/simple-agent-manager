import { expect, expectNoOverflowOrSeriousAxeViolations, test } from './fixtures';

const PAGES: { path: string; slug: string; heading: string | RegExp }[] = [
  { path: '/', slug: 'home', heading: /operating system for scalable software factories/i },
  {
    path: '/features/',
    slug: 'features-index',
    heading: /Everything your team needs/i,
  },
  {
    path: '/features/multiplayer/',
    slug: 'features-multiplayer',
    heading: /whole team's agents/i,
  },
  { path: '/integrations/', slug: 'integrations-index', heading: /What SAM works with/i },
  {
    path: '/integrations/claude-code/',
    slug: 'integrations-claude-code',
    heading: /^Claude Code$/,
  },
  { path: '/integrations/upcloud/', slug: 'integrations-upcloud', heading: /^UpCloud$/ },
  { path: '/enterprise/', slug: 'enterprise-index', heading: /infrastructure you own/i },
  {
    path: '/enterprise/security/',
    slug: 'enterprise-security',
    heading: /The VM is the boundary/i,
  },
  {
    path: '/enterprise/compliance/',
    slug: 'enterprise-compliance',
    heading: /Where your data lives/i,
  },
  { path: '/enterprise/governance/', slug: 'enterprise-governance', heading: /Who can do what/i },
  { path: '/enterprise/cost-control/', slug: 'enterprise-cost-control', heading: /Three bills/i },
  { path: '/integrations/gitlab/', slug: 'integrations-gitlab', heading: /^GitLab$/ },
  {
    path: '/enterprise/scale/',
    slug: 'enterprise-scale',
    heading: /Many agents, few idle machines/i,
  },
  {
    path: '/enterprise/agent-agnostic/',
    slug: 'enterprise-agent-agnostic',
    heading: /agents your teams already like/i,
  },
  { path: '/enterprise/open-source/', slug: 'enterprise-open-source', heading: /Read the code/i },
];

for (const { path, slug, heading } of PAGES) {
  test(`${path} has no overflow or serious axe violations`, async ({ page }, testInfo) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();

    // Scroll-reveal sections fade in over 0.6s once the IntersectionObserver
    // fires. Neither axe (which samples mid-transition, blended colours) nor a
    // full-page capture waits for that, so settle every section up front.
    await page.addStyleTag({
      content:
        '.animate-on-scroll,.fh [data-reveal]{opacity:1 !important;transform:none !important;transition:none !important}',
    });
    await page.waitForTimeout(300);

    await expectNoOverflowOrSeriousAxeViolations(page);

    const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/www-${slug}-${project}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });
}

for (const path of ['/integrations/', '/enterprise/']) {
  test(`${path} comparison tables stay readable at this viewport`, async ({ page }) => {
    await page.goto(path);
    const table = page.locator('.cmp-table').first();
    await expect(table).toBeVisible();
    // Every SAM-side cell must be on screen, not clipped behind a horizontal scroll.
    const cell = table.locator('tbody td').first();
    await expect(cell).toBeVisible();
    const box = await cell.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && box.x + box.width <= viewport.width + 1).toBe(true);
    // Under 720px each row becomes a card and the column header row is visually hidden.
    const headerHeight = await table
      .locator('thead')
      .evaluate((el) => el.getBoundingClientRect().height);
    if (viewport && viewport.width < 720) expect(headerHeight).toBeLessThanOrEqual(1);
    else expect(headerHeight).toBeGreaterThan(1);
  });
}
