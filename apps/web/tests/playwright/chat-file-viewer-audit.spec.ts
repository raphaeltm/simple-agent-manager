import { test, expect, type Page, type Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data
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

function makeChatSession(overrides: Partial<{
  id: string;
  workspaceId: string | null;
  status: string;
  topic: string;
  agentSessionId: string | null;
  isIdle: boolean;
}> = {}) {
  return {
    id: overrides.id ?? 'cs-1',
    projectId: 'proj-test-1',
    status: overrides.status ?? 'active',
    topic: overrides.topic ?? 'Implement file browsing feature',
    workspaceId: overrides.workspaceId ?? 'ws-test-1',
    agentSessionId: overrides.agentSessionId ?? 'as-1',
    isIdle: overrides.isIdle ?? false,
    agentCompletedAt: null,
    task: {
      id: 'task-1',
      status: 'in_progress',
      title: 'Implement feature',
      outputBranch: 'sam/feature-branch',
      outputPrUrl: null,
      errorMessage: null,
      outputSummary: null,
    },
    createdAt: '2026-03-20T10:00:00Z',
    updatedAt: '2026-03-20T10:00:00Z',
  };
}

function makeToolCallMessage(overrides: Partial<{
  id: string;
  toolName: string;
  locations: Array<{ path: string; line?: number }>;
  content: string;
}> = {}) {
  return {
    id: overrides.id ?? 'msg-tool-1',
    role: 'tool',
    content: JSON.stringify({
      toolCallId: `tc-${overrides.id ?? 'msg-tool-1'}`,
      title: overrides.toolName ?? 'Read',
      kind: 'file',
      status: 'completed',
      content: [{ type: 'content', text: overrides.content ?? 'File content here' }],
      locations: overrides.locations ?? [{ path: 'src/index.ts', line: 42 }],
    }),
    createdAt: Date.now(),
    toolMetadata: {
      toolCallId: `tc-${overrides.id ?? 'msg-tool-1'}`,
      title: overrides.toolName ?? 'Read',
      kind: 'file',
      status: 'completed',
      locations: overrides.locations ?? [{ path: 'src/index.ts', line: 42 }],
    },
  };
}

const MOCK_MESSAGES_WITH_TOOL_CALLS = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'Please review the file structure',
    createdAt: Date.now() - 10000,
    toolMetadata: null,
  },
  makeToolCallMessage({ id: 'msg-tool-1', toolName: 'Read', locations: [{ path: 'src/index.ts', line: 42 }] }),
  makeToolCallMessage({ id: 'msg-tool-2', toolName: 'Edit', locations: [{ path: 'src/components/Header.tsx', line: 15 }] }),
  makeToolCallMessage({
    id: 'msg-tool-3',
    toolName: 'Read',
    locations: [{ path: 'packages/shared/src/very/deeply/nested/path/to/a/file/that/has/a/really/long/name/ComponentWithExtremelyLongName.tsx', line: 1 }],
  }),
  {
    id: 'msg-2',
    role: 'assistant',
    content: 'I have reviewed the files. Here are my findings...',
    createdAt: Date.now() - 5000,
    toolMetadata: null,
  },
];

const MOCK_WORKSPACE = {
  id: 'ws-test-1',
  name: 'test-workspace',
  displayName: 'Test Workspace',
  status: 'running',
  nodeId: 'node-1',
  projectId: 'proj-test-1',
  userId: 'user-test-1',
  vmSize: 'cx22',
  vmLocation: 'fsn1',
  workspaceProfile: 'full',
  chatSessionId: 'cs-1',
  createdAt: '2026-03-20T10:00:00Z',
  updatedAt: '2026-03-20T10:00:00Z',
};

const MOCK_NODE = {
  id: 'node-1',
  name: 'test-node',
  status: 'running',
  healthStatus: 'healthy',
  cloudProvider: 'hetzner',
  userId: 'user-test-1',
  vmIp: '1.2.3.4',
  createdAt: '2026-03-20T10:00:00Z',
  updatedAt: '2026-03-20T10:00:00Z',
};

