import { expect, type Page, type Route, test } from '@playwright/test';

import { makeMockUser, screenshot, seedTheme } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'theme@example.com',
  name: 'Theme User',
  role: 'superadmin',
  sessionId: 'session-theme-1',
  userId: 'user-theme-1',
});

const MOCK_WORKSPACE = {
  id: 'ws-theme-1',
  name: 'workspace-theme-audit',
  displayName: 'Theme Audit Workspace',
  status: 'running',
  nodeId: 'node-theme-1',
  projectId: 'proj-theme-1',
  userId: 'user-theme-1',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  workspaceProfile: 'full',
  url: 'http://localhost:4173',
  portsPublic: false,
  chatSessionId: null,
  createdAt: '2026-06-06T10:00:00.000Z',
  updatedAt: '2026-06-06T10:05:00.000Z',
};

const MOCK_PROJECT = {
  id: 'proj-theme-1',
  name: 'Theme Audit Project',
  repository: 'sam/theme-audit',
  defaultBranch: 'main',
  userId: 'user-theme-1',
  githubInstallationId: 'inst-theme-1',
  defaultVmSize: 'medium',
  defaultAgentType: 'openai-codex',
  defaultProvider: 'hetzner',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-06-06T09:00:00.000Z',
  updatedAt: '2026-06-06T10:05:00.000Z',
};

const MOCK_AGENT_SESSIONS: [] = [];

const MOCK_NODE = {
  id: 'node-theme-1',
  name: 'theme-node-1',
  status: 'running',
  healthStatus: 'healthy',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  ipAddress: '10.0.0.42',
  cloudProvider: 'hetzner',
  heartbeatStaleAfterSeconds: 180,
  lastHeartbeatAt: '2026-06-06T10:05:00.000Z',
  errorMessage: null,
  createdAt: '2026-06-06T09:00:00.000Z',
  updatedAt: '2026-06-06T10:05:00.000Z',
  lastMetrics: {
    cpuPercent: 18,
    memoryUsedBytes: 2_400_000_000,
    memoryTotalBytes: 8_000_000_000,
    diskUsedBytes: 42_000_000_000,
    diskTotalBytes: 120_000_000_000,
    loadAverage1m: 0.34,
  },
};

const MOCK_WORKTREES = {
  worktrees: [
    {
      path: '/workspaces/simple-agent-manager',
      branch: 'sam/light-mode-slice-c-01ktev',
      headCommit: 'abc1234',
      isPrimary: true,
      isDirty: true,
      dirtyFileCount: 3,
      isPrunable: false,
    },
    {
      path: '/workspaces/simple-agent-manager/sam-light-review',
      branch: 'sam/light-review',
      headCommit: 'def5678',
      isPrimary: false,
      isDirty: false,
      dirtyFileCount: 0,
      isPrunable: true,
    },
  ],
};

const MOCK_GIT_STATUS = {
  staged: [{ path: 'apps/web/src/pages/workspace/index.tsx', status: 'modified' }],
  unstaged: [
    { path: 'apps/web/src/components/GitDiffView.tsx', status: 'modified' },
    { path: 'apps/web/src/components/FileViewerPanel.tsx', status: 'modified' },
  ],
  untracked: [{ path: 'apps/web/src/styles/workspace-chrome.css', status: 'untracked' }],
};

const MOCK_DIFF = {
  filePath: 'apps/web/src/components/GitDiffView.tsx',
  diff: `diff --git a/apps/web/src/components/GitDiffView.tsx b/apps/web/src/components/GitDiffView.tsx
index 1111111..2222222 100644
--- a/apps/web/src/components/GitDiffView.tsx
+++ b/apps/web/src/components/GitDiffView.tsx
@@ -8,6 +8,7 @@ export function GitDiffView() {
   return (
     <section>
+      <header className="bg-surface border-border-default" />
       <pre className="text-tn-fg">Tokyo Night diff island stays dark</pre>
     </section>
   );
`,
};

const MOCK_FILE_LIST = {
  path: '.',
  entries: [
    { name: 'apps', type: 'dir', size: 0, modifiedAt: '2026-06-06T10:00:00.000Z' },
    { name: 'packages', type: 'dir', size: 0, modifiedAt: '2026-06-06T10:00:00.000Z' },
    { name: 'package.json', type: 'file', size: 4096, modifiedAt: '2026-06-06T10:00:00.000Z' },
    { name: 'README.md', type: 'file', size: 2048, modifiedAt: '2026-06-06T10:00:00.000Z' },
  ],
};

