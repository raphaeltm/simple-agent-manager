import { expect, type Page, type Route, test } from '@playwright/test';
import type { InboxItem } from '@simple-agent-manager/shared';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

/**
 * In-chat inbox item cards (inbox slice D): an agent's `inbox_write` ask or review renders as the
 * inbox item it filed, read from and answered through the inbox routes.
 */

const PROJECT_ID = 'proj-inbox-card';
const SESSION_ID = 'sess-inbox-card';
const USER = { id: 'user-owner', name: 'Owner', email: 'owner@example.com', role: 'user' };

const LONG_REASON =
  'The pricing page header moved below the fold on phones and the plan cards now wrap to two ' +
  'columns. <script>alert(1)</script> 🚀 Check https://app.example.com/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/library/pricing/a/very/long/path/that/does/not/break ' +
  'and tell me whether the annual toggle reads clearly. '.repeat(4);

function inboxItem(overrides: Partial<InboxItem> & { ref: string }): InboxItem {
  return {
    store: 'ask',
    kind: 'review',
    projectId: PROJECT_ID,
    projectName: 'SAM',
    sessionId: SESSION_ID,
    topic: 'Pricing page',
    taskId: 'task-1',
    stackKey: SESSION_ID,
    title:
      'Please review the new pricing page before it ships to every customer on the annual plan with the long title that wraps',
    body: LONG_REASON,
    blocking: false,
    agentState: 'working',
    status: 'open',
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: null,
    dueAt: null,
    answerSpec: { type: 'acknowledge' },
    links: [
      { kind: 'pr', id: 'https://github.com/user/sam/pull/2792', label: 'Pricing page PR #2792' },
      { kind: 'preview', id: 'https://ws-01abc--5173.example.com/pricing', label: 'Preview' },
      { kind: 'idea', id: 'idea-1', label: 'Pricing plan idea with a long label that keeps going' },
    ],
    canAct: true,
    untrustedContent: true,
    ...overrides,
  };
}

const ITEMS: Record<string, InboxItem> = {
  'ask:review': inboxItem({ ref: 'ask:review' }),
  'ask:question': inboxItem({
    ref: 'ask:question',
    kind: 'question',
    blocking: true,
    agentState: 'waiting',
    title: 'Deploy the billing fix to staging first?',
    body: 'The migration touches invoices.',
    answerSpec: {
      type: 'options',
      options: ['Yes', 'No — a very long option label that has to wrap cleanly on a narrow phone'],
      allowText: false,
    },
    links: [],
  }),
  'ask:cancelled': inboxItem({
    ref: 'ask:cancelled',
    kind: 'question',
    status: 'cancelled',
    canAct: false,
    title: 'Should I use the old API?',
    body: null,
    links: [],
  }),
};

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
  topic: 'Pricing page',
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

/** The tool row for an `inbox_write` call, Codex-style title (no toolName on the result). */
function inboxRow(ref: string, sequence: number) {
  return {
    id: `tool-${ref}`,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: `tc-${ref}`,
      status: 'completed',
      title: 'mcp__sam-mcp__inbox_write',
      toolName: 'mcp__sam-mcp__inbox_write',
      kind: 'other',
      rawOutput: [
        { type: 'text', text: JSON.stringify({ inboxItem: { ref, sessionId: SESSION_ID } }) },
      ],
      contentSize: 300,
    },
    createdAt: Date.now() - 40_000 + sequence * 1000,
    sequence,
  };
}

async function setupMocks(page: Page, messages: unknown[]) {
  const records = new Map(Object.entries(ITEMS));
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages,
    user: USER,
  });
  await page.route(
    /\/api\/projects\/[^/]+\/inbox\/items\/[^/?]+(\/answer)?(\?.*)?$/,
    (route: Route) => {
      const segments = decodeURIComponent(new URL(route.request().url()).pathname).split('/');
      const isAnswer = segments[segments.length - 1] === 'answer';
      const ref = isAnswer ? segments[segments.length - 2]! : segments[segments.length - 1]!;
      const record = records.get(ref);
      if (!record)
        return route.fulfill({
          status: 404,
          json: { error: 'NOT_FOUND', message: 'Inbox item not found' },
        });
      if (isAnswer) {
        records.set(ref, { ...record, status: 'answered', canAct: false });
        return route.fulfill({
          status: 200,
          json: { ref, outcome: 'answered', agentNotified: true },
        });
      }
      return route.fulfill({ status: 200, json: { item: record, context: null } });
    }
  );
}

async function auditReview(page: Page, name: string) {
  await setupMocks(page, [inboxRow('ask:review', 1)]);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  const card = page.getByTestId('inbox-item-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Review requested')).toBeVisible();
  await expect(card.getByText('Waiting for your review')).toBeVisible();
  await expect(card.getByText('Pricing page PR #2792')).toBeVisible();
  await expect(page.getByText('mcp__sam-mcp__inbox_write')).toHaveCount(0);
  await screenshot(page, `${name}-review-open`);
  await assertNoOverflow(page);
  await card.getByRole('button', { name: 'Looks good' }).click();
  await expect(card.getByText(/Marked “Looks good”/)).toBeVisible();
  await screenshot(page, `${name}-review-answered`);
  await assertNoOverflow(page);
}

async function auditQuestionAndStates(page: Page, name: string) {
  await setupMocks(page, [
    inboxRow('ask:cancelled', 1),
    inboxRow('ask:question', 2),
    inboxRow('ask:missing', 3),
  ]);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await expect(page.getByText(/not in your inbox/)).toBeVisible();
  const question = page
    .getByTestId('inbox-item-card')
    .filter({ hasText: 'Deploy the billing fix' });
  await expect(question.getByText('Question for you')).toBeVisible();
  await expect(question.getByText('Agent paused on this')).toBeVisible();
  await expect(question.getByRole('button', { name: 'Yes', exact: true })).toBeVisible();
  await page.getByRole('log', { name: 'Conversation' }).hover();
  await page.mouse.wheel(0, -3000);
  await expect(page.getByText('Withdrawn by the agent')).toBeVisible();
  await screenshot(page, `${name}-states`);
  await assertNoOverflow(page);
}

test.describe('Project chat inbox item cards — Mobile', () => {
  test('review: open, then Looks good', async ({ page }) => {
    await auditReview(page, 'project-chat-inbox-item-card-mobile');
  });
  test('blocking question, withdrawn item and a missing item', async ({ page }) => {
    await auditQuestionAndStates(page, 'project-chat-inbox-item-card-mobile');
  });
});

test.describe('Project chat inbox item cards — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });
  test('review: open, then Looks good', async ({ page }) => {
    await auditReview(page, 'project-chat-inbox-item-card-desktop');
  });
  test('blocking question, withdrawn item and a missing item', async ({ page }) => {
    await auditQuestionAndStates(page, 'project-chat-inbox-item-card-desktop');
  });
});
