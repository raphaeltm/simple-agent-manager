/**
 * Visual audit of the real /nodes page (sessions first, CPU + memory per machine) with
 * mocked API data. The app shell pins html/body to overflow:hidden, so a fullPage capture
 * would stop at the first screen; `capture` grows the viewport to the main scroller's
 * height first, then restores it.
 */
import { expect, type Page, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, screenshot } from './audit-helpers';
import { GB, makeNode, makeSession, MINUTE, NOW, setupApiMocks } from './nodes-usage-fixtures';

const NORMAL_NODES = [
  makeNode({
    lastMetrics: {
      cpuLoadAvg1: 3.4,
      memoryPercent: 41,
      workspaceMemory: [
        {
          workspaceId: 'ws-1',
          memoryUsageBytes: 2.9 * GB,
          collectedAt: new Date(NOW - 20_000).toISOString(),
        },
        {
          workspaceId: 'ws-5',
          memoryUsageBytes: 1.3 * GB,
          collectedAt: new Date(NOW - 20_000).toISOString(),
        },
      ],
    },
  }),
  makeNode({
    id: 'node-2',
    name: 'Auto: Run the full test matrix',
    providerInstanceType: 'cx43',
    providerInstanceVcpuCount: 8,
    providerInstanceMemoryMb: 16384,
    providerInstanceDiskGb: 160,
    providerInstancePriceDisplay: '€11.99/month',
    vmLocation: 'nbg1',
    createdAt: new Date(NOW - 2 * 3600_000).toISOString(),
  }),
  makeNode({
    id: 'node-3',
    name: 'node-20261104',
    status: 'creating',
    healthStatus: 'stale',
    providerInstanceType: 'cx33',
    providerInstanceVcpuCount: 4,
    providerInstanceMemoryMb: 8192,
    providerInstanceDiskGb: 80,
    lastHeartbeatAt: null,
    lastMetrics: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
  }),
  makeNode({
    id: 'node-4',
    name: 'deploy-node',
    nodeRole: 'deployment',
    providerInstanceType: 'cx23',
    providerInstanceVcpuCount: 2,
    providerInstanceMemoryMb: 4096,
    providerInstanceDiskGb: 40,
    deploymentEnvironments: [{ id: 'env-1', projectId: 'proj-sam', name: 'production' }],
    createdAt: new Date(NOW - 30 * 24 * 3600_000).toISOString(),
  }),
  makeNode({
    id: 'node-5',
    name: 'old-node',
    status: 'error',
    healthStatus: 'unhealthy',
    providerInstanceType: 'cx33',
    errorMessage:
      'Provider rejected the server: resource_unavailable in fsn1. The node could not be created.',
    createdAt: new Date(NOW - 4 * 24 * 3600_000).toISOString(),
  }),
];

const NORMAL_SESSIONS = [
  makeSession({}),
  makeSession({
    workspaceId: 'ws-2',
    chatSessionId: 'chat-2',
    title:
      'Fix OOM eviction relocation when the chat is stopped before the snapshot is marked sleeping',
    reservation: { cpuMillis: 4000, memoryMb: 8192, diskMb: 20480, exclusiveNode: false },
    cpu: 3100,
    mem: 6.2,
    seed: 11,
  }),
  makeSession({
    workspaceId: 'ws-3',
    chatSessionId: 'chat-3',
    projectId: 'proj-ttv',
    projectName: 'TTV',
    title: 'Review previous session context using SAM MCP and summarize',
    reservation: { cpuMillis: 1000, memoryMb: 2048, diskMb: 5120, exclusiveNode: false },
    cpu: 20,
    mem: 0.3,
    seed: 23,
    status: 'sleeping',
  }),
  makeSession({
    workspaceId: 'ws-4',
    chatSessionId: null,
    title: 'ws-4-plain-workspace',
    reservation: null,
    series: { start: [], cpuMillis: [], memoryBytes: [] },
    historyEndsAt: null,
    status: 'creating',
    createdAt: new Date(NOW - 2 * MINUTE).toISOString(),
  }),
  makeSession({
    workspaceId: 'ws-5',
    chatSessionId: 'chat-5',
    title: 'Translate onboarding copy and check every string fits',
    reservation: { cpuMillis: 500, memoryMb: 1024, diskMb: 2048, exclusiveNode: false },
    cpu: 610,
    mem: 1.25,
    seed: 31,
  }),
  makeSession({
    workspaceId: 'ws-6',
    nodeId: 'node-2',
    chatSessionId: 'chat-6',
    projectId: 'proj-ttv',
    projectName: 'TTV',
    title: 'Run the full test matrix locally before opening the PR',
    reservation: { cpuMillis: 6000, memoryMb: 14336, diskMb: 40960, exclusiveNode: false },
    cpu: 7400,
    mem: 13.6,
    seed: 41,
  }),
];

