import { expect, test, type Page } from './fixtures';

async function openWizard(page: Page) {
  await page.goto('/self-host/');
  await expect(page.locator('.sh')).toBeVisible();
}

async function continueFrom(page: Page, label = 'Continue') {
  await page.getByRole('button', { name: label }).click();
}

async function reachPreviewWithValues(
  page: Page,
  opts: { domain: string; appName: string; accountType?: 'personal' | 'org'; orgName?: string }
) {
  await openWizard(page);
  await continueFrom(page, 'Get started');
  await page.locator('#sh-domain').fill(opts.domain);
  await page.locator('#sh-cf-account').fill('0123456789abcdef0123456789abcdef');
  await continueFrom(page);
  await continueFrom(page);
  await continueFrom(page);
  await expect(page.getByRole('heading', { name: 'Create your GitHub App' })).toBeVisible();

  if (opts.accountType === 'org') {
    await page.locator('input[name="sh-account-type"][value="org"]').click();
    if (opts.orgName) await page.locator('#sh-org').fill(opts.orgName);
  }

  await page.locator('#sh-app-name').fill(opts.appName);
  await page.getByRole('button', { name: 'Generate setup link' }).click();
  await expect(page.locator('#sh-app-result')).toBeVisible();
}

/**
 * Assert that every dd value inside the preview definition list fits within
 * the CSS viewport width. This catches the mobile overflow where grid tracks
 * expand past the viewport due to long monospace URL values.
 *
 * The document-level scrollWidth <= innerWidth check is insufficient because
 * overflow-x:hidden on ancestor containers causes both to expand together.
 */
async function assertPreviewValuesWithinViewport(page: Page) {
  const cssViewportWidth = page.viewportSize()!.width;

  const rects = await page.locator('#sh-app-preview dd').evaluateAll((dds) =>
    dds.map((dd) => {
      const r = dd.getBoundingClientRect();
      return { right: r.right, width: r.width, text: dd.textContent?.slice(0, 40) ?? '' };
    })
  );

  expect(rects.length).toBeGreaterThan(0);

  for (const rect of rects) {
    expect(
      rect.right,
      `preview dd "${rect.text}" right edge ${rect.right}px exceeds viewport ${cssViewportWidth}px`
    ).toBeLessThanOrEqual(cssViewportWidth);
  }
}

test.describe('self-host wizard preview overflow (mobile)', () => {
  test('personal install preview values stay within viewport', async ({ page }) => {
    await reachPreviewWithValues(page, {
      domain: 'example.com',
      appName: 'My SAM Instance',
    });
    await assertPreviewValuesWithinViewport(page);
  });

  test('org install preview values stay within viewport', async ({ page }) => {
    await reachPreviewWithValues(page, {
      domain: 'example.com',
      appName: 'SAM',
      accountType: 'org',
      orgName: 'acme-corp',
    });
    await assertPreviewValuesWithinViewport(page);
  });

  test('long domain and app name preview values stay within viewport', async ({ page }) => {
    await reachPreviewWithValues(page, {
      domain: 'my-very-long-subdomain.internal.example-company.org',
      appName: 'My-Extremely-Long-Self-Hosted-SAM-Instance-Name-For-Testing',
    });
    await assertPreviewValuesWithinViewport(page);
  });

  test('special character inputs preview values stay within viewport', async ({ page }) => {
    await reachPreviewWithValues(page, {
      domain: 'example.com',
      appName: 'SAM-Ünïcödé-<b>bold</b>',
    });
    await assertPreviewValuesWithinViewport(page);
  });
});
