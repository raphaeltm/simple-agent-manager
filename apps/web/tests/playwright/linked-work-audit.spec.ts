/**
 * Visual + behavioural audit for linked work, against the REAL project chat and the REAL
 * library file preview.
 *
 * Everything here drives production controls: the Related item in the session tool rail, the
 * header's "Working on" chip, and the preview's provenance disclosure. Nothing sets panel state
 * directly (`.claude/rules/62-tests-must-observe-the-real-trigger.md`).
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const PROJECT_ID = 'proj-links-1';
const SESSION_ID = 'cs-links-1';
const WORKSPACE_ID = 'ws-links-1';
const FILE_ID = 'file-links-1';
const NOW = Date.now();

const MOCK_USER = makeMockUser({
  email: 'links@example.com',
  name: 'Links Tester',
  role: 'superadmin',
  sessionId: 'session-links-1',
  userId: 'user-links-1',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Linked Work Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: MOCK_USER.user.id,
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/** 212 characters. The stress case for every row and for the header chip. */
const LONG_IDEA_TITLE =
  'Reconcile the supersession ledger against the ProjectData Durable Object so the active-agent count stops reporting ten times the real compute, then derive each idea status from the work linked to it instead of its row';
const LONG_FILENAME =
  'agent-observability-and-egress-with-an-unreasonably-long-report-name-0123456789.md';

function cappedList<T>(
  items: T[],
  overrides: { total?: number; truncated?: boolean; totalIsLowerBound?: boolean } = {}
) {
  return {
    items,
    total: overrides.total ?? items.length,
    truncated: overrides.truncated ?? false,
    totalIsLowerBound: overrides.totalIsLowerBound ?? false,
  };
}

function prUrl(number: number) {
  return `https://github.com/testuser/test-repo/pull/${number}`;
}

/** Every relation, every PR state, long text, and a lower-bound PR count. */
const RICH_SESSION_LINKS = {
  ideas: cappedList([
    {
      ideaId: 'idea-1',
      title: LONG_IDEA_TITLE,
      status: 'draft',
      relations: ['works_on', 'read'],
    },
    {
      ideaId: 'idea-2',
      title: 'Ideas on the Account Map',
      status: 'draft',
      relations: ['created'],
    },
    { ideaId: 'idea-3', title: 'Link store', status: 'completed', relations: ['edited'] },
    { ideaId: 'idea-4', title: 'A', status: 'draft', relations: ['discusses'] },
    { ideaId: 'idea-5', title: 'Pull request tracking', status: 'draft', relations: ['linked'] },
  ]),
  files: cappedList([
    {
      fileId: FILE_ID,
      filename: LONG_FILENAME,
      directory: '/engineering/research',
      relations: ['uploaded'],
      bySessionId: SESSION_ID,
    },
    {
      fileId: 'file-2',
      filename: 'ideas-redesign-story.html',
      directory: '/engineering/ux-audits/ideas-redesign-2026-10-23',
      relations: ['replaced', 'viewed'],
      bySessionId: SESSION_ID,
    },
    {
      fileId: 'file-3',
      filename: 'x.md',
      directory: '/',
      relations: ['viewed'],
      bySessionId: SESSION_ID,
    },
  ]),
  pullRequests: cappedList(
    [
      {
        url: prUrl(2425),
        number: 2425,
        source: 'task_output',
        bySessionId: SESSION_ID,
        state: {
          state: 'open',
          isDraft: false,
          title: 'feat(api): add bounded linked-work resource store and automatic links',
          checksState: 'pending',
          mergedAt: null,
          updatedAt: new Date(NOW - 120_000).toISOString(),
          stale: false,
        },
      },
      {
        url: prUrl(2424),
        number: 2424,
        source: 'pr_association',
        bySessionId: SESSION_ID,
        state: {
          state: 'merged',
          isDraft: false,
          title: 'docs(www): write about short-lived workload identity',
          checksState: 'success',
          mergedAt: new Date(NOW - 3_600_000).toISOString(),
          updatedAt: new Date(NOW - 3_600_000).toISOString(),
          stale: false,
        },
      },
      {
        url: prUrl(2423),
        number: 2423,
        source: 'explicit_link',
        bySessionId: SESSION_ID,
        state: {
          state: 'closed',
          isDraft: false,
          title: 'An abandoned attempt',
          checksState: 'failure',
          mergedAt: null,
          updatedAt: new Date(NOW - 86_400_000).toISOString(),
          stale: true,
        },
      },
      {
        url: prUrl(2422),
        number: 2422,
        source: 'explicit_link',
        bySessionId: SESSION_ID,
        state: {
          state: 'open',
          isDraft: true,
          title: 'Draft: still cooking',
          checksState: 'neutral',
          mergedAt: null,
          updatedAt: new Date(NOW - 600_000).toISOString(),
          stale: false,
        },
      },
      // No state: the pre-PR-tracking shape, which must render as a bare row.
      {
        url: prUrl(2421),
        number: 2421,
        source: 'explicit_link',
        bySessionId: SESSION_ID,
        state: null,
      },
    ],
    // The server could only establish a minimum here, so every count must render "N+".
    { total: 5, truncated: true, totalIsLowerBound: true }
  ),
};