const LONG_TITLE =
  'Investigate why the scheduler did not move the session to a fresh node when CPU and memory both sat near the limit for twenty minutes, then <script>alert(1)</script> & “quotes” — 日本語テキスト — and a URL https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/chat/01M6KHQ7V198XD1WZMAJ4G2XKP';

const LONG_NODES = [
  makeNode({
    name: 'Native provider / 区域 🚀 '.repeat(8),
    providerInstanceType: 'gpu-a100-80gb-highmem-really-long-type-name',
    providerInstancePriceDisplay: '€1,234.56/month (billed hourly, excluding VAT)',
  }),
];
const LONG_SESSIONS = [
  makeSession({
    title: LONG_TITLE,
    projectName: 'A project with a very long name that keeps going and going',
  }),
  makeSession({
    workspaceId: 'ws-x',
    chatSessionId: 'chat-x',
    title: 'x',
    ownerName: 'Ada Lovelace-Byron Countess of Lovelace',
    isMine: false,
    ownerUserId: 'user-2',
    seed: 3,
  }),
];

const MANY_SESSIONS = Array.from({ length: 30 }, (_, i) =>
  makeSession({
    workspaceId: `ws-many-${i}`,
    chatSessionId: `chat-many-${i}`,
    title: `Session ${i + 1}: refactor module ${i + 1}`,
    reservation: { cpuMillis: 400, memoryMb: 820, diskMb: 2048, exclusiveNode: false },
    cpu: 150 + i * 10,
    mem: 0.4 + (i % 5) * 0.1,
    seed: i + 2,
  })
);

/** Theme, and a returning user who already dismissed onboarding, so its overlay cannot cover the page. */
async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('sam-theme', value);
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-1', 'true');
  }, theme);
}

/** Grow the viewport to the main scroller so the capture includes every pane, then restore it. */
async function capture(page: Page, name: string) {
  const original = page.viewportSize();
  const extra = await page.evaluate(() => {
    const main = document.querySelector('#main-content');
    return main ? main.scrollHeight - main.clientHeight : 0;
  });
  if (original && extra > 0)
    await page.setViewportSize({ width: original.width, height: original.height + extra });
  await screenshot(page, name);
  if (original) await page.setViewportSize(original);
}