const MOCK_FILE_LISTING = {
  path: '.',
  entries: [
    { name: 'src', type: 'dir', size: 0, modifiedAt: '2026-03-20T10:00:00Z' },
    { name: 'packages', type: 'dir', size: 0, modifiedAt: '2026-03-20T10:00:00Z' },
    { name: 'package.json', type: 'file', size: 1234, modifiedAt: '2026-03-20T10:00:00Z' },
    { name: 'tsconfig.json', type: 'file', size: 456, modifiedAt: '2026-03-20T10:00:00Z' },
    { name: 'README.md', type: 'file', size: 8901, modifiedAt: '2026-03-20T10:00:00Z' },
    { name: '.gitignore', type: 'file', size: 123, modifiedAt: '2026-03-20T10:00:00Z' },
  ],
};

const MOCK_FILE_CONTENT = {
  content: `import { useState, useEffect } from 'react';

interface Props {
  title: string;
  description?: string;
}

export function FileViewer({ title, description }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch file content
    setLoading(false);
    setContent('Hello World');
  }, []);

  return (
    <div className="file-viewer">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {loading ? <span>Loading...</span> : <pre>{content}</pre>}
    </div>
  );
}`,
  filePath: 'src/index.ts',
};

const MOCK_GIT_STATUS = {
  staged: [
    { path: 'src/index.ts', status: 'modified' },
    { path: 'src/new-file.ts', status: 'added' },
  ],
  unstaged: [
    { path: 'src/components/Header.tsx', status: 'modified' },
    { path: 'tests/test.spec.ts', status: 'modified' },
  ],
  untracked: [
    { path: 'src/temp.ts', status: 'untracked' },
  ],
};

const MOCK_DIFF = {
  diff: `diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,7 @@
 import { useState, useEffect } from 'react';
+import { useCallback } from 'react';

 interface Props {
   title: string;
+  onClose?: () => void;
 }
@@ -10,3 +12,5 @@
   return (
     <div className="file-viewer">
+      <button onClick={onClose}>Close</button>
       <h1>{title}</h1>`,
  filePath: 'src/index.ts',
};

// ---------------------------------------------------------------------------
// Setup Helpers
// ---------------------------------------------------------------------------