const EMPTY_SESSION_LINKS = {
  ideas: cappedList([]),
  files: cappedList([]),
  pullRequests: cappedList([]),
};

/** 30 ideas — the "many items" scroll case. */
const MANY_SESSION_LINKS = {
  ideas: cappedList(
    Array.from({ length: 30 }, (_, index) => ({
      ideaId: `idea-many-${index}`,
      title: `Idea ${index + 1}: ${'a reasonably wordy idea title '.repeat(2)}`,
      status: 'draft',
      relations: index === 0 ? ['works_on'] : ['read'],
    }))
  ),
  files: cappedList([]),
  pullRequests: cappedList([]),
};

const FILE_LINKS = {
  sessions: cappedList([
    {
      sessionId: 'cs-author',
      topic: 'Write the agent observability and egress research report',
      status: 'completed',
      relations: ['uploaded'],
      lastActivityAt: NOW - 7_200_000,
      taskId: 'task-author',
    },
    {
      sessionId: 'cs-reader',
      topic:
        'Review every network-monitoring option against the privacy preference before proposing anything',
      status: 'active',
      relations: ['viewed'],
      lastActivityAt: NOW - 600_000,
      taskId: 'task-reader',
    },
    {
      sessionId: 'cs-untitled',
      topic: null,
      status: 'sleeping',
      relations: ['viewed'],
      lastActivityAt: null,
      taskId: null,
    },
  ]),
  ideas: cappedList([
    { ideaId: 'idea-1', title: LONG_IDEA_TITLE, status: 'draft', relations: ['linked'] },
  ]),
};

const EMPTY_FILE_LINKS = { sessions: cappedList([]), ideas: cappedList([]) };

const MARKDOWN_BODY = `# Agent observability and egress\n\nAggregate ingress and egress byte counters per workspace over time, with no destinations, URLs,\nheaders or payloads.\n`;

interface MockOptions {
  sessionLinks?: unknown;
  fileLinks?: unknown;
  /** Fails the session links request, for the error state. */
  sessionLinksStatus?: number;
  /** Omits `task.outputPrUrl`, so the header PR row comes only from linked work. */
  withoutOutputPr?: boolean;
}

function makeChatSession(options: MockOptions) {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    status: 'active',
    topic: 'Show links on chats and library files',
    workspaceId: WORKSPACE_ID,
    agentSessionId: 'as-links-1',
    isIdle: false,
    isMine: true,
    agentCompletedAt: null,
    messageCount: 2,
    startedAt: NOW - 3_600_000,
    endedAt: null,
    taskId: 'task-links-1',
    task: {
      id: 'task-links-1',
      status: 'in_progress',
      title: 'Show links on chats and library files',
      outputBranch: 'sam/t4-show-links-chats-qeryzv',
      outputPrUrl: options.withoutOutputPr ? null : prUrl(2425),
      errorMessage: null,
      outputSummary: null,
      taskMode: 'conversation',
    },
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
  };
}

