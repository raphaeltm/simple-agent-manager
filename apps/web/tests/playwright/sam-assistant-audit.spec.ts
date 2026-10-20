import { expect, type Page, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const user = makeMockUser({
  userId: 'sam-user',
  sessionId: 'sam-session',
  email: 'sam@example.com',
  name: 'SAM User',
});
function turn(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    request_key: `request-${id}`,
    message: `Message ${id}`,
    state: 'completed',
    response: 'A grounded update. [View the project](/projects/project-1)',
    error: null,
    actions: [],
    ...overrides,
  };
}

async function mockSam(
  page: Page,
  options: {
    enabled?: boolean;
    turns?: ReturnType<typeof turn>[];
    older?: ReturnType<typeof turn>[];
    failSend?: boolean;
    failHistory?: boolean;
    available?: boolean;
    work?: Record<string, unknown>[];
    rejectSend?: boolean;
    legacy?: boolean;
  } = {}
) {
  let enabled = options.enabled ?? true;
  let failSend = options.failSend ?? false;
  let failHistory = options.failHistory ?? false;
  let turns = options.turns ?? [];
  const submissions: { requestKey: string; message: string }[] = [];
  const confirmations: boolean[] = [];
  const cursors: string[] = [];
  let historyReads = 0;
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-sam-user', 'true')
  );
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const method = route.request().method();
    const respond = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path.includes('/api/auth/')) return respond(user);
    if (path === '/api/sam/settings') {
      if (method === 'PATCH') enabled = route.request().postDataJSON().enabled;
      return respond({ enabled, available: options.available ?? true });
    }
    if (path === '/api/sam/conversations/legacy/messages')
      return respond({
        messages: [
          { id: 'old-user', role: 'user', content: 'My earlier request' },
          { id: 'operator:recent', role: 'assistant', content: 'Duplicated canonical message' },
        ],
        nextCursor: null,
      });
    if (path === '/api/sam/turns') {
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        submissions.push(body);
        if (options.rejectSend)
          return respond(
            { error: 'INVALID', message: 'Message is too long', rejectedBeforeEffects: true },
            400
          );
        if (failSend) {
          failSend = false;
          return route.abort('failed');
        }
        const receipt = turn('accepted', { message: body.message, request_key: body.requestKey });
        turns = [...turns, receipt];
        return respond({ turn: receipt, accepted: true, replayed: false });
      }
      historyReads++;
      if (failHistory)
        return respond({ error: 'UNAVAILABLE', message: 'History could not load' }, 503);
      const before = url.searchParams.get('before');
      if (before) {
        cursors.push(before);
        return respond({ turns: options.older ?? [], nextCursor: null });
      }
      return respond({
        conversationId: 'legacy',
        legacyHistoryAvailable: options.legacy,
        turns,
        nextCursor: options.older ? '1720:tuple-id' : null,
        work: options.work ?? [],
      });
    }
    if (path.endsWith('/seen')) {
      for (const item of options.work ?? [])
        item.updates = { unread: 0, lastEventType: null, lastEventAt: null };
      return respond({ seen: true });
    }
    if (path.endsWith('/reconcile')) {
      turns = turns.map((item) => ({ ...item, actions: [] }));
      return respond({ reconciled: true });
    }
    if (path.endsWith('/confirm')) {
      confirmations.push(route.request().postDataJSON().approved);
      turns = turns.map((item) => ({ ...item, actions: [] }));
      return respond({ accepted: true });
    }
    if (path.endsWith('/cancel')) {
      turns = turns.map((item) => ({ ...item, state: 'cancelled' }));
      return respond({ cancelled: true });
    }
    if (path === '/api/credentials' || path === '/api/github/installations') return respond([]);
    if (path === '/api/credentials/agent') return respond({ credentials: [] });
    if (path === '/api/projects') return respond({ projects: [] });
    if (path === '/api/notifications') return respond({ notifications: [], unreadCount: 0 });
    if (path === '/api/notifications/preferences') return respond({ preferences: [] });
    if (path === '/api/agents') return respond({ agents: [] });
    return respond({});
  });
  return {
    submissions,
    confirmations,
    cursors,
    historyReads: () => historyReads,
    disable: () => {
      enabled = false;
    },
    recoverHistory: () => {
      failHistory = false;
    },
  };
}

