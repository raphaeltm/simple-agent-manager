/**
 * Playwright visual audit for the composable-credentials Connections UX:
 *   - SettingsConnections page (/settings/connections)
 *   - ConnectFlow component (inline flow triggered from Connections)
 *   - ConnectionsOverview with resolution badges
 *
 * Tests mobile (375x667) and desktop (1280x800) with diverse mock data.
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

type CCSource =
  | 'project-attachment'
  | 'user-attachment'
  | 'platform'
  | 'platform-proxy'
  | 'halted'
  | 'unresolved';

function makeConsumer(overrides: {
  consumerId: string;
  consumerName: string;
  consumerKind: 'agent' | 'compute';
  source: CCSource;
  credentialName?: string;
  credentialKind?: string | null;
  configurationName?: string | null;
  statusReason?: string | null;
  validation?: unknown;
}) {
  return {
    consumerId: overrides.consumerId,
    consumerName: overrides.consumerName,
    consumerKind: overrides.consumerKind,
    source: overrides.source,
    credentialName: overrides.credentialName ?? null,
    credentialKind: overrides.credentialKind ?? null,
    configurationName: overrides.configurationName ?? null,
    statusReason: overrides.statusReason ?? null,
    halted: overrides.source === 'halted',
    validation: overrides.validation,
  };
}

// ---------------------------------------------------------------------------
// Scenario Data Sets
// ---------------------------------------------------------------------------

// Normal: mix of all resolution sources
const NORMAL_CONSUMERS = [
  makeConsumer({
    consumerId: 'claude-code',
    consumerName: 'Claude Code',
    consumerKind: 'agent',
    source: 'user-attachment',
    credentialName: 'Claude default key',
    credentialKind: 'api-key',
    configurationName: 'Claude Code default',
  }),
  makeConsumer({
    consumerId: 'openai-codex',
    consumerName: 'OpenAI Codex',
    consumerKind: 'agent',
    source: 'user-attachment',
    credentialName: 'Codex auth.json',
    credentialKind: 'auth-json',
    configurationName: 'Codex user default',
    validation: { status: 'valid', message: 'Credential format is valid' },
  }),
  makeConsumer({
    consumerId: 'google-gemini',
    consumerName: 'Google Gemini',
    consumerKind: 'agent',
    source: 'unresolved',
  }),
  makeConsumer({
    consumerId: 'opencode',
    consumerName: 'OpenCode',
    consumerKind: 'agent',
    source: 'platform-proxy',
  }),
  makeConsumer({
    consumerId: 'hetzner',
    consumerName: 'Hetzner Cloud',
    consumerKind: 'compute',
    source: 'user-attachment',
    credentialName: 'Hetzner account',
    credentialKind: 'cloud-provider',
  }),
  makeConsumer({
    consumerId: 'scaleway',
    consumerName: 'Scaleway',
    consumerKind: 'compute',
    source: 'unresolved',
  }),
];

// All unresolved — exercises "Connect" affordance on every row
const UNRESOLVED_CONSUMERS = [
  makeConsumer({
    consumerId: 'claude-code',
    consumerName: 'Claude Code',
    consumerKind: 'agent',
    source: 'unresolved',
  }),
  makeConsumer({
    consumerId: 'openai-codex',
    consumerName: 'OpenAI Codex',
    consumerKind: 'agent',
    source: 'unresolved',
  }),
  makeConsumer({
    consumerId: 'google-gemini',
    consumerName: 'Google Gemini',
    consumerKind: 'agent',
    source: 'unresolved',
  }),
  makeConsumer({
    consumerId: 'hetzner',
    consumerName: 'Hetzner Cloud',
    consumerKind: 'compute',
    source: 'unresolved',
  }),
];

// Halted — exercises danger badge
const HALTED_CONSUMERS = [
  makeConsumer({
    consumerId: 'claude-code',
    consumerName: 'Claude Code',
    consumerKind: 'agent',
    source: 'halted',
  }),
  makeConsumer({
    consumerId: 'openai-codex',
    consumerName: 'OpenAI Codex',
    consumerKind: 'agent',
    source: 'user-attachment',
    credentialName: 'Codex auth.json',
    credentialKind: 'auth-json',
    configurationName: 'Codex user default',
    statusReason: 'invalid-auth-json',
    validation: {
      status: 'invalid',
      message: 'Codex auth.json is missing required OpenAI OAuth fields.',
    },
  }),
  makeConsumer({
    consumerId: 'hetzner',
    consumerName: 'Hetzner Cloud',
    consumerKind: 'compute',
    source: 'halted',
  }),
];

// Long text — tests overflow and wrapping in consumer names / masked labels
const LONG_TEXT_CONSUMERS = [
  makeConsumer({
    consumerId: 'long-agent-1',
    consumerName: 'A'.repeat(80) + ' Very Long Agent Name That Must Wrap',
    consumerKind: 'agent',
    source: 'user-attachment',
    credentialName: 'Credential ' + 'x'.repeat(120),
    credentialKind: 'api-key',
  }),
  makeConsumer({
    consumerId: 'long-agent-2',
    consumerName: 'Unicode Agent \u{1F916}\u{1F680}\u{2728}'.repeat(5),
    consumerKind: 'agent',
    source: 'project-attachment',
  }),
  makeConsumer({
    consumerId: 'hetzner',
    consumerName: 'Hetzner Cloud',
    consumerKind: 'compute',
    source: 'unresolved',
  }),
];

// Empty — no agents, no compute providers known
const EMPTY_CONSUMERS: unknown[] = [];

// Many items (30+) — exercises scroll behavior
const MANY_CONSUMERS = [
  ...Array.from({ length: 18 }, (_, i) =>
    makeConsumer({
      consumerId: `agent-${i}`,
      consumerName: `Agent Provider ${i + 1}`,
      consumerKind: 'agent',
      source: ['user-attachment', 'project-attachment', 'platform', 'unresolved', 'halted'][
        i % 5
      ] as CCSource,
      credentialName: i % 3 === 0 ? `Credential ${i.toString(16).padStart(4, '0')}` : undefined,
      credentialKind: i % 3 === 0 ? 'api-key' : null,
    })
  ),
  ...Array.from({ length: 8 }, (_, i) =>
    makeConsumer({
      consumerId: `compute-${i}`,
      consumerName: `Cloud Provider ${i + 1}`,
      consumerKind: 'compute',
      source: i % 2 === 0 ? 'user-attachment' : ('unresolved' as CCSource),
    })
  ),
];

// Focused Codex scenario — exercises row actions without multiple duplicate buttons.
const CODEX_ACTIVE_CONSUMERS = [
  makeConsumer({
    consumerId: 'openai-codex',
    consumerName: 'OpenAI Codex',
    consumerKind: 'agent',
    source: 'user-attachment',
    credentialName: 'Codex auth.json',
    credentialKind: 'auth-json',
    configurationName: 'Codex user default',
    validation: { status: 'valid', message: 'Credential format is valid' },
  }),
  makeConsumer({
    consumerId: 'opencode',
    consumerName: 'OpenCode',
    consumerKind: 'agent',
    source: 'platform-proxy',
  }),
];

const CODEX_BROKEN_CONSUMERS = [
  makeConsumer({
    consumerId: 'openai-codex',
    consumerName: 'OpenAI Codex',
    consumerKind: 'agent',
    source: 'user-attachment',
    credentialName: 'Codex auth.json',
    credentialKind: 'auth-json',
    configurationName: 'Codex user default',
    statusReason: 'invalid-auth-json',
    validation: {
      status: 'invalid',
      message: 'Codex auth.json is missing required OpenAI OAuth fields.',
    },
  }),
];

// AGENT_CATALOG-like mock for ConnectFlow
const MOCK_AGENT_CATALOG = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic Claude Code agent',
    provider: 'Anthropic',
    envVarName: 'ANTHROPIC_API_KEY',
    credentialHelpUrl: 'https://console.anthropic.com',
    oauthSupport: { setupInstructions: 'Run claude setup-token and paste the result.' },
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    description: 'OpenAI Codex agent',
    provider: 'OpenAI',
    envVarName: 'OPENAI_API_KEY',
    credentialHelpUrl: 'https://platform.openai.com',
    oauthSupport: null,
  },
];

// ---------------------------------------------------------------------------
// Mock Router Setup
// ---------------------------------------------------------------------------

const mockUser = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  sessionId: 'sess-1',
  userId: 'user-1',
});

function setupMocks(consumers: unknown[], apiError = false) {
  return async (page: import('@playwright/test').Page) => {
    // Inject AGENT_CATALOG mock into window before the app boots
    await page.addInitScript((catalog) => {
      // @ts-expect-error injecting mock for test
      window.__TEST_AGENT_CATALOG__ = catalog;
    }, MOCK_AGENT_CATALOG);

    await setupAuditRoutes(page, (path: string, respond: AuditResponder) => {
      if (path.includes('/api/auth')) return respond(200, mockUser);
      if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
      if (path === '/api/credentials') return respond(200, []);
      if (path.startsWith('/api/notifications'))
        return respond(200, { notifications: [], unreadCount: 0 });
      if (path === '/api/credentials/resolution-status') {
        if (apiError) return respond(500, { error: 'Internal server error' });
        return respond(200, { consumers });
      }
      if (path.startsWith('/api/credentials/')) return respond(200, { success: true });
      return undefined;
    });
  };
}

// ---------------------------------------------------------------------------
// Tests: SettingsConnections page
// ---------------------------------------------------------------------------

// Helper: navigate to a settings sub-route and wait for the content to render.
// Uses a text-based wait that doesn't depend on heading levels.
async function gotoConnections(page: import('@playwright/test').Page) {
  await page.goto('/settings/connections');
  // Wait for the "AI Agents" section header rendered by ConnectionsOverview,
  // or the "How each AI agent" description text from SettingsConnections,
  // or the Spinner to disappear — whichever signals the page loaded.
  await page.waitForSelector('h2, h3, [class*="glass-surface"]', {
    state: 'visible',
    timeout: 20000,
  });
  await page.waitForTimeout(700);
}

describeThemeAudit(
  'SettingsConnections — Normal (mixed resolution sources)',
  setupMocks(NORMAL_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await screenshot(page, `connections-normal-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'SettingsConnections — All Unresolved (Connect affordance)',
  setupMocks(UNRESOLVED_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await screenshot(page, `connections-unresolved-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'SettingsConnections — Halted credentials',
  setupMocks(HALTED_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await screenshot(page, `connections-halted-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'SettingsConnections — Long text',
  setupMocks(LONG_TEXT_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await screenshot(page, `connections-long-text-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'SettingsConnections — Empty state',
  setupMocks(EMPTY_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await screenshot(page, `connections-empty-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'SettingsConnections — Many items',
  setupMocks(MANY_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await screenshot(page, `connections-many-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'SettingsConnections — Error state',
  setupMocks([], true),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await screenshot(page, `connections-error-${suffix}`);
    await assertNoOverflow(page);
  }
);

// ---------------------------------------------------------------------------
// Tests: ConnectFlow (triggered by clicking "+ Connect an agent")
// ---------------------------------------------------------------------------

describeThemeAudit(
  'ConnectFlow — Agent selection step',
  setupMocks(UNRESOLVED_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    // Open the flow via the global "Connect an agent" button
    const connectBtn = page.getByText('+ Connect an agent');
    await connectBtn.click();
    await page.waitForTimeout(500);
    await screenshot(page, `connect-flow-agent-select-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'ConnectFlow — Codex auth.json happy path',
  setupMocks(UNRESOLVED_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await page.getByText('+ Connect an agent').click();
    await page.getByRole('button', { name: /OpenAI Codex/ }).click();
    await page.getByRole('button', { name: 'Codex auth.json' }).click();
    await screenshot(page, `connect-flow-codex-auth-json-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'Connections — Replace active Codex auth.json',
  setupMocks(CODEX_ACTIVE_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await page.getByRole('button', { name: 'Replace default' }).click();
    await screenshot(page, `connections-codex-replace-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'Connections — Disconnect active Codex credential',
  setupMocks(CODEX_ACTIVE_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.waitForTimeout(500);
    await screenshot(page, `connections-codex-disconnect-${suffix}`);
    await assertNoOverflow(page);
  }
);

describeThemeAudit(
  'Connections — Broken Codex recovery',
  setupMocks(CODEX_BROKEN_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await page.getByRole('button', { name: 'Validate' }).click();
    await page.waitForTimeout(500);
    await screenshot(page, `connections-codex-broken-validate-${suffix}`);
    await page.getByRole('button', { name: 'Replace default' }).click();
    await screenshot(page, `connections-codex-broken-replace-${suffix}`);
    await assertNoOverflow(page);
  }
);

// ---------------------------------------------------------------------------
// Tests: Settings tab bar (Connections tab visible)
// ---------------------------------------------------------------------------

describeThemeAudit(
  'Settings tabs — Connections tab active',
  setupMocks(NORMAL_CONSUMERS),
  async (page, _theme, suffix) => {
    await gotoConnections(page);
    await screenshot(page, `settings-tabs-connections-active-${suffix}`);
    await assertNoOverflow(page);
  }
);
