import { expect, type Route, test } from '@playwright/test';

import { seedTheme, setupProjectChatMocks } from './audit-helpers';
import { blogShot } from './docs-shot';

const SLUG = 'agent-questions-in-chat';
const PROJECT_ID = 'proj-blog-render';
const SESSION_ID = 'sess-blog-render';
const MARKER_ID = 'marker-blog-render';
const USER = { id: 'user-owner', name: 'Alex Morgan', email: 'alex@example.test', role: 'user' };
const PROJECT = {
  id: PROJECT_ID,
  name: 'Payments API',
  repository: 'acme/payments-api',
  repoProvider: 'github',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};
const SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Prepare the release',
  status: 'stopped',
  messageCount: 3,
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
const MESSAGES = [
  {
    id: 'msg-user',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Prepare the release and ask before opening a pull request.',
    toolMetadata: null,
    createdAt: Date.now() - 50_000,
    sequence: 1,
  },
  {
    id: 'tool-question',
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: 'tc-blog-render',
      status: 'completed',
      title: 'mcp__sam-mcp__request_human_input',
      toolName: 'mcp__sam-mcp__request_human_input',
      kind: 'other',
      rawOutput: [
        {
          type: 'text',
          text: JSON.stringify({ humanInputRequest: { id: MARKER_ID, sessionId: SESSION_ID } }),
        },
      ],
      contentSize: 120,
    },
    createdAt: Date.now() - 40_000,
    sequence: 2,
  },
  {
    id: 'msg-assistant',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: 'The checks passed. I’m waiting for your choice before I continue.',
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
    sequence: 3,
  },
];

test('capture the real question card in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['dark', 'light'] as const) {
    await seedTheme(page, theme);
    await setupProjectChatMocks(page, {
      projectId: PROJECT_ID,
      project: PROJECT,
      session: SESSION,
      messages: MESSAGES,
      user: USER,
    });
    await page.route(
      /\/api\/projects\/[^/]+\/sessions\/[^/]+\/attention\/[^/?]+(\/resolve)?(\?.*)?$/,
      (route: Route) =>
        route.fulfill({
          status: 200,
          json: {
            request: {
              id: MARKER_ID,
              reason: 'The deployment checks passed. Should I open a pull request now?',
              options: ['Open a pull request', 'Wait for one more review', 'Show me the logs'],
              category: 'approval',
              createdAt: Date.now() - 2 * 60_000,
              resolvedAt: null,
              resolvedAnswer: null,
              expired: false,
              canAnswer: true,
            },
            session: { id: SESSION_ID, topic: SESSION.topic },
            messages: [],
          },
        })
    );
    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
    const card = page.getByTestId('human-input-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('Approval needed')).toBeVisible();
    await expect(card.getByText(/Should I open a pull request now/)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Open a pull request' })).toBeVisible();
    await blogShot(page, SLUG, `question-card-${theme}`, card);
  }
});
