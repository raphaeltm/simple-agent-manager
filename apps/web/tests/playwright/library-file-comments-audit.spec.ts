/**
 * Visual + behavioural audit for library file comments (mobile 375 + desktop 1280).
 *
 * Required by .claude/rules/17-ui-visual-testing.md. Beyond screenshots, this
 * drives the real user action at both viewports — open the preview, open the
 * comment panel, select text in the rendered markdown, and post a quoted comment
 * — because a screenshot proves the panel renders, not that commenting works
 * (.claude/rules/62-tests-must-observe-the-real-trigger.md).
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

const PROJECT_ID = 'proj-library-comments';
const SESSION_ID = 'sess-library-comments';
const FILE_ID = 'markdown-file';
const FILE_NAME = 'design-notes.md';

test.use({ serviceWorkers: 'block' });

const MARKDOWN_BODY = [
  '# Design notes',
  '',
  'The quick brown fox jumps over the lazy dog and keeps going for quite a while.',
  '',
  '## Open questions',
  '',
  '- Should the retention window be configurable per project?',
  '- What happens when a supercalifragilisticexpialidociousidentifier overflows a narrow column?',
  '',
  '| Column | Value |',
  '| --- | --- |',
  '| Long text | A very long markdown table value that should wrap instead of pushing the modal wider than the viewport. |',
].join('\n');

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Library Comments Audit',
  repository: 'user/library-comments',
  repoProvider: 'github',
  createdAt: '2026-08-22T00:00:00Z',
  updatedAt: '2026-08-22T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Library comments audit',
  status: 'stopped',
  messageCount: 1,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  agentType: 'claude-code',
};

const MOCK_MESSAGES = [
  {
    id: FILE_ID,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: FILE_ID,
      status: 'completed',
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: FILE_ID },
      rawOutput: [
        {
          type: 'text',
          text: JSON.stringify({
            fileId: FILE_ID,
            filename: FILE_NAME,
            mimeType: 'text/markdown',
            sizeBytes: MARKDOWN_BODY.length,
          }),
        },
      ],
    },
    createdAt: Date.now() - 40_000,
    sequence: 1,
  },
];

const LONG_BODY =
  'This paragraph contradicts the section above it, and the reasoning behind the ' +
  'retention window is never stated anywhere in the document, which makes the ' +
  'whole section quite hard to review without more context from the author.';

const AUTHOR = {
  id: 'test-user',
  name: 'Test User',
  email: 'test@example.com',
  avatarUrl: null,
  kind: 'human',
};

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-1',
    clientMutationId: null,
    projectId: PROJECT_ID,
    fileId: FILE_ID,
    anchor: { kind: 'library_file', fileId: FILE_ID, quote: null },
    author: AUTHOR,
    body: 'Short note.',
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now() - 120_000,
    status: 'open',
    replies: [],
    ...overrides,
  };
}

type Scenario = 'empty' | 'populated' | 'error';

async function setupMocks(page: Page, scenario: Scenario) {
  const created: Record<string, unknown>[] = [];

  await page.route('**/*', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === `/api/projects/${PROJECT_ID}/library/${FILE_ID}/preview`) {
      return route.fulfill({ status: 200, contentType: 'text/markdown', body: MARKDOWN_BODY });
    }

    if (path === `/api/projects/${PROJECT_ID}/library/${FILE_ID}/comments`) {
      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON() as {
          body: string;
          quote?: string | null;
          clientMutationId?: string | null;
        };
        const saved = thread({
          id: `thread-created-${created.length + 1}`,
          clientMutationId: payload.clientMutationId ?? null,
          body: payload.body,
          anchor: { kind: 'library_file', fileId: FILE_ID, quote: payload.quote ?? null },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        created.push(saved);
        return route.fulfill({ status: 201, json: { thread: saved, idempotent: false } });
      }

      if (scenario === 'error') {
        return route.fulfill({
          status: 404,
          json: { error: 'NOT_FOUND', message: 'Library file not found' },
        });
      }

      const seeded =
        scenario === 'populated'
          ? [
              thread({
                id: 'thread-quoted',
                body: LONG_BODY,
                anchor: {
                  kind: 'library_file',
                  fileId: FILE_ID,
                  quote: 'The quick brown fox jumps over the lazy dog and keeps going for quite a while.',
                },
              }),
              thread({
                id: 'thread-resolved',
                body: 'Fixed in the latest revision.',
                status: 'resolved',
              }),
              thread({
                id: 'thread-unbroken',
                body: 'See https://example.com/a/very/long/unbroken/url/that/cannot/wrap/anywhere/at/all/really',
              }),
            ]
          : [];
      return route.fulfill({ status: 200, json: { threads: [...seeded, ...created], hasMore: false } });
    }

    return route.fallback();
  });

  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages: MOCK_MESSAGES,
  });
}

async function openPreview(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await page.getByRole('button', { name: `Open ${FILE_NAME}` }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: FILE_NAME })).toBeVisible();
  // The markdown must actually be rendered before anything can be selected in it.
  await expect(page.getByRole('heading', { name: 'Design notes' })).toBeVisible();
}

