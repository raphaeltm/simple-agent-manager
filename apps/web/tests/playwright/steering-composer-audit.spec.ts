import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, seedTheme } from './audit-helpers';

// ---------------------------------------------------------------------------
// Live steering in the REAL project chat: the Steer now / Queue next choice the
// composer offers while the agent works, and the delivery chip under a message
// sent with Steer now, in every state the server can report. The working state
// comes from the session detail's `state.activity === 'prompting'`, as in
// production; chip states come from the transcript row metadata the server writes
// (`deliveryIntent: 'steer'` + `steerOutcome`/`steerReason`).
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const MOCK_CLOUD_CREDENTIALS = [
  {
    id: 'cred-cloud-1',
    provider: 'hetzner',
    connected: true,
    createdAt: '2026-01-01T00:00:00Z',
  },
];

const MOCK_AGENT_CREDENTIALS = {
  credentials: [
    {
      agentType: 'claude-code',
      provider: 'anthropic',
      credentialKind: 'api-key',
      isActive: true,
      maskedKey: 'sk-ant-••••test',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
};

const MOCK_GITHUB_INSTALLATIONS = [
  {
    id: 'gh-inst-1',
    userId: 'user-test-1',
    installationId: 'inst-1',
    accountType: 'personal',
    accountName: 'testuser',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const NOW = Date.now();
const LONG_URL =
  'https://github.com/testuser/test-repo/blob/main/packages/importer/src/very/deeply/nested/path/to/the/module-that-needs-refactoring.ts';

function makeSession() {
  return {
    id: 'session-1',
    workspaceId: 'ws-1',
    taskId: null,
    topic: 'Refactor the importer',
    status: 'active',
    messageCount: 12,
    startedAt: NOW - 600000,
    endedAt: null,
    createdAt: NOW - 600000,
    lastMessageAt: NOW - 5000,
    isIdle: false,
    agentCompletedAt: null,
    isTerminated: false,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: 'agent-sess-1',
    viewerAccess: 'owner',
    agentType: 'claude-code',
    task: null,
  };
}

function makeWorkspace() {
  return {
    id: 'ws-1',
    nodeId: 'node-1',
    projectId: MOCK_PROJECT.id,
    name: 'test-workspace',
    displayName: 'Test workspace',
    repository: MOCK_PROJECT.repository,
    branch: 'main',
    status: 'running',
    vmSize: 'cx22',
    vmLocation: 'fsn1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    vmIp: '203.0.113.10',
    lastActivityAt: new Date(NOW - 30000).toISOString(),
    portsPublicEnabled: false,
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: new Date(NOW).toISOString(),
    url: null,
    bootLogs: [],
    chatSessionId: 'session-1',
  };
}

const steer = (outcome: Record<string, unknown> = {}) => ({
  kind: 'durable_prompt_delivery',
  source: 'user_followup',
  deliveryId: `d-${Math.random().toString(36).slice(2)}`,
  deliveryIntent: 'steer',
  ...outcome,
});

const ROWS: Array<{ role: string; content: string; toolMetadata: Record<string, unknown> | null }> =
  [
    {
      role: 'user',
      content: 'Refactor the importer so it streams rows instead of buffering.',
      toolMetadata: null,
    },
    {
      role: 'assistant',
      content:
        'Starting with the reader: I will swap the buffered parse for a streaming one, then update the callers.',
      toolMetadata: null,
    },
    {
      role: 'user',
      content: 'Use tabs, not spaces.',
      toolMetadata: steer({ steerOutcome: 'steered' }),
    },
    {
      role: 'assistant',
      content: 'Noted, switching indentation to tabs for the files I touch.',
      toolMetadata: null,
    },
    {
      role: 'user',
      content: 'Also keep the old API exported for one release.',
      toolMetadata: steer({ steerOutcome: 'queued_fallback', steerReason: 'no_running_turn' }),
    },
    {
      role: 'user',
      content: `Check ${LONG_URL} before you change the signature — it has callers outside this package that the type checker will not see because they import through the compiled dist bundle.`,
      toolMetadata: steer({
        steerOutcome: 'queued_fallback',
        steerReason: 'runtime_steering_unsupported',
      }),
    },
    {
      role: 'user',
      content: 'Skip the Windows path handling for now 🙂 <script>alert(1)</script>',
      toolMetadata: steer({ steerOutcome: 'unconfirmed', steerReason: 'runtime_changed' }),
    },
    {
      role: 'user',
      content: 'x',
      toolMetadata: steer({ steerOutcome: 'failed', steerReason: 'terminal_target' }),
    },
    {
      role: 'user',
      content: 'And add a regression test for the 10k-row file.',
      toolMetadata: steer(),
    },
  ];

const MESSAGES = ROWS.map((row, i) => ({
  id: `msg-${i}`,
  sessionId: 'session-1',
  role: row.role,
  content: row.content,
  toolMetadata: row.toolMetadata,
  createdAt: NOW - (ROWS.length - i) * 10000,
  sequence: i + 1,
}));

function chatState(working: boolean) {
  return {
    activity: working ? 'prompting' : 'idle',
    activityAt: NOW,
    statusError: null,
    currentPlan: null,
    planUpdatedAt: null,
    promptStartedAt: working ? NOW - 45000 : null,
    agentType: 'claude-code',
    lastStopReason: null,
  };
}

async function setupApiMocks(page: Page, opts: { working: boolean }) {
  const prompts: Array<Record<string, unknown>> = [];
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/credentials/agent') return respond(200, MOCK_AGENT_CREDENTIALS);
    if (path.startsWith('/api/credentials')) return respond(200, MOCK_CLOUD_CREDENTIALS);
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/github/installations') return respond(200, MOCK_GITHUB_INSTALLATIONS);
    if (path === '/api/workspaces') return respond(200, [makeWorkspace()]);

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      const session = makeSession();
      if (subPath === '/sessions') {
        return respond(200, { sessions: [session], total: 1, hasMore: false });
      }
      if (subPath.match(/^\/sessions\/[^/]+\/prompt$/)) {
        prompts.push(route.request().postDataJSON() as Record<string, unknown>);
        return respond(202, { accepted: true, status: 'queued' });
      }
      if (subPath.match(/^\/sessions\/[^/]+$/)) {
        return respond(200, {
          session,
          messages: MESSAGES,
          hasMore: false,
          state: chatState(opts.working),
        });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        return respond(200, { messages: [], hasMore: false });
      }
      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath.match(/\/commands/)) return respond(200, { commands: [] });
      return respond(200, MOCK_PROJECT);
    }
    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    return respond(404, { error: 'UNMOCKED_API_ROUTE', path });
  });
  return { prompts };
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(700);
  await page.screenshot({
    path: `../../.tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function gotoChat(page: Page) {
  await page.goto('/projects/proj-test-1/chat/session-1');
  await expect(page.getByTestId('user-message-delivery').last()).toBeVisible();
}

/** The list is virtualized: scroll it top to bottom and collect every chip it mounts, in row order. */
async function collectChipLabels(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="virtuoso-scroller"]');
    if (!scroller) throw new Error('no virtualized scroller');
    const byRow = new Map<number, string>();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
    scroller.scrollTop = 0;
    await settle();
    for (let step = 0; step < 80; step++) {
      for (const chip of document.querySelectorAll<HTMLElement>(
        '[data-testid="user-message-delivery"]'
      )) {
        const row = Number(chip.closest('[data-index]')?.getAttribute('data-index'));
        const label = chip.querySelector('[data-testid="user-message-delivery-label"]');
        byRow.set(row, (label?.textContent ?? '').trim());
      }
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
      scroller.scrollTop += scroller.clientHeight / 2;
      await settle();
    }
    return [...byRow.entries()].sort((x, y) => x[0] - y[0]).map(([, label]) => label);
  });
}

/** Scroll the virtualized list top-down until a row containing `text` is mounted. */
async function scrollUntilMounted(page: Page, text: string): Promise<void> {
  const found = await page.evaluate(async (needle) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="virtuoso-scroller"]');
    if (!scroller) return false;
    scroller.scrollTop = 0;
    for (let step = 0; step < 80; step++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const row = [...scroller.querySelectorAll<HTMLElement>('[data-index]')].find((el) =>
        (el.textContent ?? '').includes(needle)
      );
      if (row) {
        row.scrollIntoView({ block: 'center' });
        return true;
      }
      scroller.scrollTop += scroller.clientHeight / 2;
    }
    return false;
  }, text);
  expect(found).toBe(true);
}

const deliveryGroup = (page: Page) =>
  page.getByRole('group', { name: 'When to deliver your message' });
const composer = (page: Page) => page.getByPlaceholder(/^(Agent is working|Send a message)\.\.\.$/);

for (const theme of ['dark', 'light'] as const) {
  for (const viewport of ['mobile', 'desktop'] as const) {
    test.describe(`Live steering — ${theme} — ${viewport}`, () => {
      if (viewport === 'desktop') {
        test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });
      } else {
        test.use({ viewport: { width: 375, height: 667 }, isMobile: true });
      }

      test('every delivery chip state, and the steer choice while working', async ({ page }) => {
        await seedTheme(page, theme);
        await setupApiMocks(page, { working: true });
        await gotoChat(page);
        await screenshot(page, `steering-chips-bottom-${theme}-${viewport}`);
        expect(await collectChipLabels(page)).toEqual([
          'Added to current turn',
          'Sent as next message · turn had ended',
          "Sent as next message · agent can't steer",
          'Delivery unconfirmed',
          'Not delivered',
          'Steering…',
        ]);
        await page.evaluate(() => {
          const scroller = document.querySelector<HTMLElement>('[data-testid="virtuoso-scroller"]');
          if (scroller) scroller.scrollTop = 0;
        });
        await screenshot(page, `steering-chips-top-${theme}-${viewport}`);
        // The long-URL and special-character rows sit mid-list.
        await scrollUntilMounted(page, 'before you change the signature');
        await expect(page.getByText(/before you change the signature/).first()).toBeVisible();
        await assertNoOverflow(page);
        await screenshot(page, `steering-chips-middle-${theme}-${viewport}`);
        // The first owner prompt is ordinary: no chip.
        await expect(deliveryGroup(page)).toBeVisible();
        await expect(page.getByRole('button', { name: /queue next/i })).toHaveAttribute(
          'aria-pressed',
          'true'
        );
        // Neither choice is cut off (the selected label is bolder, so it truncates first).
        const truncated = await deliveryGroup(page).evaluate((group) =>
          [...group.querySelectorAll('button span.truncate')]
            .filter((label) => label.scrollWidth > label.clientWidth)
            .map((label) => label.textContent)
        );
        expect(truncated).toEqual([]);
        await screenshot(page, `steering-chips-queue-${theme}-${viewport}`);
        await assertNoOverflow(page);
      });

      test('Steer now sends a steer and shows it steering', async ({ page }) => {
        await seedTheme(page, theme);
        const api = await setupApiMocks(page, { working: true });
        await gotoChat(page);
        await page.getByRole('button', { name: /steer now/i }).click();
        await expect(page.getByText(/joins this turn if the agent can take it/i)).toBeVisible();
        await composer(page).fill('Prefer a generator over a callback here.');
        await screenshot(page, `steering-steer-selected-${theme}-${viewport}`);
        await page.getByRole('button', { name: /^send/i }).click();
        await expect.poll(() => api.prompts.length).toBe(1);
        expect(api.prompts[0]).toMatchObject({
          content: 'Prefer a generator over a callback here.',
          deliveryIntent: 'steer',
        });
        const sent = page.getByTestId('user-message-delivery').last();
        await expect(sent).toContainText('Steering…');
        await assertNoOverflow(page);
      });

      test('no steer choice while the agent is idle', async ({ page }) => {
        await seedTheme(page, theme);
        const api = await setupApiMocks(page, { working: false });
        await gotoChat(page);
        // Liveness: the composer is there, the choice is not.
        await expect(composer(page)).toBeVisible();
        await expect(deliveryGroup(page)).toHaveCount(0);
        await composer(page).fill('Next, wire the new reader into the CLI.');
        await page.getByRole('button', { name: /^send/i }).click();
        await expect.poll(() => api.prompts.length).toBe(1);
        expect(api.prompts[0]).not.toHaveProperty('deliveryIntent');
        await screenshot(page, `steering-idle-${theme}-${viewport}`);
        await assertNoOverflow(page);
      });
    });
  }
}
