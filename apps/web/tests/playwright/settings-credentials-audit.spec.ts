/**
 * Playwright visual audit for SettingsCredentials (composable-credentials UI).
 * Tests mobile (375x667) + desktop (1280x800) with stress-test mock data.
 */

import {
  assertNoOverflow,
  type AuditResponder,
  describeThemeAudit,
  makeMockUser,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

function makeCred(
  overrides: Partial<{
    id: string;
    name: string;
    kind: string;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  }> = {}
) {
  return {
    id: overrides.id ?? `cc-cred-${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name ?? 'Anthropic API Key',
    kind: overrides.kind ?? 'api-key',
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? '2026-06-01T10:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-10T15:30:00Z',
  };
}

function makeConfig(
  overrides: Partial<{
    id: string;
    name: string;
    consumerKind: string;
    consumerTarget: string;
    credentialId: string | null;
    settingsJson: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  }> = {}
) {
  return {
    id: overrides.id ?? `cc-cfg-${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name ?? 'Claude Code config',
    consumerKind: overrides.consumerKind ?? 'agent',
    consumerTarget: overrides.consumerTarget ?? 'claude-code',
    credentialId: overrides.credentialId ?? null,
    settingsJson: overrides.settingsJson ?? null,
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? '2026-06-01T10:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-10T15:30:00Z',
  };
}

function makeAttachment(
  overrides: Partial<{
    id: string;
    configurationId: string;
    consumerKind: string;
    consumerTarget: string;
    projectId: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  }> = {}
) {
  return {
    id: overrides.id ?? `cc-att-${Math.random().toString(36).slice(2, 10)}`,
    configurationId: overrides.configurationId ?? 'cc-cfg-default',
    consumerKind: overrides.consumerKind ?? 'agent',
    consumerTarget: overrides.consumerTarget ?? 'claude-code',
    projectId: overrides.projectId ?? null,
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? '2026-06-01T10:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-06-10T15:30:00Z',
  };
}

// ---------------------------------------------------------------------------
// Scenario Data Sets
// ---------------------------------------------------------------------------

const NORMAL_CREDENTIALS = [
  makeCred({ id: 'cred-1', name: 'Anthropic API Key', kind: 'api-key' }),
  makeCred({ id: 'cred-2', name: 'Claude Code OAuth', kind: 'oauth-token' }),
  makeCred({ id: 'cred-3', name: 'Hetzner Token', kind: 'cloud-provider', isActive: false }),
];

const NORMAL_CONFIGS = [
  makeConfig({
    id: 'cfg-1',
    name: 'Claude Code agent',
    consumerKind: 'agent',
    consumerTarget: 'claude-code',
    credentialId: 'cred-1',
  }),
  makeConfig({
    id: 'cfg-2',
    name: 'Codex agent',
    consumerKind: 'agent',
    consumerTarget: 'openai-codex',
    credentialId: 'cred-2',
  }),
  makeConfig({
    id: 'cfg-3',
    name: 'Hetzner compute',
    consumerKind: 'compute',
    consumerTarget: 'hetzner',
    credentialId: 'cred-3',
    settingsJson: '{"region":"fsn1","vmSize":"cx22"}',
  }),
];

const NORMAL_ATTACHMENTS = [
  makeAttachment({
    id: 'att-1',
    configurationId: 'cfg-1',
    consumerKind: 'agent',
    consumerTarget: 'claude-code',
  }),
  makeAttachment({
    id: 'att-2',
    configurationId: 'cfg-2',
    consumerKind: 'agent',
    consumerTarget: 'openai-codex',
    projectId: 'proj-abc123',
  }),
  makeAttachment({
    id: 'att-3',
    configurationId: 'cfg-3',
    consumerKind: 'compute',
    consumerTarget: 'hetzner',
    isActive: false,
  }),
];

// Long text stress test
const LONG_TEXT_CREDENTIALS = [
  makeCred({
    id: 'lt-1',
    name: 'A'.repeat(220) + ' Very Long Credential Name That Should Wrap Properly',
    kind: 'openai-compatible',
  }),
  makeCred({
    id: 'lt-2',
    name: 'Unicode: ' + '\u{1F680}\u{1F916}\u{1F4BB}\u{2728}'.repeat(20) + ' end',
    kind: 'auth-json',
  }),
];

const LONG_TEXT_CONFIGS = [
  makeConfig({
    id: 'lt-cfg-1',
    name: 'B'.repeat(200) + ' extremely long config name with many words',
    consumerKind: 'agent',
    consumerTarget: 'claude-code-ultra-long-agent-type-name-that-should-not-break-layout',
    credentialId: 'lt-1',
    settingsJson: JSON.stringify({
      model: 'claude-opus-4-20260601',
      maxTokens: 200000,
      customInstructions: 'C'.repeat(300),
    }),
  }),
];

const LONG_TEXT_ATTACHMENTS = [
  makeAttachment({
    id: 'lt-att-1',
    configurationId: 'lt-cfg-1',
    consumerKind: 'agent',
    consumerTarget: 'claude-code-ultra-long-agent-type-name',
    projectId: 'proj-' + 'x'.repeat(80),
  }),
];

// Many items (30+)
const MANY_CREDENTIALS = Array.from({ length: 35 }, (_, i) =>
  makeCred({
    id: `many-cred-${i}`,
    name: `Credential #${i + 1} — ${['api-key', 'oauth-token', 'openai-compatible', 'cloud-provider', 'auth-json'][i % 5]}`,
    kind: ['api-key', 'oauth-token', 'openai-compatible', 'cloud-provider', 'auth-json'][i % 5],
    isActive: i % 4 !== 0,
  })
);

const MANY_CONFIGS = Array.from({ length: 30 }, (_, i) =>
  makeConfig({
    id: `many-cfg-${i}`,
    name: `Configuration #${i + 1}`,
    consumerKind: i % 2 === 0 ? 'agent' : 'compute',
    consumerTarget:
      i % 2 === 0
        ? ['claude-code', 'openai-codex', 'openai'][i % 3]
        : ['hetzner', 'scaleway'][i % 2],
    credentialId: `many-cred-${i % 35}`,
  })
);

const MANY_ATTACHMENTS = Array.from({ length: 30 }, (_, i) =>
  makeAttachment({
    id: `many-att-${i}`,
    configurationId: `many-cfg-${i % 30}`,
    projectId: i % 3 === 0 ? `proj-${i}` : null,
    isActive: i % 5 !== 0,
  })
);

// ---------------------------------------------------------------------------
// Mock Router Setup
// ---------------------------------------------------------------------------

const mockUser = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  sessionId: 'sess-1',
  userId: 'user-1',
});

