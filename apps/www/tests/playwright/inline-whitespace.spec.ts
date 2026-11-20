import { expect, test } from './fixtures';

// Astro 7 changed the default `compressHTML` to 'jsx', which drops the newline between
// an inline element and the text on the next source line ("covers <code>*.example.com</code>
// ⏎ but not" renders "*.example.combut"). astro.config.ts keeps the HTML-aware `true`.
// This reads the built page, so it fails if that setting is removed.
test('inline elements keep the space to the words around them', async ({ page }) => {
  await page.goto('/self-host/');
  const normalizedText = async (selector: string, hasText: string) => {
    const element = page.locator(selector, { hasText });
    await expect(element).toHaveCount(1);
    return ((await element.textContent()) ?? '').replace(/\s+/g, ' ');
  };

  expect(await normalizedText('.sh-callout-warn', 'Universal SSL')).toContain(
    'covers *.example.com but not nested wildcards like *.sam.example.com.'
  );
  expect(await normalizedText('.sh-why-body p', 'Deploy Production')).toContain(
    'manually run the Deploy Production workflow.'
  );
});
