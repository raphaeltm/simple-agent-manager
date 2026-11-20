import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

// Mermaid 12 bundles ELK (several megabytes) and makes it the default flowchart
// layout. The marketing site keeps Mermaid off pages without diagrams and keeps
// the dagre layout, so ELK is never fetched for an ordinary diagram.

// Real content pages: if one gains or loses a diagram, pick another page here.
const DOCS_WITHOUT_DIAGRAMS = '/docs/guides/agent-context/';
const DOCS_FLOWCHART = '/docs/architecture/overview/';
const BLOG_FLOWCHART = '/blog/sams-journal-a-deploy-could-recover/';

function recordScriptRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') urls.push(new URL(request.url()).pathname);
  });
  return urls;
}

/** Mermaid stamps each node with its look; v12 would otherwise default to `neo`. */
async function expectClassicLook(page: Page, svg: string) {
  await expect(page.locator(`${svg} [data-look="classic"]`).first()).toBeAttached();
  await expect(page.locator(`${svg} [data-look="neo"]`)).toHaveCount(0);
}

const mermaidChunks = (urls: string[]) => urls.filter((url) => url.includes('/mermaid-chunks/'));
const elkChunks = (urls: string[]) => urls.filter((url) => /\/mermaid-chunks\/elk-/.test(url));

test('a docs page without diagrams loads the loader but not Mermaid', async ({ page }) => {
  const scripts = recordScriptRequests(page);
  await page.goto(DOCS_WITHOUT_DIAGRAMS, { waitUntil: 'networkidle' });

  await expect(page.locator('main h1').first()).toBeVisible();
  expect(scripts).toContain('/scripts/docs-mermaid.js');
  expect(mermaidChunks(scripts)).toEqual([]);
});

test('a docs flowchart renders with the dagre layout and never fetches ELK', async ({ page }) => {
  const scripts = recordScriptRequests(page);
  await page.goto(DOCS_FLOWCHART);

  await expect(page.locator('div.mermaid svg').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('div.mermaid > pre')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(mermaidChunks(scripts).length).toBeGreaterThan(0);
  expect(elkChunks(scripts)).toEqual([]);
  await expectClassicLook(page, 'div.mermaid svg');
});

test('a blog flowchart renders and never fetches ELK', async ({ page }) => {
  const scripts = recordScriptRequests(page);
  await page.goto(BLOG_FLOWCHART);

  await expect(page.locator('.mermaid-shell svg').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  expect(mermaidChunks(scripts).length).toBeGreaterThan(0);
  expect(elkChunks(scripts)).toEqual([]);
  await expectClassicLook(page, '.mermaid-shell svg');
});
