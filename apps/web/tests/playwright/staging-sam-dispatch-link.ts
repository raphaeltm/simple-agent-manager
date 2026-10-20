import { expect, type Page } from '@playwright/test';

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