const MOCK_FILE = {
  filePath: 'apps/web/src/pages/workspace/index.tsx',
  content: `import { WorkspaceSidebar } from '../../components/WorkspaceSidebar';

export function WorkspacePage() {
  return (
    <WorkspaceSidebar
      status="running"
      chrome="theme-tokenized"
    />
  );
}
`,
};

const MOCK_WORKSPACE_EVENTS = {
  events: [
    {
      id: 'event-1',
      type: 'workspace.started',
      timestamp: '2026-06-06T10:00:00.000Z',
      message: 'Workspace started',
      source: 'vm-agent',
    },
  ],
  nextCursor: null,
};

const MOCK_NODE_EVENTS = {
  events: [
    {
      id: 'node-event-1',
      type: 'workspace_attached',
      timestamp: '2026-06-06T10:01:00.000Z',
      message: 'Workspace attached to node',
      source: 'node-agent',
    },
  ],
  nextCursor: null,
};

const MOCK_NODE_LOGS = {
  entries: [
    {
      id: 'log-1',
      timestamp: '2026-06-06T10:02:00.000Z',
      level: 'info',
      source: 'node-agent',
      message: 'Node heartbeat accepted',
      metadata: { workspaceId: 'ws-theme-1' },
    },
    {
      id: 'log-2',
      timestamp: '2026-06-06T10:03:00.000Z',
      level: 'warn',
      source: 'docker',
      message: 'Container restarted after config refresh',
      metadata: {},
    },
  ],
  nextCursor: null,
};

const MOCK_SYSTEM_INFO = {
  cpu: {
    loadAvg1: 0.34,
    loadAvg5: 0.41,
    loadAvg15: 0.5,
    numCpu: 4,
  },
  memory: {
    usedBytes: 2_400_000_000,
    totalBytes: 8_000_000_000,
    availableBytes: 5_600_000_000,
    usedPercent: 30,
  },
  disk: {
    usedBytes: 42_000_000_000,
    totalBytes: 120_000_000_000,
    availableBytes: 78_000_000_000,
    usedPercent: 35,
    mountPath: '/',
  },
  network: {
    interface: 'eth0',
    rxBytes: 1024,
    txBytes: 2048,
  },
  uptime: {
    seconds: 3600,
    humanFormat: '1h',
  },
  docker: {
    version: '27.0.0',
    containers: 1,
    containerList: [
      {
        id: 'container-1',
        name: 'workspace-theme-audit',
        image: 'sam/workspace:latest',
        status: 'Up 1 hour',
        state: 'running',
        cpuPercent: 3.4,
        memUsage: '512MiB / 8GiB',
        memPercent: 6.4,
        createdAt: '2026-06-06T09:30:00.000Z',
      },
    ],
    error: null,
  },
  software: {
    goVersion: 'go1.25.0',
    nodeVersion: '24.0.0',
    dockerVersion: '27.0.0',
    devcontainerCliVersion: '0.75.0',
  },
  agent: {
    version: '0.1.0',
    buildDate: '2026-06-06T00:00:00Z',
    goRuntime: 'go1.25.0',
    goroutines: 12,
    heapBytes: 24_000_000,
  },
};

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupMocks(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.includes('/api/auth/')) return fulfill(route, MOCK_USER);
    if (path === '/api/client-errors') return fulfill(route, { ok: true });
    if (path === '/api/t') return fulfill(route, { ok: true });
    if (path.startsWith('/api/notifications')) return fulfill(route, { notifications: [], unreadCount: 0 });
    if (path === '/api/projects') return fulfill(route, { projects: [MOCK_PROJECT], nextCursor: null });
    if (path === '/api/projects/proj-theme-1') return fulfill(route, MOCK_PROJECT);
    if (path === '/api/projects/proj-theme-1/sessions') return fulfill(route, { sessions: [], total: 0, hasMore: false });
    if (path === '/api/terminal/token') {
      return fulfill(route, {
        token: 'workspace-token',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        workspaceUrl: MOCK_WORKSPACE.url,
      });
    }
    if (path === '/api/workspaces/ws-theme-1') return fulfill(route, MOCK_WORKSPACE);
    if (path === '/api/workspaces/ws-theme-1/agent-sessions') return fulfill(route, MOCK_AGENT_SESSIONS);
    if (path === '/api/workspaces') return fulfill(route, [MOCK_WORKSPACE]);
    if (path === '/api/nodes/node-theme-1') return fulfill(route, MOCK_NODE);
    if (path === '/api/nodes/node-theme-1/logs') return fulfill(route, MOCK_NODE_LOGS);
    if (path === '/api/nodes/node-theme-1/events') return fulfill(route, MOCK_NODE_EVENTS);
    if (path === '/api/nodes/node-theme-1/system-info') return fulfill(route, MOCK_SYSTEM_INFO);
    if (path === '/api/providers/catalog') return fulfill(route, { catalogs: [] });
    if (path === '/api/trial/status') return fulfill(route, { available: false });
    if (path === '/api/agents') return fulfill(route, { agents: [] });
    if (path === '/api/github/installations') return fulfill(route, []);

    return fulfill(route, {});
  });

  await page.route('**/workspaces/ws-theme-1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.startsWith('/api/')) return route.fallback();
    if (path.endsWith('/agent-sessions')) return fulfill(route, { sessions: MOCK_AGENT_SESSIONS });
    if (path.endsWith('/events')) return fulfill(route, MOCK_WORKSPACE_EVENTS);
    if (path.endsWith('/ports')) return fulfill(route, { ports: [{ port: 5173, protocol: 'http', processName: 'vite' }] });
    if (path.endsWith('/worktrees')) return fulfill(route, MOCK_WORKTREES);
    if (path.endsWith('/git/branches')) return fulfill(route, { branches: [{ name: 'main' }, { name: 'sam/light-mode-slice-c-01ktev' }] });
    if (path.endsWith('/git/status')) return fulfill(route, MOCK_GIT_STATUS);
    if (path.endsWith('/git/diff')) return fulfill(route, MOCK_DIFF);
    if (path.endsWith('/git/file')) return fulfill(route, MOCK_FILE);
    if (path.endsWith('/files/list')) return fulfill(route, MOCK_FILE_LIST);
    if (path.endsWith('/files/find')) {
      return fulfill(route, {
        files: [
          'apps/web/src/pages/workspace/index.tsx',
          'apps/web/src/components/GitDiffView.tsx',
          'apps/web/src/styles/workspace-chrome.css',
        ],
      });
    }
    if (path.endsWith('/files/view')) return fulfill(route, MOCK_FILE);

    return fulfill(route, {});
  });

  await page.route('**/terminal/ws**', (route) => route.abort());
  await page.route('**/api/nodes/*/logs/stream**', (route) => route.abort());
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    docOverflow: document.documentElement.scrollWidth > window.innerWidth,
    bodyOverflow: document.body.scrollWidth > window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(overflow.docOverflow, `Document scrollWidth (${overflow.docWidth}) exceeds viewport (${overflow.viewportWidth})`).toBe(false);
  expect(overflow.bodyOverflow, `Body scrollWidth (${overflow.bodyWidth}) exceeds viewport (${overflow.viewportWidth})`).toBe(false);
}

