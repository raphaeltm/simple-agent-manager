import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

const PROJECT_ID = 'proj-system-context';
const SESSION_ID = 'sess-system-context';
const USER_TEXT =
  'Keep my exact request visible: ship the origin pipeline ✅ <without changing this text>.';
const INJECTED_TEXT = `IMPORTANT: ${'Long SAM-injected policy and knowledge context with unicode 日本語, emoji 🔒, and <script>literal entities</script>. '.repeat(18)} Call get_instructions before starting.`;

const PROJECT = {
  id: PROJECT_ID,
  name: 'System Context Audit',
  repository: 'user/system-context-audit',
  repoProvider: 'github',
  createdAt: '2026-07-11T00:00:00Z',
  updatedAt: '2026-07-11T00:00:00Z',
};

const SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Injected context disclosure',
  status: 'stopped',
  messageCount: 3,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  agentType: 'openai-codex',
};

const MESSAGES = [
  {
    id: 'user',
    sessionId: SESSION_ID,
    role: 'user',
    content: USER_TEXT,
    toolMetadata: null,
    createdAt: Date.now() - 30_000,
    sequence: 1,
  },
  {
    id: 'system',
    sessionId: SESSION_ID,
    role: 'user',
    content: INJECTED_TEXT,
    toolMetadata: null,
    origin: 'system',
    createdAt: Date.now() - 29_000,
    sequence: 2,
  },
  {
    id: 'assistant',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: 'I received the full context and kept the user request intact.',
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
    sequence: 3,
  },
];

async function setup(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true')
  );
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: PROJECT,
    session: SESSION,
    messages: MESSAGES,
  });
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
}

async function audit(page: Page, viewport: 'mobile' | 'desktop') {
  await setup(page);
  await expect(page.getByText(USER_TEXT)).toBeVisible();
  const disclosure = page.locator('details.sam-injected-message');
  await expect(disclosure).not.toHaveAttribute('open', '');
  await expect(page.getByText(INJECTED_TEXT)).not.toBeVisible();
  const summary = page.getByText('Show system context');
  await expect(summary).toBeVisible();
  if (viewport === 'mobile') {
    expect((await summary.locator('xpath=..').boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await assertNoOverflow(page);
  await screenshot(page, `project-chat-system-context-collapsed-${viewport}`);

  await summary.click();
  await expect(disclosure).toHaveAttribute('open', '');
  await expect(page.getByText(INJECTED_TEXT)).toBeVisible();
  await expect(page.getByText(USER_TEXT)).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, `project-chat-system-context-expanded-${viewport}`);
}

test('keeps mixed user text visible and long injected context collapsed/expandable', async ({
  page,
}, testInfo) => {
  const viewport = testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
  await audit(page, viewport);
});