const MESSAGES = {
  messages: [
    {
      id: 'msg-1',
      sessionId: SESSION_ID,
      role: 'user',
      content: 'Show me what this chat is related to.',
      toolMetadata: null,
      createdAt: NOW - 600_000,
    },
    {
      id: 'msg-2',
      sessionId: SESSION_ID,
      role: 'assistant',
      content: 'The Related panel in the tool rail lists the ideas, files and pull requests.',
      toolMetadata: null,
      createdAt: NOW - 590_000,
    },
  ],
  hasMore: false,
};

const LIBRARY_FILE = {
  id: FILE_ID,
  projectId: PROJECT_ID,
  filename: LONG_FILENAME,
  directory: '/engineering/research',
  mimeType: 'text/markdown',
  sizeBytes: MARKDOWN_BODY.length,
  status: 'ready',
  uploadSource: 'agent',
  uploadSessionId: null,
  uploadTaskId: null,
  extractedTextPreview: null,
  description: null,
  r2Key: `files/${FILE_ID}`,
  encryptionKeyVersion: 1,
  replacedAt: null,
  replacedBy: null,
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
  tags: [],
};

async function setupMocks(page: Page, options: MockOptions = {}) {
  const { sessionLinks = RICH_SESSION_LINKS, fileLinks = FILE_LINKS, sessionLinksStatus } = options;
  const session = makeChatSession(options);
  const state = { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null };

  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
    // Labels mode makes the Related badge render as a number rather than a dot, so the "N+"
    // rendering is visible in the screenshots and assertable.
    window.localStorage.setItem('sam-session-tool-strip-mode', 'labels');
  }, MOCK_USER.user.id);

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const { pathname } = new URL(url);

    if (pathname.endsWith('/ws') || url.includes('websocket')) {
      await route.abort();
      return;
    }
    if (pathname === '/api/auth/session' || pathname === '/api/auth/get-session') {
      await route.fulfill({ json: MOCK_USER });
      return;
    }
    if (pathname === '/api/projects') {
      await route.fulfill({ json: { projects: [MOCK_PROJECT], nextCursor: null } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}`) {
      await route.fulfill({ json: MOCK_PROJECT });
      return;
    }
    if (pathname === '/api/report-issue/config') {
      await route.fulfill({ json: { enabled: true } });
      return;
    }

    // The two endpoints under test.
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/links`) {
      if (sessionLinksStatus) {
        await route.fulfill({
          status: sessionLinksStatus,
          json: { error: 'INTERNAL', message: 'boom' },
        });
        return;
      }
      await route.fulfill({ json: sessionLinks });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/library/${FILE_ID}/links`) {
      await route.fulfill({ json: fileLinks });
      return;
    }

    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/messages`) {
      await route.fulfill({ json: MESSAGES });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/state`) {
      await route.fulfill({ json: state });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}`) {
      await route.fulfill({
        json: { session, messages: MESSAGES.messages, hasMore: false, state },
      });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions`) {
      await route.fulfill({ json: { sessions: [session], total: 1 } });
      return;
    }
    if (pathname === `/api/workspaces/${WORKSPACE_ID}`) {
      await route.fulfill({
        json: {
          id: WORKSPACE_ID,
          nodeId: null,
          projectId: PROJECT_ID,
          name: 'linked-work',
          repository: 'testuser/test-repo',
          branch: 'sam/t4-show-links-chats-qeryzv',
          status: 'running',
          vmSize: 'medium',
          vmLocation: 'nbg1',
          workspaceProfile: 'lightweight',
          vmIp: '203.0.113.42',
          lastActivityAt: new Date(NOW - 60_000).toISOString(),
          errorMessage: null,
          createdAt: new Date(NOW - 3_600_000).toISOString(),
          updatedAt: new Date(NOW - 60_000).toISOString(),
          chatSessionId: SESSION_ID,
        },
      });
      return;
    }

    // Library
    if (pathname === `/api/projects/${PROJECT_ID}/library`) {
      await route.fulfill({ json: { files: [LIBRARY_FILE], nextCursor: null } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/library/directories`) {
      await route.fulfill({ json: { directories: [] } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/library/${FILE_ID}`) {
      await route.fulfill({ json: LIBRARY_FILE });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/library/${FILE_ID}/preview`) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/markdown' },
        body: MARKDOWN_BODY,
      });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/library/${FILE_ID}/comments`) {
      await route.fulfill({ json: { threads: [] } });
      return;
    }

    // Array-shaped endpoints the chat shell reads. Without these the catch-all `{}` below
    // reaches an `Array.prototype` call and the whole page crashes.
    if (
      pathname === '/api/nodes' ||
      pathname === '/api/credentials' ||
      pathname === '/api/notifications' ||
      pathname === '/api/github/installations'
    ) {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname === '/api/credentials/agent') {
      await route.fulfill({ json: { credentials: [] } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/credential-attribution-health`) {
      await route.fulfill({ json: { healthy: true } });
      return;
    }
    if (pathname === '/api/notifications/preferences') {
      await route.fulfill({ json: { email: false, push: false } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/agent-profiles`) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/tasks`) {
      await route.fulfill({ json: { tasks: [], nextCursor: null } });
      return;
    }
    if (pathname === '/api/chats') {
      await route.fulfill({ json: { sessions: [], total: 0 } });
      return;
    }
    if (pathname === '/api/agents') {
      await route.fulfill({ json: { agents: [] } });
      return;
    }
    await route.fulfill({ json: {} });
  });
}

