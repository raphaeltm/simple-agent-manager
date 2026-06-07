import { type Page, test } from '@playwright/test';

import {
  makeMockUser,
  seedTheme,
  setupAuditRoutes,
  visitAndCapture,
} from './audit-helpers';

/**
 * Light-mode visual audit for the Admin cluster sub-pages:
 * /admin/overview, /users, /stream, /ai-proxy, /usage, /quotas, /credentials.
 *
 * These screens were not covered by an existing light-mode audit (admin costs,
 * logs, errors, and analytics are already covered elsewhere). This audit captures
 * dark and light at every viewport project so future light-mode regressions on
 * the health metrics, user rows, log stream chrome, AI proxy cards, node usage
 * meters, quota bars, and platform credential cards fail CI.
 */

const longName =
  'Very long admin label that keeps going through multiple clauses and includes symbols <>& "quotes" to stress wrapping';

const MOCK_USER = makeMockUser({
  email: 'admin-audit@example.com',
  name: 'Admin Audit User',
  role: 'superadmin',
  sessionId: 'session-admin-audit',
  userId: 'user-admin-audit',
});

const health = {
  activeNodes: 12,
  activeWorkspaces: 34,
  inProgressTasks: 7,
  errorCount24h: 18,
  timestamp: '2026-06-06T00:00:00Z',
};

const errorTrends = {
  range: '24h',
  interval: '1h',
  buckets: Array.from({ length: 24 }, (_, index) => ({
    timestamp: `2026-06-06T${String(index).padStart(2, '0')}:00:00Z`,
    total: index % 5,
    bySource: {
      api: index % 3,
      vm_agent: index % 2,
      web: index % 4 === 0 ? 1 : 0,
      cron: 0,
    },
  })),
};

const adminUsers = {
  users: Array.from({ length: 30 }, (_, index) => ({
    id: `user-${index}`,
    email: index === 0 ? `${longName}@example.com` : `user-${index}@example.com`,
    name: index === 0 ? longName : index === 1 ? null : `User ${index}`,
    avatarUrl: null,
    role: index === 0 ? 'superadmin' : index % 3 === 0 ? 'admin' : 'user',
    status: index % 4 === 0 ? 'pending' : index % 5 === 0 ? 'suspended' : 'approved',
    createdAt: '2026-06-01T00:00:00Z',
  })),
};

const aiProxyConfig = {
  defaultModel: 'claude-opus-4',
  billingMode: 'auto',
  source: 'admin',
  updatedAt: '2026-06-06T00:00:00Z',
  hasUnifiedBilling: true,
  hasAnthropicCredential: true,
  hasOpenAICredential: false,
  models: [
    {
      id: 'gemma-3',
      label: 'Gemma 3 26B',
      provider: 'workers-ai',
      tier: 'low-cost',
      available: true,
      costPer1kInputTokens: 0,
      costPer1kOutputTokens: 0,
    },
    {
      id: 'claude-opus-4',
      label: longName,
      provider: 'anthropic',
      tier: 'premium',
      available: true,
      costPer1kInputTokens: 0.015,
      costPer1kOutputTokens: 0.075,
    },
    {
      id: 'gpt-4o',
      label: 'GPT-4o',
      provider: 'openai',
      tier: 'standard',
      available: false,
      costPer1kInputTokens: 0.005,
      costPer1kOutputTokens: 0.015,
    },
  ],
};

const nodeUsage = {
  period: { start: '2026-06-01T00:00:00Z', end: '2026-06-30T23:59:59Z' },
  users: Array.from({ length: 20 }, (_, index) => ({
    userId: `user-${index}`,
    email: index === 0 ? `${longName}@example.com` : `user-${index}@example.com`,
    name: index === 0 ? longName : index === 1 ? null : `User ${index}`,
    avatarUrl: null,
    totalNodeHours: 142.5 - index * 5,
    totalVcpuHours: 570 - index * 20,
    platformNodeHours: 90.25 - index * 3,
    activeNodes: index % 4,
  })),
};

const quotas = {
  defaultQuota: { monthlyVcpuHoursLimit: 200, updatedAt: '2026-06-01T00:00:00Z' },
  users: Array.from({ length: 20 }, (_, index) => ({
    userId: `user-${index}`,
    email: index === 0 ? `${longName}@example.com` : `user-${index}@example.com`,
    name: index === 0 ? longName : index === 1 ? null : `User ${index}`,
    avatarUrl: null,
    monthlyVcpuHoursLimit: index % 3 === 0 ? null : 100 + index * 10,
    source: index % 3 === 0 ? 'default' : index % 5 === 0 ? 'unlimited' : 'user_override',
    currentUsage: 50 + index * 5,
    percentUsed: index % 3 === 0 ? null : Math.min(100, 40 + index * 5),
  })),
};

const platformCredentials = {
  credentials: [
    {
      id: 'cred-hetzner',
      label: longName,
      isEnabled: true,
      credentialType: 'cloud-provider',
      provider: 'hetzner',
      agentType: null,
      credentialKind: 'api-token',
      createdAt: '2026-06-01T00:00:00Z',
    },
    {
      id: 'cred-scaleway',
      label: 'Scaleway secret',
      isEnabled: false,
      credentialType: 'cloud-provider',
      provider: 'scaleway',
      agentType: null,
      credentialKind: 'api-token',
      createdAt: '2026-06-02T00:00:00Z',
    },
    {
      id: 'cred-anthropic',
      label: 'Anthropic platform key',
      isEnabled: true,
      credentialType: 'agent-api-key',
      provider: null,
      agentType: 'claude-code',
      credentialKind: 'api-key',
      createdAt: '2026-06-03T00:00:00Z',
    },
  ],
};

async function setupMocks(page: Page) {
  await setupAuditRoutes(page, (path, respond) => {
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/trial-status') return respond(200, { isTrial: false });
    // AppShell mounts the sidebar project list on every protected route; without
    // this mock listProjects() returns the catch-all {} and SidebarProjectList
    // crashes on projects.length, falsely passing the audit via the error boundary.
    if (path === '/api/projects') return respond(200, { projects: [], total: 0 });
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications')
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });

    if (path === '/api/admin/observability/health') return respond(200, health);
    if (path === '/api/admin/observability/trends') return respond(200, errorTrends);
    if (path === '/api/admin/users') return respond(200, adminUsers);
    if (path === '/api/admin/ai-proxy/config') return respond(200, aiProxyConfig);
    if (path === '/api/admin/usage/nodes') return respond(200, nodeUsage);
    if (path === '/api/admin/quotas/users') return respond(200, quotas);
    if (path === '/api/admin/platform-credentials') return respond(200, platformCredentials);
    return undefined;
  });
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Admin cluster theme audit — ${theme}`, () => {
    test('surfaces', async ({ page }) => {
      await seedTheme(page, theme);
      await setupMocks(page);
      const suffix = `${theme}-${page.viewportSize()?.width ?? 'unknown'}`;

      await visitAndCapture(page, '/admin/overview', `admin-overview-${suffix}`, theme);
      await visitAndCapture(page, '/admin/users', `admin-users-${suffix}`, theme);
      await visitAndCapture(page, '/admin/stream', `admin-stream-${suffix}`, theme);
      await visitAndCapture(page, '/admin/ai-proxy', `admin-ai-proxy-${suffix}`, theme);
      await visitAndCapture(page, '/admin/usage', `admin-usage-${suffix}`, theme);
      await visitAndCapture(page, '/admin/quotas', `admin-quotas-${suffix}`, theme);
      await visitAndCapture(page, '/admin/credentials', `admin-credentials-${suffix}`, theme);
    });
  });
}
