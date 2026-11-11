/**
 * New-chat composer compute gate, visual + behavioural audit.
 *
 * A user with no cloud account of their own may still send when the installation provides
 * machines (`hasInfraCredential: true`), even with the SAM-managed AI proxy off
 * (`available: false`), which is how every self-hosted box runs. Before the fix the composer
 * refused every send there with "Cloud credentials required". Real ProjectChat page, mocked API.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, getProjectSuffix, makeMockUser, screenshot } from './audit-helpers';

const PROJECT_ID = 'proj-compute-gate';
const USER_ID = 'user-compute-gate';
const GATE_MESSAGE = /Cloud credentials required/;

const MOCK_USER = makeMockUser({
  email: 'member@example.com',
  name: 'Member',
  role: 'user',
  sessionId: 'session-compute-gate',
  userId: USER_ID,
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Self-hosted project',
  repository: 'acme/self-hosted',
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
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};

function makeProfile(id: string, name: string) {
  return {
    id,
    name,
    projectId: PROJECT_ID,
    userId: USER_ID,
    agentType: 'google-antigravity',
    description: 'Default profile for project conversations',
    model: 'gemini-3.8-flash',
    effort: 'auto',
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    resourceRequirementsJson: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: 'full',
    runtime: null,
    devcontainerConfigName: null,
    taskMode: 'conversation',
    githubCliPolicy: null,
    isBuiltin: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
}

const PROFILES = [makeProfile('p-conv', 'Conversation profile')];
const LONG_PROFILES = [
  makeProfile(
    'p-long',
    `Conversation profile with an unusually long name ${'and more words '.repeat(10)}<b>&amp;</b> 🚀`
  ),
];

/** GET /api/trial-status as a self-hosted box answers it (AI proxy off). */
const SELF_HOST_COMPUTE = {
  available: false,
  agentType: null,
  hasInfraCredential: true,
  hasAgentCredential: false,
  dailyTokenBudget: null,
  dailyTokenUsage: null,
};
const NO_COMPUTE = { ...SELF_HOST_COMPUTE, hasInfraCredential: false };

interface Scenario {
  trialStatus: typeof SELF_HOST_COMPUTE;
  profiles: ReturnType<typeof makeProfile>[];
  submits: string[];
}

async function setupMocks(page: Page, scenario: Scenario) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    // No cloud account of the user's own.
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path === '/api/trial-status') return respond(200, scenario.trialStatus);
    if (path === '/api/agents')
      return respond(200, {
        agents: [
          {
            id: 'google-antigravity',
            name: 'Google Antigravity',
            configured: true,
            supportsAcp: true,
          },
        ],
      });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/workspaces') return respond(200, []);
    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (match) {
      const subPath = match[2] || '';
      if (subPath === '/tasks/submit' && request.method() === 'POST') {
        scenario.submits.push(request.postData() ?? '');
        // Hold the submit open: the audit is about the gate, not provisioning.
        return respond(503, { error: 'AUDIT_STOP', message: 'stopped by audit' });
      }
      if (subPath === '/agent-profiles') return respond(200, { items: scenario.profiles });
      if (subPath === '/agent-profiles/picker')
        return respond(200, { usageWindowDays: 30, usage: [], hiddenProfileIds: [] });
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

async function openNewChat(page: Page, scenario: Scenario) {
  await page.addInitScript((userId) => {
    localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER_ID);
  await setupMocks(page, scenario);
  const trialStatusRead = page.waitForResponse((r) => r.url().endsWith('/api/trial-status'));
  await page.goto(`/projects/${PROJECT_ID}/chat`);
  await expect(page.locator('textarea[role="combobox"]')).toBeVisible();
  await trialStatusRead;
  // Let the query result commit before the send.
  await page.waitForTimeout(300);
}

async function send(page: Page, text: string) {
  await page.locator('textarea[role="combobox"]').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

test.describe('New-chat compute gate', () => {
  test('installation machines with the AI proxy off: the send goes out', async ({
    page,
  }, testInfo) => {
    const scenario: Scenario = { trialStatus: SELF_HOST_COMPUTE, profiles: PROFILES, submits: [] };
    await openNewChat(page, scenario);
    await expect(page.getByRole('button', { name: /^To / })).toContainText('Conversation profile');

    await send(page, 'Reply with the single word: hello');

    await expect.poll(() => scenario.submits.length).toBe(1);
    expect(scenario.submits[0]).toContain('Reply with the single word: hello');
    await expect(page.getByText(GATE_MESSAGE)).toHaveCount(0);
    await screenshot(
      page,
      `new-chat-compute-gate-installation-${getProjectSuffix(testInfo.project.name)}`
    );
    await assertNoOverflow(page);
  });

  test('long profile name and long prompt stay inside the screen', async ({ page }, testInfo) => {
    const scenario: Scenario = {
      trialStatus: SELF_HOST_COMPUTE,
      profiles: LONG_PROFILES,
      submits: [],
    };
    await openNewChat(page, scenario);
    const prompt = `Check https://example.com/${'very-long-path-segment-'.repeat(12)} ${'and wrap '.repeat(60)}`;
    await page.locator('textarea[role="combobox"]').fill(prompt);
    await screenshot(page, `new-chat-compute-gate-long-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => scenario.submits.length).toBe(1);
    await expect(page.getByText(GATE_MESSAGE)).toHaveCount(0);
  });

  test('no user cloud account and no installation machines: the gate message shows', async ({
    page,
  }, testInfo) => {
    const scenario: Scenario = { trialStatus: NO_COMPUTE, profiles: PROFILES, submits: [] };
    await openNewChat(page, scenario);
    // Liveness: the composer and its profile rendered, so a missing submit is the gate.
    await expect(page.getByRole('button', { name: /^To / })).toContainText('Conversation profile');

    await send(page, 'Reply with the single word: hello');

    await expect(page.getByText(GATE_MESSAGE)).toBeVisible();
    expect(scenario.submits).toHaveLength(0);
    await screenshot(
      page,
      `new-chat-compute-gate-refused-${getProjectSuffix(testInfo.project.name)}`
    );
    await assertNoOverflow(page);
  });
});
