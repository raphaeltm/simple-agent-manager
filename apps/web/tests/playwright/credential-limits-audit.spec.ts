/**
 * Visual audit — credential usage-limit chip on the chat header and on Settings →
 * Credentials cards (.claude/rules/17). Mocked API data pushes both surfaces:
 * normal windows, a credential with many windows and a long name, a critical
 * window, empty (no samples → chip absent), and a failing limits endpoint.
 */
import { expect, type Page, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  type AuditResponder,
  makeMockUser,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

const PROJECT_ID = 'proj-limits-1';
const SESSION_ID = 'cs-limits-1';
const AGENT_SESSION_ID = 'as-limits-1';
const NOW = Date.now();

const MOCK_USER = makeMockUser({
  email: 'limits@example.com',
  name: 'Limits Tester',
  sessionId: 'session-limits-1',
  userId: 'user-limits-1',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Usage Limits Project',
  repository: 'testuser/limits-repo',
  defaultBranch: 'main',
  userId: 'user-limits-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function window(
  windowType: string,
  utilizationPercent: number | null,
  overrides: Record<string, unknown> = {}
) {
  const level =
    utilizationPercent === null
      ? 'ok'
      : utilizationPercent >= 100
        ? 'rejected'
        : utilizationPercent >= 90
          ? 'critical'
          : utilizationPercent >= 75
            ? 'warning'
            : 'ok';
  return {
    windowType,
    provider: windowType.startsWith('claude')
      ? 'anthropic'
      : windowType.startsWith('codex')
        ? 'openai'
        : 'opencode',
    source: 'claude-acp.rate_limit',
    status: level === 'rejected' ? 'rejected' : 'allowed',
    level,
    utilizationPercent,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes: null,
    resetsAt: NOW + 2 * 3_600_000 + 10 * 60_000,
    observedAt: NOW - 4 * 60_000,
    updatedAt: NOW - 4 * 60_000,
    ...overrides,
  };
}

function credential(
  credentialId: string,
  windows: ReturnType<typeof window>[],
  overrides: Record<string, unknown> = {}
) {
  const rank = { ok: 0, warning: 1, critical: 2, rejected: 3 } as const;
  const level = windows.reduce<keyof typeof rank>(
    (worst, w) =>
      rank[w.level as keyof typeof rank] > rank[worst] ? (w.level as keyof typeof rank) : worst,
    'ok'
  );
  return {
    credentialReference: `cc_credentials:${credentialId}`,
    credentialId,
    credentialSource: 'user',
    provider: 'anthropic',
    providerMode: 'direct',
    agentType: 'claude-code',
    level,
    observedAt: NOW - 4 * 60_000,
    windows,
    ...overrides,
  };
}

const CLAUDE_CRED = credential('cred-claude', [
  window('claude.five_hour', 72, { windowMinutes: 300 }),
  window('claude.seven_day', 31, { windowMinutes: 10080, resetsAt: NOW + 3 * 86_400_000 }),
]);

const CODEX_CRITICAL_CRED = credential(
  'cred-codex',
  [
    window('codex.primary', 93.4, { windowMinutes: 300, source: 'vm-agent.codex_rollout' }),
    window('codex.secondary', 100, {
      windowMinutes: 10080,
      source: 'vm-agent.codex_rollout',
      resetsAt: NOW + 5 * 86_400_000,
    }),
  ],
  { provider: 'openai', agentType: 'openai-codex' }
);

const OPENCODE_MANY_CRED = credential(
  'cred-opencode',
  [
    window('opencode.rolling', 7, { source: 'vm-agent.opencode_go_usage' }),
    window('opencode.weekly', 39, {
      source: 'vm-agent.opencode_go_usage',
      resetsAt: NOW + 26 * 3_600_000,
    }),
    window('opencode.monthly', 19, { source: 'vm-agent.opencode_go_usage', resetsAt: null }),
    window('claude.seven_day_opus', null, { resetsAt: null }),
    window('claude.seven_day_sonnet', 4, { resetsAt: NOW - 1000 }),
  ],
  { provider: 'opencode', agentType: 'opencode', credentialSource: 'project' }
);

const LONG_NAME =
  'A'.repeat(40) +
  ' extremely long credential name that keeps going and going for layout stress ' +
  'B'.repeat(60);

const CC_CREDENTIALS = [
  {
    id: 'cred-claude',
    name: 'Claude Max (personal)',
    kind: 'oauth-token',
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'cred-codex',
    name: 'ChatGPT Pro',
    kind: 'auth-json',
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'cred-opencode',
    name: LONG_NAME,
    kind: 'api-key',
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'cred-nolimits',
    name: 'Hetzner (no usage samples)',
    kind: 'cloud-provider',
    isActive: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

type LimitsScenario = 'normal' | 'empty' | 'error';

function limitsBody(scenario: LimitsScenario, credentials: unknown[]) {
  if (scenario === 'empty') return { credentials: [], generatedAt: NOW };
  return { credentials, generatedAt: NOW };
}

function makeChatSession() {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    status: 'active',
    topic:
      'Investigate flaky deploy pipeline and propose a fix for the retry storm in the webhook relay',
    workspaceId: 'ws-limits-1',
    agentSessionId: AGENT_SESSION_ID,
    agentType: 'claude-code',
    isIdle: false,
    isMine: true,
    agentCompletedAt: null,
    createdAt: '2026-10-05T10:00:00Z',
    updatedAt: '2026-10-05T10:00:00Z',
  };
}

const CHAT_MESSAGES = [
  {
    id: 'm1',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Please look into the deploy failures.',
    toolMetadata: null,
    createdAt: NOW - 120_000,
  },
  {
    id: 'm2',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: 'On it. Checking the last three runs now.',
    toolMetadata: null,
    createdAt: NOW - 60_000,
  },
];

function chatHandler(scenario: LimitsScenario, sessionCredential: unknown) {
  return (path: string, respond: AuditResponder) => {
    if (path.includes('/api/auth')) return respond(200, MOCK_USER);
    if (path === `/api/projects/${PROJECT_ID}/credential-limits`) {
      if (scenario === 'error') return respond(500, { error: 'INTERNAL_ERROR' });
      return respond(200, limitsBody(scenario, [sessionCredential]));
    }
    if (path === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}`) {
      return respond(200, {
        session: makeChatSession(),
        messages: CHAT_MESSAGES,
        hasMore: false,
        state: { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null },
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/messages`) {
      return respond(200, { messages: CHAT_MESSAGES, hasMore: false });
    }
    if (path === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/state`) {
      return respond(200, {
        activity: 'idle',
        activityAt: NOW,
        statusError: null,
        currentPlan: null,
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/sessions`) {
      return respond(200, { sessions: [makeChatSession()], total: 1 });
    }
    if (path === `/api/projects/${PROJECT_ID}/activity`) return respond(200, { events: [] });
    if (path === `/api/projects/${PROJECT_ID}/tasks`)
      return respond(200, { tasks: [], nextCursor: null });
    if (path === `/api/projects/${PROJECT_ID}`) return respond(200, MOCK_PROJECT);
    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], total: 1 });
    // App-shell data the chat route loads; these must be the right container shape.
    if (path === '/api/credentials') return respond(200, []);
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/github/installations') return respond(200, { installations: [] });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/chats' || path === '/api/chats/recent')
      return respond(200, { sessions: [], total: 0, totalActive: 0 });
    return undefined;
  };
}

