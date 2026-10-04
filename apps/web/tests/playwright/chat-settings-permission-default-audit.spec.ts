import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

// The workspace chat's in-chat Agent Settings panel (acp-client ChatSettingsPanel,
// rendered by ChatSession for workspaces without a linked project chat). It must open
// on the platform default permission mode when the user has none saved.

const MOCK_USER = makeMockUser({
  email: 'permission-audit@example.com',
  name: 'Permission Audit',
  sessionId: 'session-permission-audit',
  userId: 'user-permission-audit',
});

const WORKSPACE_ID = 'ws-permission-audit';
const AGENT_SESSION_ID = 'agent-session-permission-audit';
const NOW = '2026-10-04T09:00:00.000Z';

const MOCK_WORKSPACE = {
  id: WORKSPACE_ID,
  name: 'workspace-permission-audit',
  displayName: 'Permission Audit Workspace',
  status: 'running',
  nodeId: 'node-permission-audit',
  projectId: null,
  userId: MOCK_USER.user.id,
  vmSize: 'medium',
  vmLocation: 'nbg1',
  workspaceProfile: 'full',
  url: 'https://ws-permission-audit.example.test',
  portsPublic: false,
  chatSessionId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const MOCK_AGENT_SESSIONS = [
  {
    id: AGENT_SESSION_ID,
    workspaceId: WORKSPACE_ID,
    status: 'running',
    label: 'Claude Code chat',
    agentType: 'claude-code',
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const MOCK_AGENTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic Claude Code agent',
    supportsAcp: true,
    configured: true,
  },
];

// The desktop workspace sidebar renders node resource stats.
const MOCK_NODE = {
  id: MOCK_WORKSPACE.nodeId,
  name: 'permission-audit-node',
  status: 'running',
  healthStatus: 'healthy',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  ipAddress: '10.0.0.42',
  cloudProvider: 'hetzner',
  heartbeatStaleAfterSeconds: 180,
  lastHeartbeatAt: NOW,
  errorMessage: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const MOCK_SYSTEM_INFO = {
  cpu: { loadAvg1: 0.34, loadAvg5: 0.41, loadAvg15: 0.5, numCpu: 4 },
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
  network: { interface: 'eth0', rxBytes: 1024, txBytes: 2048 },
  uptime: { seconds: 3600, humanFormat: '1h' },
  docker: { version: '27.0.0', containers: 0, containerList: [] },
};

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupMocks(page: Page, savedPermissionMode: string | null) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.includes('/api/auth/')) return fulfill(route, MOCK_USER);
    if (path.startsWith('/api/notifications')) {
      return fulfill(route, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/projects') return fulfill(route, { projects: [], nextCursor: null });
    if (path === '/api/terminal/token') {
      return fulfill(route, {
        token: 'workspace-token',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        workspaceUrl: MOCK_WORKSPACE.url,
      });
    }
    if (path === `/api/workspaces/${WORKSPACE_ID}`) return fulfill(route, MOCK_WORKSPACE);
    if (path === `/api/workspaces/${WORKSPACE_ID}/agent-sessions`) {
      return fulfill(route, MOCK_AGENT_SESSIONS);
    }
    if (path === '/api/workspaces') return fulfill(route, [MOCK_WORKSPACE]);
    if (path === '/api/agents') return fulfill(route, { agents: MOCK_AGENTS });
    if (path === `/api/nodes/${MOCK_NODE.id}`) return fulfill(route, MOCK_NODE);
    if (path === `/api/nodes/${MOCK_NODE.id}/system-info`) return fulfill(route, MOCK_SYSTEM_INFO);
    if (path === '/api/agent-settings/claude-code') {
      return fulfill(route, {
        agentType: 'claude-code',
        model: null,
        permissionMode: savedPermissionMode,
        allowedTools: null,
        deniedTools: null,
        additionalEnv: null,
        opencodeProvider: null,
        opencodeBaseUrl: null,
        providerMode: null,
        createdAt: savedPermissionMode ? NOW : null,
        updatedAt: savedPermissionMode ? NOW : null,
      });
    }
    if (path === '/api/trial/status') return fulfill(route, { available: false });
    if (path === '/api/github/installations') return fulfill(route, []);

    return fulfill(route, {});
  });

  // Workspace host HTTP (live session list, ports, git) — nothing under test.
  await page.route(`${MOCK_WORKSPACE.url}/**`, (route) => fulfill(route, {}));
  // Keep the ACP and terminal sockets open without a server; the settings panel
  // does not depend on an established agent session.
  await page.routeWebSocket(/ws-permission-audit\.example\.test/, () => {});
}

async function openChatSettings(page: Page, savedPermissionMode: string | null) {
  await setupMocks(page, savedPermissionMode);
  await page.goto(`/workspaces/${WORKSPACE_ID}?view=conversation&sessionId=${AGENT_SESSION_ID}`);
  const settingsButton = page.getByRole('button', { name: 'Agent settings' });
  await expect(settingsButton).toBeVisible({ timeout: 15_000 });
  await settingsButton.click();
  const dialog = page.getByRole('dialog', { name: 'Agent Settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Loading settings...')).toHaveCount(0);
  return dialog;
}

test.describe('Workspace chat settings panel — permission default', () => {
  test('opens on Bypass Permissions when no mode is saved', async ({ page }) => {
    const dialog = await openChatSettings(page, null);

    await expect(dialog.getByRole('radio', { name: 'Bypass Permissions' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(dialog.getByRole('radio', { name: 'Manual' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    await expect(dialog.getByText(/auto-approve all actions/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();

    await screenshot(page, 'chat-settings-permission-default-bypass');
    await assertNoOverflow(page);
  });

  test('keeps a saved Manual choice selected', async ({ page }) => {
    const dialog = await openChatSettings(page, 'default');

    await expect(dialog.getByRole('radio', { name: 'Manual' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(dialog.getByRole('radio', { name: 'Bypass Permissions' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    await expect(dialog.getByText(/auto-approve all actions/i)).toHaveCount(0);

    await screenshot(page, 'chat-settings-permission-saved-manual');
    await assertNoOverflow(page);
  });
});
