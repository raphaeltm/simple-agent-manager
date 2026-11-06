import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, seedTheme } from './audit-helpers';
import {
  MOCK_AGENT_CREDENTIALS,
  MOCK_CLOUD_CREDENTIALS,
  MOCK_GITHUB_INSTALLATIONS,
  MOCK_PROJECT,
  MOCK_USER,
} from './chat-audit-fixtures';

// ---------------------------------------------------------------------------
// Live steering in the REAL project chat: the Steer / Queue chip the lifecycle dock
// offers while the agent works, and the delivery chip under a message
// sent with Steer now, in every state the server can report. The working state
// comes from the session detail's `state.activity === 'prompting'`, as in
// production; chip states come from the transcript row metadata the server writes
// (`deliveryIntent: 'steer'` + `steerOutcome`/`steerReason`).
// ---------------------------------------------------------------------------

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

const PLAN = [
  { content: 'Swap the buffered parse for a streaming reader', status: 'completed' },
  { content: 'Update the callers', status: 'in_progress' },
  { content: 'Add a regression test for the 10k-row file', status: 'pending' },
];

function chatState(working: boolean, withPlan = false, steeringSupported?: boolean) {
  return {
    ...(steeringSupported === undefined ? {} : { steeringSupported }),
    activity: working ? 'prompting' : 'idle',
    activityAt: NOW,
    statusError: null,
    currentPlan: withPlan ? PLAN : null,
    planUpdatedAt: null,
    promptStartedAt: working ? NOW - 45000 : null,
    agentType: 'claude-code',
    lastStopReason: null,
  };
}

async function setupApiMocks(
  page: Page,
  opts: { working: boolean; withPlan?: boolean; steeringSupported?: boolean }
) {
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
          state: chatState(opts.working, opts.withPlan, opts.steeringSupported),
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

const chip = (page: Page) => page.getByTestId('delivery-intent-chip');
const composer = (page: Page) =>
  page.getByPlaceholder(/^(Steer the agent|Queue next|Send a message)\.\.\.$/);

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
        // Steer is the default while the agent works, and the placeholder says so.
        await expect(chip(page)).toHaveAttribute('data-intent', 'steer');
        await expect(page.getByPlaceholder('Steer the agent...')).toBeVisible();
        await chip(page).click();
        await expect(chip(page)).toHaveAttribute('data-intent', 'queue');
        await expect(page.getByPlaceholder('Queue next...')).toBeVisible();
        await screenshot(page, `steering-chips-queue-${theme}-${viewport}`);
        await assertNoOverflow(page);
      });

      test('a message sent while the agent works steers by default and shows it steering', async ({
        page,
      }) => {
        await seedTheme(page, theme);
        const api = await setupApiMocks(page, { working: true });
        await gotoChat(page);
        // No click: Steer is already selected.
        await expect(chip(page)).toHaveAttribute('data-intent', 'steer');
        await composer(page).fill('Prefer a generator over a callback here.');
        if (viewport === 'mobile') {
          // The newest chip must not sit under the phone-only conversation toggle.
          const chipBox = await page
            .getByTestId('user-message-delivery')
            .last()
            .locator(':scope > span')
            .boundingBox();
          const toggleBox = await page.getByTestId('chat-immersive-toggle').boundingBox();
          expect(chipBox && toggleBox).toBeTruthy();
          // Unconditional: every chip on a phone ends left of the toggle's column.
          expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(toggleBox!.x);
        }
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

      test('the chip shares the dock row with the plan pill without touching Interrupt', async ({
        page,
      }) => {
        await seedTheme(page, theme);
        await setupApiMocks(page, { working: true, withPlan: true });
        await gotoChat(page);
        const planBox = await page.getByRole('button', { name: 'View plan' }).boundingBox();
        const chipBox = await chip(page).boundingBox();
        const stopBox = await page.getByRole('button', { name: 'Interrupt agent' }).boundingBox();
        const composerBox = await composer(page).boundingBox();
        expect(planBox && chipBox && stopBox && composerBox).toBeTruthy();
        // Plan pill, then the chip, on one row, ending left of the centre button.
        expect(planBox!.x + planBox!.width).toBeLessThanOrEqual(chipBox!.x);
        expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(stopBox!.x);
        expect(
          Math.abs(planBox!.y + planBox!.height / 2 - (chipBox!.y + chipBox!.height / 2))
        ).toBeLessThan(2);
        // The row sits above the message box: the choice takes no row of its own.
        expect(chipBox!.y + chipBox!.height).toBeLessThanOrEqual(composerBox!.y);
        // Both placeholders fit the empty message box on one line (a wrapped one is clipped).
        for (const intent of ['steer', 'queue'] as const) {
          if (intent === 'queue') await chip(page).click();
          await expect(chip(page)).toHaveAttribute('data-intent', intent);
          const box = await composer(page).evaluate((el) => ({
            content: el.scrollHeight,
            visible: el.clientHeight,
          }));
          expect(box.content).toBeLessThanOrEqual(box.visible + 1);
        }
        await screenshot(page, `steering-chip-with-plan-${theme}-${viewport}`);
        await assertNoOverflow(page);
      });

      test('no steer choice while the agent is idle', async ({ page }) => {
        await seedTheme(page, theme);
        const api = await setupApiMocks(page, { working: false });
        await gotoChat(page);
        // Liveness: the composer is there, the choice is not.
        await expect(composer(page)).toBeVisible();
        await expect(chip(page)).toHaveCount(0);
        await composer(page).fill('Next, wire the new reader into the CLI.');
        await page.getByRole('button', { name: /^send/i }).click();
        await expect.poll(() => api.prompts.length).toBe(1);
        expect(api.prompts[0]).not.toHaveProperty('deliveryIntent');
        await screenshot(page, `steering-idle-${theme}-${viewport}`);
        await assertNoOverflow(page);
      });

      test('no steer choice while working when the agent cannot steer', async ({ page }) => {
        await seedTheme(page, theme);
        const api = await setupApiMocks(page, { working: true, steeringSupported: false });
        await gotoChat(page);
        // Liveness: the agent shows working (Interrupt) and the composer is there.
        await expect(page.getByRole('button', { name: /interrupt/i })).toBeVisible();
        await expect(composer(page)).toBeVisible();
        await expect(chip(page)).toHaveCount(0);
        await expect(composer(page)).toHaveAttribute('placeholder', 'Queue next...');
        await composer(page).fill('Also cover the empty-file case.');
        await page.getByRole('button', { name: /^send/i }).click();
        await expect.poll(() => api.prompts.length).toBe(1);
        expect(api.prompts[0]).not.toHaveProperty('deliveryIntent');
        await screenshot(page, `steering-unsupported-${theme}-${viewport}`);
        await assertNoOverflow(page);
      });
    });
  }
}
