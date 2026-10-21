import { expect, type Page, type Request } from '@playwright/test';

/** Internal Router links store a relative href; verify their resolved destination too. */
export async function expectDispatchSourceLink(page: Page, source: string): Promise<void> {
  const destination = new URL(source);
  expect(destination.origin).toBe(new URL(page.url()).origin);
  const path = `${destination.pathname}${destination.search}${destination.hash}`;
  const link = page
    .getByRole('link', { name: 'Open chat', exact: true })
    .and(page.locator(`a[href=${JSON.stringify(path)}]`))
    .first();
  await expect(link).toBeVisible();
  await expect(link).toHaveJSProperty('href', destination.href);
}

/** Navigation completion precedes the authenticated history fetch. Await that read explicitly. */
export async function reloadSamHistory(page: Page, samApi: string, timeout: number): Promise<void> {
  let requested: Request | undefined;
  let navigationStarted = false;
  const onRequest = (item: Request) => {
    if (item.isNavigationRequest() && item.frame() === page.mainFrame()) navigationStarted = true;
    if (navigationStarted && item.url() === `${samApi}/turns` && item.method() === 'GET')
      requested = item;
  };
  page.on('request', onRequest);
  const response = page.waitForResponse((item) => item.request() === requested, { timeout });
  try {
    const [history] = await Promise.all([response, page.reload({ timeout })]);
    expect(history.status(), 'Reloaded private history read succeeds').toBe(200);
  } finally {
    page.off('request', onRequest);
  }
}
