/**
 * New-chat profile picker visual audit (idea 01M5EW9H86VD88S7E3WWA1D9X1).
 *
 * Real ProjectChat page with mocked API data: recent profile cards in the empty canvas,
 * the composer's "To" control, the picker sheet (search, edit mode, hidden profiles)
 * and the Chat options panel, at every configured viewport plus a keyboard-open phone.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, getProjectSuffix, makeMockUser, screenshot } from './audit-helpers';

const PROJECT_ID = 'proj-picker-1';
const USER_ID = 'user-test-1';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: USER_ID,
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Picker Audit Project',
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

type ProfileSeed = {
  id: string;
  name: string;
  agentType: string;
  model?: string | null;
  effort?: string;
  taskMode?: string | null;
  description?: string | null;
  runtime?: string | null;
};

function makeProfile(seed: ProfileSeed) {
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

/** Fifteen profiles shaped like a real heavy user's: chat brains, variants, builders, automation. */
const FIFTEEN = [
  makeProfile({
    id: 'p-astra-high',
    name: 'Astra High',
    agentType: 'openai-codex',
    model: 'gpt-6-astra',
    effort: 'high',
  }),
  makeProfile({
    id: 'p-backend',
    name: 'Backend Implementation',
    agentType: 'openai-codex',
    model: 'gpt-6-sol',
    effort: 'low',
    taskMode: 'task',
    description: 'Write code and open pull requests focused on backend tasks.',
  }),
  makeProfile({
    id: 'p-fable',
    name: 'Fable chat',
    agentType: 'claude-code',
    model: 'claude-fable-5-1',
    effort: 'xhigh',
  }),
  makeProfile({
    id: 'p-frontend',
    name: 'Frontend Implementation',
    agentType: 'claude-code',
    model: 'claude-opus-5',
    taskMode: 'task',
    description: 'UI work with screenshot checks, through to a pull request.',
  }),
  makeProfile({
    id: 'p-luna',
    name: 'Quick Questions',
    agentType: 'openai-codex',
    model: 'gpt-6-luna',
    effort: 'medium',
  }),
  makeProfile({
    id: 'p-astra-low',
    name: 'Astra Fast',
    agentType: 'openai-codex',
    model: 'gpt-6-astra',
    effort: 'low',
  }),
  makeProfile({ id: 'p-oc', name: 'OC', agentType: 'opencode', model: 'opencode-go/kimi-k3' }),
  makeProfile({
    id: 'p-opus',
    name: 'Opus 5.5 Chat',
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'max',
    description: 'Careful reviews, UX audits and design critique.',
  }),
  makeProfile({
    id: 'p-cto',
    name: 'Picky CTO',
    agentType: 'openai-codex',
    model: 'gpt-6-astra',
    effort: 'low',
  }),
  makeProfile({
    id: 'p-launch',
    name: 'Launch Copy',
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
  }),
  makeProfile({
    id: 'p-security',
    name: 'Security Review',
    agentType: 'opencode',
    model: 'opencode-go/kimi-k3',
  }),
  makeProfile({
    id: 'p-sol',
    name: 'Sol',
    agentType: 'openai-codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    runtime: 'vm',
  }),
  makeProfile({
    id: 'p-sol-mid',
    name: 'Sol Mid Chat',
    agentType: 'openai-codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
  }),
  makeProfile({
    id: 'p-staging',
    name: 'Staging Validator',
    agentType: 'claude-code',
    model: 'claude-opus-5',
    effort: 'high',
    taskMode: 'task',
  }),
  makeProfile({ id: 'p-tiny', name: 'Tiny Chat', agentType: 'openai-codex', model: 'gpt-6-luna' }),
];

const RECENT_USAGE = ['p-opus', 'p-sol', 'p-astra-high', 'p-astra-low'].map((profileId, index) => ({
  profileId,
  lastUsedAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
  chatCount: 12 - index * 3,
}));

/** Stress set: 34 profiles, 200-character names, unicode, HTML-looking text, one-letter names. */
const STRESS = [
  ...FIFTEEN,
  makeProfile({
    id: 's-long',
    name: `Extremely long profile name ${'with many words '.repeat(12)}end`,
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    description: `A description that keeps going ${'and going '.repeat(40)} https://example.com/${'very-long-path-segment-'.repeat(8)}`,
  }),
  makeProfile({
    id: 's-unicode',
    name: '部署 π — Ünïcödé 🚀',
    agentType: 'openai-codex',
    model: 'gpt-6.1-sol',
  }),
  makeProfile({ id: 's-html', name: '<script>alert(1)</script> & co', agentType: 'opencode' }),
  makeProfile({ id: 's-x', name: 'X', agentType: 'claude-code' }),
  ...Array.from({ length: 15 }, (_, index) =>
    makeProfile({
      id: `s-gen-${index}`,
      name: `Generated profile ${index + 1}`,
      agentType: index % 2 ? 'openai-codex' : 'claude-code',
    })
  ),
];

