/**
 * Visual audit for SAM notice rows in project chat (rule 17).
 *
 * Messages SAM injects into a chat render as one quiet line that expands on tap into detail,
 * quoted text, entity cards and the agent text. Mounts the real project chat route against
 * mocked APIs; the stress cases are a 200+ character headline, eight cards, a long unbroken
 * quote with a URL, a notice with no cards, and a multi-line system log (rule 56).
 */

import { expect, type Page, test } from '@playwright/test';

import {
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
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});

const MOCK_PROJECT = makeMockProject();

const SESSION = {
  id: 'session-1',
  projectId: 'proj-test-1',
  taskId: 'task-session-1',
  topic: 'Auth cleanup: redirect loop and billing migration',
  status: 'active',
  workspaceId: null,
  nodeId: null,
  branch: 'sam/auth-cleanup',
  startedAt: Date.parse('2026-01-15T10:00:00Z'),
  lastMessageAt: Date.parse('2026-01-15T10:40:00Z'),
  createdAt: Date.parse('2026-01-15T10:00:00Z'),
  updatedAt: Date.parse('2026-01-15T10:40:00Z'),
  stoppedAt: null,
  viewerAccess: 'owner',
};

const LONG_TITLE =
  'Audit every place the platform injects messages into a chat and replace raw identifiers with readable notices across the API, the web app and the VM agent, including legacy paths';
const UNBROKEN =
  'https://github.com/raphaeltm/simple-agent-manager/pull/2551/files#diff-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function delivery(source: string, samNotice: Record<string, unknown>) {
  return { source, kind: 'durable_prompt_delivery', deliveryId: `d-${source}`, samNotice };
}

let t = Date.parse('2026-01-15T10:00:00Z');
function message(
  id: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  toolMetadata: Record<string, unknown> | null = null
) {
  t += 60_000;
  return { id, sessionId: 'session-1', role, content, toolMetadata, createdAt: t, sequence: t };
}

const MESSAGES = [
  message('u1', 'user', 'Split the auth cleanup into two subtasks and tell me when both are done.'),
  message('a1', 'assistant', "Dispatched both subtasks. I'll report back once each has a PR."),
  message(
    'n-done',
    'user',
    'SAM durable orchestration event: a wait_for_subtasks subscription resolved.\n\n{"waitId":"01M6R7C5M2","reason":"condition_met","children":[{"taskId":"child-1","status":"completed"}]}',
    delivery('parent_wakeup', {
      v: 1,
      type: 'subtask.completed',
      headline: 'Subtask finished: Fix login redirect loop on expired sessions',
      severity: 'success',
      refs: [
        {
          kind: 'task',
          id: 'child-1',
          label: 'Fix login redirect loop on expired sessions',
          status: 'Completed',
        },
        {
          kind: 'pull_request',
          id: '2551',
          label: 'fix(web): stop redirect loop when the session cookie expires',
          status: 'Checks passing',
          url: 'https://github.com/raphaeltm/simple-agent-manager/pull/2551',
        },
      ],
    })
  ),
  message(
    'n-agent',
    'user',
    'SAM notice (system-generated, not a human message): agent message batch 01M6R7J has 1 new message(s) on channel agent-dm.4f1c0e9a7b. Event IDs: 01M6R7J1.',
    delivery('project_event_wake', {
      v: 1,
      type: 'agent.message',
      headline: 'Message from another agent',
      severity: 'info',
      quote: {
        from: 'Another agent',
        text: `Heads up: #2551 changes the cookie name <b>&amp;</b> 🚀 See ${UNBROKEN}`,
      },
      refs: [{ kind: 'task', id: 'reviewer-1', label: 'Review open auth pull requests' }],
    })
  ),
  message(
    'n-many',
    'user',
    'SAM durable orchestration event: a wait_for_subtasks subscription resolved.',
    delivery('parent_wakeup', {
      v: 1,
      type: 'subtask.failed',
      headline: `Subtask finished: ${LONG_TITLE}`,
      severity: 'error',
      refs: Array.from({ length: 8 }, (_, i) => ({
        kind: i % 2 ? 'task' : 'idea',
        id: `ref-${i}`,
        label: i === 0 ? LONG_TITLE : `Linked item number ${i + 1}`,
        status: i === 1 ? 'Failed' : i === 3 ? 'Running' : null,
      })),
    })
  ),
  message(
    'a2',
    'assistant',
    'The redirect fix is in #2551. Rewriting the billing migration to use ALTER TABLE.'
  ),
  message(
    'n-checkin',
    'user',
    '[SAM Orchestrator Check-In] Your task appears to have stalled — no activity detected for several minutes.',
    {
      source: 'sam_orchestrator',
      kind: 'reconciliation_checkin',
      deliveryId: 'ci-1',
      samNotice: {
        v: 1,
        type: 'checkin.stalled',
        headline: 'SAM asked the agent for a progress update',
        detail:
          "No activity for 12 minutes. If the agent doesn't reply soon, the task is marked failed.",
        severity: 'info',
        refs: [],
      },
    }
  ),
  message(
    's-log',
    'system',
    'Workspace build failed\n# Step 1/23 : FROM node:18\n* Installing dependencies...\nnpm ERR! code ERESOLVE'
  ),
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
    ownTask: {
      id: 'child-1',
      title: 'Fix login redirect loop on expired sessions',
      status: 'completed',
      executionStep: null,
      errorMessage: null,
      outputBranch: 'sam/fix-login-loop',
      outputSummary:
        'Expired sessions now clear the cookie before redirecting, so the login page no longer bounces back to the dashboard.',
      outputPrUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/2551',
      startedAt: '2026-01-15T10:00:00Z',
      workspaceId: null,
    },
  });
  await page.goto('/projects/proj-test-1/chat/session-1');
  await expect(page.getByTestId('sam-notice-row').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('body')).not.toContainText('Do you have a cloud hosting account?');
}

