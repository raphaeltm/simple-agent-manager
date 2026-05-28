import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, getProjectSuffix, makeMockUser, screenshot } from './audit-helpers';

type AuditMode = 'new' | 'active' | 'provisioning' | 'wizard' | 'single-default';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});

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
  {
    agentType: 'openai-codex',
    name: 'review',
    description: 'Review current changes and identify risks.',
    updatedAt: Date.now(),
  },
  {
    agentType: 'openai-codex',
    name: 'test',
    description: 'Run the focused test suite for this session.',
    updatedAt: Date.now(),
  },
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

const PROVISIONING_SESSION = {
  ...ACTIVE_SESSION,
  id: 'session-provisioning-1',
  workspaceId: null,
  taskId: 'task-provisioning-1',
  topic: 'Provisioning session with long branch name',
  status: 'active',
  task: {
    id: 'task-provisioning-1',
    status: 'queued',
    taskMode: 'task',
    outputBranch: 'sam/provisioning-progress-with-long-branch-name',
    errorMessage: null,
  },
};

function getSessionsForMode(mode: AuditMode) {
  if (mode === 'active') return [ACTIVE_SESSION];
  if (mode === 'provisioning') return [PROVISIONING_SESSION];
  return [];
}

function getSessionForMode(mode: AuditMode) {
  if (mode === 'provisioning') return PROVISIONING_SESSION;
  return ACTIVE_SESSION;
}

function makeMessage(index: number) {
  const role = index % 2 === 0 ? 'user' : 'assistant';
  return {
    id: `message-${index}`,
    sessionId: ACTIVE_SESSION.id,
    role,
    content:
      role === 'user'
        ? `User asks about composer behavior ${index}: ${'long input text '.repeat(12)}`
        : `Assistant response ${index}: Handles unicode, emoji, HTML entities &amp; wrapped content without clipping. ${'Detailed response. '.repeat(14)}`,
    toolMetadata: null,
    createdAt: Date.now() - (40 - index) * 10_000,
    sequence: index,
  };
}

async function assertMobileTouchTargets(page: Page) {
  const isMobile = await page.evaluate(() => window.innerWidth <= 480);
  if (!isMobile) return;
  const buttons = page.locator(
    'textarea[role="combobox"] ~ button, button[aria-label="Attach files to this task"], button[aria-label="Attach files"]'
  );
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const box = await buttons.nth(index).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
}

async function captureComposerAudit(page: Page, name: string) {
  await assertMobileTouchTargets(page);
  await screenshot(page, name);
  await assertNoOverflow(page);
}

async function setupApiMocks(page: Page, mode: AuditMode) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials'))
      return respond(200, [
        { id: 'cred-1', provider: 'hetzner', name: 'Hetzner', createdAt: Date.now() },
      ]);
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/agents') {
      return respond(200, {
        agents: mode === 'single-default'
          ? [{ id: 'openai-codex', name: 'OpenAI Codex', description: 'Focused implementation agent', configured: true, supportsAcp: true }]
          : [
              { id: 'openai-codex', name: 'OpenAI Codex', description: 'Focused implementation agent', configured: true, supportsAcp: true },
              { id: 'claude-code', name: 'Claude Code', description: 'General coding agent', configured: true, supportsAcp: true },
            ],
      });
    }
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/workspaces') return respond(200, []);
    if (path === `/api/workspaces/${ACTIVE_SESSION.workspaceId}`) {
      return respond(200, {
        id: ACTIVE_SESSION.workspaceId,
        name: 'Composer workspace',
        status: 'running',
        url: null,
        nodeId: null,
      });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/agent-profiles') {
        return respond(200, { items: mode === 'wizard' || mode === 'single-default' ? [] : AGENT_PROFILES });
      }
      if (subPath.match(/^\/agent-profiles\/[^/]+\/runtime\/env-vars/)) {
        return respond(200, { envVars: [] });
      }
      if (subPath.match(/^\/agent-profiles\/[^/]+\/runtime\/files/)) {
        return respond(200, { files: [] });
      }
      if (subPath === '/cached-commands') return respond(200, { commands: CACHED_COMMANDS });
      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
      if (subPath === '/tasks/task-provisioning-1') {
        return respond(200, {
          id: 'task-provisioning-1',
          status: 'queued',
          executionStep: 'workspace_ready',
          errorMessage: null,
          outputBranch: 'sam/provisioning-progress-with-long-branch-name',
          startedAt: new Date(Date.now() - 85_000).toISOString(),
          workspaceId: 'workspace-provisioning-1',
        });
      }
      if (subPath === '/sessions') {
        const sessions = getSessionsForMode(mode);
        return respond(200, { sessions, total: sessions.length, hasMore: false });
      }

      const sessionDetailMatch = subPath.match(/^\/sessions\/([^/]+)$/);
      if (sessionDetailMatch) {
        return respond(200, {
          session: getSessionForMode(mode),
          messages: Array.from({ length: 36 }, (_, index) => makeMessage(index)),
          hasMore: false,
        });
      }

      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        return respond(
          200,
          Array.from({ length: 36 }, (_, index) => makeMessage(index))
        );
      }

      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    if (path === '/api/providers/catalog' || path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });

    return respond(200, {});
  });
}

