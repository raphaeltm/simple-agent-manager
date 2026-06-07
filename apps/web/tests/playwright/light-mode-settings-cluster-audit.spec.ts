import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

/**
 * Light-mode visual audit for the Settings cluster sub-pages:
 * /settings/cloud-provider, /github, /agents, /notifications, /usage, /api-tokens.
 *
 * These screens were not covered by an existing light-mode audit (slice-e covers
 * project-scoped settings, not the user-level Settings cluster). This audit
 * captures dark and light at every viewport project so future light-mode
 * regressions on the provider forms, agent cards, notification toggles, usage
 * meters, and token rows fail CI.
 */

const longName =
  'Very long settings label that keeps going through multiple clauses and includes symbols <>& "quotes" to stress wrapping';

const MOCK_USER = makeMockUser({
  email: 'settings-audit@example.com',
  name: 'Settings Audit User',
  role: 'superadmin',
  sessionId: 'session-settings-audit',
  userId: 'user-settings-audit',
});

const credentials = [
  {
    id: 'cred-hetzner',
    provider: 'hetzner',
    connected: true,
    createdAt: '2026-06-01T00:00:00Z',
    validation: { valid: true, message: 'Token valid', validationMode: 'provider' },
  },
  {
    id: 'cred-scaleway',
    provider: 'scaleway',
    connected: false,
    createdAt: '2026-06-02T00:00:00Z',
    validation: {
      valid: false,
      message: 'Validation failed for this credential with a long error message that must wrap',
      error: 'invalid_secret',
      status: 401,
      validationMode: 'provider',
    },
  },
  {
    id: 'cred-gcp',
    provider: 'gcp',
    connected: true,
    createdAt: '2026-06-03T00:00:00Z',
    validation: { valid: true, message: 'WIF configured', validationMode: 'provider' },
  },
];

const installations = Array.from({ length: 6 }, (_, index) => ({
  id: `gh-inst-${index}`,
  userId: 'user-settings-audit',
  installationId: `inst-${index}`,
  accountType: index % 2 === 0 ? 'organization' : 'personal',
  accountName: index === 0 ? longName : `account-${index}`,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
}));

const repositories = Array.from({ length: 24 }, (_, index) => ({
  id: index + 1,
  fullName: index === 0 ? `raphaeltm/${longName}` : `raphaeltm/repo-${index}`,
  name: index === 0 ? longName : `repo-${index}`,
  private: index % 3 === 0,
  defaultBranch: 'main',
  installationId: `inst-${index % 6}`,
}));

const agents = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic Claude Code agent with ACP support.',
    supportsAcp: true,
    configured: true,
    credentialHelpUrl: 'https://example.com/help/claude',
    fallbackCredentialSource: null,
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    description: longName,
    supportsAcp: false,
    configured: false,
    credentialHelpUrl: 'https://example.com/help/codex',
    fallbackCredentialSource: null,
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    description: 'Gemini agent.',
    supportsAcp: false,
    configured: true,
    credentialHelpUrl: 'https://example.com/help/gemini',
    fallbackCredentialSource: 'platform-sam',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode multi-provider agent.',
    supportsAcp: true,
    configured: false,
    credentialHelpUrl: 'https://example.com/help/opencode',
    fallbackCredentialSource: 'platform-opencode',
  },
];

const agentCredentials = [
  {
    agentType: 'claude-code',
    provider: 'anthropic',
    credentialKind: 'oauth-token',
    isActive: true,
    maskedKey: 'sk-ant-****wxyz',
    label: 'Pro/Max Subscription',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-06T00:00:00Z',
    scope: 'user',
  },
  {
    agentType: 'google-gemini',
    provider: 'google',
    credentialKind: 'api-key',
    isActive: true,
    maskedKey: 'AIza****1234',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-06T00:00:00Z',
    scope: 'user',
  },
];

const notificationPreferences = {
  preferences: [
    { notificationType: '*', projectId: null, channel: 'in_app', enabled: true },
    { notificationType: 'task_complete', projectId: null, channel: 'in_app', enabled: true },
    { notificationType: 'needs_input', projectId: null, channel: 'in_app', enabled: true },
    { notificationType: 'error', projectId: null, channel: 'in_app', enabled: false },
    { notificationType: 'progress', projectId: null, channel: 'in_app', enabled: false },
    { notificationType: 'session_ended', projectId: null, channel: 'in_app', enabled: true },
    { notificationType: 'pr_created', projectId: null, channel: 'in_app', enabled: true },
  ],
};

const computeUsage = {
  currentPeriod: {
    start: '2026-06-01T00:00:00Z',
    end: '2026-06-30T23:59:59Z',
    totalVcpuHours: 142.5,
    platformVcpuHours: 90.25,
    userVcpuHours: 52.25,
    activeWorkspaces: 2,
  },
  activeSessions: Array.from({ length: 4 }, (_, index) => ({
    nodeId: `node-${index}`,
    name: index === 0 ? longName : `node-${index}`,
    vmSize: 'cx42',
    createdAt: '2026-06-06T00:00:00Z',
    status: 'active',
    workspaceId: `ws-${index}`,
    serverType: 'cx42',
    vcpuCount: 4,
    startedAt: '2026-06-06T00:00:00Z',
    credentialSource: index % 2 === 0 ? 'platform' : 'user',
  })),
};

