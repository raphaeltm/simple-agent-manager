import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, getProjectSuffix, makeMockUser, screenshot } from './audit-helpers';

type AuditMode =
  'new' | 'active' | 'provisioning' | 'wizard' | 'single-wizard' | 'no-agents' | 'duplicate';

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

function makeAgentProfile(overrides: Record<string, unknown>) {
  return {
    id: 'profile-base',
    projectId: MOCK_PROJECT.id,
    userId: 'user-test-1',
    name: 'Profile',
    description: null,
    agentType: 'openai-codex',
    model: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    runtime: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: null,
    isBuiltin: false,
    createdAt: '2026-05-18T00:00:00Z',
    updatedAt: '2026-05-18T00:00:00Z',
    ...overrides,
  };
}

const AGENT_PROFILES = [
  makeAgentProfile({
    id: 'profile-codex',
    name: 'Codex',
    description: 'Use for focused implementation and code review.',
    runtime: 'cf-container',
  }),
  makeAgentProfile({
    id: 'profile-open-code',
    name: 'Open Code',
    description: 'Profile with a multi-word name and a longer description for wrapping.',
    agentType: 'opencode',
    runtime: 'vm',
  }),
  makeAgentProfile({
    id: 'profile-long-name',
    name: 'Long reusable profile name with unicode π and escaped <script> content that must truncate',
    description: 'A deliberately long profile name for mobile wrapping and truncation checks.',
    agentType: 'claude-code',
  }),
];

const MENTION_PROFILES = [
  ...AGENT_PROFILES,
  ...[
    'gcp-deployer',
    'release.bot',
    'worker_123',
    '123agent',
    '部署π',
    'quote "agent"',
    'path\\agent',
  ].map((name, index) => makeAgentProfile({ id: `mention-${index}`, name })),
  ...Array.from({ length: 30 }, (_, index) =>
    makeAgentProfile({
      id: `many-${index}`,
      name: `Stress profile ${index} with ${'long unicode π text '.repeat(12)}`,
      description: 'Long description & <script>safe text</script> ' + 'wrapping '.repeat(60),
    })
  ),
];

