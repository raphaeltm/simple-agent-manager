import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';

const NOW = Date.now();
const MOCK_USER = makeMockUser({
  userId: 'review-user',
  sessionId: 'session-review',
  email: 'review@example.com',
  name: 'Review User',
  role: 'user',
});

const worstCaseWorkspace = {
  id: 'ws-worst-1',
  nodeId: 'node-0',
  projectId: 'proj-review',
  name: 'workspace-worst',
  displayName: 'Workspace with an extremely long display name that stresses card layout wrapping on narrow mobile viewports',
  repository: 'acme/sweep-audit-repository-with-a-fairly-long-name',
  branch: 'feat/very-long-branch-name-created-by-an-agent-for-a-multi-step-task',
  status: 'running',
  vmSize: 'cx32',
  vmLocation: 'fsn1',
  workspaceProfile: null,
  devcontainerConfigName: null,
  vmIp: '192.0.2.10',
  lastActivityAt: new Date(NOW - 3_600_000).toISOString(),
  portsPublicEnabled: false,
  errorMessage: null,
  createdAt: new Date(NOW - 86_400_000).toISOString(),
  updatedAt: new Date(NOW - 3_600_000).toISOString(),
  url: 'https://ws-worst-1.example.com',
};

const zeroCountProject = {
  id: 'proj-zero',
  name: 'Idle Project With Zero Active Workspaces',
  repository: 'acme/idle-repo',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: 'review-user',
  installationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  defaultLocation: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  taskExecutionTimeoutMs: null,
  maxConcurrentTasks: null,
  maxDispatchDepth: null,
  maxSubTasksPerTask: null,
  warmNodeTimeoutMs: null,
  maxWorkspacesPerNode: null,
  nodeCpuThresholdPercent: null,
  nodeMemoryThresholdPercent: null,
  createdAt: '2026-07-06T00:00:00.000Z',
  updatedAt: '2026-07-06T00:00:00.000Z',
  activeWorkspaceCount: 0,
  activeSessionCount: 0,
  lastActivityAt: null,
  status: 'active',
};

async function setupMocks(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-review-user', 'true')
  );
  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects') return respond(200, { projects: [zeroCountProject] });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    if (path === '/api/workspaces') return respond(200, [worstCaseWorkspace]);
    if (path === '/api/nodes') return respond(200, []);
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path === '/api/trial/status' || path === '/api/trial-status') return respond(200, { available: false });
    return undefined;
  });
}

test.describe('tmp review check', () => {
  test('workspace card worst case at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await setupMocks(page);
    await page.goto('/workspaces');
    await page.waitForTimeout(900);
    await screenshot(page, 'tmp-review-workspace-320');
    await assertNoOverflow(page);

    const branchInfo = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const branchSpan = spans.find((s) => s.textContent?.includes('feat/very-long-branch'));
      if (!branchSpan) return null;
      const rect = branchSpan.getBoundingClientRect();
      return {
        width: rect.width,
        text: branchSpan.textContent,
        scrollWidth: branchSpan.scrollWidth,
        clientWidth: branchSpan.clientWidth,
      };
    });
    console.log('BRANCH SPAN INFO', branchInfo);

    const titleInfo = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const titleSpan = spans.find((s) => s.textContent?.includes('Workspace with an extremely long'));
      if (!titleSpan) return null;
      const rect = titleSpan.getBoundingClientRect();
      return { width: rect.width, scrollWidth: titleSpan.scrollWidth, clientWidth: titleSpan.clientWidth };
    });
    console.log('TITLE SPAN INFO', titleInfo);
  });

  test('project card zero-count at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await setupMocks(page);
    await page.goto('/dashboard');
    await page.waitForTimeout(900);
    await screenshot(page, 'tmp-review-project-zero-320');
    await assertNoOverflow(page);
    const text = await page.evaluate(() => document.body.textContent ?? '');
    console.log('HAS ZERO TEXT ANYWHERE?', text.includes('0 ws'), text.includes('0 session'));
  });
});
