import { expect, type Page, type Route, test } from '@playwright/test';

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-05-18T00:00:00Z',
    updatedAt: '2026-05-18T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-05-18T00:00:00Z',
    updatedAt: '2026-05-18T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-composer-1',
  name: 'Composer Audit Project With A Very Long Name That Must Wrap Cleanly',
  repository: 'testuser/really-long-project-chat-composer-audit-repository-name',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: '',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-05-18T00:00:00Z',
  updatedAt: '2026-05-18T00:00:00Z',
};

const AGENT_PROFILES = [
  {
    id: 'profile-codex',
    projectId: MOCK_PROJECT.id,
    userId: 'user-test-1',
    name: 'Codex',
    description: 'Use for focused implementation and code review.',
    agentType: 'openai-codex',
    model: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: null,
    isBuiltin: false,
    createdAt: '2026-05-18T00:00:00Z',
    updatedAt: '2026-05-18T00:00:00Z',
  },
  {
    id: 'profile-open-code',
    projectId: MOCK_PROJECT.id,
    userId: 'user-test-1',
    name: 'Open Code',
    description: 'Profile with a multi-word name and a longer description for wrapping.',
    agentType: 'opencode',
    model: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: null,
    isBuiltin: false,
    createdAt: '2026-05-18T00:00:00Z',
    updatedAt: '2026-05-18T00:00:00Z',
  },
];

const CACHED_COMMANDS = [
  { agentType: 'openai-codex', name: 'review', description: 'Review current changes and identify risks.', updatedAt: Date.now() },
  { agentType: 'openai-codex', name: 'test', description: 'Run the focused test suite for this session.', updatedAt: Date.now() },
];

const ACTIVE_SESSION = {
  id: 'session-composer-1',
  workspaceId: 'workspace-composer-1',
  taskId: 'task-composer-1',
  topic: 'Active composer session with long topic text and <script>escaped</script> symbols',
  status: 'active',
  messageCount: 36,
  startedAt: Date.now() - 600_000,
  endedAt: null,
  createdAt: Date.now() - 600_000,
  lastMessageAt: Date.now() - 30_000,
  isIdle: false,
  agentCompletedAt: null,
  isTerminated: false,
  workspaceUrl: null,
  cleanupAt: null,
  agentSessionId: 'agent-session-1',
  task: {
    id: 'task-composer-1',
    status: 'in_progress',
    taskMode: 'conversation',
    outputBranch: 'sam/composer-audit',
    errorMessage: null,
  },
};

function makeMessage(index: number) {
  const role = index % 2 === 0 ? 'user' : 'assistant';
  return {
    id: `message-${index}`,
    sessionId: ACTIVE_SESSION.id,
    role,
    content: role === 'user'
      ? `User asks about composer behavior ${index}: ${'long input text '.repeat(12)}`
      : `Assistant response ${index}: Handles unicode, emoji, HTML entities &amp; wrapped content without clipping. ${'Detailed response. '.repeat(14)}`,
    toolMetadata: null,
    createdAt: Date.now() - (40 - index) * 10_000,
    sequence: index,
  };
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

async function assertMobileTouchTargets(page: Page) {
  const isMobile = await page.evaluate(() => window.innerWidth <= 480);
  if (!isMobile) return;
  const buttons = page.locator('textarea[role="combobox"] ~ button, button[aria-label="Attach files to this task"], button[aria-label="Attach files"]');
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const box = await buttons.nth(index).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
}

async function setupApiMocks(page: Page, mode: 'new' | 'active') {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, [{ id: 'cred-1', provider: 'hetzner', name: 'Hetzner', createdAt: Date.now() }]);
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/agents') {
      return respond(200, {
        agents: [
          { id: 'openai-codex', name: 'OpenAI Codex', configured: true, supportsAcp: true },
          { id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true },
        ],
      });
    }
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/workspaces') return respond(200, []);
    if (path === `/api/workspaces/${ACTIVE_SESSION.workspaceId}`) {
      return respond(200, { id: ACTIVE_SESSION.workspaceId, name: 'Composer workspace', status: 'running', url: null, nodeId: null });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/agent-profiles') return respond(200, { items: AGENT_PROFILES });
      if (subPath === '/cached-commands') return respond(200, { commands: CACHED_COMMANDS });
      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
      if (subPath === '/sessions') {
        const sessions = mode === 'active' ? [ACTIVE_SESSION] : [];
        return respond(200, { sessions, total: sessions.length, hasMore: false });
      }

      const sessionDetailMatch = subPath.match(/^\/sessions\/([^/]+)$/);
      if (sessionDetailMatch) {
        return respond(200, {
          session: ACTIVE_SESSION,
          messages: Array.from({ length: 36 }, (_, index) => makeMessage(index)),
          hasMore: false,
        });
      }

      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        return respond(200, Array.from({ length: 36 }, (_, index) => makeMessage(index)));
      }

      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });

    return respond(200, {});
  });
}

test.describe('Project chat composer audit', () => {
  test('new-chat composer handles controls, long text, slash, and mentions', async ({ page }, testInfo) => {
    await setupApiMocks(page, 'new');
    await page.goto(`/projects/${MOCK_PROJECT.id}/chat`);
    await page.waitForTimeout(1200);

    const textarea = page.locator('textarea[role="combobox"]');
    await expect(textarea).toBeVisible();
    await textarea.fill(`Implement shared composer behavior with unicode π, emoji, HTML-like <button>, and ${'very long wrapping text '.repeat(16)}`);

    await expect(page.locator('select[aria-label="Workspace profile"], select#workspace-profile-select')).toBeVisible();
    await expect(page.locator('select[aria-label="Run mode"], select#task-mode-select')).toBeVisible();
    await assertMobileTouchTargets(page);
    await screenshot(page, `project-chat-composer-new-long-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    await assertNoOverflow(page);

    await textarea.fill('/');
    await expect(page.getByText('/review')).toBeVisible();
    await screenshot(page, `project-chat-composer-new-slash-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    await assertNoOverflow(page);

    await textarea.fill('@Open');
    await expect(page.getByText('@Open Code')).toBeVisible();
    await screenshot(page, `project-chat-composer-new-mention-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    await assertNoOverflow(page);
  });

  test('active follow-up composer has shared autocomplete without new-task controls', async ({ page }, testInfo) => {
    await setupApiMocks(page, 'active');
    await page.goto(`/projects/${MOCK_PROJECT.id}/chat/${ACTIVE_SESSION.id}`);
    await page.waitForTimeout(1500);

    const textarea = page.locator('textarea[role="combobox"]');
    await expect(textarea).toBeVisible();
    await expect(page.locator('select[aria-label="Workspace profile"], select#workspace-profile-select')).toHaveCount(0);
    await expect(page.locator('select[aria-label="Run mode"], select#task-mode-select')).toHaveCount(0);

    await textarea.fill('/');
    await expect(page.getByText('/review')).toBeVisible();
    await assertMobileTouchTargets(page);
    await screenshot(page, `project-chat-composer-followup-slash-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    await assertNoOverflow(page);

    await textarea.fill('@Cod');
    await expect(page.getByText('@Codex')).toBeVisible();
    await screenshot(page, `project-chat-composer-followup-mention-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    await assertNoOverflow(page);
  });
});