async function checkLayout(page: Page) {
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  const rootWidth = await page.evaluate(() => {
    const main = document.querySelector('#main-content');
    return main ? main.getBoundingClientRect().width <= window.innerWidth : false;
  });
  expect(rootWidth).toBe(true);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Nodes usage page (${theme})`, () => {
    test.beforeEach(async ({ page }) => setTheme(page, theme));

    test('normal data', async ({ page }) => {
      await setupApiMocks(page, { nodes: NORMAL_NODES, sessions: NORMAL_SESSIONS });
      await page.goto('/nodes');
      await expect(page.getByRole('heading', { name: 'Hetzner cx53' })).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Nodes page: ship the live CPU and memory view' })
      ).toBeVisible();
      await expect(page.getByText('over limit').first()).toBeVisible();
      await expect(page.getByText('burst, fine').first()).toBeVisible();
      await expect(page.getByText('production')).toBeVisible();
      await expect(page.getByText(/Provider rejected the server/)).toBeVisible();
      // The task-derived node name never titles a machine.
      await expect(page.getByRole('heading', { name: /Review previous session/ })).toHaveCount(0);
      await checkLayout(page);
      await capture(page, `nodes-usage-normal-${theme}`);
    });

    // State-machine audit D5: `destroying` and `deleting` are real node statuses that
    // were missing from NodeStatus, so the chip had no entry for them.
    test('nodes on their way out show a Deleting chip', async ({ page }) => {
      const leaving = [
        makeNode({
          id: 'node-del',
          name: 'deploy-node',
          nodeRole: 'deployment',
          status: 'deleting',
        }),
        makeNode({ id: 'node-des', name: 'old-worker', status: 'destroying' }),
        makeNode({ id: 'node-run', name: 'live-worker', status: 'running' }),
      ];
      await setupApiMocks(page, { nodes: leaving, sessions: [] });
      await page.goto('/nodes');
      await expect(page.getByText('Deleting')).toHaveCount(2);
      // Liveness: the running machine beside them still reads as running.
      await expect(page.getByText('Running').first()).toBeVisible();
      await checkLayout(page);
      await capture(page, `nodes-usage-deleting-${theme}`);
    });

    test('long text wraps correctly', async ({ page }) => {
      test.skip(theme === 'light', 'layout check runs once; light covers colours');
      await setupApiMocks(page, { nodes: LONG_NODES, sessions: LONG_SESSIONS });
      await page.goto('/nodes');
      await expect(page.getByText('Ada', { exact: true })).toBeVisible();
      await checkLayout(page);
      await capture(page, 'nodes-usage-long-text');
    });

    test('empty state', async ({ page }) => {
      test.skip(theme === 'light', 'layout check runs once');
      await setupApiMocks(page, { nodes: [], sessions: [] });
      await page.goto('/nodes');
      await expect(page.getByText('No nodes yet')).toBeVisible();
      await checkLayout(page);
      await capture(page, 'nodes-usage-empty');
    });

    test('many sessions on one machine', async ({ page }) => {
      test.skip(theme === 'light', 'layout check runs once');
      await setupApiMocks(page, { nodes: [NORMAL_NODES[0]], sessions: MANY_SESSIONS });
      await page.goto('/nodes');
      await expect(
        page.getByRole('link', { name: 'Session 30: refactor module 30' })
      ).toBeAttached();
      await checkLayout(page);
      await capture(page, 'nodes-usage-many');
    });

    test('usage error keeps machines visible', async ({ page }) => {
      test.skip(theme === 'light', 'layout check runs once');
      await setupApiMocks(page, { nodes: NORMAL_NODES, usageError: true });
      await page.goto('/nodes');
      await expect(page.getByText(/Couldn.t load sessions and usage/)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Hetzner cx53' })).toBeVisible();
      await checkLayout(page);
      await capture(page, 'nodes-usage-error');
    });

    test('create form open', async ({ page }) => {
      test.skip(theme === 'light', 'layout check runs once');
      await setupApiMocks(page, { nodes: NORMAL_NODES, sessions: NORMAL_SESSIONS });
      await page.goto('/nodes');
      await page.getByRole('button', { name: 'Create Node' }).click();
      await expect(page.getByLabel('Native offering')).toBeVisible();
      await checkLayout(page);
      await capture(page, 'nodes-usage-create-form');
    });

    test('actions menu and Advanced work from the keyboard', async ({ page }) => {
      test.skip(theme === 'light', 'interaction check runs once');
      await setupApiMocks(page, { nodes: NORMAL_NODES, sessions: NORMAL_SESSIONS });
      await page.goto('/nodes');
      const trigger = page.getByRole('button', { name: 'Actions for Hetzner cx53' });
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitem', { name: 'Stop' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menuitem', { name: 'Stop' })).toHaveCount(0);

      const pane = page.getByRole('article', { name: /Hetzner cx53/ });
      const advanced = pane.getByText('Advanced', { exact: true });
      await advanced.focus();
      await page.keyboard.press('Enter');
      await expect(pane.getByRole('link', { name: /Workspace/ }).first()).toBeVisible();

      // 44px targets on a phone.
      if ((page.viewportSize()?.width ?? 0) < 768) {
        for (const target of [trigger, advanced, pane.getByRole('link', { name: /Details/ })]) {
          const box = await target.boundingBox();
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
      }
    });

    test('nodes error', async ({ page }) => {
      test.skip(theme === 'light', 'layout check runs once');
      await setupApiMocks(page, { nodesError: true });
      await page.goto('/nodes');
      await expect(page.getByText('Nodes store unavailable')).toBeVisible();
      await checkLayout(page);
      await capture(page, 'nodes-usage-nodes-error');
    });
  });
}
