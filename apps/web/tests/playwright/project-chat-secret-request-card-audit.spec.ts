import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

/**
 * In-chat secret request cards: an agent's `request_secret` call renders as a secure input card;
 * a project owner types the value there and it goes straight to the API, never into the chat.
 */

const PROJECT_ID = 'proj-secret-request';
const SESSION_ID = 'sess-secret-request';
const SENTINEL = 'sk_live_SYNTHETIC_SENTINEL_value_never_in_chat';

const USER = { id: 'user-owner', name: 'Owner', email: 'owner@example.com', role: 'user' };

const LONG_NAME = 'SUPER_LONG_THIRD_PARTY_SERVICE_PRODUCTION_READ_WRITE_API_TOKEN_FOR_REGION_EU_WEST';
const LONG_REASON =
  'I need a Cloudflare API token to create the DNS records for the preview environment. ' +
  'Create it at https://dash.cloudflare.com/profile/api-tokens/a/very/long/path/that/does/not/break/naturally ' +
  'with Zone:DNS:Edit on sammy.party only. <script>alert(1)</script> 🚀 ' +
  'It only needs to live for the length of this task, so I asked for a one-hour expiry. '.repeat(2);

const IDS = {
  open: 'req-open',
  fulfilled: 'req-fulfilled',
  declined: 'req-declined',
  expired: 'req-expired',
  missing: 'req-missing',
};

interface MockRequest {
  id: string;
  projectId: string;
  envKey: string;
  reason: string;
  ttlSeconds: number | null;
  status: 'pending' | 'fulfilled' | 'declined' | 'expired';
  requestingTaskId: string;
  requestingChatSessionId: string;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  secretExpiresAt: string | null;
  replacedExisting: boolean;
}

function request(overrides: Partial<MockRequest>): MockRequest {
  return {
    id: IDS.open,
    projectId: PROJECT_ID,
    envKey: LONG_NAME,
    reason: LONG_REASON,
    ttlSeconds: 3_600,
    status: 'pending',
    requestingTaskId: 'task-1',
    requestingChatSessionId: SESSION_ID,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    resolvedAt: null,
    resolvedByName: null,
    secretExpiresAt: null,
    replacedExisting: false,
    ...overrides,
  };
}

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'SAM',
  repository: 'user/sam',
  repoProvider: 'github',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Preview environment DNS',
  status: 'stopped',
  messageCount: 4,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  viewerAccess: 'owner',
  agentType: 'claude-code',
};

/** The compact tool row the API keeps for a request_secret call. */
function requestRow(id: string, sequence: number) {
  return {
    id: `tool-${id}`,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: `tc-${id}`,
      status: 'completed',
      title: 'mcp__sam-mcp__request_secret',
      toolName: 'mcp__sam-mcp__request_secret',
      kind: 'other',
      rawOutput: [{ type: 'text', text: JSON.stringify({ secretRequest: { id } }) }],
      contentSize: 300,
    },
    createdAt: Date.now() - 40_000 + sequence * 1000,
    sequence,
  };
}

const OPEN_MESSAGES = [
  {
    id: 'msg-user-1',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Set up DNS for the preview environment.',
    toolMetadata: null,
    createdAt: Date.now() - 50_000,
    sequence: 1,
  },
  requestRow(IDS.open, 2),
  {
    id: 'msg-assistant-1',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: "I've asked for the token on a secure card. I'll continue once it's saved.",
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
    sequence: 3,
  },
];

const STATE_MESSAGES = [
  requestRow(IDS.declined, 1),
  requestRow(IDS.expired, 2),
  requestRow(IDS.fulfilled, 3),
];

const MISSING_MESSAGES = [requestRow(IDS.missing, 1)];

interface Captured {
  fulfilBodies: unknown[];
  otherBodies: string[];
}