const SKILLS = [
  {
    ...makeProfile({ id: 'skill-do', name: 'do', agentType: 'claude-code' }),
    agentType: null,
    effort: null,
    defaultProfileId: null,
    description: 'End-to-end task execution.',
  },
];

interface Scenario {
  profiles: ReturnType<typeof makeProfile>[];
  picker?: { usage: typeof RECENT_USAGE; hiddenProfileIds: string[] } | 'error';
}

async function setupMocks(page: Page, scenario: Scenario) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials'))
      return respond(200, [
        { id: 'cred-1', provider: 'hetzner', name: 'Hetzner', createdAt: Date.now() },
      ]);
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
      if (subPath === '/agent-profiles') return respond(200, { items: scenario.profiles });
      if (subPath === '/agent-profiles/picker') {
        if (scenario.picker === 'error')
          return respond(500, { error: 'INTERNAL_ERROR', message: 'boom' });
        return respond(200, {
          usageWindowDays: 30,
          ...(scenario.picker ?? { usage: [], hiddenProfileIds: [] }),
        });
      }
      if (subPath === '/skills') return respond(200, { items: SKILLS });
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
  await page.goto(`/projects/${PROJECT_ID}/chat`);
  await expect(page.locator('textarea[role="combobox"]')).toBeVisible();
}

const toControl = (page: Page) => page.getByRole('button', { name: /^To / });
const cards = (page: Page) => page.getByRole('region', { name: 'Choose a profile' });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Choose a profile' });

/** The toolbar controls replace chips; on a phone each must stay a 44px touch target. */
async function assertToolbarTouchTargets(page: Page) {
  const controls = [
    toControl(page),
    page.getByRole('button', { name: 'Attach files to this task' }),
    page.getByRole('button', { name: /^Chat options/ }),
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
}

/**
 * Every card must be wide enough to read its name. Columns follow the chat area, which
 * is ~250px on a tablet beside two sidebars; screen breakpoints crushed the cards there.
 */
async function assertCardsReadable(page: Page, minWidthPx = 140) {
  const profileCards = cards(page).locator('button[aria-pressed]');
  const count = await profileCards.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const box = await profileCards.nth(index).boundingBox();
    // Hidden builder cards have no box; every rendered card must be readable.
    if (box) expect(box.width).toBeGreaterThanOrEqual(minWidthPx);
  }
}

async function composerShareOfViewport(page: Page): Promise<number> {
  return page.evaluate(() => {
    const textarea = document.querySelector('textarea[role="combobox"]');
    const root = textarea?.closest('.glass-chrome');
    const box = root?.getBoundingClientRect();
    return box ? box.height / window.innerHeight : 1;
  });
}