async function checkLayout(page: Page, name: string) {
  await screenshot(page, name);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

test('off by default gates direct entry and the navigation; settings toggle enables SAM', async ({
  page,
}) => {
  const mock = await mockSam(page, { enabled: false });
  await page.goto('/sam');
  await expect(page.getByRole('heading', { name: 'Your private SAM assistant' })).toBeVisible();
  await expect(page.getByLabel('Message SAM')).toHaveCount(0);
  expect(mock.historyReads()).toBe(0);
  await expect(page.locator('a[href="/sam"]')).toHaveCount(0);
  await checkLayout(page, 'sam-off');
  await page.getByRole('link', { name: 'Open Settings' }).click();
  const toggle = page.getByRole('switch', { name: 'Enable SAM assistant' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await checkLayout(page, 'sam-settings-off');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await checkLayout(page, 'sam-settings-on');
  await page.getByRole('link', { name: 'Open SAM', exact: true }).click();
  await expect(page.getByLabel('Message SAM')).toBeVisible();
  await checkLayout(page, 'sam-empty');
  if (page.viewportSize()!.width < 768) {
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await expect(page.getByRole('button', { name: 'SAM', exact: true })).toBeVisible();
    await checkLayout(page, 'sam-mobile-navigation');
  } else {
    await expect(page.locator('a[href="/sam"]')).toBeVisible();
  }
});

test('retry survives reload with the same key and only one recorded message', async ({ page }) => {
  const mock = await mockSam(page, { failSend: true });
  await page.goto('/sam');
  await page.getByLabel('Message SAM').fill('Start the reviewed task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry message' })).toBeEnabled();
  await checkLayout(page, 'sam-retry-error');
  await page.reload();
  await expect(page.getByLabel('Message SAM')).toHaveValue('Start the reviewed task');
  await page.getByRole('button', { name: 'Retry message' }).click();
  await expect(page.getByLabel('Message SAM')).toHaveValue('');
  expect(mock.submissions).toHaveLength(2);
  expect(mock.submissions[1]).toEqual(mock.submissions[0]);
  await expect(page.locator('article')).toHaveCount(1);
});

test('recent history loads older messages, renders source links and approval receipts', async ({
  page,
}) => {
  const mock = await mockSam(page, {
    turns: [
      turn('recent', {
        actions: [
          {
            id: 'action-1',
            operation: 'sam_stop_task',
            input_json: '{"projectId":"project-1","reason":"User requested stop"}',
            state: 'approval_required',
            result_json: '{"link":"/projects/project-1/chat/session-1"}',
          },
        ],
      }),
    ],
    older: Array.from({ length: 30 }, (_, index) =>
      turn(`older-${index}`, {
        message:
          index === 0
            ? 'A'
            : `Older ${index} · café 👋 <script>alert("XSS")</script> & entities ${'longword'.repeat(45)}`,
      })
    ),
  });
  await page.goto('/sam');
  await expect(page.getByRole('link', { name: 'View the project' })).toHaveAttribute(
    'href',
    '/projects/project-1'
  );
  await expect(page.getByRole('link', { name: 'Open source work' })).toHaveAttribute(
    'href',
    /\/projects\/project-1\/chat\/session-1$/
  );
  await checkLayout(page, 'sam-actions');
  await page.getByRole('button', { name: 'Load older messages' }).click();
  await expect(page.locator('article')).toHaveCount(31);
  expect(mock.cursors).toContain('1720:tuple-id');
  await expect(page.locator('article').first()).toContainText('A');
  await expect(page.locator('article script')).toHaveCount(0);
  await checkLayout(page, 'sam-long-history');
  await page.getByRole('button', { name: 'Confirm this action' }).click();
  await expect(page.getByRole('button', { name: 'Confirm this action' })).toHaveCount(0);
  expect(mock.confirmations).toEqual([true]);
  await page.getByLabel('Message SAM').fill('Draft kept while history refreshes');
  await expect(page.getByLabel('Message SAM')).toHaveValue('Draft kept while history refreshes');
});

test('unavailable action retains its receipt without confirmation controls', async ({ page }) => {
  const mock = await mockSam(page, {
    turns: [
      turn('revoked', {
        actions: [
          {
            id: 'revoked-action',
            available: false,
            operation: 'sam_stop_task',
            input_json: '{}',
            state: 'approval_required',
            result_json: JSON.stringify({
              message:
                'Resource details are no longer accessible. The receipt is retained for your records.',
            }),
          },
        ],
      }),
    ],
  });
  await page.goto('/sam');
  await expect(page.locator('article')).toContainText('Resource details are no longer accessible.');
  await expect(page.getByRole('button', { name: 'Confirm this action' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open source work' })).toHaveCount(0);
  expect(mock.confirmations).toEqual([]);
});

test('active turn can stop without cancelling project work', async ({ page }) => {
  await mockSam(page, { turns: [turn('running', { state: 'running', response: null })] });
  await page.goto('/sam');
  await expect(page.getByText('Working… You can leave this page and return.')).toBeVisible();
  await page.getByLabel('Message SAM').fill('My next draft');
  await page.getByRole('button', { name: 'Stop SAM turn' }).click();
  await expect(page.getByText('SAM · cancelled', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message SAM')).toHaveValue('My next draft');
  await expect(
    page.getByText('Stopping this turn does not cancel project work already dispatched.')
  ).toBeVisible();
});

test('stale tabs lose conversation access when disabled elsewhere', async ({ page }) => {
  const mock = await mockSam(page);
  await page.goto('/sam');
  await expect(page.getByLabel('Message SAM')).toBeVisible();
  mock.disable();
  await page.evaluate(() => {
    const channel = new BroadcastChannel('sam-account-settings');
    channel.postMessage('sam-user');
    channel.close();
  });
  await expect(page.getByLabel('Message SAM')).toHaveCount(0);
  await expect(page.locator('a[href="/sam"]')).toHaveCount(0);
});

test('history errors are visible and recover without sending against unknown state', async ({
  page,
}) => {
  const mock = await mockSam(page, { failHistory: true });
  await page.goto('/sam');
  await expect(page.getByText('History could not load')).toBeVisible();
  await page.getByLabel('Message SAM').fill('Do work');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await checkLayout(page, 'sam-history-error');
  mock.recoverHistory();
  await page.getByRole('button', { name: 'Retry history' }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('320px layout keeps the composer and long text within bounds', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await mockSam(page, {
    turns: [turn('narrow', { message: 'longword'.repeat(100), response: 'A'.repeat(300) })],
  });
  await page.goto('/sam');
  await expect(page.getByLabel('Message SAM')).toBeVisible();
  await checkLayout(page, 'sam-narrow');
});

test('work updates stay expandable and preserve an unrelated draft', async ({ page }) => {
  const mock = await mockSam(page, {
    turns: [turn('work')],
    work: [
      {
        actionId: 'action-1',
        projectId: 'project-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        status: 'in_progress',
        link: '/projects/project-1/chat/session-1',
        observedAt: Date.now(),
        attention: true,
      },
    ],
  });
  await page.goto('/sam');
  const summary = page.getByText('Project work · 1 · Needs attention', { exact: true });
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(page.getByRole('link', { name: 'Open project work' })).toHaveAttribute(
    'href',
    '/projects/project-1/chat/session-1'
  );
  await page.getByLabel('Message SAM').fill('Keep this draft while work updates');
  const initialReads = mock.historyReads();
  await expect.poll(mock.historyReads).toBeGreaterThan(initialReads);
  await expect(page.getByLabel('Message SAM')).toHaveValue('Keep this draft while work updates');
  await expect(page.getByRole('link', { name: 'Open project work' })).toBeVisible();
  await checkLayout(page, 'sam-work-updates');
});

test('definitive pre-admission rejection unlocks the draft for correction', async ({ page }) => {
  await mockSam(page, { rejectSend: true });
  await page.goto('/sam');
  await page.getByLabel('Message SAM').fill('Invalid message');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Message is too long')).toBeVisible();
  await expect(page.getByLabel('Message SAM')).toBeEditable();
  await page.getByLabel('Message SAM').fill('Corrected message');
  await expect(page.getByLabel('Message SAM')).toHaveValue('Corrected message');
});

test('uncertain dispatch checks its existing outcome without resubmitting work', async ({
  page,
}) => {
  const mock = await mockSam(page, {
    turns: [
      turn('uncertain', {
        actions: [
          {
            id: 'uncertain-action',
            operation: 'sam_chat_start',
            input_json: '{"projectId":"project-1"}',
            state: 'uncertain',
            result_json: null,
          },
        ],
      }),
    ],
  });
  await page.goto('/sam');
  await page.getByRole('button', { name: 'Check outcome' }).click();
  await expect(page.getByRole('button', { name: 'Check outcome' })).toHaveCount(0);
  expect(mock.submissions).toHaveLength(0);
});

test('earlier private history loads only on demand and avoids duplicate current messages', async ({
  page,
}) => {
  await mockSam(page, { legacy: true });
  await page.goto('/sam');
  await expect(page.getByText('My earlier request')).toHaveCount(0);
  await page.getByText('Earlier SAM history', { exact: true }).click();
  await expect(page.getByText('My earlier request')).toBeVisible();
  await expect(page.getByText('Duplicated canonical message')).toHaveCount(0);
  await checkLayout(page, 'sam-earlier-history');
});

test('quiet work updates can be marked seen without answering or sending a turn', async ({
  page,
}) => {
  const mock = await mockSam(page, {
    work: [
      {
        actionId: 'update-action',
        taskTitle: 'Review the change',
        projectName: 'SAM',
        projectId: 'project-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        status: 'completed',
        observedAt: Date.now(),
        attention: false,
        updates: { unread: 2, lastEventType: 'task.completed', lastEventAt: Date.now() },
      },
    ],
  });
  await page.goto('/sam');
  await page.getByText('Project work · 1 · New updates', { exact: true }).click();
  await expect(page.getByText('2 unseen updates')).toBeVisible();
  await checkLayout(page, 'sam-unread-work');
  await page.getByRole('button', { name: 'Mark seen' }).click();
  await expect(page.getByText('2 unseen updates')).toHaveCount(0);
  expect(mock.submissions).toHaveLength(0);
  await expect(page.getByRole('link', { name: 'Open project work' })).toBeVisible();
});

test('users can persistently opt out while the installation is unavailable', async ({ page }) => {
  await mockSam(page, { enabled: true, available: false });
  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: 'Enable SAM assistant' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Open SAM', exact: true })).toHaveCount(0);
});
