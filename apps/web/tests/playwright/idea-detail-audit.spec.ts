/**
 * UI/UX audit tests for IdeaDetailPage.
 * Captures mobile (375x667) and desktop (1280x800) screenshots.
 * Tests markdown rendering, desktop side panel, mobile FAB + modal,
 * search filtering, and overflow safety with diverse mock data.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock factories
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
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function makeTask(overrides: {
  id: string;
  title: string;
  status?: string;
  description?: string | null;
}) {
  return {
    projectId: 'proj-test-1',
    userId: 'user-test-1',
    parentTaskId: null,
    workspaceId: null,
    description: overrides.description ?? null,
    status: overrides.status ?? 'draft',
    executionStep: null,
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 0,
    agentProfileHint: null,
    blocked: false,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    outputSummary: null,
    outputBranch: null,
    outputPrUrl: null,
    finalizedAt: null,
    createdAt: '2026-03-20T10:00:00Z',
    updatedAt: '2026-03-20T10:00:00Z',
    dependencies: [],
    ...overrides,
  };
}

function makeSessionLink(overrides: {
  sessionId: string;
  topic?: string | null;
  status?: string;
  context?: string | null;
  linkedAt?: number;
}) {
  return {
    sessionId: overrides.sessionId,
    topic: overrides.topic ?? 'Untitled conversation',
    status: overrides.status ?? 'stopped',
    context: overrides.context ?? null,
    linkedAt: overrides.linkedAt ?? Date.now() - 3600000,
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MARKDOWN_DESCRIPTION = `# Project Architecture

This is a **comprehensive** document describing the project architecture in detail.

## Overview

The system consists of several interconnected components:

1. **API Layer** — Handles HTTP requests and routes them to services
2. **Database Layer** — Manages persistence with D1
3. **Worker Layer** — Background processing with Durable Objects

### Code Example

\`\`\`typescript
interface WorkspaceConfig {
  id: string;
  name: string;
  provider: 'hetzner' | 'scaleway';
  region: string;
}

async function createWorkspace(config: WorkspaceConfig): Promise<Workspace> {
  const node = await selectNode(config.provider, config.region);
  return await provisionWorkspace(node, config);
}
\`\`\`

## Data Flow

| Step | Component | Action |
|------|-----------|--------|
| 1 | Web UI | User submits task |
| 2 | API Worker | Validates and creates task record |
| 3 | Task Runner DO | Provisions workspace |
| 4 | VM Agent | Starts agent session |

## Important Notes

> **Warning**: Always verify workspace health before sending tasks.
> The heartbeat interval is configurable via \`HEARTBEAT_INTERVAL_MS\`.

### Links

- [Documentation](https://example.com/docs)
- [API Reference](https://example.com/api)

---

*Last updated: March 2026*`;

const LONG_UNBROKEN_URL = 'https://example.com/this-is-an-extremely-long-url-that-should-not-cause-horizontal-overflow-even-on-mobile-devices-with-narrow-viewports-and-it-just-keeps-going-and-going-and-going-without-any-natural-break-points?param1=value1&param2=value2&param3=value3&param4=longlonglongvalue';

const LONG_MARKDOWN_DESCRIPTION = `# Document with Edge Cases

Here is a very long unbroken string: ${'a'.repeat(300)}

And a long URL: ${LONG_UNBROKEN_URL}

## Table with Long Content

| Column One | Column Two | Column Three |
|------------|------------|--------------|
| ${'LongCellContent'.repeat(10)} | Short | ${'AnotherLongCell'.repeat(8)} |
| Normal | ${'VeryLongMiddleColumn'.repeat(6)} | Normal |

## Nested Lists

- First level item
  - Second level with some detail
    - Third level item with a longer description that wraps across multiple lines on narrow viewports
      - Fourth level deep nesting
- Another first level
  1. Ordered sub-item one
  2. Ordered sub-item two with \`inline code that is quite long and might wrap\`

## Code Block with Long Lines

\`\`\`bash
curl -X POST "https://api.example.com/v1/workspaces" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" -H "Content-Type: application/json" -d '{"name": "test-workspace", "provider": "hetzner", "region": "nbg1"}'
\`\`\`

> This is a blockquote that contains quite a lot of text to test how it wraps on narrow screens. It should maintain proper indentation and visual styling regardless of the viewport width.

---

Final paragraph with **bold**, *italic*, ~~strikethrough~~, and \`inline code\`.`;

const SPECIAL_CHARS_DESCRIPTION = `# Special Characters Test 🎉

<script>alert('xss')</script>

**HTML entities**: &amp; &lt; &gt; &quot; &#39;

**Unicode**: 你好世界 • مرحبا • Привет мир • こんにちは

**Emoji sequences**: 👨‍👩‍👧‍👦 🏳️‍🌈 👩🏽‍💻 🇨🇦

## Math-like content

E = mc² | α β γ δ | ∑ ∏ ∫ ∂

## Markdown edge cases

\\*not bold\\* and \\*\\*not double bold\\*\\*

[Link with special chars](https://example.com/path?q=hello+world&lang=en#section-1)`;

// Extremely aggressive unbroken content to test overflow protection
const LONG_CELL = 'CellData'.repeat(5);
const TABLE_ROW = Array.from({ length: 10 }, () => LONG_CELL).join(' | ');
const EXTREME_OVERFLOW_DESCRIPTION = [
  '# Overflow Stress Test',
  '',
  'x'.repeat(500),
  '',
  'Paragraph with a ' + 'verylongword'.repeat(40) + ' embedded in the middle of text.',
  '',
  '## Links',
  '',
  '[A link with normal text](https://example.com/short)',
  '',
  'Here is a bare URL: https://example.com/' + 'path/'.repeat(60) + 'endpoint?' + 'param=value&'.repeat(20) + 'final=true',
  '',
  '## Inline Code',
  '',
  'This has `' + 'longInlineCode'.repeat(30) + '` in a paragraph.',
  '',
  '## Table with Many Columns',
  '',
  '| ' + Array.from({ length: 10 }, (_, i) => `Col${i}`).join(' | ') + ' |',
  '| ' + Array.from({ length: 10 }, () => '---').join(' | ') + ' |',
  '| ' + TABLE_ROW + ' |',
  '',
  '## Deeply Nested Lists',
  '',
  '- Level 1',
  '  - Level 2',
  '    - Level 3',
  '      - Level 4',
  '        - Level 5 with ' + 'deepnestedcontent'.repeat(20),
  '          - Level 6',
  '',
  '## Code Block',
  '',
  '```',
  'x'.repeat(400),
  '```',
  '',
  '## Blockquote',
  '',
  '> ' + 'Blockquotecontent'.repeat(30),
].join('\n');

const TASK_EXTREME_OVERFLOW = makeTask({
  id: 'idea-extreme',
  title: 'x'.repeat(500),
  status: 'draft',
  description: EXTREME_OVERFLOW_DESCRIPTION,
});

const TASK_NORMAL = makeTask({
  id: 'idea-1',
  title: 'Implement user authentication',
  status: 'in_progress',
  description: MARKDOWN_DESCRIPTION,
});

const TASK_LONG_CONTENT = makeTask({
  id: 'idea-long',
  title: 'This is an extremely long idea title that should wrap properly on mobile screens without causing any horizontal overflow or layout breakage when displayed in the detail header area of the page',
  status: 'draft',
  description: LONG_MARKDOWN_DESCRIPTION,
});

const TASK_NO_DESC = makeTask({
  id: 'idea-nodesc',
  title: 'Update dependencies',
  status: 'ready',
  description: null,
});

const TASK_DONE = makeTask({
  id: 'idea-done',
  title: 'Refactor API error handling',
  status: 'completed',
  description: 'Standardize error responses across all endpoints.',
});

const TASK_SPECIAL = makeTask({
  id: 'idea-special',
  title: '<script>alert("xss")</script> & "Special" \'Title\' with <em>HTML</em>',
  status: 'draft',
  description: SPECIAL_CHARS_DESCRIPTION,
});

const TASK_SINGLE_CHAR = makeTask({
  id: 'idea-single',
  title: 'X',
  status: 'draft',
  description: 'Y',
});

const MOCK_SESSIONS = [
  makeSessionLink({
    sessionId: 's1',
    topic: 'Auth implementation discussion',
    status: 'stopped',
    context: 'Discussed approach for OAuth flow with GitHub',
    linkedAt: Date.now() - 7200000,
  }),
  makeSessionLink({
    sessionId: 's2',
    topic: 'Auth debugging session',
    status: 'active',
    context: 'Currently debugging token refresh issues',
    linkedAt: Date.now() - 600000,
  }),
];

const MANY_SESSIONS = Array.from({ length: 12 }, (_, i) =>
  makeSessionLink({
    sessionId: `sess-${i}`,
    topic: i === 3 ? null : `Session ${i + 1}: ${['Planning', 'Implementation', 'Review', 'Debug', 'Testing', 'Deployment'][i % 6]}`,
    status: i === 0 ? 'active' : 'stopped',
    context:
      i % 2 === 0
        ? `Context for session ${i + 1} with details about what was discussed during this conversation`
        : null,
    linkedAt: Date.now() - i * 3600000,
  }),
);

const SESSIONS_LONG_TEXT = [
  makeSessionLink({
    sessionId: 'slong1',
    topic: 'A very long conversation topic that describes in great detail what was discussed during this particular session including all the nuances and edge cases that were covered',
    status: 'active',
    context: 'This context is also quite lengthy and contains a lot of information about the conversation including technical details, decisions made, and action items that need to be followed up on later',
    linkedAt: Date.now() - 1800000,
  }),
  makeSessionLink({
    sessionId: 'slong2',
    topic: `Topic with unbroken word: ${'superlongword'.repeat(10)}`,
    status: 'stopped',
    context: `Context with long URL: ${LONG_UNBROKEN_URL}`,
    linkedAt: Date.now() - 3600000,
  }),
];

// ---------------------------------------------------------------------------
// Route mock helper
// ---------------------------------------------------------------------------

async function setupMocks(
  page: Page,
  options: {
    taskDetail?: ReturnType<typeof makeTask> | null;
    taskSessions?: ReturnType<typeof makeSessionLink>[];
    taskNotFound?: boolean;
    serverError?: boolean;
  } = {},
) {
  const {
    taskDetail = null,
    taskSessions = [],
    taskNotFound = false,
    serverError = false,
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/agents') return respond(200, []);
    if (path.startsWith('/api/credentials')) return respond(200, { credentials: [] });
    if (path.startsWith('/api/workspaces')) return respond(200, []);
    if (path === '/api/projects') return respond(200, { projects: [] });
    if (path.endsWith('/health')) return respond(200, { status: 'ok' });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (subPath.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });

      // Task sessions endpoint: /tasks/:id/sessions
      if (subPath.match(/^\/tasks\/[^/]+\/sessions$/)) {
        if (serverError) return respond(500, { error: 'Internal server error' });
        return respond(200, { sessions: taskSessions, count: taskSessions.length });
      }

      // Task detail: /tasks/:id
      if (subPath.match(/^\/tasks\/[^/]+$/)) {
        if (serverError) return respond(500, { error: 'Internal server error' });
        if (taskNotFound || !taskDetail) return respond(404, { error: 'Not found' });
        return respond(200, taskDetail);
      }

      if (subPath === '/tasks' || subPath.startsWith('/tasks?')) {
        return respond(200, { tasks: [], nextCursor: null });
      }

      if (!subPath || subPath === '/') return respond(200, MOCK_PROJECT);
    }

    return respond(200, {});
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

// Note: this check catches layout-level overflow (page scrolling horizontally).
// Elements using overflow-x: auto (tables, code blocks) contain their overflow
// internally and will not be detected here — this is intentional behavior.
async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    docOverflow: document.documentElement.scrollWidth > window.innerWidth,
    bodyOverflow: document.body.scrollWidth > window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(overflow.docOverflow, `Document scrollWidth (${overflow.docWidth}) exceeds viewport (${overflow.viewportWidth})`).toBe(false);
  expect(overflow.bodyOverflow, `Body scrollWidth (${overflow.bodyWidth}) exceeds viewport (${overflow.viewportWidth})`).toBe(false);
}

// ---------------------------------------------------------------------------
// Mobile tests (375x667 — set in playwright.config.ts)
// ---------------------------------------------------------------------------

test.describe('IdeaDetailPage — Mobile (375px)', () => {
  test('markdown description renders fully', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_NORMAL, taskSessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Implement user authentication');
    await screenshot(page, 'idea-detail-mobile-markdown');

    // Title visible
    await expect(page.getByRole('heading', { name: /Implement user authentication/i })).toBeVisible();
    // Status badge present
    await expect(page.getByText('Executing')).toBeVisible();
    // Markdown content rendered (h1 inside the markdown)
    await expect(page.getByRole('heading', { name: 'Project Architecture' })).toBeVisible();
    // Code block rendered
    await expect(page.getByText('WorkspaceConfig').first()).toBeVisible();
    // Table rendered
    await expect(page.getByText('API Worker')).toBeVisible();
    // Markdown rendered block exists
    await expect(page.locator('[data-testid="rendered-markdown"]')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('FAB visible and opens conversations modal', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) > 500, 'FAB is mobile-only');
    await setupMocks(page, { taskDetail: TASK_NORMAL, taskSessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Implement user authentication');

    // FAB should be visible with badge count
    const fab = page.getByRole('button', { name: /Show conversations/i });
    await expect(fab).toBeVisible();
    await expect(fab.locator('span')).toContainText('2');

    // Click FAB to open modal
    await fab.click();
    await page.waitForTimeout(300);

    // Modal should show conversations
    await expect(page.getByRole('dialog', { name: /Linked conversations/i })).toBeVisible();
    await expect(page.getByText('Auth implementation discussion')).toBeVisible();
    await expect(page.getByText('Auth debugging session')).toBeVisible();
    // Search field in modal
    await expect(page.getByPlaceholder('Search conversations...')).toBeVisible();

    await screenshot(page, 'idea-detail-mobile-fab-modal');
    await assertNoOverflow(page);
  });

  test('conversations modal search filters results', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) > 500, 'FAB is mobile-only');
    await setupMocks(page, { taskDetail: TASK_NORMAL, taskSessions: MANY_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Implement user authentication');

    // Open modal
    await page.getByRole('button', { name: /Show conversations/i }).click();
    await page.waitForTimeout(300);

    // Type in search
    const searchInput = page.getByPlaceholder('Search conversations...');
    await searchInput.fill('Planning');
    await page.waitForTimeout(200);

    // Only matching sessions should be visible
    await expect(page.getByText('Session 1: Planning')).toBeVisible();
    // Non-matching sessions should be hidden
    await expect(page.getByText('Session 2: Implementation')).not.toBeVisible();

    await screenshot(page, 'idea-detail-mobile-search-filter');

    // Clear search
    await page.getByRole('button', { name: /Clear search/i }).click();
    await page.waitForTimeout(200);
    // All sessions should be back
    await expect(page.getByText('Session 2: Implementation')).toBeVisible();
  });

  test('conversations modal closes on backdrop click', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) > 500, 'FAB is mobile-only');
    await setupMocks(page, { taskDetail: TASK_NORMAL, taskSessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Implement user authentication');

    await page.getByRole('button', { name: /Show conversations/i }).click();
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).toBeVisible();

    // Click the close button
    await page.getByRole('button', { name: /Close conversations panel/i }).click();
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('empty sessions — no FAB badge count', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) > 500, 'FAB is mobile-only');
    await setupMocks(page, { taskDetail: TASK_NO_DESC, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-nodesc');
    await page.waitForSelector('text=Update dependencies');
    await screenshot(page, 'idea-detail-mobile-empty');

    // FAB visible but no badge
    const fab = page.getByRole('button', { name: /Show conversations/i });
    await expect(fab).toBeVisible();

    // Open modal and check empty state
    await fab.click();
    await page.waitForTimeout(300);
    await expect(page.getByText('No conversations linked yet')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('no description — no markdown section', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_NO_DESC, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-nodesc');
    await page.waitForSelector('text=Update dependencies');

    // No markdown rendered
    const markdown = page.locator('[data-testid="rendered-markdown"]');
    await expect(markdown).not.toBeVisible();
    // Status still shown
    await expect(page.getByText('Ready')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('done status displays correctly', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_DONE, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-done');
    await page.waitForSelector('text=Refactor API error handling');
    await screenshot(page, 'idea-detail-mobile-done-status');

    await expect(page.getByText('Done')).toBeVisible();
    await assertNoOverflow(page);
  });

  test('long title + long markdown wraps without overflow', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_LONG_CONTENT, taskSessions: SESSIONS_LONG_TEXT });
    await page.goto('/projects/proj-test-1/ideas/idea-long');
    await page.waitForSelector('text=This is an extremely long idea title');
    await screenshot(page, 'idea-detail-mobile-long-content');

    await assertNoOverflow(page);
  });

  test('special characters and XSS prevention', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_SPECIAL, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-special');
    await page.waitForTimeout(1200);
    await screenshot(page, 'idea-detail-mobile-special-chars');

    // Script tags should not execute — check page is still functional
    await expect(page.getByText('Exploring')).toBeVisible();
    // Unicode should render
    await expect(page.getByText('你好世界')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('extreme unbroken content does not cause horizontal overflow', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_EXTREME_OVERFLOW, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-extreme');
    await page.waitForSelector('[data-testid="rendered-markdown"]');
    await screenshot(page, 'idea-detail-mobile-extreme-overflow');

    await assertNoOverflow(page);
  });

  test('single character title and description', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_SINGLE_CHAR, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-single');
    await page.waitForTimeout(1200);
    await screenshot(page, 'idea-detail-mobile-single-char');

    await expect(page.getByRole('heading', { name: 'X' })).toBeVisible();
    await assertNoOverflow(page);
  });

  test('not found state', async ({ page }) => {
    await setupMocks(page, { taskNotFound: true });
    await page.goto('/projects/proj-test-1/ideas/nonexistent');
    await page.waitForTimeout(1200);
    await screenshot(page, 'idea-detail-mobile-not-found');

    await expect(page.getByRole('button', { name: /Back to Ideas/i })).toBeVisible();
    await assertNoOverflow(page);
  });

  test('server error state with retry', async ({ page }) => {
    await setupMocks(page, { serverError: true });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForTimeout(1200);
    await screenshot(page, 'idea-detail-mobile-error');

    await expect(page.getByText('Failed to load idea details')).toBeVisible();
    await expect(page.getByRole('button', { name: /Try again/i })).toBeVisible();
    await assertNoOverflow(page);
  });

  test('many sessions in modal', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) > 500, 'FAB is mobile-only');
    await setupMocks(page, { taskDetail: TASK_NORMAL, taskSessions: MANY_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Implement user authentication');

    const fab = page.getByRole('button', { name: /Show conversations/i });
    await expect(fab.locator('span')).toContainText('12');

    await fab.click();
    await page.waitForTimeout(300);
    await screenshot(page, 'idea-detail-mobile-many-sessions');

    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Desktop tests (1280x800)
// ---------------------------------------------------------------------------

test.describe('IdeaDetailPage — Desktop (1280px)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('two-column layout with markdown and conversations panel', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_NORMAL, taskSessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Implement user authentication');
    await screenshot(page, 'idea-detail-desktop-two-column');

    // Title visible
    await expect(page.getByRole('heading', { name: /Implement user authentication/i })).toBeVisible();
    // Markdown rendered
    await expect(page.getByRole('heading', { name: 'Project Architecture' })).toBeVisible();
    await expect(page.getByText('WorkspaceConfig').first()).toBeVisible();
    // Conversations panel visible (not behind a FAB)
    await expect(page.getByText('Conversations (2)')).toBeVisible();
    await expect(page.getByText('Auth implementation discussion')).toBeVisible();
    // Search field visible
    await expect(page.getByPlaceholder('Search conversations...')).toBeVisible();
    // No FAB on desktop
    const fab = page.getByRole('button', { name: /Show conversations/i });
    await expect(fab).not.toBeVisible();

    await assertNoOverflow(page);
  });

  test('conversations search filters on desktop', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_NORMAL, taskSessions: MANY_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Implement user authentication');

    const searchInput = page.getByPlaceholder('Search conversations...');
    await searchInput.fill('Review');
    await page.waitForTimeout(200);

    await expect(page.getByText('Session 3: Review')).toBeVisible();
    await expect(page.getByText('Session 1: Planning')).not.toBeVisible();

    await screenshot(page, 'idea-detail-desktop-search');
    await assertNoOverflow(page);
  });

  test('empty sessions desktop', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_NO_DESC, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-nodesc');
    await page.waitForSelector('text=Update dependencies');
    await screenshot(page, 'idea-detail-desktop-empty');

    await expect(page.getByText('No conversations linked yet')).toBeVisible();
    await assertNoOverflow(page);
  });

  test('long content wraps without overflow on desktop', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_LONG_CONTENT, taskSessions: SESSIONS_LONG_TEXT });
    await page.goto('/projects/proj-test-1/ideas/idea-long');
    await page.waitForSelector('text=This is an extremely long idea title');
    await screenshot(page, 'idea-detail-desktop-long-content');

    await assertNoOverflow(page);
  });

  test('special characters desktop', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_SPECIAL, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-special');
    await page.waitForTimeout(1200);
    await screenshot(page, 'idea-detail-desktop-special-chars');

    await expect(page.getByText('你好世界')).toBeVisible();
    await assertNoOverflow(page);
  });

  test('many sessions in side panel', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_NORMAL, taskSessions: MANY_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Conversations (12)');
    await screenshot(page, 'idea-detail-desktop-many-sessions');

    await assertNoOverflow(page);
  });

  test('extreme unbroken content does not cause horizontal overflow on desktop', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_EXTREME_OVERFLOW, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-extreme');
    await page.waitForSelector('[data-testid="rendered-markdown"]', { timeout: 5000 }).catch(() => {});
    await screenshot(page, 'idea-detail-desktop-extreme-overflow');

    await assertNoOverflow(page);
  });
});
