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
// Live steering in the REAL project chat: the Steer now / Queue next choice the
// composer offers while the agent works, and the delivery chip under a message
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

// PROTOTYPE (not for main): screenshots of the three compact steering alternatives
// next to the current control, in the real project chat. `?steerUi=` picks the variant.

const OUT = '../../.tmp/steer-alternatives';
const VARIANTS = ['current', 'dock', 'split', 'line'] as const;

async function open(page: Page, variant: string) {
  await page.goto(`/projects/proj-test-1/chat/session-1?steerUi=${variant}`);
  await expect(page.getByTestId('user-message-delivery').last()).toBeVisible();
  await page.waitForTimeout(900);
}

async function footerHeight(page: Page) {
  const box = await page.getByTestId('session-footer').boundingBox();
  return Math.round(box!.height);
}

const heights: Record<string, number> = {};

for (const theme of ['dark', 'light'] as const) {
  for (const viewport of ['mobile', 'desktop'] as const) {
    test.describe(`Steering alternatives — ${theme} — ${viewport}`, () => {
      if (viewport === 'desktop') {
        test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });
      } else {
        test.use({ viewport: { width: 375, height: 667 }, isMobile: true });
      }
      for (const variant of VARIANTS) {
        test(variant, async ({ page }) => {
          await seedTheme(page, theme);
          await setupApiMocks(page, { working: true });
          await open(page, variant);
          heights[`${variant}-${viewport}-empty`] = await footerHeight(page);
          await page.screenshot({ path: `${OUT}/${variant}-${viewport}-${theme}-empty.png` });
          await page.getByRole('combobox').first().fill('Prefer a generator over a callback here.');
          await page.waitForTimeout(300);
          heights[`${variant}-${viewport}-typed`] = await footerHeight(page);
          await page.screenshot({ path: `${OUT}/${variant}-${viewport}-${theme}-typed.png` });
          if (variant === 'split') {
            await page.getByTestId('steer-ui-split-caret').click();
            await expect(page.getByRole('menu')).toBeVisible();
            await page.screenshot({ path: `${OUT}/${variant}-${viewport}-${theme}-menu.png` });
            await page.getByRole('menuitemradio', { name: /queue next/i }).click();
          } else if (variant === 'dock') {
            await page.getByTestId('steer-ui-dock-chip').click();
          } else if (variant === 'line') {
            await page.getByRole('button', { name: /queue instead/i }).click();
          }
          if (variant !== 'current') {
            await page.waitForTimeout(300);
            await page.screenshot({ path: `${OUT}/${variant}-${viewport}-${theme}-queue.png` });
          }
          await assertNoOverflow(page);
          console.log('FOOTER', theme, JSON.stringify(heights));
        });
      }
    });
  }
}
