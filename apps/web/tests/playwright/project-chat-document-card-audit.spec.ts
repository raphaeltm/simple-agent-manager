import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

const PROJECT_ID = 'proj-doc-1';
const SESSION_ID = 'sess-doc-cards';

// 1x1 transparent PNG so the inline image thumbnail actually loads.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const MARKDOWN_BODY = [
  '# How authentication works',
  '',
  'SAM issues a short-lived JWT on login and refreshes it via the session cookie.',
  '',
  '## Token refresh',
  '',
  'The refresh happens in a Durable Object so concurrent workspaces cannot race.',
  '',
  '- Step 1: validate the stored refresh token',
  '- Step 2: exchange it for a new access token',
  '- Step 3: persist the rotated token',
].join('\n');

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Document Card Audit',
  repository: 'user/doc-card-audit',
  repoProvider: 'github',
  createdAt: '2026-07-03T00:00:00Z',
  updatedAt: '2026-07-03T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Document cards',
  status: 'stopped',
  messageCount: 7,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  agentType: 'claude-code',
};

/** Build a completed library tool message carrying card metadata. */
function docToolMsg(opts: {
  id: string;
  sequence: number;
  toolName: string;
  rawInput: Record<string, unknown>;
  result: Record<string, unknown>;
}) {
  return {
    id: opts.id,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: opts.id,
      status: 'completed',
      toolName: opts.toolName,
      rawInput: opts.rawInput,
      rawOutput: [{ type: 'text', text: JSON.stringify(opts.result) }],
    },
    createdAt: Date.now() - 40_000 + opts.sequence * 1000,
    sequence: opts.sequence,
  };
}

const LONG_CAPTION =
  'This is the auth flow explainer written last week. Section 3 (token refresh) is the part that answers your question about why concurrent workspaces were racing on the refresh token — the rest is background context you can skim.';

const MOCK_MESSAGES = [
  {
    id: 'msg-user-1',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Can you write up how auth works and show me the diagram?',
    toolMetadata: null,
    createdAt: Date.now() - 50_000,
    sequence: 1,
  },
  docToolMsg({
    id: 'md-1',
    sequence: 2,
    toolName: 'mcp__sam-mcp__upload_to_library',
    rawInput: { filePath: '/docs/how-auth-works.md' },
    result: { fileId: 'md-1', filename: 'how-auth-works.md', mimeType: 'text/markdown', sizeBytes: 2048 },
  }),
  docToolMsg({
    id: 'img-1',
    sequence: 3,
    toolName: 'mcp__sam-mcp__display_from_library',
    rawInput: { fileId: 'img-1', caption: 'The auth sequence diagram' },
    result: { fileId: 'img-1', filename: 'auth-sequence-diagram.png', mimeType: 'image/png', sizeBytes: 40000 },
  }),
  docToolMsg({
    id: 'pdf-1',
    sequence: 4,
    toolName: 'mcp__sam-mcp__display_from_library',
    rawInput: { fileId: 'pdf-1', caption: LONG_CAPTION },
    result: { fileId: 'pdf-1', filename: 'security-review-a-very-long-filename-that-should-truncate-gracefully.pdf', mimeType: 'application/pdf', sizeBytes: 900000 },
  }),
  docToolMsg({
    id: 'gone-1',
    sequence: 5,
    toolName: 'mcp__sam-mcp__display_from_library',
    rawInput: { fileId: 'gone-1' },
    result: { error: 'FILE_NOT_FOUND' },
  }),
  {
    id: 'msg-assistant-1',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: 'Done — the write-up and the diagram are above.',
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
    sequence: 6,
  },
];

async function setupMocks(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true');
  });

  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages: MOCK_MESSAGES,
  });

  // Preview endpoint: serve markdown text and a real PNG per fileId.
  await page.route(/\/library\/[^/]+\/preview/, (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/md-1/')) {
      return route.fulfill({ status: 200, contentType: 'text/markdown', body: MARKDOWN_BODY });
    }
    if (path.includes('/img-1/')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG });
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

async function renderAndAudit(page: Page, name: string) {
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

  // Every document tool call renders as its own card (upload/display/tombstone).
  await expect(page.getByRole('button', { name: 'Open how-auth-works.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open auth-sequence-diagram.png' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open security-review.*\.pdf/ })).toBeVisible();
  await expect(page.getByText(/No longer in the library/)).toBeVisible();
  // Caption renders with the display card.
  await expect(page.getByText('The auth sequence diagram')).toBeVisible();
  // Markdown source preview fetched and clamped inline.
  await expect(page.getByText(/# How authentication works/)).toBeVisible();

  await screenshot(page, name);
  await assertNoOverflow(page);
}

test.describe('Project Chat Document Cards — Mobile', () => {
  test('renders tiered document cards without overflow', async ({ page }) => {
    await setupMocks(page);
    await renderAndAudit(page, 'project-chat-document-cards-mobile');
  });
});

test.describe('Project Chat Document Cards — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('renders tiered document cards without overflow', async ({ page }) => {
    await setupMocks(page);
    await renderAndAudit(page, 'project-chat-document-cards-desktop');
  });
});