function settingsHandler(scenario: LimitsScenario) {
  return (path: string, respond: AuditResponder) => {
    if (path.includes('/api/auth')) return respond(200, MOCK_USER);
    if (path === '/api/credentials/limits') {
      if (scenario === 'error') return respond(500, { error: 'INTERNAL_ERROR' });
      return respond(
        200,
        limitsBody(scenario, [CLAUDE_CRED, CODEX_CRITICAL_CRED, OPENCODE_MANY_CRED])
      );
    }
    if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
    if (path === '/api/credentials') return respond(200, []);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/cc/credentials') return respond(200, { credentials: CC_CREDENTIALS });
    if (path === '/api/cc/configurations') return respond(200, { configurations: [] });
    if (path === '/api/cc/attachments') return respond(200, { attachments: [] });
    if (path.startsWith('/api/cc/')) return respond(200, { success: true });
    return undefined;
  };
}

/**
 * The first-run onboarding overlay covers the chat for a user with no cloud
 * credential (the rule-62 incident). A returning user has dismissed it, which
 * the app persists per user in localStorage; seed that state before navigation.
 */
async function dismissOnboarding(page: Page) {
  await page.addInitScript((userId: string) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);
}

function agentSettingsHandler(opencodeProvider: 'opencode-zen' | 'opencode-go') {
  return (path: string, respond: AuditResponder) => {
    if (path.includes('/api/auth')) return respond(200, MOCK_USER);
    if (path === '/api/agents') {
      return respond(200, {
        agents: [{ id: 'opencode', name: 'OpenCode', description: 'OpenCode agent with multi-provider support' }],
      });
    }
    if (path === '/api/model-catalog/opencode') {
      return respond(200, {
        agentType: 'opencode',
        source: 'dynamic',
        updatedAt: '2026-06-27T00:00:00.000Z',
        groups: [
          { label: 'OpenCode Zen', models: [{ id: 'opencode/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', group: 'OpenCode Zen' }] },
          { label: 'OpenCode Go', models: [{ id: 'opencode-go/glm-5.2', name: 'GLM-5.2', group: 'OpenCode Go' }] },
        ],
      });
    }
    if (path === '/api/agent-settings/opencode') {
      return respond(200, {
        agentType: 'opencode',
        model: null,
        permissionMode: 'bypassPermissions',
        allowedTools: null,
        deniedTools: null,
        additionalEnv: null,
        opencodeProvider,
        opencodeBaseUrl: null,
        providerMode: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
    }
    if (path === '/api/projects') return respond(200, { projects: [] });
    if (path === '/api/credentials') return respond(200, []);
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/github')) return respond(200, []);
    return undefined;
  };
}

async function openAgentSettings(page: Page, opencodeProvider: 'opencode-zen' | 'opencode-go') {
  await dismissOnboarding(page);
  await setupAuditRoutes(page, agentSettingsHandler(opencodeProvider));
  await page.goto('/settings/agents');
  await page.getByTestId('agent-card-opencode').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
}

async function openChat(page: Page, scenario: LimitsScenario, sessionCredential: unknown) {
  await dismissOnboarding(page);
  await setupAuditRoutes(page, chatHandler(scenario, sessionCredential));
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await page.getByTestId('session-header').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(600);
}

async function openSettings(page: Page, scenario: LimitsScenario) {
  await dismissOnboarding(page);
  await setupAuditRoutes(page, settingsHandler(scenario));
  await page.goto('/settings/credentials');
  await page.getByRole('heading', { name: 'Credentials' }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
}

/**
 * The chip must sit inside the header card horizontally: its right edge may not
 * pass the header's right edge (rule 17: assert the relationship in coordinates).
 */
async function expectChipInsideHeader(page: Page) {
  const header = page.getByTestId('session-header');
  const chip = header.getByTestId('credential-limit-chip');
  await expect(chip).toBeVisible();
  const headerBox = await header.boundingBox();
  const chipBox = await chip.boundingBox();
  expect(headerBox && chipBox).toBeTruthy();
  expect(chipBox!.x).toBeGreaterThanOrEqual(headerBox!.x - 1);
  expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(headerBox!.x + headerBox!.width + 1);
}

function surfaceTests() {
  test('chat header shows the session credential chip and opens details', async ({ page }) => {
    await openChat(page, 'normal', CLAUDE_CRED);
    await expectChipInsideHeader(page);
    await expect(page.getByTestId('credential-limit-chip')).toHaveText(
      /Claude · 5h 72% · Week 31%/
    );
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'credential-limits-chat-normal', { scopeToProject: true });

    await page.getByTestId('credential-limit-chip').click();
    const details = page.getByTestId('credential-limit-details');
    await expect(details).toBeVisible();
    await expect(details.getByTestId('credential-limit-window')).toHaveCount(2);
    await expect(details).toContainText('resets in 2h');
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'credential-limits-chat-details', { scopeToProject: true });
  });

  test('chat header renders a critical Codex credential', async ({ page }) => {
    await openChat(page, 'normal', CODEX_CRITICAL_CRED);
    await expectChipInsideHeader(page);
    await expect(page.getByTestId('credential-limit-chip')).toHaveText(
      /Codex · 5h 93% · Week 100%/
    );
    await expect(page.getByTestId('credential-limit-chip')).toHaveAccessibleName(/Limit reached/);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'credential-limits-chat-critical', { scopeToProject: true });
  });

  test('chat header collapses many windows and stays inside the card', async ({ page }) => {
    await openChat(page, 'normal', OPENCODE_MANY_CRED);
    await expectChipInsideHeader(page);
    await expect(page.getByTestId('credential-limit-chip')).toHaveText(
      /OpenCode · Rolling 7% · Week 39% · Month 19% · \+2/
    );
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'credential-limits-chat-many', { scopeToProject: true });
    await page.getByTestId('credential-limit-chip').click();
    await expect(
      page.getByTestId('credential-limit-details').getByTestId('credential-limit-window')
    ).toHaveCount(5);
    await expect(page.getByTestId('credential-limit-details')).toContainText('reset due');
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'credential-limits-chat-many-details', { scopeToProject: true });
  });

  test('chat header hides the chip without samples or on a failing endpoint, and still renders', async ({
    page,
  }) => {
    await openChat(page, 'empty', CLAUDE_CRED);
    await expect(page.getByTestId('session-header')).toContainText('Active');
    await expect(page.getByTestId('credential-limit-chip')).toHaveCount(0);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'credential-limits-chat-empty', { scopeToProject: true });

    await openChat(page, 'error', CLAUDE_CRED);
    await expect(page.getByTestId('session-header')).toContainText('Active');
    await expect(page.getByTestId('credential-limit-chip')).toHaveCount(0);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
  });

  // Settings pages run the advisory overflow check only: the settings tab strip
  // is 679px wide inside the page's overflow-x-hidden main at 375px today, with
  // or without this change (SAM idea 01M46AJBTE8361Q9T7J11CB3YM).
  test('settings credential cards show usage rows only for credentials with samples', async ({
    page,
  }) => {
    await openSettings(page, 'normal');
    const rows = page.getByTestId('credential-usage-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Claude · 5h 72%');
    await expect(rows.nth(0)).toContainText(/sampled \d+m ago/);
    await assertNoOverflow(page);
    await screenshot(page, 'credential-limits-settings-normal', { scopeToProject: true });

    await rows.nth(1).getByTestId('credential-limit-chip').click();
    await expect(page.getByTestId('credential-limit-details')).toContainText('Codex usage');
    await assertNoOverflow(page);
    await screenshot(page, 'credential-limits-settings-details', { scopeToProject: true });
  });

  test('agent settings show the Zen console note only for the opencode-zen provider', async ({ page }) => {
    await openAgentSettings(page, 'opencode-zen');
    const note = page.getByTestId('opencode-zen-balance-note');
    await note.scrollIntoViewIfNeeded();
    await expect(note).toBeVisible();
    await expect(note).toContainText('OpenCode console');
    await expect(note.locator('a')).toHaveAttribute('href', 'https://opencode.ai/zen');
    await assertNoOverflow(page);
    await screenshot(page, 'credential-limits-agent-settings-zen-note', { scopeToProject: true });

    await openAgentSettings(page, 'opencode-go');
    await expect(page.getByTestId('agent-card-opencode')).toBeVisible();
    await expect(page.getByTestId('opencode-zen-balance-note')).toHaveCount(0);
  });

  test('settings cards degrade silently when limits are empty or failing', async ({ page }) => {
    await openSettings(page, 'empty');
    await expect(page.getByText('Claude Max (personal)')).toBeVisible();
    await expect(page.getByTestId('credential-usage-row')).toHaveCount(0);
    await assertNoOverflow(page);
    await screenshot(page, 'credential-limits-settings-empty', { scopeToProject: true });

    await openSettings(page, 'error');
    await expect(page.getByText('Claude Max (personal)')).toBeVisible();
    await expect(page.getByTestId('credential-usage-row')).toHaveCount(0);
    await assertNoOverflow(page);
  });
}

test.describe('Credential usage limits — Mobile', () => {
  surfaceTests();
});

test.describe('Credential usage limits — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  surfaceTests();
});
