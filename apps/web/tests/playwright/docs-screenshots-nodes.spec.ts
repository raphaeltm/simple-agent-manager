/**
 * Documentation screenshot for the Nodes page (Compute pools guide, "What each machine is
 * using"): one machine named for its hardware, its CPU and memory chart, and a row per
 * session showing what it uses against what SAM set aside for it.
 *
 * Mocks follow `nodes-usage-audit.spec.ts`, which holds the stress cases; these fixtures are
 * ordinary and fictional on purpose.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-nodes \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow } from './audit-helpers';
import { docsShot } from './docs-shot';
import { makeNode, makeSession, MOCK_USER, setupApiMocks } from './nodes-usage-fixtures';

/** Every session belongs to Dana, in the Payments API project. */
const USER = {
  ...MOCK_USER,
  user: { ...MOCK_USER.user, email: 'dana@example.com', name: 'Dana Reyes' },
};

function session(overrides: Parameters<typeof makeSession>[0]) {
  return makeSession({
    projectId: 'proj-payments',
    projectName: 'Payments API',
    title: 'Add tax columns to receipts',
    ownerName: 'Dana Reyes',
    ...overrides,
  });
}

const NODES = [
  makeNode({
    name: 'node-payments-1',
    providerInstanceType: 'cx43',
    providerInstanceVcpuCount: 8,
    providerInstanceMemoryMb: 16384,
    providerInstanceDiskGb: 160,
    providerInstancePriceDisplay: '€11.99/month',
    vmLocation: 'nbg1',
    lastMetrics: { cpuLoadAvg1: 3.1, memoryPercent: 52, diskPercent: 18 },
  }),
];

const SESSIONS = [
  session({ cpu: 900, mem: 2.6, seed: 7 }),
  session({
    workspaceId: 'ws-2',
    chatSessionId: 'chat-2',
    title: 'Run the full test suite and fix the flaky checkout tests',
    reservation: { cpuMillis: 2000, memoryMb: 4096, diskMb: 20480, exclusiveNode: false },
    cpu: 3100,
    mem: 3.4,
    seed: 11,
  }),
  session({
    workspaceId: 'ws-3',
    chatSessionId: 'chat-3',
    title: 'Load the March invoices into a local database and compare totals',
    reservation: { cpuMillis: 1000, memoryMb: 2048, diskMb: 10240, exclusiveNode: false },
    cpu: 450,
    mem: 2.7,
    seed: 23,
  }),
];

async function openNodes(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-1', 'true');
  });
  await setupApiMocks(page, { nodes: NODES, sessions: SESSIONS, user: USER });
  await page.goto('/nodes');
  const pane = page.getByRole('article', { name: /Hetzner cx43/ });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('link', { name: 'Add tax columns to receipts' })).toBeVisible();
  await expect(pane.getByText('over limit').first()).toBeVisible();
  await expect(pane.getByText('burst, fine').first()).toBeVisible();
  await assertNoOverflow(page);
  return pane;
}

test('docs: a machine on the Nodes page', async ({ page }) => {
  const isMobile = (page.viewportSize()?.width ?? 0) < 500;
  if (isMobile) await page.setViewportSize({ width: 375, height: 1400 });
  else await page.setViewportSize({ width: 1280, height: 1100 });
  const pane = await openNodes(page);
  await page.mouse.move(2, 2);
  await docsShot(page, isMobile ? 'nodes-machine-mobile' : 'nodes-machine', pane);
});