function noticeRow(page: Page, type: string) {
  return page.locator(`[data-testid="sam-notice-row"][data-notice-type="${type}"]`).first();
}

/** Every card and quote stays inside the conversation log, measured in page coordinates. */
async function assertInsideLog(page: Page, selector: string) {
  const log = await page.getByRole('log', { name: 'Conversation' }).boundingBox();
  expect(log).not.toBeNull();
  const boxes = await page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    })
  );
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(log!.x - 1);
    expect(box.right).toBeLessThanOrEqual(log!.x + log!.width + 1);
  }
}

for (const viewport of [
  { name: 'Mobile', width: 375, height: 667, isMobile: true },
  { name: 'Desktop', width: 1280, height: 800, isMobile: false },
]) {
  test.describe(`SAM notice rows — ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
    });

    test('collapsed notices are one line each, between real messages', async ({ page }) => {
      await openChat(page);
      // Liveness: the agent's reply renders normally between the notices. (The list is
      // virtualized and opens at the bottom, so assert on rows near the end.)
      await expect(page.getByText('The redirect fix is in #2551.')).toBeVisible();
      await expect(noticeRow(page, 'checkin.stalled')).toBeVisible();
      await expect(noticeRow(page, 'system.message')).toBeVisible();
      for (const toggle of await page.locator('[data-testid="sam-notice-row"] > button').all()) {
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        const box = await toggle.boundingBox();
        expect(box!.height).toBeLessThanOrEqual(40);
      }
      // The ID-heavy agent text stays hidden.
      await expect(page.getByText(/wait_for_subtasks/)).toHaveCount(0);
      await assertNoOverflow(page);
      await screenshot(page, `sam-notice-rows-collapsed-${viewport.name.toLowerCase()}`);
    });

    test('a subtask notice expands into cards and the agent text', async ({ page }) => {
      await openChat(page);
      const row = noticeRow(page, 'subtask.completed');
      await row.getByRole('button', { name: /Subtask finished: Fix login/ }).click();
      await expect(row.getByTestId('sam-notice-ref')).toHaveCount(2);
      await expect(row.getByTestId('sam-notice-ref').nth(1)).toHaveAttribute(
        'href',
        'https://github.com/raphaeltm/simple-agent-manager/pull/2551'
      );
      await row.getByText('Show what the agent saw').click();
      await expect(row.locator('pre')).toContainText('wait_for_subtasks');
      await assertInsideLog(page, '[data-testid="sam-notice-ref"]');
      await assertNoOverflow(page);
      await row.scrollIntoViewIfNeeded();
      await screenshot(page, `sam-notice-rows-expanded-${viewport.name.toLowerCase()}`);
    });

    test('a long quote, a long headline and eight cards stay inside the conversation', async ({
      page,
    }) => {
      await openChat(page);
      const agent = noticeRow(page, 'agent.message');
      await agent.getByRole('button', { name: /Message from another agent/ }).click();
      await expect(agent.getByText('not written by SAM', { exact: false })).toBeVisible();
      // Special characters render as text, never as markup.
      await expect(agent.locator('blockquote')).toContainText('<b>&amp;</b> 🚀');
      await expect(agent.locator('blockquote b')).toHaveCount(0);
      const many = noticeRow(page, 'subtask.failed');
      await many.locator('> button').click();
      await expect(many.getByTestId('sam-notice-ref')).toHaveCount(8);
      await assertInsideLog(
        page,
        '[data-testid="sam-notice-ref"], [data-testid="sam-notice-body"] figure'
      );
      await assertNoOverflow(page);
      await screenshot(page, `sam-notice-rows-stress-${viewport.name.toLowerCase()}`);
      await many.scrollIntoViewIfNeeded();
      await screenshot(page, `sam-notice-rows-many-cards-${viewport.name.toLowerCase()}`);
    });

    test('a task card opens a quick-look dialog with live task data', async ({ page }) => {
      await openChat(page);
      const row = noticeRow(page, 'subtask.completed');
      await row.locator('> button').click();
      await row.getByTestId('sam-notice-ref').first().click();
      const dialog = page.getByTestId('sam-notice-task-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Expired sessions now clear the cookie');
      await expect(dialog.getByRole('link', { name: 'Open its chat' })).toHaveAttribute(
        'href',
        '/projects/proj-test-1/tasks/child-1'
      );
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      await assertNoOverflow(page);
      await screenshot(page, `sam-notice-rows-dialog-${viewport.name.toLowerCase()}`);
    });

    test('a system row and a no-card notice expand cleanly', async ({ page }) => {
      await openChat(page);
      const system = noticeRow(page, 'system.message');
      await system.getByRole('button', { name: /Workspace build failed/ }).click();
      await system.getByText('Show full message').click();
      await expect(system.locator('pre')).toContainText('npm ERR! code ERESOLVE');
      const checkin = noticeRow(page, 'checkin.stalled');
      await checkin.locator('> button').click();
      await expect(checkin).toContainText('No activity for 12 minutes.');
      await expect(checkin.getByTestId('sam-notice-ref')).toHaveCount(0);
      await assertNoOverflow(page);
      await system.scrollIntoViewIfNeeded();
      await screenshot(page, `sam-notice-rows-system-${viewport.name.toLowerCase()}`);
    });
  });
}