/**
 * The chat page behind the modal has its own "Comments" sidebar on desktop, so
 * every panel assertion is scoped to the preview dialog.
 */
function commentPanel(page: Page) {
  return page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: FILE_NAME }) });
}

async function openCommentPanel(page: Page) {
  await page.getByRole('button', { name: 'Show comments' }).click();
  await expect(commentPanel(page).getByRole('heading', { name: 'Comments' })).toBeVisible();
}

/** Selects the whole first paragraph of the rendered markdown, as a user drag would. */
async function selectFirstParagraph(page: Page) {
  await page.evaluate(() => {
    const anchor = document.querySelector('[data-comment-anchor]');
    const paragraph = anchor?.querySelector('p');
    if (!paragraph) throw new Error('rendered markdown paragraph not found');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new Event('mouseup'));
  });
}

function suffixFor(page: Page) {
  return page.viewportSize()?.width === 375 ? 'mobile' : 'desktop';
}

test.describe('Library file comments', () => {
  test('empty state', async ({ page }) => {
    await setupMocks(page, 'empty');
    await openPreview(page);
    await openCommentPanel(page);

    await expect(commentPanel(page).getByText('No comments on this file yet.')).toBeVisible();
    await screenshot(page, `library-file-comments-empty-${suffixFor(page)}`);
    await assertNoOverflow(page);
  });

  test('populated with long text, a long quote and an unbreakable URL', async ({ page }) => {
    await setupMocks(page, 'populated');
    await openPreview(page);
    await openCommentPanel(page);

    const panel = commentPanel(page);
    await expect(panel.getByText(LONG_BODY)).toBeVisible();
    await expect(panel.getByText('Fixed in the latest revision.')).toHaveCount(0); // collapsed
    await expect(panel.getByRole('button', { name: /Show resolved thread/ })).toBeVisible();
    await screenshot(page, `library-file-comments-populated-${suffixFor(page)}`);
    await assertNoOverflow(page);
  });

  test('load error is surfaced, not swallowed into an empty state', async ({ page }) => {
    await setupMocks(page, 'error');
    await openPreview(page);
    await openCommentPanel(page);

    const panel = commentPanel(page);
    await expect(panel.getByText('Library file not found')).toBeVisible();
    await expect(panel.getByText('No comments on this file yet.')).toHaveCount(0);
    await screenshot(page, `library-file-comments-error-${suffixFor(page)}`);
    await assertNoOverflow(page);
  });

  test('a user can select text in the preview and post a quoted comment', async ({ page }) => {
    await setupMocks(page, 'empty');
    await openPreview(page);

    // The real trigger: select text in the rendered markdown.
    await selectFirstParagraph(page);

    // Coarse pointers get the bottom action bar, fine pointers the popover; both
    // are labelled "Comment on selection", so this covers either without
    // asserting which one the viewport happens to produce.
    const selectionUi = page.getByLabel('Comment on selection');
    const commentOnSelection = selectionUi.getByRole('button').first();
    await expect(commentOnSelection).toBeVisible();
    await screenshot(page, `library-file-comments-selection-${suffixFor(page)}`);
    await assertNoOverflow(page);

    await commentOnSelection.click();

    // The panel opens with the selection quoted in the composer.
    const panel = commentPanel(page);
    await expect(panel.getByRole('heading', { name: 'Comments' })).toBeVisible();
    const composer = panel.getByPlaceholder('Comment on the selected text…');
    await expect(composer).toBeVisible();

    await composer.fill('This sentence needs a citation.');
    await screenshot(page, `library-file-comments-composing-${suffixFor(page)}`);
    await assertNoOverflow(page);

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.method() === 'POST' &&
          new URL(req.url()).pathname ===
            `/api/projects/${PROJECT_ID}/library/${FILE_ID}/comments`
      ),
      panel.getByRole('button', { name: 'Comment', exact: true }).click(),
    ]);

    // The quote actually reached the API — not just rendered in the composer.
    const payload = request.postDataJSON() as { body: string; quote: string | null };
    expect(payload.body).toBe('This sentence needs a citation.');
    expect(payload.quote).toContain('The quick brown fox');

    // And the posted comment is visible in the thread list.
    await expect(panel.getByText('This sentence needs a citation.')).toBeVisible();
    await screenshot(page, `library-file-comments-posted-${suffixFor(page)}`);
    await assertNoOverflow(page);

    // Closing and reopening the modal must not lose the thread. Comments are
    // read from the server on mount rather than held in component state, so this
    // is structurally safe today — the assertion is here to keep it that way if
    // someone later introduces client-local comment state.
    // On mobile the comment panel is a full-width overlay that covers the header,
    // so closing it first is what a real user does there too.
    await page.getByRole('button', { name: 'Close comments' }).click();
    await page.getByRole('button', { name: 'Close preview' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: `Open ${FILE_NAME}` }).click();
    await openCommentPanel(page);
    await expect(
      commentPanel(page).getByText('This sentence needs a citation.')
    ).toBeVisible();
  });
});