async function gotoAuditedPage(page: Page, theme: 'dark' | 'light', path: string) {
  await seedTheme(page, theme);
  await setupMocks(page);
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme === 'dark' ? 'sam' : 'sam-light');
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Workspace and node chrome - ${theme}`, () => {
    test(`workspace file viewer uses ${theme} chrome tokens`, async ({ page }) => {
      await gotoAuditedPage(page, theme, '/workspaces/ws-theme-1?files=view&path=apps/web/src/pages/workspace/index.tsx');
      await expect(page.getByText('Theme Audit Workspace')).toBeVisible({ timeout: 5000 });
      await expect(page.getByText('index.tsx').first()).toBeVisible({ timeout: 5000 });
      await expect(page.getByText('theme-tokenized')).toBeVisible({ timeout: 5000 });
      await assertNoOverflow(page);
      await screenshot(page, `workspace-file-${theme}`);
    });

    test(`workspace diff view uses ${theme} chrome tokens`, async ({ page }) => {
      await gotoAuditedPage(page, theme, '/workspaces/ws-theme-1?git=diff&file=apps/web/src/components/GitDiffView.tsx&staged=false');
      await expect(page.getByText('GitDiffView.tsx').first()).toBeVisible({ timeout: 5000 });
      await expect(page.getByText('Tokyo Night diff island stays dark')).toBeVisible({ timeout: 5000 });
      await assertNoOverflow(page);
      await screenshot(page, `workspace-diff-${theme}`);
    });

    test(`node detail uses ${theme} chrome tokens`, async ({ page }) => {
      await gotoAuditedPage(page, theme, '/nodes/node-theme-1');
      await expect(page.getByText('theme-node-1').first()).toBeVisible({ timeout: 5000 });
      await expect(page.getByText('Node heartbeat accepted')).toBeVisible({ timeout: 5000 });
      await expect(page.getByText('Theme Audit Workspace')).toBeVisible({ timeout: 5000 });
      await assertNoOverflow(page);
      await screenshot(page, `node-detail-${theme}`);
    });
  });
}
