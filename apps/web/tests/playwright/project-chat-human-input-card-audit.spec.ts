import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

/**
 * In-chat question cards: an agent's `request_human_input` call renders as the question it
 * created, and the user answers it from the conversation instead of only from the bell.
 */

const PROJECT_ID = 'proj-human-input';
const SESSION_ID = 'sess-human-input';

const USER = { id: 'user-owner', name: 'Owner', email: 'owner@example.com', role: 'user' };

const LONG_QUESTION =
  'Should I start two agents now?\n\n' +
  '1) **Self-host first deploy**: add a check at the start of the deploy that verifies Cloudflare ' +
  'token permissions, list the real prerequisites and costs up front, and show the setup link at ' +
  'the end. (0 of 5 outside first deploys worked.) <script>alert(1)</script> 🚀\n\n' +
  '2) **Your instance front door**: replace "Awaiting Approval" with "This is a private SAM. Run ' +
  'your own", add a "close new signups" setting set to closed, and retire /try. See ' +
  'https://app.example.com/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/chat/01M6R3Y19QBZ8R44PD2HEH6YDZ/a/very/long/path ' +
  'for details. ' +
  'Separately, the security fix is still running on its own and SAM will wake me when it ' +
  'finishes. '.repeat(3);

const IDS = {
  open: 'marker-open',
  answered: 'marker-answered',
  expired: 'marker-expired',
  freeText: 'marker-free-text',
  missing: 'marker-missing',
};

interface MockRequest {
  id: string;
  reason: string | null;
  options: string[];
  category: string | null;
  createdAt: number;
  resolvedAt: number | null;
  resolvedAnswer: string | null;
  expired: boolean;
  canAnswer: boolean;
}

