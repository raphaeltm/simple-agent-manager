/**
 * Usage left on profiles in the new-chat picker, through the real ProjectChat page.
 *
 * Accounts, profile pins and usage limits are served as the API returns them, so which
 * account each profile runs on is resolved by the real account model, as in production:
 * Opus 5.5 Chat runs on the default Claude account (Sam Support, 5h at 94%), Claudiii is
 * pinned to Sam Sam (17%), SamSamC to Sam Social (5h refused) and Codex profiles to the
 * default Codex account.
 */
import { expect, type Page, type Route, test } from '@playwright/test';
import type {
  CCProfileAttachmentItem,
  CredentialLimitCredentialSummary,
  CredentialLimitLevel,
  CredentialLimitWindowSummary,
} from '@simple-agent-manager/shared';

import { accountRows, mergeRows } from '../unit/components/accounts/fixtures';
import {
  assertNoOverflow,
  expectTheme,
  getProjectSuffix,
  makeMockUser,
  screenshot,
  seedTheme,
} from './audit-helpers';

const PROJECT_ID = 'proj-usage-1';
const USER_ID = 'user-usage-1';
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  sessionId: 'session-usage-1',
  userId: USER_ID,
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Usage Audit Project',
  repository: 'acme/payments-api',
  defaultBranch: 'main',
  userId: USER_ID,
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: '',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

function makeProfile(seed: {
  id: string;
  name: string;
  agentType: string;
  model?: string | null;
  effort?: string;
  taskMode?: string;
}) {
  return {
    projectId: PROJECT_ID,
    userId: USER_ID,
    description: null,
    model: null,
    effort: 'auto',
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    resourceRequirementsJson: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: 'lightweight',
    runtime: null,
    devcontainerConfigName: null,
    taskMode: 'conversation',
    githubCliPolicy: null,
    isBuiltin: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...seed,
  };
}

const OPUS = { agentType: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };
const LONG_NAME = `Overnight-Migration-Reviewer-With-An-Unbroken-Name-${'x'.repeat(80)}`;

const PROFILES = [
  makeProfile({ id: 'p-opus', name: 'Opus 5.5 Chat', ...OPUS }),
  makeProfile({
    id: 'p-astra',
    name: 'Astra High',
    agentType: 'openai-codex',
    model: 'gpt-6-astra',
  }),
  makeProfile({ id: 'p-oc', name: 'OC', agentType: 'opencode', model: 'opencode-go/kimi-k3' }),
  makeProfile({ id: 'p-samsamc', name: 'SamSamC', ...OPUS }),
  makeProfile({ id: 'p-claudiii', name: 'Claudiii', ...OPUS }),
  makeProfile({
    id: 'p-fable',
    name: 'Fable chat',
    agentType: 'claude-code',
    model: 'claude-fable-5-1',
  }),
  makeProfile({ id: 'p-long', name: LONG_NAME, ...OPUS, taskMode: 'task' }),
  makeProfile({
    id: 'p-sol',
    name: 'Backend Implementation',
    agentType: 'openai-codex',
    taskMode: 'task',
  }),
];

const RECENT = ['p-opus', 'p-astra', 'p-oc', 'p-samsamc', 'p-long'].map((profileId, index) => ({
  profileId,
  lastUsedAt: new Date(NOW - (index + 1) * HOUR).toISOString(),
  chatCount: 10 - index,
}));

const ROWS = mergeRows(
  accountRows({
    id: 'support',
    name: 'Sam Support',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    isDefault: true,
  }),
  accountRows({
    id: 'samsam',
    name: 'Sam Sam',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
  }),
  accountRows({
    id: 'social',
    name: 'Sam Social',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
  }),
  accountRows({
    id: 'codex',
    name: 'Work ChatGPT',
    kind: 'agent',
    target: 'openai-codex',
    credentialKind: 'oauth-token',
    isDefault: true,
  })
);

