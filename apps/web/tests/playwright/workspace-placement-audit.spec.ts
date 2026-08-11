import { expect, type Page, type Route, test } from '@playwright/test';
import type { PlacementExplanation } from '@simple-agent-manager/shared';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
  seedTheme,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'placement@example.com',
  name: 'Placement Auditor',
  sessionId: 'session-placement-1',
  userId: 'user-placement-1',
});

const BASE_PLACEMENT: PlacementExplanation = {
  schemaVersion: 2,
  outcome: 'reused',
  selectionPath: 'capacity',
  selectedNodeId: '01NODE_SELECTED',
  summary: 'Reused a healthy compatible node with available capacity.',
  request: {
    runtime: 'vm',
    vmSize: 'medium',
    vmLocation: 'hel1',
    maxWorkspacesPerNode: 5,
    cpuThresholdPercent: 50,
    memoryThresholdPercent: 50,
    heartbeatStaleSeconds: 180,
  },
  evaluatedNodes: [
    {
      nodeId: '01NODE_SELECTED',
      path: 'capacity',
      accepted: true,
      rejectionReasons: [],
      snapshot: {
        runtime: 'vm',
        vmSize: 'medium',
        vmLocation: 'hel1',
        healthStatus: 'healthy',
        agentVersionCompatible: true,
        heartbeatAgeSeconds: 12,
        activeWorkspaceCount: 2,
        cpuLoadAvg1: 8,
        memoryPercent: 20,
      },
    },
  ],
  provisioningAttempts: [],
  decidedAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z',
};

const STRESS_PLACEMENT: PlacementExplanation = {
  ...BASE_PLACEMENT,
  outcome: 'failed',
  selectionPath: 'provisioning',
  selectedNodeId: null,
  summary:
    `No reusable node qualified — ${'long placement evidence '.repeat(14)}` +
    '& <script>safe</script> é🚀.',
  evaluatedNodes: Array.from({ length: 32 }, (_, index) => ({
    ...BASE_PLACEMENT.evaluatedNodes[0]!,
    nodeId: `node-${index}-é🚀-<script>alert(${index})</script>-${'x'.repeat(120)}`,
    accepted: false,
    rejectionReasons: ['agent-version-mismatch', 'workspace-limit', 'heartbeat-stale'] as const,
  })),
  provisioningAttempts: [
    {
      vmSize: 'large',
      vmLocation: 'hel1',
      outcome: 'capacity-rejected',
      failureReason: 'capacity-unavailable',
    },
    {
      vmSize: 'medium',
      vmLocation: 'hel1',
      outcome: 'failed',
      failureReason: 'provider-failed',
    },
  ],
};

const LEGACY_PLACEMENT = {
  selectedVmSize: 'medium',
  vmSizeSource: 'project',
  reservation: {
    cpuMillis: 1000,
    memoryMb: 2048,
    diskMb: 4096,
    exclusiveNode: false,
    maxCoTenants: 5,
    source: 'project',
    sourceId: 'p',
    version: 1,
  },
  reason: 'L',
  decidedAt: '2026-08-10T00:00:00.000Z',
};

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupMocks(page: Page, placementExplanation: unknown) {
  const workspace = {
    id: 'ws-placement-1',
    name: 'placement-audit',
    displayName: 'Placement Audit Workspace',
    status: 'stopped',
    nodeId: 'node-placement-1',
    projectId: 'project-placement-1',
    userId: 'user-placement-1',
    repository: 'owner/repository',
    branch: 'main',
    vmSize: 'medium',
    vmLocation: 'hel1',
    workspaceProfile: 'full',
    url: 'http://localhost:4173',
    placementExplanation,
    errorMessage: null,
    chatSessionId: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:05:00.000Z',
  };
  const project = {
    id: 'project-placement-1',
    name: 'Placement Project',
    repository: 'owner/repository',
    defaultBranch: 'main',
    userId: 'user-placement-1',
  };

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/api/auth/')) return fulfill(route, MOCK_USER);
    if (path === '/api/workspaces/ws-placement-1') return fulfill(route, workspace);
    if (path === '/api/workspaces/ws-placement-1/agent-sessions') return fulfill(route, []);
    if (path === '/api/workspaces/ws-placement-1/events') {
      return fulfill(route, { events: [], nextCursor: null });
    }
    if (path === '/api/workspaces') return fulfill(route, [workspace]);
    if (path === '/api/projects/project-placement-1') return fulfill(route, project);
    if (path === '/api/projects') return fulfill(route, { projects: [project], nextCursor: null });
    if (path.startsWith('/api/notifications')) {
      return fulfill(route, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/providers/catalog') return fulfill(route, { catalogs: [] });
    if (path === '/api/trial/status') return fulfill(route, { available: false });
    if (path === '/api/agents') return fulfill(route, { agents: [] });
    if (path === '/api/github/installations') return fulfill(route, []);
    return fulfill(route, {});
  });
}

async function openPlacement(page: Page): Promise<void> {
  await page.goto('/workspaces/ws-placement-1');
  await expect(page.getByText('Placement Audit Workspace').first()).toBeVisible();
  if (page.viewportSize()!.width < 768) {
    await page.getByRole('button', { name: 'Open workspace menu' }).click();
    await expect(page.getByRole('dialog', { name: 'Workspace menu' })).toBeVisible();
  }
  const placementToggle = page.getByRole('button', { name: /placement/i });
  await expect(placementToggle).toBeVisible();
  await placementToggle.click();
  await expect(placementToggle).toHaveAttribute('aria-expanded', 'true');
}

async function auditLayout(page: Page): Promise<void> {
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  const sidebar =
    page.viewportSize()!.width < 768
      ? page.getByRole('dialog', { name: 'Workspace menu' })
      : page.locator('aside');
  const dimensions = await sidebar.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

const scenarios = [
  { name: 'normal', value: BASE_PLACEMENT, expected: BASE_PLACEMENT.summary },
  { name: 'empty', value: null, expected: 'No placement explanation was recorded.' },
  { name: 'legacy-single-character', value: LEGACY_PLACEMENT, expected: 'L' },
  { name: 'stress-failed-special', value: STRESS_PLACEMENT, expected: 'Rejected candidates' },
] as const;

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Workspace placement — ${theme}`, () => {
    for (const scenario of scenarios) {
      test(scenario.name, async ({ page }) => {
        await seedTheme(page, theme);
        await setupMocks(page, scenario.value);
        await openPlacement(page);
        await expect(
          page.getByText(scenario.expected, { exact: scenario.expected === 'L' })
        ).toBeVisible();
        const injectedScript = await page
          .locator('script')
          .evaluateAll((elements) =>
            elements.some((element) => element.textContent?.includes('alert('))
          );
        expect(injectedScript).toBe(false);
        await auditLayout(page);

        if (scenario.name === 'stress-failed-special') {
          const lastCandidate = page.getByText(/node-31-é🚀-/);
          await lastCandidate.scrollIntoViewIfNeeded();
          await expect(lastCandidate).toBeVisible();
          await auditLayout(page);
        }
        await screenshot(page, `workspace-placement-${scenario.name}-${theme}`);
      });
    }
  });
}
