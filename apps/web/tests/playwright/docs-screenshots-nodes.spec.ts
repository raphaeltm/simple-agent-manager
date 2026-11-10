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
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow } from './audit-helpers';
import { docsShot } from './docs-shot';

const NOW = Date.now();
const MINUTE = 60_000;
const GB = 1024 * 1024 * 1024;

const MOCK_USER = {
  user: {
    id: 'user-1',
    email: 'dana@example.com',
    name: 'Dana Reyes',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-1',
    userId: 'user-1',
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

function makeNode(overrides: Record<string, unknown>) {
  return {
    id: 'node-1',
    name: 'node-payments-1',
    status: 'running',
    healthStatus: 'healthy',
    cloudProvider: 'hetzner',
    vmSize: 'large',
    vmLocation: 'fsn1',
    nodeRole: 'workspace',
    nodeClass: 'managed',
    providerInstanceType: 'cx53',
    providerInstanceVcpuCount: 16,
    providerInstanceMemoryMb: 32768,
    providerInstanceDiskGb: 320,
    providerInstancePriceDisplay: '€22.99/month',
    ipAddress: '1.2.3.4',
    lastHeartbeatAt: new Date(NOW - 20_000).toISOString(),
    heartbeatStaleAfterSeconds: 180,
    lastMetrics: { cpuLoadAvg1: 2.1, memoryPercent: 34, diskPercent: 12 },
    errorMessage: null,
    createdAt: new Date(NOW - 3 * 3600_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

/** History ends ~12 minutes ago, as a 15-minute upload cadence leaves it. */
function series(seed: number, cpuMillis: number, memoryGb: number, minutes = 48) {
  const end = NOW - 12 * MINUTE;
  const start = Array.from({ length: minutes }, (_, i) => end - (minutes - i) * MINUTE);
  let x = seed;
  const wobble = () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280 - 0.5;
  };
  return {
    start,
    cpuMillis: start.map(() => Math.max(0, Math.round(cpuMillis * (1 + wobble())))),
    memoryBytes: start.map(() => Math.round(memoryGb * GB * (1 + wobble() * 0.15))),
  };
}

function makeSession(
  overrides: Record<string, unknown> & { cpu?: number; mem?: number; seed?: number }
) {
  const { cpu = 600, mem = 2, seed = 7, ...rest } = overrides;
  const status = (rest.status as string | undefined) ?? 'running';
  return {
    holdsReservation: ['running', 'creating', 'recovery'].includes(status),
    historyTruncated: false,
    workspaceId: 'ws-1',
    nodeId: 'node-1',
    projectId: 'proj-payments',
    projectName: 'Payments API',
    chatSessionId: 'chat-1',
    title: 'Add tax columns to receipts',
    ownerUserId: 'user-1',
    ownerName: 'Dana Reyes',
    isMine: true,
    status: 'running',
    createdAt: new Date(NOW - 70 * MINUTE).toISOString(),
    reservation: { cpuMillis: 2000, memoryMb: 4096, diskMb: 10240, exclusiveNode: false },
    series: series(seed, cpu, mem),
    historyEndsAt: NOW - 12 * MINUTE,
    historyOmitted: false,
    ...rest,
  };
}

function usage(workspaces: unknown[]) {
  return {
    windowMinutes: 60,
    windowStart: NOW - 60 * MINUTE,
    windowEnd: NOW,
    bucketMs: MINUTE,
    historyOmittedCount: 0,
    historyTruncatedCount: 0,
    workspacesOmitted: false,
    workspaces,
  };
}

async function setupApiMocks(
  page: Page,
  options: { nodes?: unknown[]; sessions?: unknown[]; usageError?: boolean; nodesError?: boolean }
) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.startsWith('/api/auth/')) return route.fulfill({ json: MOCK_USER });
    if (path.startsWith('/api/notifications'))
      return route.fulfill({ json: { notifications: [], total: 0 } });
    if (path === '/api/projects') return route.fulfill({ json: { projects: [], total: 0 } });
    if (path === '/api/credentials' || path === '/api/github/installations')
      return route.fulfill({ json: [] });
    if (path === '/api/credentials/agent') return route.fulfill({ json: { credentials: [] } });
    if (path === '/api/providers/catalog') return route.fulfill({ json: { catalogs: [] } });
    if (path === '/api/capacity-pools/defaults')
      return route.fulfill({
        json: {
          effectiveSummary: {
            scope: 'installation',
            state: 'configured-ready',
            strategy: 'pack',
            exhaustionPolicy: 'fail',
            availableCandidateCount: 1,
            nativeOfferings: [
              {
                provider: 'hetzner',
                location: 'nbg1',
                providerInstanceType: 'cx43',
                displayName: 'CX43',
                vcpu: 8,
                memoryMb: 16384,
                diskGb: 160,
                price: '€16/month',
              },
            ],
          },
        },
      });
    if (path === '/api/nodes/resource-usage') {
      if (options.usageError)
        return route.fulfill({
          status: 500,
          json: { error: 'INTERNAL_ERROR', message: 'Usage store unavailable' },
        });
      return route.fulfill({ json: usage(options.sessions ?? []) });
    }
    if (path === '/api/nodes') {
      if (options.nodesError)
        return route.fulfill({
          status: 500,
          json: { error: 'INTERNAL_ERROR', message: 'Nodes store unavailable' },
        });
      return route.fulfill({ json: options.nodes ?? [] });
    }
    return route.fulfill({ json: {} });
  });
}


const NODES = [
  makeNode({
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
  makeSession({ cpu: 900, mem: 2.6, seed: 7 }),
  makeSession({
    workspaceId: 'ws-2',
    chatSessionId: 'chat-2',
    title: 'Run the full test suite and fix the flaky checkout tests',
    reservation: { cpuMillis: 2000, memoryMb: 4096, diskMb: 20480, exclusiveNode: false },
    cpu: 3100,
    mem: 3.4,
    seed: 11,
  }),
  makeSession({
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
  await setupApiMocks(page, { nodes: NODES, sessions: SESSIONS });
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
