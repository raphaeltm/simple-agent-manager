import { appendFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, type Page, test } from '@playwright/test';

const FIXTURE_ROOT = path.resolve(
  process.cwd(),
  '../../.codex/tmp/architecture-playwright-fixture'
);
const SCREENSHOT_DIR = path.resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots');

test.beforeEach(async () => {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await rm(path.join(FIXTURE_ROOT, 'architecture/threads'), { force: true, recursive: true });
  await writeModel(normalModel('API component'));
});

test('keyboard drill, lenses, source preview, threads, and SSE reload', async ({
  page,
}, testInfo) => {
  await page.goto('/?lens=structure');
  await expect(page.getByRole('heading', { name: 'Playwright Architecture' })).toBeVisible();
  await assertNoOverflow(page);
  await assertViewportScrollOwnership(page);

  if (testInfo.project.name.startsWith('mobile')) {
    const controlTops = await page
      .locator('.zoom-controls > *')
      .evaluateAll((controls) =>
        controls.map((control) => Math.round(control.getBoundingClientRect().top))
      );
    expect(new Set(controlTops).size).toBe(1);
  }

  const apiButton = page.locator('.node-select', { hasText: 'API component' });
  await apiButton.focus();
  await apiButton.press('Enter');
  const inspector = page.locator('aside[aria-label="Architecture inspector"]');
  await expect(inspector).toContainText('API component');
  if (testInfo.project.name.startsWith('mobile')) {
    await expect(inspector).toHaveAttribute('role', 'dialog');
    const focusable = inspector.locator(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled])'
    );
    await expect(focusable.first()).toBeFocused();
    await screenshot(page, `viewer-inspector-open-${testInfo.project.name}`);
    await page.keyboard.press('Shift+Tab');
    await expect(focusable.last()).toBeFocused();
    await focusable.last().focus();
    await page.keyboard.press('Tab');
    await expect(focusable.first()).toBeFocused();
    await page.setViewportSize({ width: 900, height: 667 });
    await expect(inspector).toHaveAttribute('role', 'complementary');
    await expect(page.getByRole('button', { name: 'Close architecture inspector' })).toHaveCount(0);
    await expect(page.locator('.topbar')).not.toHaveAttribute('inert', '');
    await page.setViewportSize({ width: 375, height: 667 });
    await apiButton.click();
    await expect(inspector).toHaveAttribute('role', 'dialog');
  }
  await page.keyboard.press('Escape');
  await expect(apiButton).toBeFocused();

  await page.getByRole('button', { name: 'Open API component scope' }).click();
  await expect(page).toHaveURL(/focus=api/);
  await page.getByRole('button', { name: 'Root system' }).click();
  await expect(page).toHaveURL(/focus=root/);

  await page.getByRole('button', { name: 'Flow' }).click();
  await expect(page.getByText('Select API')).toBeVisible();
  await expect(page.locator('.flow-step-index')).toHaveText(['01', '02']);
  await expect(page.getByRole('button', { name: 'Open API component in structure' })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect relationship API calls Worker' }).click();
  await expect(inspector).toContainText('api → worker');
  if (testInfo.project.name.startsWith('mobile')) await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
  await screenshot(page, `viewer-flow-${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Open API component in structure' }).click();
  await expect(page).toHaveURL(/lens=structure/);

  const topologyTab = page.getByRole('button', { name: 'Topology' });
  await topologyTab.click();
  await topologyTab.hover();
  const activeTabColors = await topologyTab.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { background: style.backgroundColor, text: style.color };
  });
  expect(activeTabColors.text).not.toBe(activeTabColors.background);
  await expect(page.getByRole('region', { name: 'Directed system topology' })).toBeVisible();
  const topology = page.locator('.topology-lens');
  const apiTopologyNode = topology.locator('.topology-node', { hasText: 'API component' });
  await expect(apiTopologyNode).toBeVisible();
  await expect(topology.getByRole('button', { name: 'Worker runtime' })).toBeVisible();
  await screenshot(page, `viewer-topology-overview-${testInfo.project.name}`);
  await apiTopologyNode.click();
  await expect(apiTopologyNode).toHaveClass(/selected/);
  await expect
    .poll(() =>
      apiTopologyNode.evaluate((element) => window.getComputedStyle(element).outlineWidth)
    )
    .toBe('5px');
  if (testInfo.project.name.startsWith('mobile')) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Inspect API calls Worker connection' }).click();
  await expect(inspector).toContainText('api → worker');
  if (testInfo.project.name.startsWith('mobile')) await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  const squaredSurfaces = await page
    .locator('.canvas, .architecture-inspector, .topology-node, .lens-tab')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        className: element.className,
        radius: window.getComputedStyle(element).borderRadius,
      }))
    );
  expect(
    squaredSurfaces.every((surface) => surface.radius === '0px'),
    squaredSurfaces
  ).toBe(true);
  await assertNoOverflow(page);
  await assertViewportScrollOwnership(page);
  await screenshot(page, `viewer-topology-${testInfo.project.name}`);

  await page.getByRole('button', { name: 'State' }).click();
  await expect(page.getByLabel('Task state transition list')).toContainText('Queued');
  await expect(page.getByLabel('Queued when start goes to Running')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
  await screenshot(page, `viewer-state-${testInfo.project.name}`);
  if (testInfo.project.name.startsWith('mobile')) {
    await page.setViewportSize({ width: 320, height: 700 });
    await assertNoOverflow(page);
    await page.setViewportSize({ width: 375, height: 667 });
  }
  await page.getByRole('button', { name: 'Structure' }).click();

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByLabel('Canvas zoom')).toHaveText('113%');

  const structureCanvas = page.getByRole('region', { name: 'structure architecture canvas' });
  await structureCanvas.locator('.focus-node', { hasText: 'API component' }).click();
  const sourceButton = page.getByRole('button', { name: /src\/api.ts:1/ });
  await sourceButton.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(sourceButton).toBeInViewport();
  await sourceButton.click();
  await expect(page.getByLabel('Source preview')).toContainText('export const hello');
  await assertViewportScrollOwnership(page);
  await expect(page.locator('.topbar')).toBeInViewport();

  const windowScrollBeforeAsk = await page.evaluate(() => window.scrollY);
  await page.getByRole('button', { name: 'Ask about API component' }).click();
  await expect(page.getByRole('heading', { name: 'Discussion' })).toBeFocused();
  await expect.poll(() => inspector.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(windowScrollBeforeAsk);
  await assertNoOverflow(page);

  await page.getByLabel('Question title').fill('Browser question');
  await page.getByLabel('Question', { exact: true }).fill('Question body');
  await page.getByRole('button', { name: 'Create question' }).click();
  await expect(page.getByText(/Saved to architecture\/threads/)).toBeVisible();
  await page.getByLabel(/Reply to Browser question/).fill('Browser reply');
  await page.getByRole('button', { name: 'Reply in thread' }).last().click();
  await expect(page.getByText(/Browser reply/)).toBeVisible();

  const threadFiles = await readdir(path.join(FIXTURE_ROOT, 'architecture/threads'));
  const threadFile = threadFiles.find((file) => file.endsWith('.thread.md'));
  expect(threadFile).toBeDefined();
  const directAgentReply = `Reply added by direct file edit — Δ <safe> & Unicode. ${'A'.repeat(500)}`;
  await appendFile(
    path.join(FIXTURE_ROOT, 'architecture/threads', threadFile!),
    `\n<!-- arch-message id: msg-direct-edit
author: agent
createdAt: '2026-08-13T00:02:00.000Z' -->
${directAgentReply}
`
  );
  await expect(page.getByText(directAgentReply)).toBeVisible();
  const browserThread = page.getByRole('list', { name: 'Browser question messages' });
  await expect(browserThread.getByLabel('Author: user').first()).toContainText('User');
  await expect(browserThread.getByLabel('Author: agent')).toContainText('Agent');
  await expect(browserThread.locator('time').last()).toHaveAttribute(
    'datetime',
    '2026-08-13T00:02:00.000Z'
  );

  if (testInfo.project.name.startsWith('mobile')) {
    await page.setViewportSize({ width: 320, height: 700 });
    await inspector.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByRole('button', { name: 'Ask about API component' }).click();
    await expect(page.getByRole('heading', { name: 'Discussion' })).toBeFocused();
    await assertNoOverflow(page);
    await screenshot(page, `viewer-qa-320-${testInfo.project.name}`);
    await page.setViewportSize({ width: 375, height: 667 });
  }

  if (testInfo.project.name.startsWith('mobile')) await page.keyboard.press('Escape');

  await writeModel(normalModel('API renamed by file edit'));
  await expect(page.locator('.node-title', { hasText: 'API renamed by file edit' })).toBeVisible();
  await screenshot(page, `viewer-main-${testInfo.project.name}`);
  await assertControlBounds(page);
});

test('responsive normal, long, empty, invalid, many, and special-character states', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await assertNoOverflow(page);
  await screenshot(page, `viewer-normal-${testInfo.project.name}`);

  await writeModel(longModel());
  await expect(page.getByText(/very-long-token/)).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, `viewer-long-${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Topology' }).click();
  await expect(page.locator('.topology-node')).toHaveCount(3);
  await assertNoOverflow(page);
  await assertViewportScrollOwnership(page);
  await screenshot(page, `viewer-topology-long-${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Structure' }).click();

  await writeModel(emptyModel());
  await expect(page.getByText('Empty architecture workspace')).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, `viewer-empty-${testInfo.project.name}`);

  await writeModel('version: 1\nname: Broken\nelements:\n  - id: api\n');
  await expect(page.getByRole('alert')).toContainText('Invalid workspace edit detected');
  await screenshot(page, `viewer-invalid-${testInfo.project.name}`);

  await writeModel(manyModel());
  await expect(page.getByText('Node 34')).toBeVisible();
  await assertNoOverflow(page);
  const canvas = page.getByRole('region', { name: 'structure architecture canvas' });
  await canvas.focus();
  const beforePan = await canvas.evaluate((element) => element.scrollTop);
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(() => canvas.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(beforePan);
  await screenshot(page, `viewer-many-${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Reset view' }).click();
  await page.getByRole('button', { name: 'Topology' }).click();
  await expect(page.locator('.topology-node')).toHaveCount(36);
  await assertNoOverflow(page);
  const topologyCanvas = page.getByRole('region', { name: 'topology architecture canvas' });
  await topologyCanvas.focus();
  const topologyPanBefore = await topologyCanvas.evaluate((element) => element.scrollTop);
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(() => topologyCanvas.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(topologyPanBefore);
  await assertViewportScrollOwnership(page);
  await screenshot(page, `viewer-topology-many-${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Structure' }).click();

  await writeModel(specialModel());
  await expect(page.getByText('Literal <script>alert(1)</script>')).toBeVisible();
  expect(await page.locator('script', { hasText: 'alert(1)' }).count()).toBe(0);
  await assertNoOverflow(page);
  await screenshot(page, `viewer-special-${testInfo.project.name}`);
  await page.getByRole('button', { name: 'Topology' }).click();
  await expect(
    page.locator('.topology-node', { hasText: 'Literal <script>alert(1)</script>' })
  ).toBeVisible();
  await assertNoOverflow(page);
  await assertViewportScrollOwnership(page);
  await screenshot(page, `viewer-topology-special-${testInfo.project.name}`);

  if (testInfo.project.name.startsWith('mobile')) {
    await page.setViewportSize({ width: 320, height: 700 });
    await assertNoOverflow(page);
    await screenshot(page, `viewer-320-${testInfo.project.name}`);
  }
});

test('renders a bounded API error state', async ({ page }, testInfo) => {
  await page.route('**/api/model', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ error: { message: 'Simulated model API failure' } }),
      contentType: 'application/json',
      status: 500,
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Invalid workspace' })).toBeVisible();
  await expect(page.getByText('Simulated model API failure', { exact: true })).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, `viewer-api-error-${testInfo.project.name}`);
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
    const rootOverflow =
      document.documentElement.scrollWidth > viewportWidth ||
      document.body.scrollWidth > viewportWidth;
    const clipped = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .filter((element) => !element.closest('[data-intentional-clip]'))
      .filter((element) => !element.classList.contains('sr-only'))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') return false;
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
          return false;
        return (
          (style.overflowX === 'hidden' || style.overflowX === 'clip') &&
          element.scrollWidth > element.clientWidth + 1
        );
      })
      .map((element) => ({ className: element.className, tag: element.tagName }));
    return { clipped, rootOverflow };
  });
  expect(overflow.rootOverflow, JSON.stringify(overflow)).toBe(false);
  expect(overflow.clipped, JSON.stringify(overflow)).toEqual([]);
}

async function assertViewportScrollOwnership(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const app = document.querySelector('.architecture-app')?.getBoundingClientRect();
    return {
      appBottom: app?.bottom,
      appTop: app?.top,
      bodyHeight: document.body.scrollHeight,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      windowScrollY: window.scrollY,
    };
  });
  expect(metrics.windowScrollY).toBe(0);
  expect(metrics.appTop).toBe(0);
  expect(metrics.appBottom).toBe(metrics.viewportHeight);
  expect(metrics.bodyHeight).toBe(metrics.viewportHeight);
  expect(metrics.documentHeight).toBe(metrics.viewportHeight);
}

async function assertControlBounds(page: Page): Promise<void> {
  const bounds = await page.evaluate(() => {
    const selectors = ['.architecture-app', '.lens-tabs', '.architecture-inspector'];
    const width = window.innerWidth;
    const height = window.innerHeight;
    return selectors.map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return {
        selector,
        bottom: rect?.bottom ?? 0,
        visibleInspector:
          selector !== '.architecture-inspector' ||
          width > 760 ||
          document.querySelector(selector)?.classList.contains('is-open') === true,
        left: rect?.left ?? 0,
        right: rect?.right ?? 0,
        width,
        height,
      };
    });
  });
  for (const bound of bounds) {
    expect(bound.left, bound.selector).toBeGreaterThanOrEqual(0);
    expect(bound.right, bound.selector).toBeLessThanOrEqual(bound.width);
    if (bound.selector === '.architecture-inspector' && bound.visibleInspector) {
      expect(bound.bottom, bound.selector).toBeLessThanOrEqual(bound.height);
    }
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
  return normalModel(
    `API with very-long-token-${'x'.repeat(180)} and https://example.com/${'y'.repeat(160)}`
  );
}

function manyModel(): string {
  const nodes = Array.from(
    { length: 35 },
    (_, index) => `  - id: node-${index}
    parent: root
    kind: component
    title: Node ${index}`
  ).join('\n');
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