function pin(profileId: string, profileName: string, account: string): CCProfileAttachmentItem {
  return {
    id: `pin-${profileId}`,
    configurationId: `cfg-${account}`,
    agentProfileId: profileId,
    profileName,
    projectId: PROJECT_ID,
    projectName: MOCK_PROJECT.name,
    consumerKind: 'agent',
    consumerTarget: 'claude-code',
    isActive: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const PINS = [pin('p-claudiii', 'Claudiii', 'samsam'), pin('p-samsamc', 'SamSamC', 'social')];

function limitWindow(
  windowType: string,
  utilizationPercent: number,
  level: CredentialLimitLevel,
  resetsInMs: number,
  now: number
): CredentialLimitWindowSummary {
  return {
    windowType,
    provider: windowType.startsWith('claude') ? 'anthropic' : 'openai',
    source: 'mock',
    status: level === 'rejected' ? 'rejected' : level === 'ok' ? 'allowed' : 'allowed_warning',
    level,
    utilizationPercent,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes: windowType.endsWith('five_hour') ? 300 : 10080,
    resetsAt: now + resetsInMs,
    observedAt: now - 2 * MIN,
    updatedAt: now - 2 * MIN,
  };
}

function usage(
  credentialId: string,
  agentType: string,
  windows: CredentialLimitWindowSummary[]
): CredentialLimitCredentialSummary {
  return {
    credentialReference: `cc_credentials:${credentialId}`,
    credentialId,
    credentialName: null,
    credentialSource: 'user',
    provider: windows[0]!.provider,
    providerMode: 'oauth',
    agentType,
    level: 'ok',
    observedAt: Math.max(...windows.map((window) => window.observedAt)),
    windows,
  };
}

/**
 * Reset times are relative to the response, with 30s of slack, so the countdowns read
 * 53m and 2h 10m however long the run takes (minutes round up, hours' minutes down).
 */
function limits(now: number) {
  return [
    usage('cred-support', 'claude-code', [
      limitWindow('claude.five_hour', 94, 'critical', 52 * MIN + 30_000, now),
      limitWindow('claude.seven_day', 69, 'ok', 7 * HOUR, now),
    ]),
    usage('cred-samsam', 'claude-code', [
      limitWindow('claude.five_hour', 17, 'ok', HOUR, now),
      limitWindow('claude.seven_day', 9, 'ok', 100 * HOUR, now),
    ]),
    usage('cred-social', 'claude-code', [
      limitWindow('claude.five_hour', 100, 'rejected', 2 * HOUR + 10 * MIN + 30_000, now),
      limitWindow('claude.seven_day', 56, 'ok', 4 * HOUR, now),
    ]),
    usage('cred-codex', 'openai-codex', [limitWindow('codex.primary', 40, 'ok', 50 * HOUR, now)]),
  ];
}

async function setupMocks(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/cc/credentials') return respond(200, { credentials: ROWS.credentials });
    if (path === '/api/cc/configurations')
      return respond(200, { configurations: ROWS.configurations });
    if (path === '/api/cc/attachments') return respond(200, { attachments: ROWS.attachments });
    if (path === '/api/cc/profile-attachments') return respond(200, { attachments: PINS });
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path === '/api/credentials/limits')
      return respond(200, { credentials: limits(Date.now()), generatedAt: Date.now() });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials'))
      return respond(200, [{ id: 'cred-1', provider: 'hetzner', name: 'Hetzner', createdAt: NOW }]);
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/agents')
      return respond(200, {
        agents: [
          { id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true },
          { id: 'openai-codex', name: 'Codex', configured: true, supportsAcp: true },
          { id: 'opencode', name: 'OpenCode', configured: true, supportsAcp: true },
        ],
      });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/workspaces') return respond(200, []);
    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (match) {
      const subPath = match[2] || '';
      if (subPath === '/agent-profiles') return respond(200, { items: PROFILES });
      if (subPath === '/agent-profiles/picker')
        return respond(200, { usageWindowDays: 30, usage: RECENT, hiddenProfileIds: [] });
      if (subPath === '/skills') return respond(200, { items: [] });
      if (subPath === '/cached-commands') return respond(200, { commands: [] });
      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
      if (subPath === '/sessions') return respond(200, { sessions: [], total: 0, hasMore: false });
      return respond(200, MOCK_PROJECT);
    }
    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    if (path.startsWith('/api/provider')) return respond(200, { catalogs: [] });
    return respond(200, {});
  });
}