async function setupMocks(
  page: Page,
  messages: unknown[],
  options: { failSave?: boolean } = {}
): Promise<Captured> {
  const captured: Captured = { fulfilBodies: [], otherBodies: [] };
  const records = new Map<string, MockRequest>([
    [IDS.open, request({})],
    [
      IDS.fulfilled,
      request({
        id: IDS.fulfilled,
        envKey: 'STRIPE_API_KEY',
        reason: 'Create a test-mode webhook endpoint.',
        status: 'fulfilled',
        resolvedAt: new Date(Date.now() - 30_000).toISOString(),
        resolvedByName: 'Raphaël',
        secretExpiresAt: new Date(Date.now() + 3_500_000).toISOString(),
      }),
    ],
    [
      IDS.declined,
      request({
        id: IDS.declined,
        envKey: 'X',
        reason: 'x',
        ttlSeconds: null,
        status: 'declined',
        resolvedAt: new Date(Date.now() - 50_000).toISOString(),
        resolvedByName: 'Owner',
      }),
    ],
    [
      IDS.expired,
      request({
        id: IDS.expired,
        envKey: 'OPENAI_API_KEY',
        reason: 'Run the evaluation suite against the real model.',
        status: 'expired',
      }),
    ],
  ]);

  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages,
    user: USER,
  });

  page.on('request', (req) => {
    const body = req.postData();
    if (body && !req.url().includes('/secret-requests/')) captured.otherBodies.push(body);
  });

  await page.route(
    /\/api\/projects\/[^/]+\/secret-requests\/[^/?]+(\/(fulfill|decline))?(\?.*)?$/,
    (route: Route) => {
      const segments = new URL(route.request().url()).pathname.split('/');
      const action = segments[segments.length - 1];
      const isAction = action === 'fulfill' || action === 'decline';
      const id = isAction ? segments[segments.length - 2]! : action!;
      const record = records.get(id);
      if (!record)
        return route.fulfill({
          status: 404,
          json: { error: 'NOT_FOUND', message: 'Secret request not found' },
        });
      if (action === 'fulfill') {
        captured.fulfilBodies.push(route.request().postDataJSON());
        if (options.failSave)
          return route.fulfill({
            status: 409,
            json: { error: 'CONFLICT', message: 'This secret request was already fulfilled' },
          });
        const resolved: MockRequest = {
          ...record,
          status: 'fulfilled',
          resolvedAt: new Date().toISOString(),
          resolvedByName: 'Owner',
          secretExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          replacedExisting: true,
        };
        records.set(id, resolved);
        return route.fulfill({ status: 200, json: { request: resolved, agentNotified: true } });
      }
      if (action === 'decline') {
        const resolved: MockRequest = { ...record, status: 'declined', resolvedByName: 'Owner' };
        records.set(id, resolved);
        return route.fulfill({ status: 200, json: { request: resolved, agentNotified: true } });
      }
      return route.fulfill({
        status: 200,
        json: {
          request: record,
          existing:
            id === IDS.open
              ? {
                  isSecret: true,
                  collected: true,
                  expiresAt: null,
                  expired: true,
                  updatedAt: '2026-11-01T00:00:00Z',
                }
              : null,
          canResolve: record.status === 'pending',
        },
      });
    }
  );
  return captured;
}

/**
 * The card must fit its column: a long unbroken name inflating the card's min-content width is
 * clipped by the chat's scroller, which the document-level overflow check cannot see
 * (`.claude/rules/56`). Compare measured coordinates instead.
 */
async function assertCardsFitColumn(page: Page) {
  const overflows = await page.getByTestId('secret-request-card').evaluateAll((cards) =>
    cards.map((card) => {
      const box = card.getBoundingClientRect();
      const parent = card.parentElement?.getBoundingClientRect();
      return {
        contentWider: card.scrollWidth - card.clientWidth,
        pastParent: parent ? box.right - parent.right : 0,
        pastViewport: box.right - window.innerWidth,
      };
    })
  );
  for (const overflow of overflows) {
    expect(overflow.contentWider).toBeLessThanOrEqual(1);
    expect(overflow.pastParent).toBeLessThanOrEqual(1);
    expect(overflow.pastViewport).toBeLessThanOrEqual(0);
  }
}