const SKILLS = [
  {
    id: 'skill-audit',
    projectId: MOCK_PROJECT.id,
    userId: 'user-test-1',
    name: 'Implementation Audit',
    description: 'Repeatable task setup for implementation work with resource hints.',
    agentType: null,
    model: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    runtime: null,
    vmSizeOverride: 'large',
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: 'task',
    isBuiltin: false,
    defaultProfileId: 'profile-codex',
    resourceRequirementsJson: '{"minVcpu":4,"minMemoryGb":8}',
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
  viewerAccess: 'owner',
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

async function setupApiMocks(page: Page, mode: AuditMode, profiles = AGENT_PROFILES) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route: Route) => {
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
    if (path === '/api/agents') {
      if (mode === 'no-agents') {
        return respond(200, { agents: [] });
      }
      return respond(200, {
        agents:
          mode === 'single-wizard'
            ? [
                {
                  id: 'openai-codex',
                  name: 'OpenAI Codex With A Long Friendly Name',
                  description:
                    'Focused implementation agent with a long description that should wrap cleanly on mobile',
                  configured: true,
                  supportsAcp: true,
                },
              ]
            : [
                {
                  id: 'openai-codex',
                  name: 'OpenAI Codex',
                  description: 'Focused implementation agent',
                  configured: true,
                  supportsAcp: true,
                },
                {
                  id: 'claude-code',
                  name: 'Claude Code With A Long Friendly Name And Special <characters>',
                  description:
                    'General coding agent with a long description that should wrap cleanly on mobile',
                  configured: true,
                  supportsAcp: true,
                },
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
        return respond(200, {
          items:
            mode === 'wizard' || mode === 'single-wizard' || mode === 'no-agents' ? [] : profiles,
        });
      }
      if (subPath === '/agent-profiles/picker') {
        return respond(200, { usage: [], hiddenProfileIds: [], usageWindowDays: 30 });
      }
      if (subPath === '/skills') return respond(200, { items: mode === 'wizard' ? [] : SKILLS });
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
    if (path === '/api/providers/catalog' || path.startsWith('/api/provider-catalog'))
      return respond(200, { catalogs: [] });

    return respond(200, {});
  });
}

async function openMockedChat(
  page: Page,
  mode: AuditMode,
  sessionId?: string,
  profiles = AGENT_PROFILES
) {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true')
  );
  await setupApiMocks(page, mode, profiles);
  await page.goto(`/projects/${MOCK_PROJECT.id}/chat${sessionId ? `/${sessionId}` : ''}`);
  await page.waitForTimeout(sessionId ? 1500 : 1200);
}

async function expectComposerDisabled(page: Page) {
  await expect(page.locator('textarea[role="combobox"]')).toBeDisabled();
}

async function captureNoProfileGate(page: Page, screenshotName: string) {
  await expect(page.getByText('Create a profile to start')).toBeVisible();
  await expectComposerDisabled(page);
  await captureComposerAudit(page, screenshotName);
}

async function openProfileWizard(page: Page) {
  await page.getByRole('button', { name: /Create profile/i }).click();
}

async function chooseWizardOption(page: Page, label: RegExp) {
  await page.getByRole('button', { name: label }).click();
  await page.getByRole('button', { name: /Next/i }).click();
}

test.describe('Project chat composer audit', () => {
  test('new-chat composer handles controls, long text, slash, and mentions', async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, 'new');

    const textarea = page.locator('textarea[role="combobox"]');
    await expect(textarea).toBeVisible();
    // Three profiles: the empty screen offers them as cards instead of starter prompts.
    const cards = page.getByRole('region', { name: 'Choose a profile' });
    await expect(cards.getByRole('button', { name: /^Codex/ })).toBeVisible();
    const toControl = page.getByRole('button', { name: /^To / });
    await expect(toControl).toContainText('Codex');

    // Skill selector moved behind Chat options and still surfaces resource hints.
    await page.getByRole('button', { name: 'Chat options' }).click();
    const skillSelect = page.getByLabel('Skill', { exact: true });
    await expect(skillSelect).toBeVisible();
    await skillSelect.selectOption('skill-audit');
    await expect(page.getByText(/8 GB RAM/)).toBeVisible();
    await skillSelect.selectOption('');
    await page.getByRole('button', { name: 'Chat options' }).click();
    await screenshot(
      page,
      `project-chat-composer-new-prompts-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
    );
    await assertNoOverflow(page);

    await cards.getByRole('button', { name: /^Open Code/ }).click();
    await expect(toControl).toContainText('Open Code');
    await textarea.fill(
      `Implement shared composer behavior with unicode π, emoji, HTML-like <button>, and ${'very long wrapping text '.repeat(16)}`
    );
    await captureComposerAudit(
      page,
      `project-chat-composer-new-long-${getProjectSuffix(testInfo.project.name)}`
    );

    await toControl.click();
    const sheet = page.getByRole('dialog', { name: 'Choose a profile' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: /Edit Open Code/i }).click();
    await expect(page.getByRole('dialog').last()).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-profile-edit-modal-${getProjectSuffix(testInfo.project.name)}`
    );
    await page.keyboard.press('Escape');

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
  test('no-agent state keeps settings prompt and disabled composer', async ({ page }, testInfo) => {
    await openMockedChat(page, 'no-agents');

    await expect(page.getByText('Add an agent to start chatting')).toBeVisible();
    await expectComposerDisabled(page);
    await captureComposerAudit(
      page,
      `project-chat-no-agents-${getProjectSuffix(testInfo.project.name)}`
    );
  });

  test('single-agent no-profile state gates composer and opens shortened wizard', async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, 'single-wizard');

    await expect(page.getByText(/Choose an agent and default runtime settings/)).toBeVisible();
    await captureNoProfileGate(
      page,
      `project-chat-profile-gate-single-${getProjectSuffix(testInfo.project.name)}`
    );

    await openProfileWizard(page);
    await expect(page.getByText('What kind of work?')).toBeVisible();
    await expect(page.getByText('Which agent?')).toHaveCount(0);
    await captureComposerAudit(
      page,
      `project-chat-profile-wizard-single-work-type-${getProjectSuffix(testInfo.project.name)}`
    );

    await chooseWizardOption(page, /Chat and explore/i);
    await expect(page.getByText('Where should it run?')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-profile-wizard-single-runtime-${getProjectSuffix(testInfo.project.name)}`
    );
  });

  test('multi-agent no-profile state gates composer and opens wizard', async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, 'wizard');

    await captureNoProfileGate(
      page,
      `project-chat-profile-gate-${getProjectSuffix(testInfo.project.name)}`
    );

    await openProfileWizard(page);
    await expect(page.getByText('Which agent?')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-profile-wizard-agent-${getProjectSuffix(testInfo.project.name)}`
    );
  });

  test('existing profiles handle long names and duplicate profile-name errors', async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, 'duplicate');

    const cards = page.getByRole('region', { name: 'Choose a profile' });
    await expect(cards.getByRole('button', { name: /^Codex/ })).toBeVisible();
    await expect(cards.getByRole('button', { name: /Long reusable profile name/ })).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-profile-existing-long-names-${getProjectSuffix(testInfo.project.name)}`
    );

    await page.getByRole('button', { name: /^To / }).click();
    await page
      .getByRole('dialog', { name: 'Choose a profile' })
      .getByRole('button', { name: /^New$/ })
      .click();
    await chooseWizardOption(page, /OpenAI Codex/i);
    await chooseWizardOption(page, /Chat and explore/i);
    await chooseWizardOption(page, /Instant container/i);
    await page.getByRole('textbox', { name: 'Profile name' }).fill('Codex');
    await page.getByRole('button', { name: /Create profile/i }).click();

    await expect(page.getByText('Profile "Codex" already exists')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-profile-duplicate-error-${getProjectSuffix(testInfo.project.name)}`
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

    await expect(page.getByText('Installing dependencies · 3 of 4')).toBeVisible();
    await expect(page.getByText(/This usually takes 2–4 minutes/)).toBeVisible();
    await expect(page.getByText('sam/provisioning-progress-with-long-branch-name')).toBeVisible();
    await captureComposerAudit(
      page,
      `project-chat-provisioning-progress-${getProjectSuffix(testInfo.project.name)}`
    );
  });
});

