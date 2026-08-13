import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, type Page,test } from '@playwright/test';

const FIXTURE_ROOT = path.resolve(process.cwd(), '../../.codex/tmp/architecture-playwright-fixture');
const SCREENSHOT_DIR = path.resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots');

test.beforeEach(async () => {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await writeModel(normalModel('API component'));
});

test('keyboard drill, lenses, source preview, threads, and SSE reload', async ({ page }, testInfo) => {
  await page.goto('/?lens=structure');
  await expect(page.getByRole('heading', { name: 'Playwright Architecture' })).toBeVisible();
  await assertNoOverflow(page);

  const apiButton = page.getByRole('button', { name: /API component/ }).first();
  await apiButton.focus();
  await apiButton.press('Enter');
  await expect(page.getByLabel('Architecture inspector')).toContainText('API component');
  await page.keyboard.press('Escape');
  await expect(apiButton).toBeFocused();

  await page.getByRole('button', { name: 'Drill into' }).first().click();
  await expect(page).toHaveURL(/focus=api/);
  await page.getByRole('button', { name: 'Root system' }).click();
  await expect(page).toHaveURL(/focus=root/);

  await page.getByRole('button', { name: 'Flow' }).click();
  await expect(page.getByText('Select API')).toBeVisible();
  await page.getByRole('button', { name: 'Open in structure' }).first().click();
  await expect(page).toHaveURL(/lens=structure/);

  await page.getByRole('button', { name: 'State' }).click();
  await expect(page.getByLabel('Task state transition list')).toContainText('queued → running when start');
  await page.getByRole('button', { name: 'Structure' }).click();

  await page.getByRole('button', { name: /API component/ }).first().click();
  await page.getByRole('button', { name: /src\/api.ts:1/ }).click();
  await expect(page.getByLabel('Source preview')).toContainText('export const hello');

  await page.getByLabel('Question title').fill('Browser question');
  await page.getByLabel('Question').fill('Question body');
  await page.getByRole('button', { name: 'Create question' }).click();
  await expect(page.getByText(/Saved to architecture\/threads/)).toBeVisible();
  await page.getByLabel(/Reply to Browser question/).fill('Browser reply');
  await page.getByRole('button', { name: 'Reply' }).last().click();
  await expect(page.getByText(/Browser reply/)).toBeVisible();

  await writeModel(normalModel('API renamed by file edit'));
  await expect(page.getByRole('button', { name: /API renamed by file edit/ }).first()).toBeVisible();
  await screenshot(page, `viewer-main-${testInfo.project.name}`);
  await assertControlBounds(page);
});

test('responsive normal, long, empty, invalid, many, and special-character states', async ({ page }, testInfo) => {
  await page.goto('/');
  await assertNoOverflow(page);
  await screenshot(page, `viewer-normal-${testInfo.project.name}`);

  await writeModel(longModel());
  await expect(page.getByText(/very-long-token/)).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, `viewer-long-${testInfo.project.name}`);

  await writeModel(emptyModel());
  await expect(page.getByText('Empty architecture workspace')).toBeVisible();
  await assertNoOverflow(page);

  await writeModel('version: 1\nname: Broken\nelements:\n  - id: api\n');
  await expect(page.getByText(/Invalid workspace edit detected/)).toBeAttached();

  await writeModel(manyModel());
  await expect(page.getByText('Node 34')).toBeVisible();
  await assertNoOverflow(page);

  await writeModel(specialModel());
  await expect(page.getByText('Literal <script>alert(1)</script>')).toBeVisible();
  expect(await page.locator('script', { hasText: 'alert(1)' }).count()).toBe(0);
  await assertNoOverflow(page);
  await screenshot(page, `viewer-special-${testInfo.project.name}`);
});

async function screenshot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600);
  await page.screenshot({ fullPage: true, path: path.join(SCREENSHOT_DIR, `${name}.png`) });
}

async function writeModel(content: string): Promise<void> {
  await writeFile(path.join(FIXTURE_ROOT, 'architecture/model.yaml'), content);
}

async function assertNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const rootOverflow = document.documentElement.scrollWidth > viewportWidth || document.body.scrollWidth > viewportWidth;
    const clipped = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .filter((element) => !element.closest('[data-intentional-clip]'))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') return false;
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return false;
        return (style.overflowX === 'hidden' || style.overflowX === 'clip') && element.scrollWidth > element.clientWidth + 1;
      })
      .map((element) => ({ className: element.className, tag: element.tagName }));
    return { clipped, rootOverflow };
  });
  expect(overflow.rootOverflow, JSON.stringify(overflow)).toBe(false);
  expect(overflow.clipped, JSON.stringify(overflow)).toEqual([]);
}

async function assertControlBounds(page: Page): Promise<void> {
  const bounds = await page.evaluate(() => {
    const selectors = ['.architecture-app', '.lens-tabs', '.architecture-inspector'];
    const width = window.innerWidth;
    return selectors.map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return { selector, left: rect?.left ?? 0, right: rect?.right ?? 0, width };
    });
  });
  for (const bound of bounds) {
    expect(bound.left, bound.selector).toBeGreaterThanOrEqual(0);
    expect(bound.right, bound.selector).toBeLessThanOrEqual(bound.width);
  }
}

function normalModel(apiTitle: string): string {
  return `
version: 1
name: Playwright Architecture
elements:
  - id: root
    kind: system
    title: Root system
  - id: api
    parent: root
    kind: component
    title: ${apiTitle}
    sourceRefs:
      - path: src/api.ts
        startLine: 1
  - id: worker
    parent: root
    kind: runtime
    title: Worker runtime
relationships:
  - id: api-worker
    from: api
    to: worker
    title: API calls Worker
flows:
  - id: request-flow
    title: Request flow
    steps:
      - id: select
        title: Select API
        element: api
      - id: call
        title: Call Worker
        relationship: api-worker
stateMachines:
  - id: task-state
    title: Task state
    element: api
    states:
      - id: queued
        title: Queued
      - id: running
        title: Running
    transitions:
      - from: queued
        to: running
        event: start
`;
}

function emptyModel(): string {
  return 'version: 1\nname: Empty\n';
}

function longModel(): string {
  return normalModel(`API with very-long-token-${'x'.repeat(180)} and https://example.com/${'y'.repeat(160)}`);
}

function manyModel(): string {
  const nodes = Array.from({ length: 35 }, (_, index) => `  - id: node-${index}
    parent: root
    kind: component
    title: Node ${index}`).join('\n');
  return `version: 1
name: Many
elements:
  - id: root
    kind: system
    title: Root system
${nodes}
`;
}

function specialModel(): string {
  return normalModel('Literal <script>alert(1)</script>');
}