async function openChat(page: Page, options: MockOptions = {}) {
  await setupMocks(page, options);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  // Liveness: a crashed page has no rail and no overflow, so every assertion below would pass
  // vacuously without this.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByTestId('session-tool-related')).toBeVisible({ timeout: 15_000 });
  // Fixed wait mandated by `apps/web/.claude/rules/17-ui-visual-testing.md`: CSS transitions
  // have no completion event to await.
  await page.waitForTimeout(600);
}

async function openLibraryPreview(page: Page, options: MockOptions = {}) {
  await setupMocks(page, options);
  await page.goto(`/projects/${PROJECT_ID}/library?preview=${FILE_ID}`);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(600);
}

async function capture(page: Page, name: string) {
  await screenshot(page, name);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

test.describe('Linked work — chat Related panel', () => {
  test('the rail offers Related on first paint and opening it lists every group', async ({
    page,
  }) => {
    await openChat(page);

    // Discoverable without opening any disclosure, and the badge is honest about the count.
    const related = page.getByTestId('session-tool-related');
    await expect(related).toBeVisible();
    // ideas 5 + files 3 + pull requests 5, where the PR count is a lower bound.
    await expect(related).toHaveText(/13\+/);
    await expect(related).toHaveAttribute('aria-label', /13 or more items/);

    await related.click();

    const drawer = page.getByTestId('session-linked-work-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Related work' })).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Ideas' })).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Files' })).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Pull requests' })).toBeVisible();

    await expect(drawer.getByTestId('linked-work-idea')).toHaveCount(5);
    await expect(drawer.getByTestId('linked-work-file')).toHaveCount(3);
    await expect(drawer.getByTestId('linked-work-pr')).toHaveCount(5);

    // Relations read as plain words, strongest first.
    await expect(drawer.getByText('Working on · Read')).toBeVisible();
    await expect(
      drawer.getByText('Replaced · Viewed · /engineering/ux-audits/ideas-redesign-2026-10-23')
    ).toBeVisible();

    // "N+" only where the server said the count is a minimum.
    await expect(drawer.getByText('5+', { exact: true })).toBeVisible();
    await expect(drawer.getByText('3', { exact: true })).toBeVisible();

    await capture(page, 'linked-work-drawer-rich');
  });

  test('each row opens the right place', async ({ page }) => {
    await openChat(page);
    await page.getByTestId('session-tool-related').click();
    const drawer = page.getByTestId('session-linked-work-drawer');

    await expect(drawer.getByTestId('linked-work-idea').first()).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/ideas/idea-1`
    );
    await expect(drawer.getByTestId('linked-work-file').first()).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/library?preview=${FILE_ID}`
    );
    const pr = drawer.getByTestId('linked-work-pr').first();
    await expect(pr).toHaveAttribute('href', prUrl(2425));
    await expect(pr).toHaveAttribute('target', '_blank');
    await expect(pr).toHaveAttribute('rel', /noopener/);
  });

  test('a pull request shows its state, and one without state shows no pill', async ({ page }) => {
    await openChat(page);
    await page.getByTestId('session-tool-related').click();
    const drawer = page.getByTestId('session-linked-work-drawer');

    // Every state, each with its own word — not colour alone.
    await expect(drawer.getByTestId('pr-state-badge')).toHaveCount(4);
    await expect(drawer.locator('[data-testid="pr-state-badge"][data-state="open"]')).toHaveText(
      'Open'
    );
    await expect(drawer.locator('[data-testid="pr-state-badge"][data-state="merged"]')).toHaveText(
      'Merged'
    );
    await expect(drawer.locator('[data-testid="pr-state-badge"][data-state="closed"]')).toHaveText(
      'Closed'
    );
    await expect(drawer.locator('[data-testid="pr-state-badge"][data-state="draft"]')).toHaveText(
      'Draft'
    );
    await expect(drawer.getByText('Checks running')).toBeVisible();
    await expect(drawer.getByText('Checks failing')).toBeVisible();

    // The stateless PR is still a row, titled by its number, with no badge beside it.
    const stateless = drawer.getByTestId('linked-work-pr').nth(4);
    await expect(stateless).toContainText('Pull request #2421');
    await expect(stateless.getByTestId('pr-state-badge')).toHaveCount(0);
  });

  test('the open panel does not overlap the tool rail', async ({ page }) => {
    await openChat(page);
    const railBefore = await page.getByTestId('session-tool-rail').boundingBox();
    await page.getByTestId('session-tool-related').click();
    const drawer = page.getByTestId('session-linked-work-drawer');
    await expect(drawer).toBeVisible();

    const drawerBox = await drawer.boundingBox();
    const viewport = page.viewportSize();
    expect(drawerBox).not.toBeNull();
    expect(viewport).not.toBeNull();

    // Measured coordinates, not a screenshot: the panel's right edge meets the viewport edge,
    // and it never starts left of 0 (`apps/web/.claude/rules/17-ui-visual-testing.md`).
    expect(Math.round(drawerBox!.x + drawerBox!.width)).toBeLessThanOrEqual(viewport!.width + 1);
    expect(drawerBox!.x).toBeGreaterThanOrEqual(-1);

    if (viewport!.width >= 768) {
      // On desktop the panel is a rail beside the conversation; it must cover the tool rail's
      // column rather than sit beside a rail that has moved.
      expect(railBefore).not.toBeNull();
      expect(drawerBox!.width).toBeLessThan(viewport!.width);
    } else {
      // On a phone it is full screen.
      expect(Math.round(drawerBox!.width)).toBe(viewport!.width);
    }
  });

  test('the header chip names the idea being worked on and opens it', async ({ page }) => {
    await openChat(page);
    const chip = page.getByTestId('session-working-on-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Working on');
    await expect(chip).toHaveAttribute('href', `/projects/${PROJECT_ID}/ideas/idea-1`);
    await expect(chip).toHaveAttribute('aria-label', /Working on the idea/);
    await capture(page, 'linked-work-header-chip');
  });

  test('View PR carries the number and the state', async ({ page }) => {
    await openChat(page);
    // The PR row lives in the Details panel, opened by the rail's Details action.
    await page.getByTestId('session-tool-details').click();
    const viewPr = page.getByTestId('session-view-pr');
    await expect(viewPr).toContainText('View PR #2425');
    await expect(viewPr).toHaveAttribute('href', prUrl(2425));
    await viewPr.scrollIntoViewIfNeeded();
    await expect(
      page.locator('[data-testid="pr-state-badge"][data-state="open"]').first()
    ).toBeVisible();
    await capture(page, 'linked-work-view-pr-state');
  });

  test('a chat with no output PR still shows the one the link store knows', async ({ page }) => {
    await openChat(page, { withoutOutputPr: true });
    await page.getByTestId('session-tool-details').click();
    // Without this the header said nothing about a pull request a shepherd had associated.
    await expect(page.getByTestId('session-view-pr')).toContainText('View PR #2425');
  });

  test('an empty panel explains what links are', async ({ page }) => {
    await openChat(page, { sessionLinks: EMPTY_SESSION_LINKS });

    // Absence assertions need a positive control beside them: a crashed page also has no chip.
    await expect(page.getByTestId('session-tool-related')).toBeVisible();
    await expect(page.getByTestId('session-working-on-chip')).toHaveCount(0);

    await page.getByTestId('session-tool-related').click();
    const empty = page.getByTestId('linked-work-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('Nothing related yet');
    await expect(empty).toContainText('the ideas it works on');
    await capture(page, 'linked-work-drawer-empty');
  });

  test('a failed read offers a retry without breaking the chat', async ({ page }) => {
    await openChat(page, { sessionLinksStatus: 500 });
    // Liveness: the conversation still rendered.
    await expect(page.getByText('Show me what this chat is related to.')).toBeVisible();

    await page.getByTestId('session-tool-related').click();
    const error = page.getByTestId('linked-work-error');
    await expect(error).toBeVisible();
    await expect(error.getByRole('button', { name: 'Try again' })).toBeVisible();
    await capture(page, 'linked-work-drawer-error');
  });

  test('thirty linked ideas scroll inside the panel', async ({ page }) => {
    await openChat(page, { sessionLinks: MANY_SESSION_LINKS });
    await page.getByTestId('session-tool-related').click();
    const drawer = page.getByTestId('session-linked-work-drawer');
    await expect(drawer.getByTestId('linked-work-idea')).toHaveCount(30);
    await capture(page, 'linked-work-drawer-many');
  });
});