function request(overrides: Partial<MockRequest>): MockRequest {
  return {
    id: IDS.open,
    reason: LONG_QUESTION,
    options: [
      'Start both',
      'Only the self-host deploy fix',
      'Only the front door',
      'Not yet — a very long option label that has to wrap cleanly on a narrow phone screen',
    ],
    category: 'approval',
    createdAt: Date.now() - 2 * 60_000,
    resolvedAt: null,
    resolvedAnswer: null,
    expired: false,
    canAnswer: true,
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
  topic: 'Business, technical and strategic audit',
  status: 'stopped',
  messageCount: 6,
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

/** The compact tool row the API returns for a request_human_input call. */
function questionRow(id: string, sequence: number) {
  return {
    id: `tool-${id}`,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: `tc-${id}`,
      status: 'completed',
      title: 'mcp__sam-mcp__request_human_input',
      toolName: 'mcp__sam-mcp__request_human_input',
      kind: 'other',
      rawOutput: [
        {
          type: 'text',
          text: JSON.stringify({ humanInputRequest: { id, sessionId: SESSION_ID } }),
        },
      ],
      contentSize: 400,
    },
    createdAt: Date.now() - 40_000 + sequence * 1000,
    sequence,
  };
}

/**
 * Three short conversations, because the chat list is virtualized and only mounts the rows near
 * the bottom: one with an open question, one with the settled and free-text states, and one
 * whose question no longer exists.
 */
const OPEN_MESSAGES = [
  {
    id: 'msg-user-1',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Audit SAM and tell me what to fix first.',
    toolMetadata: null,
    createdAt: Date.now() - 50_000,
    sequence: 1,
  },
  questionRow(IDS.open, 2),
  {
    id: 'msg-assistant-1',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: "I've sent you an approval card. Until you answer, there's nothing else for me to do.",
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
    sequence: 3,
  },
];

const STATE_MESSAGES = [
  questionRow(IDS.answered, 1),
  questionRow(IDS.expired, 2),
  questionRow(IDS.freeText, 3),
];

/** Alone, so the virtualized list always mounts it. */
const MISSING_MESSAGES = [questionRow(IDS.missing, 1)];

async function setupMocks(page: Page, messages: unknown[]) {
  const records = new Map<string, MockRequest>([
    [IDS.open, request({})],
    [
      IDS.answered,
      request({
        id: IDS.answered,
        reason: 'Merge PR #2549 now?',
        options: ['Merge', 'Wait'],
        category: 'decision',
        resolvedAt: Date.now() - 60_000,
        resolvedAnswer: 'Merge',
        canAnswer: false,
      }),
    ],
    [
      IDS.expired,
      request({
        id: IDS.expired,
        reason: 'x',
        options: [],
        category: null,
        expired: true,
        canAnswer: false,
      }),
    ],
    [
      IDS.freeText,
      request({
        id: IDS.freeText,
        reason: 'Which Hetzner region should the new pool use?',
        options: [],
        category: 'clarification',
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

  await page.route(
    /\/api\/projects\/[^/]+\/sessions\/[^/]+\/attention\/[^/?]+(\/resolve)?(\?.*)?$/,
    (route: Route) => {
      const segments = new URL(route.request().url()).pathname.split('/');
      const isResolve = segments[segments.length - 1] === 'resolve';
      const id = isResolve ? segments[segments.length - 2]! : segments[segments.length - 1]!;
      const record = records.get(id);
      if (!record)
        return route.fulfill({
          status: 404,
          json: { error: 'NOT_FOUND', message: 'Attention request not found' },
        });
      if (isResolve) {
        const { answer } = route.request().postDataJSON() as { answer: string };
        records.set(id, {
          ...record,
          resolvedAt: Date.now(),
          resolvedAnswer: answer,
          canAnswer: false,
        });
        return route.fulfill({
          status: 200,
          json: { resolved: true, alreadyResolved: false, answer },
        });
      }
      return route.fulfill({
        status: 200,
        json: {
          request: record,
          session: { id: SESSION_ID, topic: MOCK_SESSION.topic },
          messages: [],
        },
      });
    }
  );
}

async function auditOpen(page: Page, name: string) {
  await setupMocks(page, OPEN_MESSAGES);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

  const card = page.getByTestId('human-input-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Approval needed')).toBeVisible();
  await expect(card.getByText('Needs your answer')).toBeVisible();
  await expect(card.getByText(/Should I start two agents now/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Start both' })).toBeVisible();
  // The long brief starts collapsed so the answer buttons stay close to the question.
  await expect(card.getByRole('button', { name: 'Show full question' })).toBeVisible();
  // The raw tool name is not shown in place of the card.
  await expect(page.getByText('mcp__sam-mcp__request_human_input')).toHaveCount(0);

  await screenshot(page, `${name}-open`);
  await assertNoOverflow(page);

  await card.getByRole('button', { name: 'Show full question' }).click();
  // Agent-supplied markup in the question renders as text.
  await expect(card.getByText(/<script>alert\(1\)<\/script>/)).toBeVisible();
  await screenshot(page, `${name}-expanded`);
  await assertNoOverflow(page);

  await card.getByRole('button', { name: 'Only the front door' }).click();
  await expect(card.getByText('Answered', { exact: true })).toBeVisible();
  await expect(card.getByText('Answered: Only the front door')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Start both' })).toHaveCount(0);
  await screenshot(page, `${name}-answered`);
  await assertNoOverflow(page);
}

async function auditStates(page: Page, name: string) {
  await setupMocks(page, STATE_MESSAGES);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

  const cards = page.getByTestId('human-input-card');
  const freeText = cards.filter({ hasText: 'Which Hetzner region' });
  await expect(freeText.getByText('Clarification needed')).toBeVisible();
  await expect(freeText.getByLabel('Your answer')).toBeVisible();
  await expect(freeText.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  await assertNoOverflow(page);

  // The first cards sit above the virtualized window on a phone; scroll up to mount them.
  await page.getByRole('log', { name: 'Conversation' }).hover();
  await page.mouse.wheel(0, -3000);
  await expect(cards.filter({ hasText: 'Merge PR' }).getByText('Answered: Merge')).toBeVisible();
  await expect(page.getByText('This question has expired.')).toBeVisible();
  await screenshot(page, `${name}-states`);
  await assertNoOverflow(page);
}

async function auditMissing(page: Page, name: string) {
  await setupMocks(page, MISSING_MESSAGES);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

  // An unknown question shows a retryable error rather than an empty card.
  await expect(page.getByText(/Couldn't load this question/)).toBeVisible();
  await expect(page.getByText(/Attention request not found/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await screenshot(page, `${name}-missing`);
  await assertNoOverflow(page);
}

test.describe('Project chat human input cards — Mobile', () => {
  test('answers an open question from the conversation', async ({ page }) => {
    await auditOpen(page, 'project-chat-human-input-cards-mobile');
  });

  test('answered, expired and free-text questions', async ({ page }) => {
    await auditStates(page, 'project-chat-human-input-cards-mobile');
  });

  test('a question that no longer exists', async ({ page }) => {
    await auditMissing(page, 'project-chat-human-input-cards-mobile');
  });
});

test.describe('Project chat human input cards — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('answers an open question from the conversation', async ({ page }) => {
    await auditOpen(page, 'project-chat-human-input-cards-desktop');
  });

  test('answered, expired and free-text questions', async ({ page }) => {
    await auditStates(page, 'project-chat-human-input-cards-desktop');
  });

  test('a question that no longer exists', async ({ page }) => {
    await auditMissing(page, 'project-chat-human-input-cards-desktop');
  });
});