async function setupMocks(page: Page, options: {
  session?: ReturnType<typeof makeChatSession>;
  messages?: unknown[];
  workspace?: typeof MOCK_WORKSPACE | null;
  node?: typeof MOCK_NODE | null;
  fileListing?: typeof MOCK_FILE_LISTING | null;
  fileContent?: typeof MOCK_FILE_CONTENT | null;
  gitStatus?: typeof MOCK_GIT_STATUS | null;
  gitDiff?: typeof MOCK_DIFF | null;
  fileError?: boolean;
} = {}) {
  const {
    session = makeChatSession(),
    messages = MOCK_MESSAGES_WITH_TOOL_CALLS,
    workspace = MOCK_WORKSPACE,
    node = MOCK_NODE,
    fileListing = MOCK_FILE_LISTING,
    fileContent = MOCK_FILE_CONTENT,
    gitStatus = MOCK_GIT_STATUS,
    gitDiff = MOCK_DIFF,
    fileError = false,
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    // Auth
    if (url.includes('/api/auth/me')) {
      return route.fulfill({ json: MOCK_USER });
    }

    // Project detail
    if (url.match(/\/api\/projects\/[^/]+$/) && !url.includes('sessions') && !url.includes('files') && !url.includes('git')) {
      return route.fulfill({ json: { ...MOCK_PROJECT, sessions: [session] } });
    }

    // Session detail
    if (url.includes('/sessions/') && url.includes('/detail')) {
      return route.fulfill({
        json: {
          ...session,
          messages: messages,
          hasMore: false,
        },
      });
    }

    // Session list
    if (url.match(/\/api\/projects\/[^/]+\/sessions\/?$/)) {
      return route.fulfill({ json: { sessions: [session] } });
    }

    // Chat messages (WebSocket fallback / REST)
    if (url.includes('/messages')) {
      return route.fulfill({
        json: { messages, hasMore: false },
      });
    }

    // Workspace
    if (url.match(/\/api\/workspaces\/[^/]+$/) && !url.includes('ports')) {
      if (!workspace) return route.fulfill({ status: 404, json: { error: 'not_found' } });
      return route.fulfill({ json: workspace });
    }

    // Workspace ports
    if (url.includes('/ports')) {
      return route.fulfill({ json: { ports: [] } });
    }

    // Node
    if (url.match(/\/api\/nodes\//)) {
      if (!node) return route.fulfill({ status: 404, json: { error: 'not_found' } });
      return route.fulfill({ json: node });
    }

    // File proxy routes
    if (url.includes('/files/list')) {
      if (fileError) return route.fulfill({ status: 500, json: { error: 'VM agent unreachable' } });
      if (!fileListing) return route.fulfill({ status: 404, json: { error: 'not_found' } });
      return route.fulfill({ json: fileListing });
    }

    if (url.includes('/files/view') || url.includes('/git/file')) {
      if (fileError) return route.fulfill({ status: 500, json: { error: 'VM agent unreachable' } });
      if (!fileContent) return route.fulfill({ status: 404, json: { error: 'not_found' } });
      return route.fulfill({ json: fileContent });
    }

    if (url.includes('/git/status')) {
      if (fileError) return route.fulfill({ status: 500, json: { error: 'VM agent unreachable' } });
      if (!gitStatus) return route.fulfill({ json: { staged: [], unstaged: [], untracked: [] } });
      return route.fulfill({ json: gitStatus });
    }

    if (url.includes('/git/diff')) {
      if (fileError) return route.fulfill({ status: 500, json: { error: 'VM agent unreachable' } });
      if (!gitDiff) return route.fulfill({ json: { diff: '', filePath: '' } });
      return route.fulfill({ json: gitDiff });
    }

    // Terminal token (for workspace ports)
    if (url.includes('/terminal/token')) {
      return route.fulfill({ json: { token: 'mock-token', expiresAt: new Date(Date.now() + 86400000).toISOString(), workspaceUrl: 'https://ws-test-1.example.com' } });
    }

    // Tasks
    if (url.includes('/tasks')) {
      return route.fulfill({ json: { tasks: [] } });
    }

    // Default
    return route.fulfill({ json: {} });
  });

  // Block WebSocket connections to prevent real connection attempts
  await page.route('**/ws/**', (route) => route.abort());
}

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

/**
 * Expand the session header and click a panel button (Files or Git).
 * Uses expect assertions instead of isVisible guards to ensure elements are found.
 */
async function openPanel(page: Page, buttonName: 'Files' | 'Git') {
  const chevron = page.locator('[aria-label="Show session details"]');
  await expect(chevron).toBeVisible({ timeout: 3000 });
  await chevron.click();
  await page.waitForTimeout(200);

  const btn = page.getByRole('button', { name: buttonName, exact: false }).first();
  await expect(btn).toBeVisible({ timeout: 3000 });
  await btn.click();
  await page.waitForTimeout(800);
}

/**
 * Expand the session header (without clicking a panel button).
 */
async function expandSessionHeader(page: Page) {
  const chevron = page.locator('[aria-label="Show session details"]');
  await expect(chevron).toBeVisible({ timeout: 3000 });
  await chevron.click();
  await page.waitForTimeout(300);
}

async function takeScreenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

// ===========================================================================
// SESSION HEADER TESTS — Mobile
// ===========================================================================

test.describe('ChatFileViewer — Session Header — Mobile', () => {
  test('session header with Files/Git buttons (active workspace)', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await expandSessionHeader(page);

    await takeScreenshot(page, 'session-header-files-git-buttons-mobile');
    await assertNoOverflow(page);
  });

  test('session header without buttons (no workspace)', async ({ page }) => {
    await setupMocks(page, { session: makeChatSession({ workspaceId: null }) });
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    // When no workspace, chevron may still be available — try to expand
    const chevron = page.locator('[aria-label="Show session details"]');
    if (await chevron.isVisible()) {
      await chevron.click();
      await page.waitForTimeout(300);
    }

    await takeScreenshot(page, 'session-header-no-workspace-mobile');
    await assertNoOverflow(page);
  });

  test('session header with stopped session', async ({ page }) => {
    await setupMocks(page, {
      session: makeChatSession({ status: 'stopped' }),
      workspace: { ...MOCK_WORKSPACE, status: 'stopped' },
    });
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await takeScreenshot(page, 'session-header-stopped-mobile');
    await assertNoOverflow(page);
  });
});

