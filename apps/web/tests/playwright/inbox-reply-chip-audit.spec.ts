/**
 * Visual audit for the "Re:" chip on inbox replies in the project chat (rule 17). A reply sent
 * from the inbox is an ordinary user message whose delivery metadata names the item; the chip
 * opens the item. Stress cases: a 200+ character item title, a reply with no recorded title, and
 * a long unbroken reply body.
 */
import { expect, type Page, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeIdleSessionState,
  makeMockProject,
  makeMockUser,
  screenshot,
  setupSleepingChatMocks,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});
const MOCK_PROJECT = makeMockProject();
const SESSION = {
  id: 'session-1',
  projectId: 'proj-test-1',
  taskId: 'task-session-1',
  topic: 'Workspace deletion retries',
  status: 'active',
  workspaceId: null,
  nodeId: null,
  branch: 'sam/retries',
  startedAt: Date.parse('2026-01-15T10:00:00Z'),
  lastMessageAt: Date.parse('2026-01-15T10:40:00Z'),
  createdAt: Date.parse('2026-01-15T10:00:00Z'),
  updatedAt: Date.parse('2026-01-15T10:40:00Z'),
  stoppedAt: null,
  viewerAccess: 'owner',
};

const LONG_TITLE =
  'Should the retry cap apply per node or per project, given that noisy nodes on the flaky provider region keep starving the others and the per-project cap would hide which node is actually failing?';

let t = Date.parse('2026-01-15T10:00:00Z');
function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  toolMetadata: Record<string, unknown> | null = null
) {
  t += 60_000;
  return { id, sessionId: 'session-1', role, content, toolMetadata, createdAt: t, sequence: t };
}
const inboxReply = (ref: string, inboxTitle?: string) => ({
  kind: 'durable_prompt_delivery',
  source: 'inbox_reply',
  deliveryId: `d-${ref}`,
  userId: 'user-test-1',
  inboxRef: ref,
  ...(inboxTitle ? { inboxTitle } : {}),
});

const MESSAGES = [
  message('a1', 'assistant', 'Retries are capped and logged. One open design point before I push.'),
  message(
    'r1',
    'user',
    'What happens to nodes that are already mid-retry? https://logs.example.com/a/very/long/unbroken/path/segment/that/should/never/push/the/layout/sideways',
    inboxReply('ask:01Q', LONG_TITLE)
  ),
  message('a2', 'assistant', 'Good question. I responded on the inbox item.'),
  message('r2', 'user', 'Ok, per node.', inboxReply('ask:01R')),
];

async function openChat(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true');
  });
  await setupSleepingChatMocks(page, {
    user: MOCK_USER,
    project: MOCK_PROJECT,
    session: SESSION,
    messages: MESSAGES,
    state: makeIdleSessionState(),
  });
  await page.goto('/projects/proj-test-1/chat/session-1');
}

for (const viewport of [
  { name: 'mobile', width: 375, height: 667, isMobile: true },
  { name: 'desktop', width: 1280, height: 800, isMobile: false },
]) {
  test.describe(`Inbox reply chip — ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
    });

    test('a reply from the inbox names its item and opens it', async ({ page }) => {
      await openChat(page);
      const chips = page.getByTestId('inbox-reply-chip');
      await expect(chips.last()).toBeVisible({ timeout: 10_000 });
      await expect(chips.last()).toHaveText('Re: an inbox item');
      // Liveness: the reply is an ordinary bubble beside its chip.
      await expect(page.getByText('Ok, per node.')).toBeVisible();
      // The chip stays inside the conversation, however long the title.
      const log = (await page.getByRole('log', { name: 'Conversation' }).boundingBox())!;
      for (const box of await chips.evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect)
      )) {
        expect(box.left).toBeGreaterThanOrEqual(log.x - 1);
        expect(box.right).toBeLessThanOrEqual(log.x + log.width + 1);
      }
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await screenshot(page, `inbox-reply-chip-${viewport.name}`);
      await chips.last().getByRole('link').click();
      await expect(page).toHaveURL(/\/projects\/proj-test-1\/inbox\?item=ask%3A01R$/);
    });
  });
}