async function auditOpen(page: Page, name: string) {
  const captured = await setupMocks(page, OPEN_MESSAGES);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

  const card = page.getByTestId('secret-request-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Secret requested')).toBeVisible();
  await expect(card.getByText('Waiting for a value')).toBeVisible();
  await expect(card.getByText(/Cloudflare API token/)).toBeVisible();
  // Agent-written markup renders as text.
  await expect(card.getByText(/<script>alert\(1\)<\/script>/)).toBeVisible();
  await expect(card.getByText(/Expires 1 hour after it is saved/)).toBeVisible();
  await expect(card.getByText(/already exists in this project/)).toBeVisible();
  await expect(page.getByText('mcp__sam-mcp__request_secret')).toHaveCount(0);
  await screenshot(page, `${name}-open`);
  await assertNoOverflow(page);
  await assertCardsFitColumn(page);

  const input = card.getByLabel(/Value for/);
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(SENTINEL);
  const save = card.getByRole('button', { name: 'Save secret' });
  await expect(save).toBeDisabled();
  await card.getByLabel('Replace the existing value').check();
  await screenshot(page, `${name}-filled`);
  await assertNoOverflow(page);
  await assertCardsFitColumn(page);
  await save.click();

  await expect(card.getByText('Supplied', { exact: true })).toBeVisible();
  await expect(card.getByText(/Supplied by Owner/)).toBeVisible();
  await expect(card.getByLabel(/Value for/)).toHaveCount(0);
  expect(captured.fulfilBodies).toEqual([{ value: SENTINEL, replaceExisting: true }]);
  // The value went only to the fulfil call: not to any other request, nor into the page.
  expect(captured.otherBodies.join('\n')).not.toContain(SENTINEL);
  expect(await page.content()).not.toContain(SENTINEL);
  await screenshot(page, `${name}-supplied`);
  await assertNoOverflow(page);
}

async function auditSaveError(page: Page, name: string) {
  await setupMocks(page, OPEN_MESSAGES, { failSave: true });
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  const card = page.getByTestId('secret-request-card');
  await card.getByLabel(/Value for/).fill(SENTINEL);
  await card.getByLabel('Replace the existing value').check();
  await card.getByRole('button', { name: 'Save secret' }).click();
  await expect(card.getByRole('alert')).toHaveText(/already fulfilled/);
  await screenshot(page, `${name}-save-error`);
  await assertNoOverflow(page);
}

async function auditStates(page: Page, name: string) {
  await setupMocks(page, STATE_MESSAGES);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  const cards = page.getByTestId('secret-request-card');
  await expect(cards.filter({ hasText: 'STRIPE_API_KEY' }).getByText(/Supplied by Raphaël/)).toBeVisible();
  await assertNoOverflow(page);
  await page.getByRole('log', { name: 'Conversation' }).hover();
  await page.mouse.wheel(0, -3000);
  await expect(cards.filter({ hasText: 'OPENAI_API_KEY' }).getByText('Expired')).toBeVisible();
  await expect(page.getByText(/Declined by Owner/)).toBeVisible();
  await screenshot(page, `${name}-states`);
  await assertNoOverflow(page);
  await assertCardsFitColumn(page);
}

async function auditMissing(page: Page, name: string) {
  await setupMocks(page, MISSING_MESSAGES);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await expect(page.getByText(/Couldn't load this secret request/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await screenshot(page, `${name}-missing`);
  await assertNoOverflow(page);
}

test.describe('Project chat secret request cards — Mobile', () => {
  test('supplies a secret from the conversation', async ({ page }) => {
    await auditOpen(page, 'project-chat-secret-request-mobile');
  });
  test('shows a save error and keeps the form', async ({ page }) => {
    await auditSaveError(page, 'project-chat-secret-request-mobile');
  });
  test('supplied, declined and expired requests', async ({ page }) => {
    await auditStates(page, 'project-chat-secret-request-mobile');
  });
  test('a request that no longer exists', async ({ page }) => {
    await auditMissing(page, 'project-chat-secret-request-mobile');
  });
});

test.describe('Project chat secret request cards — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('supplies a secret from the conversation', async ({ page }) => {
    await auditOpen(page, 'project-chat-secret-request-desktop');
  });
  test('shows a save error and keeps the form', async ({ page }) => {
    await auditSaveError(page, 'project-chat-secret-request-desktop');
  });
  test('supplied, declined and expired requests', async ({ page }) => {
    await auditStates(page, 'project-chat-secret-request-desktop');
  });
  test('a request that no longer exists', async ({ page }) => {
    await auditMissing(page, 'project-chat-secret-request-desktop');
  });
});
