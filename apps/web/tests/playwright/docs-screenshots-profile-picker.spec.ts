/**
 * Documentation screenshots for "Choosing a profile for a new chat" in the agents guide
 * (apps/www/src/content/docs/docs/guides/agents.md): an empty chat asking "Who should take this?"
 * with recent profiles as cards, and the full list behind the composer's **To** control.
 *
 * Drives the REAL project chat page with mocked API data and asserts on what rendered before
 * capturing (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). Stress cases (34
 * profiles, long and unicode names, API failure) live in `new-chat-profile-picker-audit.spec.ts`;
 * these fixtures are a small, ordinary set on purpose.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-profile-picker \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { makeMockUser, seedTheme } from './audit-helpers';
import { docsShot, opaqueBackdrop } from './docs-shot';

const PROJECT_ID = 'proj-docs-picker';
const USER_ID = 'user-docs-picker';
const HOUR = 3_600_000;

const MOCK_USER = makeMockUser({
  email: 'dana@example.com',
  name: 'Dana Reyes',
  sessionId: 'session-docs-picker',
  userId: USER_ID,
});

const PROJECT = {
  id: PROJECT_ID,
  name: 'Payments API',
  repository: 'acme/payments-api',
  defaultBranch: 'main',
  userId: USER_ID,
  githubInstallationId: 'inst-docs',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: '',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
};

function profile(seed: {
  id: string;
  name: string;
  agentType: string;
  model: string;
  effort?: string;
  taskMode?: 'task' | 'conversation';
  description: string;
}) {
  return {
    projectId: PROJECT_ID,
    userId: USER_ID,
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

const PROFILES = [
  profile({
    id: 'p-brainstormer',
    name: 'Brainstormer',
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'max',
    description: 'Talk through ideas and designs before anyone writes code.',
  }),
  profile({
    id: 'p-careful-builder',
    name: 'Careful Builder',
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'high',
    taskMode: 'task',
    description: 'Makes the change, runs the tests and opens a pull request.',
  }),
  profile({
    id: 'p-code-reviewer',
    name: 'Code Reviewer',
    agentType: 'openai-codex',
    model: 'gpt-6-astra',
    effort: 'high',
    description: 'Reviews a branch or pull request and lists what to fix.',
  }),
  profile({
    id: 'p-quick-questions',
    name: 'Quick Questions',
    agentType: 'openai-codex',
    model: 'gpt-6-luna',
    effort: 'medium',
    description: 'Short answers about how the code works.',
  }),
  profile({
    id: 'p-frontend-builder',
    name: 'Frontend Builder',
    agentType: 'claude-code',
    model: 'claude-sonnet-5',
    taskMode: 'task',
    description: 'UI changes with screenshot checks, through to a pull request.',
  }),
  profile({
    id: 'p-release-notes',
    name: 'Release Notes',
    agentType: 'openai-codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    description: 'Writes the changelog entry for what shipped.',
  }),
];

/** Picked by hand in this project recently, newest first. */
const USAGE = ['p-brainstormer', 'p-careful-builder', 'p-code-reviewer'].map(
  (profileId, index) => ({
    profileId,
    lastUsedAt: new Date(Date.now() - (index + 1) * 5 * HOUR).toISOString(),
    chatCount: 9 - index * 3,
  })
);

async function setupMocks(page: Page) {
  await page.addInitScript((id) => {
    localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true');
  }, USER_ID);
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown) => route.fulfill({ json: body });
    if (path.includes('/api/auth/')) return respond(MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond({ notifications: [], unreadCount: 0 });
    // A finished setup, so the navigation shows no "Complete Setup" prompt.
    if (path === '/api/credentials/agent')
      return respond({ credentials: [{ agentType: 'claude-code', isActive: true }] });
    if (path.startsWith('/api/credentials'))
      return respond([{ id: 'cred-docs', provider: 'hetzner', createdAt: '2026-09-01' }]);
    if (path === '/api/github/installations')
      return respond([{ id: 'inst-docs', accountName: 'acme', accountType: 'Organization' }]);
    if (path === '/api/trial/status') return respond({ available: false });
    if (path === '/api/agents')
      return respond({
        agents: [
          { id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true },
          { id: 'openai-codex', name: 'Codex', configured: true, supportsAcp: true },
        ],
      });
    if (path === '/api/workspaces') return respond([]);
    if (path === '/api/projects') return respond({ projects: [PROJECT], nextCursor: null });
    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (match) {
      const sub = match[2] || '';
      if (sub === '/agent-profiles') return respond({ items: PROFILES });
      if (sub === '/agent-profiles/picker')
        return respond({ usageWindowDays: 30, usage: USAGE, hiddenProfileIds: [] });
      if (sub === '/skills') return respond({ items: [] });
      if (sub === '/cached-commands') return respond({ commands: [] });
      if (sub === '/tasks') return respond({ tasks: [], nextCursor: null });
      if (sub === '/sessions') return respond({ sessions: [], total: 0, hasMore: false });
      return respond(PROJECT);
    }
    if (path.startsWith('/api/provider')) return respond({ catalogs: [] });
    return respond({});
  });
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

const toControl = (page: Page) => page.getByRole('button', { name: /^To / });

async function openNewChat(page: Page) {
  await seedTheme(page, 'dark');
  if (isMobile(page)) await page.setViewportSize({ width: 375, height: 812 });
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/chat`);
  await expect(page.locator('textarea[role="combobox"]')).toBeVisible();
  // The profile picked most recently by hand is already chosen.
  await expect(toControl(page)).toContainText('Brainstormer');
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Complete Setup' })).toHaveCount(0);
}

test('docs: a new chat offers recent profiles as cards', async ({ page }) => {
  await openNewChat(page);
  const cards = page.getByRole('region', { name: 'Choose a profile' });
  await expect(page.getByText('Who should take this?')).toBeVisible();
  for (const name of ['Brainstormer', 'Careful Builder', 'Code Reviewer'])
    await expect(cards.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(
    cards.getByText('Talk through ideas and designs before anyone writes code.')
  ).toBeVisible();
  await page.mouse.move(2, 2);
  if (isMobile(page)) {
    await docsShot(page, 'new-chat-profiles-mobile');
    return;
  }
  // On a desktop, keep to the chat column: from just above the question down to the composer.
  const composer = page
    .locator('textarea[role="combobox"]')
    .locator('xpath=ancestor::*[contains(@class, "glass-chrome")][1]');
  const question = (await page.getByText('Who should take this?').boundingBox())!;
  const box = (await composer.boundingBox())!;
  const top = Math.max(0, question.y - 48);
  await docsShot(page, 'new-chat-profiles', {
    clip: { x: box.x, y: top, width: box.width, height: box.y + box.height - top },
  });
});

test('docs: the To control lists every profile', async ({ page }) => {
  // One image serves both widths: the list on a phone is the same, as a sheet from the bottom.
  test.skip(isMobile(page), 'the desktop capture is used for phones too');
  await openNewChat(page);
  await toControl(page).click();
  const sheet = page.getByRole('dialog', { name: 'Choose a profile' });
  await expect(sheet).toBeVisible();
  for (const label of ['Recent', 'Chat & explore', 'Build & open PRs'])
    await expect(sheet.getByText(label, { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Edit list' })).toBeVisible();
  await opaqueBackdrop(page, 'dark');
  await page.mouse.move(2, 2);
  await docsShot(page, 'new-chat-profile-list', sheet);
});