for (const mode of ['new', 'active'] as const) {
  test(`mention syntax stays intact in ${mode} composer`, async ({ page }, testInfo) => {
    await openMockedChat(
      page,
      mode,
      mode === 'active' ? ACTIVE_SESSION.id : undefined,
      MENTION_PROFILES
    );
    const textarea = page.locator('textarea[role="combobox"]');
    await expect(textarea).toBeVisible();
    const examples = [
      ['gcp-', 'gcp-deployer', '@gcp-deployer '],
      ['release.', 'release.bot', '@release.bot '],
      ['worker_1', 'worker_123', '@worker_123 '],
      ['123', '123agent', '@123agent '],
      ['部署', '部署π', '@部署π '],
      ['Open', 'Open Code', '@"Open Code" '],
      ['quote', 'quote "agent"', '@"quote \\"agent\\"" '],
      ['path', 'path\\agent', '@"path\\\\agent" '],
    ];
    for (const [query, name, inserted] of examples) {
      await textarea.fill(`Please @${query}`);
      await expect(textarea).toHaveValue(`Please @${query}`);
      await textarea.press('End');
      const option = page
        .getByRole('listbox')
        .getByRole('option')
        .filter({ has: page.getByText(`@${name}`, { exact: true }) });
      await expect(option).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(textarea).toHaveValue(`Please ${inserted}`);
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      );
    }
    for (const ordinaryText of ['person@release.bot', '@release.bot/package', 'plain message']) {
      await textarea.fill(ordinaryText);
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await expect(textarea).toHaveValue(ordinaryText);
    }
    await textarea.fill('@');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(
      MENTION_PROFILES.length
    );
    await captureComposerAudit(
      page,
      `mention-fix-${mode}-many-${getProjectSuffix(testInfo.project.name)}`
    );
    await textarea.fill('@Stress');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(30);
    const clippedNames = await page
      .getByRole('listbox')
      .getByRole('option')
      .evaluateAll((options) =>
        options.flatMap((option) => {
          const name = option.querySelector('span');
          return name && name.scrollWidth > name.clientWidth + 1 ? [name.textContent] : [];
        })
      );
    expect(clippedNames).toEqual([]);
    const sendButton = page.getByRole('button', { name: 'Send', exact: true });
    await sendButton.scrollIntoViewIfNeeded();
    const sendBox = await sendButton.boundingBox();
    expect(sendBox).not.toBeNull();
    expect(sendBox!.y).toBeGreaterThanOrEqual(0);
    expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    const composerBox = await textarea.boundingBox();
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await captureComposerAudit(
      page,
      `mention-fix-${mode}-long-${getProjectSuffix(testInfo.project.name)}`
    );
    const viewport = page.viewportSize()!;
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/mention-fix-${mode}-long-${getProjectSuffix(testInfo.project.name)}-${viewport.width}x${viewport.height}.png`,
      fullPage: false,
    });
  });
}

for (const mode of ['new', 'active'] as const) {
  test(`attachments ${mode}: stage, remove, paste, drop and show errors`, async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, mode, mode === 'active' ? ACTIVE_SESSION.id : undefined);
    let upload = 0;
    await page.route('**/tasks/request-upload', (route) => {
      const body = route.request().postDataJSON();
      if (body.filename === 'failed.txt')
        return route.fulfill({
          status: 503,
          body: JSON.stringify({ message: 'Upload unavailable' }),
        });
      upload++;
      return route.fulfill({
        json: {
          uploadId: `upload-${upload}`,
          uploadUrl: `http://localhost:4173/mock-upload/${upload}`,
        },
      });
    });
    await page.route('**/mock-upload/*', (route) => route.fulfill({ status: 200 }));
    const textarea = page.locator('textarea[role="combobox"]');
    await textarea.fill('Please read all attached files and compare them.');
    await page.locator('input[type=file]').setInputFiles([
      {
        name: 'long-file-name-'.repeat(14) + '.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('first'),
      },
      { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second') },
    ]);
    await expect(
      page.getByRole('button', { name: 'Remove second.txt', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Remove second.txt', exact: true }).click();
    await textarea.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.files;
      transfer.items.add(new File(['image'], 'pasted-image.png', { type: 'image/png' }));
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
      );
    });
    await expect(page.getByRole('button', { name: 'Remove pasted-image.png' })).toBeVisible();
    await textarea.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['drop'], 'dropped.txt', { type: 'text/plain' }));
      element.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
    });
    await expect(page.getByRole('button', { name: 'Remove dropped.txt' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
    await screenshot(page, `attachments-${mode}-ready-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
    await page.locator('input[type=file]').setInputFiles({
      name: 'failed.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('failure'),
    });
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await screenshot(page, `attachments-${mode}-error-${getProjectSuffix(testInfo.project.name)}`);
    await assertNoOverflow(page);
  });
}

/** Stages files through the composer's real paste handler, built in the page from canvas/bytes. */
async function pasteFiles(
  page: Page,
  files: Array<
    | { kind: 'image'; name: string; width: number; height: number }
    | { kind: 'bytes'; name: string; type: string; size: number }
    | { kind: 'video'; name: string }
  >
) {
  await page.locator('textarea[role="combobox"]').evaluate(async (element, specs) => {
    const transfer = new DataTransfer();
    for (const spec of specs) {
      if (spec.kind === 'image') {
        const canvas = document.createElement('canvas');
        canvas.width = spec.width;
        canvas.height = spec.height;
        const ctx = canvas.getContext('2d')!;
        const gradient = ctx.createLinearGradient(0, 0, spec.width, spec.height);
        gradient.addColorStop(0, '#2f7d4f');
        gradient.addColorStop(1, '#f6a85b');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, spec.width, spec.height);
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((b) => resolve(b!), 'image/png')
        );
        transfer.items.add(new File([blob], spec.name, { type: 'image/png' }));
      } else if (spec.kind === 'video') {
        // A real, playable WebM: half a second of a 320x180 canvas through MediaRecorder.
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d')!;
        const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => chunks.push(event.data);
        const stopped = new Promise((resolve) => (recorder.onstop = resolve));
        recorder.start();
        for (let frame = 0; frame < 15; frame++) {
          ctx.fillStyle = `hsl(${frame * 24} 60% 45%)`;
          ctx.fillRect(0, 0, 320, 180);
          await new Promise((resolve) => setTimeout(resolve, 33));
        }
        recorder.stop();
        await stopped;
        transfer.items.add(new File(chunks, spec.name, { type: 'video/webm' }));
      } else {
        transfer.items.add(new File([new Uint8Array(spec.size)], spec.name, { type: spec.type }));
      }
    }
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
    );
  }, files);
}

async function pasteText(page: Page, text: string) {
  await page.locator('textarea[role="combobox"]').evaluate((element, value) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', value);
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
    );
  }, text);
}

async function mockUploads(page: Page) {
  let upload = 0;
  await page.route('**/tasks/request-upload', (route) => {
    upload++;
    return route.fulfill({
      json: {
        uploadId: `upload-${upload}`,
        uploadUrl: `http://localhost:4173/mock-upload/${upload}`,
      },
    });
  });
  await page.route('**/mock-upload/*', (route) => route.fulfill({ status: 200 }));
}