test.describe('New-chat profile picker', () => {
  test('15 profiles: recent cards, last-used default, compact composer', async ({
    page,
  }, testInfo) => {
    await openNewChat(page, {
      profiles: FIFTEEN,
      picker: { usage: RECENT_USAGE, hiddenProfileIds: [] },
    });

    await expect(toControl(page)).toContainText('Opus 5.5 Chat');
    await expect(cards(page).getByText('Recent')).toBeVisible();
    for (const name of ['Opus 5.5 Chat', 'Sol', 'Astra High', 'Astra Fast']) {
      await expect(cards(page).getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(cards(page).getByRole('button', { name: 'All 15 profiles' })).toBeVisible();
    await assertCardsReadable(page);
    // Acceptance: the composer no longer dominates a phone screen.
    if ((page.viewportSize()?.width ?? 0) <= 390) {
      expect(await composerShareOfViewport(page)).toBeLessThanOrEqual(0.25);
      await assertToolbarTouchTargets(page);
    }
    await screenshot(page, `new-chat-picker-cards-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);

    await cards(page).getByRole('button', { name: /^Sol/ }).first().click();
    await expect(toControl(page)).toContainText('Sol');
  });

  test('picker sheet: sections, search, edit mode and options', async ({ page }, testInfo) => {
    await openNewChat(page, {
      profiles: FIFTEEN,
      picker: { usage: RECENT_USAGE, hiddenProfileIds: [] },
    });
    const suffix = getProjectSuffix(testInfo.project.name);

    await toControl(page).click();
    await expect(sheet(page)).toBeVisible();
    for (const label of ['Recent', 'Chat & explore', 'Build & open PRs']) {
      await expect(sheet(page).getByText(label, { exact: true })).toBeVisible();
    }
    await screenshot(page, `new-chat-picker-sheet-${suffix}`);
    await assertNoOverflow(page);

    await sheet(page).getByRole('searchbox', { name: 'Search profiles' }).fill('astra');
    await expect(sheet(page).getByRole('button', { name: /^Astra High/ })).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: /^Opus/ })).toHaveCount(0);
    await screenshot(page, `new-chat-picker-search-${suffix}`);
    await sheet(page).getByRole('searchbox', { name: 'Search profiles' }).fill('');

    await sheet(page).getByRole('button', { name: 'Edit list' }).click();
    await expect(sheet(page).getByText(/11 profiles you haven’t picked in 30 days/)).toBeVisible();
    await screenshot(page, `new-chat-picker-edit-${suffix}`);
    await assertNoOverflow(page);
    await sheet(page).getByRole('button', { name: 'Close' }).click();
    await expect(sheet(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Chat options' }).click();
    await expect(page.getByLabel('Skill', { exact: true })).toBeVisible();
    await screenshot(page, `new-chat-picker-options-${suffix}`);
    await assertNoOverflow(page);
  });

  test('keyboard-open phone keeps the profile and message box visible', async ({
    page,
  }, testInfo) => {
    test.skip((page.viewportSize()?.width ?? 0) > 430, 'phone-only scenario');
    await page.setViewportSize({ width: 375, height: 400 });
    await openNewChat(page, {
      profiles: FIFTEEN,
      picker: { usage: RECENT_USAGE, hiddenProfileIds: [] },
    });

    const textarea = page.locator('textarea[role="combobox"]');
    await textarea.fill('Fix the flaky provisioning test in the task runner and open a PR');
    const textBox = await textarea.boundingBox();
    const toBox = await toControl(page).boundingBox();
    expect(textBox && textBox.y >= 0 && textBox.y + textBox.height <= 400).toBe(true);
    expect(toBox && toBox.y >= 0 && toBox.y + toBox.height <= 400).toBe(true);
    await screenshot(page, `new-chat-picker-keyboard-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });

  test('one profile keeps the starter prompts', async ({ page }, testInfo) => {
    await openNewChat(page, { profiles: [FIFTEEN[7]!] });

    await expect(toControl(page)).toContainText('Opus 5.5 Chat');
    await expect(page.getByText('What do you want to build?')).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    await screenshot(page, `new-chat-picker-single-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });

  test('no recent chats shows the first profiles', async ({ page }, testInfo) => {
    await openNewChat(page, { profiles: FIFTEEN });

    await expect(cards(page).getByText('Your profiles')).toBeVisible();
    await expect(toControl(page)).toContainText('Astra High');
    await screenshot(page, `new-chat-picker-no-usage-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });

  test('34 profiles with long, unicode and HTML-looking names stay inside the screen', async ({
    page,
  }, testInfo) => {
    await openNewChat(page, {
      profiles: STRESS,
      picker: {
        usage: ['s-long', 's-unicode', 's-html', 's-x'].map((profileId, index) => ({
          ...RECENT_USAGE[0]!,
          profileId,
          lastUsedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
        })),
        hiddenProfileIds: [],
      },
    });
    const suffix = getProjectSuffix(testInfo.project.name);

    await expect(cards(page).getByRole('button', { name: /^部署 π/ })).toBeVisible();
    await expect(cards(page).getByText('<script>alert(1)</script> & co')).toBeVisible();
    await assertCardsReadable(page);
    await screenshot(page, `new-chat-picker-stress-cards-${suffix}`);
    await assertNoOverflow(page);

    await toControl(page).click();
    await expect(sheet(page)).toBeVisible();
    await screenshot(page, `new-chat-picker-stress-sheet-${suffix}`);
    await assertNoOverflow(page);
  });

  test('hidden profiles leave the cards and wait at the end of the sheet', async ({
    page,
  }, testInfo) => {
    await openNewChat(page, {
      profiles: FIFTEEN,
      picker: { usage: RECENT_USAGE, hiddenProfileIds: ['p-sol', 'p-tiny', 'p-oc'] },
    });

    await expect(cards(page).getByRole('button', { name: /^Opus/ })).toBeVisible();
    await expect(cards(page).getByRole('button', { name: /^Sol\b/ })).toHaveCount(0);
    await toControl(page).click();
    const hiddenToggle = sheet(page).getByRole('button', { name: /Hidden from new chat \(3\)/ });
    await hiddenToggle.scrollIntoViewIfNeeded();
    await hiddenToggle.click();
    const hiddenRow = sheet(page).getByRole('button', { name: /^Tiny Chat/ });
    await expect(hiddenRow).toBeVisible();
    await hiddenRow.scrollIntoViewIfNeeded();
    await screenshot(page, `new-chat-picker-hidden-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });

  test('picker API failure falls back without breaking the screen', async ({ page }, testInfo) => {
    await openNewChat(page, { profiles: FIFTEEN, picker: 'error' });

    await expect(toControl(page)).toContainText('Astra High');
    await expect(cards(page).getByText('Your profiles')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Something went wrong');
    await screenshot(page, `new-chat-picker-error-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });
});