async function openMockedChat(page: Page, mode: AuditMode, sessionId?: string) {
  await setupApiMocks(page, mode);
  await page.goto(`/projects/${MOCK_PROJECT.id}/chat${sessionId ? `/${sessionId}` : ''}`);
  await page.waitForTimeout(sessionId ? 1500 : 1200);
}

test.describe('Project chat composer audit', () => {
  test('new-chat composer handles controls, long text, slash, and mentions', async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, 'new');

    const textarea = page.locator('textarea[role="combobox"]');
    await expect(textarea).toBeVisible();
    await expect(page.getByText('Run the tests and summarize what fails.')).toBeVisible();
    await screenshot(
      page,
      `project-chat-composer-new-prompts-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
    );
    await assertNoOverflow(page);

    await page.getByText('Run the tests and summarize what fails.').click();
    await expect(textarea).toHaveValue('Run the tests and summarize what fails.');
    await textarea.fill(
      `Implement shared composer behavior with unicode π, emoji, HTML-like <button>, and ${'very long wrapping text '.repeat(16)}`
    );

    await expect(page.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-composer-new-long-${getProjectSuffix(testInfo.project.name)}`
    );

    await page.getByRole('button', { name: /Edit Codex/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-profile-edit-modal-${getProjectSuffix(testInfo.project.name)}`
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await textarea.fill('/');
    await expect(page.getByText('/review')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-composer-new-slash-${getProjectSuffix(testInfo.project.name)}`
    );

    await textarea.fill('@Open');
    await expect(page.getByText('@Open Code')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-composer-new-mention-${getProjectSuffix(testInfo.project.name)}`
    );
  });
  test('single-agent no-profile state shows default banner with active composer', async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, 'single-default');

    await expect(page.getByText(/Using/)).toBeVisible();
    await expect(page.getByText(/OpenAI Codex/)).toBeVisible();
    const textarea = page.locator('textarea[role="combobox"]');
    await expect(textarea).toBeEnabled();
    await textarea.fill('Quick question with long wrapping text '.repeat(8));
    await captureComposerAudit(
      page,
      `project-chat-profile-default-${getProjectSuffix(testInfo.project.name)}`
    );
  });

  test('multi-agent no-profile state gates composer and opens wizard', async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, 'wizard');

    await expect(page.getByText('Create a profile to start')).toBeVisible();
    await expect(page.locator('textarea[role="combobox"]')).toBeDisabled();
    await captureComposerAudit(
      page,
      `project-chat-profile-gate-${getProjectSuffix(testInfo.project.name)}`
    );

    await page.getByRole('button', { name: /Create profile/i }).click();
    await expect(page.getByText('Which agent?')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-profile-wizard-agent-${getProjectSuffix(testInfo.project.name)}`
    );
  });


  test('active follow-up composer has shared autocomplete without new-task controls', async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, 'active', ACTIVE_SESSION.id);

    const textarea = page.locator('textarea[role="combobox"]');
    await expect(textarea).toBeVisible();
    await expect(page.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(0);

    await textarea.fill('/');
    await expect(page.getByText('/review')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-composer-followup-slash-${getProjectSuffix(testInfo.project.name)}`
    );

    await textarea.fill('@Cod');
    await expect(page.getByText('@Codex')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-composer-followup-mention-${getProjectSuffix(testInfo.project.name)}`
    );
  });

  test('restored provisioning session shows staged progress without overflow', async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, 'provisioning', PROVISIONING_SESSION.id);

    await expect(page.getByText('Installing dependencies (3/4)')).toBeVisible();
    await expect(page.getByText(/Usually takes 2-4 minutes/)).toBeVisible();
    await expect(page.getByText('sam/provisioning-progress-with-long-branch-name')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-provisioning-progress-${getProjectSuffix(testInfo.project.name)}`
    );
  });
});