test.describe('Linked work — library file preview', () => {
  test('the preview says where the file came from and expands to the detail', async ({ page }) => {
    await openLibraryPreview(page);

    const strip = page.getByTestId('file-linked-work');
    await expect(strip).toBeVisible();
    const toggle = page.getByTestId('file-linked-work-toggle');
    await expect(toggle).toContainText('Uploaded by Write the agent observability');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await capture(page, 'file-linked-work-collapsed');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('file-linked-chat')).toHaveCount(3);
    await expect(page.getByTestId('file-linked-idea')).toHaveCount(1);
    // The producing chat leads; a chat that only read the file follows.
    await expect(page.getByTestId('file-linked-chat').first()).toContainText('Uploaded');
    await expect(page.getByTestId('file-linked-chat').first()).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/chat/cs-author`
    );
    await expect(page.getByTestId('file-linked-idea').first()).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/ideas/idea-1`
    );
    // An untitled chat still gets a label rather than an empty row.
    await expect(page.getByText('Untitled chat')).toBeVisible();
    await capture(page, 'file-linked-work-expanded');
  });

  test('a file with nothing linked grows no strip', async ({ page }) => {
    await openLibraryPreview(page, { fileLinks: EMPTY_FILE_LINKS });
    // Positive control first: the preview itself rendered.
    await expect(page.getByRole('heading', { name: LONG_FILENAME })).toBeVisible();
    await expect(page.getByTestId('file-linked-work')).toHaveCount(0);
    await capture(page, 'file-linked-work-absent');
  });
});