const quotaStatus = {
  monthlyVcpuHoursLimit: 200,
  source: 'default',
  currentUsage: 142.5,
  remaining: 57.5,
  periodStart: '2026-06-01T00:00:00Z',
  periodEnd: '2026-06-30T23:59:59Z',
  byocExempt: false,
};

const aiUsage = {
  totalCostUsd: 12.3456,
  totalRequests: 482,
  totalInputTokens: 1_234_567,
  totalOutputTokens: 234_567,
  cachedRequests: 120,
  errorRequests: 3,
  byModel: Array.from({ length: 5 }, (_, index) => ({
    model: index === 0 ? `claude-opus-4-very-long-model-identifier-${longName}` : `model-${index}`,
    provider: 'anthropic',
    requests: 100 - index * 10,
    inputTokens: 200_000 - index * 10_000,
    outputTokens: 50_000 - index * 5_000,
    costUsd: 3.21 - index * 0.4,
    cachedRequests: 20,
    errorRequests: index,
  })),
  byDay: Array.from({ length: 14 }, (_, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, '0')}`,
    requests: 30 + index,
    inputTokens: 80_000 + index * 1_000,
    outputTokens: 16_000 + index * 500,
    costUsd: 0.8 + index * 0.05,
  })),
  period: 'current-month',
  periodLabel: 'June 2026',
};

const aiBudget = {
  settings: {
    dailyInputTokenLimit: 1_000_000,
    dailyOutputTokenLimit: 200_000,
    monthlyCostCapUsd: 50,
    alertThresholdPercent: 80,
  },
  isCustom: true,
  dailyUsage: { inputTokens: 750_000, outputTokens: 120_000 },
  effectiveLimits: { dailyInputTokenLimit: 1_000_000, dailyOutputTokenLimit: 200_000 },
  monthCostUsd: 12.34,
  utilization: { dailyInputPercent: 75, dailyOutputPercent: 60, monthlyCostPercent: 24 },
  exceeded: false,
};

const apiTokens = Array.from({ length: 8 }, (_, index) => ({
  id: `token-${index}`,
  name: index === 0 ? longName : `Token ${index}`,
  createdAt: '2026-06-01T00:00:00Z',
  lastUsedAt: index % 3 === 0 ? null : '2026-06-06T00:00:00Z',
  revokedAt: index === 7 ? '2026-06-06T12:00:00Z' : null,
}));

async function seedTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('sam-theme', value);
  }, theme);
}

async function setupMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/api-tokens')) return respond(200, apiTokens);
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/trial-status') return respond(200, { isTrial: false });
    if (path === '/api/credentials/agent') return respond(200, { credentials: agentCredentials });
    if (path === '/api/credentials') return respond(200, credentials);
    if (path === '/api/agents') return respond(200, { agents });
    if (path.startsWith('/api/agent-settings/'))
      return respond(200, {
        agentType: path.split('/').pop(),
        model: null,
        permissionMode: null,
        allowedTools: null,
        deniedTools: null,
        additionalEnv: null,
        opencodeProvider: null,
        opencodeBaseUrl: null,
        opencodeProviderName: null,
        providerMode: null,
        createdAt: null,
        updatedAt: null,
      });
    if (path === '/api/github/installations') return respond(200, installations);
    if (path === '/api/github/install-url') return respond(200, { url: 'https://github.com/apps/sam/installations/new' });
    if (path === '/api/github/repositories') return respond(200, { repositories });
    if (path === '/api/notifications/preferences') return respond(200, notificationPreferences);
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications')
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    if (path === '/api/usage/compute') return respond(200, computeUsage);
    if (path === '/api/usage/quota') return respond(200, quotaStatus);
    if (path === '/api/usage/ai/budget') return respond(200, aiBudget);
    if (path === '/api/usage/ai') return respond(200, aiUsage);

    return respond(200, {});
  });
}

async function expectTheme(page: Page, theme: 'dark' | 'light') {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ui-theme')))
    .toBe(theme === 'light' ? 'sam-light' : 'sam');
}

async function visitAndCapture(page: Page, path: string, name: string, theme: 'dark' | 'light') {
  await page.goto(path);
  await expectTheme(page, theme);
  await page.waitForTimeout(700);
  await screenshot(page, name);
  await assertNoOverflow(page);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Settings cluster theme audit — ${theme}`, () => {
    test('surfaces', async ({ page }) => {
      await seedTheme(page, theme);
      await setupMocks(page);
      const suffix = `${theme}-${page.viewportSize()?.width ?? 'unknown'}`;

      await visitAndCapture(page, '/settings/cloud-provider', `settings-cloud-provider-${suffix}`, theme);
      await visitAndCapture(page, '/settings/github', `settings-github-${suffix}`, theme);
      await visitAndCapture(page, '/settings/agents', `settings-agents-${suffix}`, theme);
      await visitAndCapture(page, '/settings/notifications', `settings-notifications-${suffix}`, theme);
      await visitAndCapture(page, '/settings/usage', `settings-usage-${suffix}`, theme);
      await visitAndCapture(page, '/settings/api-tokens', `settings-api-tokens-${suffix}`, theme);
    });
  });
}