const LONG_PASTE = Array.from(
  { length: 140 },
  (_, i) =>
    `2026-11-07T14:08:${String(i % 60).padStart(2, '0')}Z ERROR vm-agent turn=${i} msg="flush failed"`
).join('\n');

for (const mode of ['new', 'active'] as const) {
  test(`attachment previews ${mode}: cards, local viewer, paste round-trip, oversize file`, async ({
    page,
  }, testInfo) => {
    const suffix = getProjectSuffix(testInfo.project.name);
    await openMockedChat(page, mode, mode === 'active' ? ACTIVE_SESSION.id : undefined);
    await mockUploads(page);
    const uploads: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/mock-upload/')) uploads.push(request.url());
    });

    await pasteFiles(page, [
      { kind: 'image', name: 'CleanShot_2026-11-07.png', width: 800, height: 500 },
    ]);
    await pasteText(page, LONG_PASTE);
    await page.locator('input[type=file]').setInputFiles([
      { name: 'workspace-snapshot.zip', mimeType: 'application/zip', buffer: Buffer.alloc(4096) },
      {
        name: 'meeting-notes.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# Notes\n\nline two\n'),
      },
    ]);
    // Over the 50 MB per-file limit: staged as failed, never uploaded, still previewable.
    await pasteFiles(page, [
      { kind: 'bytes', name: 'huge-recording.mp4', type: 'video/mp4', size: 50 * 1024 * 1024 + 1 },
    ]);

    const list = page.getByTestId('composer-attachments');
    await expect(list.locator('li')).toHaveCount(5);
    const pasteCard = page.getByRole('button', {
      name: /^Preview Pasted text, Pasted text, 140 lines/,
    });
    await expect(pasteCard).toContainText('2026-11-07T14:08:00Z ERROR');
    await expect(
      page.getByRole('button', {
        name: /^Preview huge-recording\.mp4.*failed: Larger than the 50 MB limit/,
      })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    // The thumbnail is the real decoded local image.
    const thumb = list.locator('img').first();
    await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(800);
    expect(await thumb.getAttribute('src')).toMatch(/^blob:/);
    // The row stays inside the composer: its right edge never passes the textarea's.
    const listBox = (await list.boundingBox())!;
    const textareaBox = (await page.locator('textarea[role="combobox"]').boundingBox())!;
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(textareaBox.y).toBeGreaterThan(listBox.y);
    await screenshot(page, `attachment-previews-${mode}-cards-${suffix}`);
    await assertNoOverflow(page);

    // Image viewer reads the local file.
    await page.getByRole('button', { name: /^Preview CleanShot_2026-11-07\.png/ }).click();
    const dialog = page.getByTestId('attachment-preview');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('800 × 500');
    const viewerImg = dialog.getByRole('img', { name: 'CleanShot_2026-11-07.png' });
    expect(await viewerImg.getAttribute('src')).toMatch(/^blob:/);
    const dialogBox = (await dialog.boundingBox())!;
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await screenshot(page, `attachment-previews-${mode}-image-viewer-${suffix}`);
    await assertNoOverflow(page);

    // Arrow key → the paste, with numbered lines; Edit in message puts it back in the box.
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('attachment-text-preview')).toContainText('turn=139');
    await screenshot(page, `attachment-previews-${mode}-text-viewer-${suffix}`);
    await assertNoOverflow(page);
    await page.getByRole('button', { name: 'Edit in message' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('textarea[role="combobox"]')).toHaveValue(LONG_PASTE);
    await expect(list.locator('li')).toHaveCount(4);

    // The failed file still opens from the local copy and explains itself.
    await page.getByRole('button', { name: /^Preview huge-recording\.mp4/ }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Larger than the 50 MB limit. Remove it to send'
    );
    // Its bytes are zeros, so the player gives up and the viewer says so instead of showing a blank.
    await expect(dialog).toContainText("This video can't play in your browser");
    await screenshot(page, `attachment-previews-${mode}-failed-viewer-${suffix}`);
    await page.getByRole('button', { name: 'Remove huge-recording.mp4' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    expect(uploads).toHaveLength(4);

    // A real recording plays from the local file.
    await pasteFiles(page, [{ kind: 'video', name: 'screen-recording.webm' }]);
    await page.getByRole('button', { name: /^Preview screen-recording\.webm/ }).click();
    const video = dialog.getByTestId('video-preview');
    await expect(video).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState >= 1 && el.videoWidth))
      .toBe(320);
    await screenshot(page, `attachment-previews-${mode}-video-viewer-${suffix}`);
    await assertNoOverflow(page);
  });

  test(`attachment previews ${mode}: twenty files scroll sideways inside the composer`, async ({
    page,
  }, testInfo) => {
    await openMockedChat(page, mode, mode === 'active' ? ACTIVE_SESSION.id : undefined);
    await mockUploads(page);
    await pasteFiles(page, [
      ...Array.from({ length: 6 }, (_, i) => ({
        kind: 'image' as const,
        name: `screenshot-${i}.png`,
        width: i % 2 ? 4000 : 300,
        height: i % 2 ? 300 : 2400,
      })),
      ...['a.zip', 'b.pdf', 'c.xlsx', 'd.mp3', 'e.tar.gz', 'f.bin', 'core'].map((name) => ({
        kind: 'bytes' as const,
        name,
        type: '',
        size: 2048,
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        kind: 'bytes' as const,
        name: `${'quarterly-infrastructure-cost-review-'.repeat(4)}${i}.csv`,
        type: 'text/csv',
        size: 1024,
      })),
    ]);
    const list = page.getByTestId('composer-attachments');
    await expect(list.locator('li')).toHaveCount(20);
    await expect(page.getByText('20 attachments')).toBeVisible();
    const scroll = await list.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(scroll.sw).toBeGreaterThan(scroll.cw);
    await expect(page.locator('textarea[role="combobox"]')).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
    await screenshot(
      page,
      `attachment-previews-${mode}-twenty-${getProjectSuffix(testInfo.project.name)}`
    );
    await assertNoOverflow(page);
  });
}