function setupMocks(credentials: unknown[], configurations: unknown[], attachments: unknown[]) {
  return async (page: import('@playwright/test').Page) => {
    await setupAuditRoutes(page, (path: string, respond: AuditResponder) => {
      if (path.includes('/api/auth')) return respond(200, mockUser);
      // Shell routes required for Settings page to render
      if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
      if (path === '/api/credentials') return respond(200, []);
      if (path.startsWith('/api/notifications'))
        return respond(200, { notifications: [], unreadCount: 0 });
      // CC routes
      if (path === '/api/cc/credentials') return respond(200, { credentials });
      if (path === '/api/cc/configurations') return respond(200, { configurations });
      if (path === '/api/cc/attachments') return respond(200, { attachments });
      if (path.startsWith('/api/cc/')) return respond(200, { success: true });
      return undefined;
    });
  };
}

function setupErrorMocks() {
  return async (page: import('@playwright/test').Page) => {
    await setupAuditRoutes(page, (path: string, respond: AuditResponder) => {
      if (path.includes('/api/auth')) return respond(200, mockUser);
      // Shell routes required for Settings page to render
      if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
      if (path === '/api/credentials') return respond(200, []);
      if (path.startsWith('/api/notifications'))
        return respond(200, { notifications: [], unreadCount: 0 });
      // CC routes return errors for this scenario
      if (path.startsWith('/api/cc/')) return respond(500, { error: 'Internal server error' });
      return undefined;
    });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeThemeAudit(
  'SettingsCredentials — Normal',
  setupMocks(NORMAL_CREDENTIALS, NORMAL_CONFIGS, NORMAL_ATTACHMENTS),
  async (page, theme, suffix) => {
    await page.goto('/settings/credentials');
    await page.getByRole('heading', { name: 'Credentials' }).waitFor();
    await page.waitForTimeout(500);
    await screenshot(page, `settings-credentials-normal-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'SettingsCredentials — Long Text',
  setupMocks(LONG_TEXT_CREDENTIALS, LONG_TEXT_CONFIGS, LONG_TEXT_ATTACHMENTS),
  async (page, theme, suffix) => {
    await page.goto('/settings/credentials');
    await page.getByRole('heading', { name: 'Credentials' }).waitFor();
    await page.waitForTimeout(500);
    await screenshot(page, `settings-credentials-long-text-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'SettingsCredentials — Empty State',
  setupMocks([], [], []),
  async (page, theme, suffix) => {
    await page.goto('/settings/credentials');
    await page.getByRole('heading', { name: 'Credentials' }).waitFor();
    await page.waitForTimeout(500);
    await screenshot(page, `settings-credentials-empty-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'SettingsCredentials — Many Items',
  setupMocks(MANY_CREDENTIALS, MANY_CONFIGS, MANY_ATTACHMENTS),
  async (page, theme, suffix) => {
    await page.goto('/settings/credentials');
    await page.getByRole('heading', { name: 'Credentials' }).waitFor();
    await page.waitForTimeout(500);
    await screenshot(page, `settings-credentials-many-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'SettingsCredentials — Error State',
  setupErrorMocks(),
  async (page, theme, suffix) => {
    await page.goto('/settings/credentials');
    await page.getByRole('heading', { name: 'Credentials' }).waitFor();
    await page.waitForTimeout(500);
    await screenshot(page, `settings-credentials-error-${suffix}`);
    await assertNoOverflow(page);
  }
);