// ===========================================================================
// TOOL CALL CARD TESTS — Mobile
// ===========================================================================

test.describe('ChatFileViewer — Tool Call Cards — Mobile', () => {
  test('tool calls with clickable file references', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1500);

    await takeScreenshot(page, 'tool-call-clickable-files-mobile');
    await assertNoOverflow(page);
  });

  test('tool call with long file path does not overflow', async ({ page }) => {
    await setupMocks(page, {
      messages: [
        makeToolCallMessage({
          id: 'long-path',
          toolName: 'Read',
          locations: [{ path: 'packages/shared/src/very/deeply/nested/path/to/a/file/ComponentWithExtremelyLongName.tsx', line: 1 }],
        }),
      ],
    });
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1500);

    await takeScreenshot(page, 'tool-call-long-path-mobile');
    await assertNoOverflow(page);
  });
});

// ===========================================================================
// FILE BROWSER PANEL TESTS — Mobile
// ===========================================================================

test.describe('ChatFileViewer — File Browser — Mobile', () => {
  test('file browser with entries', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await openPanel(page, 'Files');

    await takeScreenshot(page, 'file-browser-entries-mobile');
    await assertNoOverflow(page);
  });

  test('file browser empty directory', async ({ page }) => {
    await setupMocks(page, { fileListing: { path: '.', entries: [] } });
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await openPanel(page, 'Files');

    await takeScreenshot(page, 'file-browser-empty-mobile');
    await assertNoOverflow(page);
  });

  test('file browser error state', async ({ page }) => {
    await setupMocks(page, { fileError: true });
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await openPanel(page, 'Files');

    await takeScreenshot(page, 'file-browser-error-mobile');
    await assertNoOverflow(page);
  });
});

// ===========================================================================
// GIT STATUS PANEL TESTS — Mobile
// ===========================================================================

test.describe('ChatFileViewer — Git Status — Mobile', () => {
  test('git status with changes', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await openPanel(page, 'Git');

    await takeScreenshot(page, 'git-status-changes-mobile');
    await assertNoOverflow(page);
  });

  test('git status no changes', async ({ page }) => {
    await setupMocks(page, { gitStatus: { staged: [], unstaged: [], untracked: [] } });
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await openPanel(page, 'Git');

    await takeScreenshot(page, 'git-status-no-changes-mobile');
    await assertNoOverflow(page);
  });
});

// ===========================================================================
// DIFF VIEW TESTS — Mobile
// ===========================================================================

test.describe('ChatFileViewer — Diff View — Mobile', () => {
  test('diff view with changes', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await openPanel(page, 'Git');

    // Click diff button on first staged file
    const diffBtn = page.getByRole('button', { name: 'Diff' }).first();
    await expect(diffBtn).toBeVisible({ timeout: 3000 });
    await diffBtn.click();
    await page.waitForTimeout(800);

    await takeScreenshot(page, 'diff-view-changes-mobile');
    await assertNoOverflow(page);
  });
});

// ===========================================================================
// DESKTOP TESTS
// ===========================================================================

test.describe('ChatFileViewer — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('session header with Files/Git buttons', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await expandSessionHeader(page);

    await takeScreenshot(page, 'session-header-files-git-buttons-desktop');
    await assertNoOverflow(page);
  });

  test('file browser slide-over', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await openPanel(page, 'Files');

    await takeScreenshot(page, 'file-browser-slide-over-desktop');
    await assertNoOverflow(page);
  });

  test('git status slide-over', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1000);

    await openPanel(page, 'Git');
    await page.waitForTimeout(800);

    await takeScreenshot(page, 'git-status-slide-over-desktop');
    await assertNoOverflow(page);
  });

  test('tool calls with clickable file references', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(1500);

    await takeScreenshot(page, 'tool-call-clickable-files-desktop');
    await assertNoOverflow(page);
  });
});