async function openNewChat(page: Page) {
  await page.addInitScript((userId) => {
    localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER_ID);
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/chat`);
  await expect(page.locator('textarea[role="combobox"]')).toBeVisible();
}

const toControl = (page: Page) => page.getByRole('button', { name: /^To / });
const cards = (page: Page) => page.getByRole('region', { name: 'Choose a profile' });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Choose a profile' });
const nudge = (page: Page) => page.getByTestId('profile-usage-nudge');

test.describe('New-chat picker: usage left on profiles', () => {
  test('cards, To chip and nudge show what is left, and the nudge switches profile', async ({
    page,
  }, testInfo) => {
    await openNewChat(page);
    const suffix = getProjectSuffix(testInfo.project.name);

    // Opus runs on the default Claude account, 94% into its 5h window.
    const opusCard = cards(page).getByRole('button', { name: /^Opus 5\.5 Chat/ });
    await expect(opusCard.getByText('6% left · resets 53m')).toBeVisible();
    await expect(opusCard.getByTestId('profile-usage-ring')).toHaveAttribute(
      'data-usage-left',
      '6'
    );
    // SamSamC's pin points at the refused account.
    const outCard = cards(page).getByRole('button', { name: /^SamSamC/ });
    await expect(outCard.getByText('Out · back in 2h 10m')).toBeVisible();
    // A Codex profile with room: ring only, no words.
    const astraCard = cards(page).getByRole('button', { name: /^Astra High/ });
    await expect(astraCard).toHaveAccessibleName(/60% left$/);
    await expect(astraCard.getByTestId('profile-usage-notice')).toHaveCount(0);

    await expect(toControl(page)).toHaveAccessibleName(/^To Opus 5\.5 Chat, 6% left/);
    await expect(nudge(page)).toContainText('6% left on Sam Support · resets in 53m');
    const switchButton = nudge(page).getByRole('button', { name: 'Use Claudiii · 83% left' });
    await expect(switchButton).toBeVisible();
    await screenshot(page, `new-chat-usage-cards-${suffix}`);
    await assertNoOverflow(page);

    await switchButton.click();
    await expect(toControl(page)).toHaveAccessibleName(/^To Claudiii, 83% left/);
    await expect(toControl(page).getByTestId('profile-usage-ring')).toHaveAttribute(
      'data-usage-left',
      '83'
    );
    await expect(nudge(page)).toHaveCount(0);
  });

  test('the sheet folds exhausted profiles into "Out for now"', async ({ page }, testInfo) => {
    await openNewChat(page);
    const suffix = getProjectSuffix(testInfo.project.name);

    await toControl(page).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: /^Claudiii/ })).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: /^SamSamC/ })).toHaveCount(0);
    await screenshot(page, `new-chat-usage-sheet-${suffix}`);
    await assertNoOverflow(page);

    const fold = sheet(page).getByRole('button', { name: 'Out for now (1)' });
    await fold.scrollIntoViewIfNeeded();
    await fold.click();
    const outRow = sheet(page).getByRole('button', { name: /^SamSamC/ });
    await outRow.scrollIntoViewIfNeeded();
    await expect(outRow).toContainText('Out');
    await expect(outRow).toContainText('back in 2h 10m');
    await screenshot(page, `new-chat-usage-sheet-out-${suffix}`);
    await assertNoOverflow(page);

    await outRow.click();
    await expect(toControl(page)).toHaveAccessibleName(/^To SamSamC, Out · back in 2h 10m/);
    await expect(nudge(page)).toContainText('Out on Sam Social · back in 2h 10m');
    await expect(
      nudge(page).getByRole('button', { name: 'Use Claudiii · 83% left' })
    ).toBeVisible();
    await screenshot(page, `new-chat-usage-out-selected-${suffix}`);
    await assertNoOverflow(page);
  });

  test('light theme: rings, words and nudge stay legible', async ({ page }, testInfo) => {
    await seedTheme(page, 'light');
    await openNewChat(page);
    await expectTheme(page, 'light');
    const suffix = getProjectSuffix(testInfo.project.name);

    await expect(
      cards(page)
        .getByRole('button', { name: /^Opus 5\.5 Chat/ })
        .getByText('6% left · resets 53m')
    ).toBeVisible();
    await expect(nudge(page)).toBeVisible();
    await screenshot(page, `new-chat-usage-cards-light-${suffix}`);
    await assertNoOverflow(page);

    await toControl(page).click();
    await sheet(page).getByRole('button', { name: 'Out for now (1)' }).click();
    await expect(sheet(page).getByRole('button', { name: /^SamSamC/ })).toBeVisible();
    await screenshot(page, `new-chat-usage-sheet-light-${suffix}`);
    await assertNoOverflow(page);
  });
});
