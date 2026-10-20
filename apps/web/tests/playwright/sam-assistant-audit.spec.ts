import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';
import { expectDispatchSourceLink } from './staging-sam-dispatch-link';

const user = makeMockUser({
  userId: 'sam-user',
  sessionId: 'sam-session',
  email: 'sam@example.com',
  name: 'SAM User',
});
const project = {
  id: 'project-1',
  name: 'Website redesign',
  repository: 'acme/website',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: 'sam-user',
  installationId: 'inst-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  summary: {
    activeWorkspaceCount: 0,
    activeSessionCount: 0,
    lastActivityAt: null,
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
};
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
/** A real destructive operation as the server projects it while awaiting confirmation. */
const stopAction = {
  id: 'action-1',
  operation: 'sam_work_stop',
  input_json: '{"projectId":"project-1","sessionId":"session-1"}',
  state: 'approval_required',
  result_json: null,
};
/** Read receipts arrive stripped to `{}` by the server projection. */
function readAction(id: string, operation: string) {
  return { id, operation, input_json: '{}', state: 'completed', result_json: null };
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
    transcript?: string;
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
    if (path === '/api/projects') return respond({ projects: [project] });
    if (path === '/api/notifications') return respond({ notifications: [], unreadCount: 0 });
    if (path === '/api/notifications/preferences') return respond({ preferences: [] });
    if (path === '/api/agents') return respond({ agents: [] });
    if (path === '/api/transcribe') return respond({ text: options.transcript ?? '' });
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

/**
 * 44 CSS px matches the project chat composer and the reviewed Automation page.
 * The repository removed blanket 56px mandates in favour of compact controls
 * (commit 95c810a49); this floor guards against regressions to tiny targets.
 */
async function checkTouchTarget(control: Locator) {
  const box = await control.boundingBox();
  expect(box, 'Primary control has a measurable touch target').not.toBeNull();
  expect(box!.height, 'Primary control is at least 44 CSS pixels tall').toBeGreaterThanOrEqual(44);
  expect(box!.width, 'Primary control is at least 44 CSS pixels wide').toBeGreaterThanOrEqual(44);
}

async function checkComposerTouchTargets(page: Page) {
  const buttons = page.getByLabel('Message SAM').locator('..').getByRole('button');
  await expect(buttons).toHaveCount(2);
  for (const button of await buttons.all()) await checkTouchTarget(button);
  await page
    .getByLabel('Message SAM')
    .locator('..')
    .screenshot({
      path: test.info().outputPath(`composer-${page.viewportSize()?.width}.png`),
    });
}

/** The composer is pinned: fully on screen, and the newest turn ends above it. */
async function checkComposerPinned(page: Page) {
  const composer = page.locator('form').filter({ has: page.getByLabel('Message SAM') });
  await expect(composer).toBeInViewport({ ratio: 1 });
  const viewport = page.viewportSize()!;
  const composerBox = (await composer.boundingBox())!;
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(viewport.height + 1);
  const newest = page.locator('article').last();
  if ((await newest.count()) > 0) {
    await expect(newest).toBeInViewport();
    const scrollerBox = (await page.getByTestId('sam-conversation-scroller').boundingBox())!;
    expect(scrollerBox.y + scrollerBox.height).toBeLessThanOrEqual(composerBox.y + 1);
  }
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
  const originalViewport = page.viewportSize()!;
  const openSettings = page.getByRole('link', { name: 'Open Settings' });
  await checkTouchTarget(openSettings);
  await checkLayout(page, 'sam-off');
  await page.setViewportSize({ width: 320, height: 667 });
  await checkTouchTarget(openSettings);
  await checkLayout(page, 'sam-off-narrow');
  await page.setViewportSize(originalViewport);
  await openSettings.click();
  const toggle = page.getByRole('switch', { name: 'Enable SAM assistant' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // The visible state word sits beside the switch and mirrors aria-checked.
  await expect(toggle.locator('..').getByText('Off', { exact: true })).toBeVisible();
  await checkTouchTarget(toggle);
  await checkLayout(page, 'sam-settings-off');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle.locator('..').getByText('On', { exact: true })).toBeVisible();
  const openSam = page.getByRole('link', { name: 'Open SAM', exact: true });
  await checkTouchTarget(openSam);
  // The opt-in stays compact so the settings tabs remain on the first screen.
  await expect(page.getByRole('tab', { name: 'Cloud Provider' })).toBeInViewport({ ratio: 1 });
  await checkLayout(page, 'sam-settings-on');
  await page.setViewportSize({ width: 320, height: 667 });
  await checkTouchTarget(toggle);
  await checkTouchTarget(openSam);
  await checkLayout(page, 'sam-settings-on-narrow');
  await page.setViewportSize(originalViewport);
  await openSam.click();
  await expect(page.getByLabel('Message SAM')).toBeVisible();
  await checkComposerTouchTargets(page);
  await checkComposerPinned(page);
  await checkLayout(page, 'sam-empty');
  if (page.viewportSize()!.width < 768) {
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    const samItem = page.getByRole('button', { name: 'SAM', exact: true });
    await expect(samItem).toBeVisible();
    await expect(samItem.locator('svg.lucide-bot')).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Chats', exact: true }).locator('svg.lucide-bot')
    ).toHaveCount(0);
    await checkLayout(page, 'sam-mobile-navigation');
  } else {
    await expect(page.locator('a[href="/sam"]')).toBeVisible();
    // SAM and Chats must not share an icon (indistinguishable in the collapsed sidebar).
    await expect(page.locator('a[href="/sam"] svg.lucide-bot')).toHaveCount(1);
    await expect(page.locator('a[href="/chats"] svg.lucide-bot')).toHaveCount(0);
  }
});

test('retry survives reload with the same key and only one recorded message', async ({ page }) => {
  const mock = await mockSam(page, { failSend: true });
  await page.goto('/sam');
  await page.getByLabel('Message SAM').fill('Start the reviewed task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry message' })).toBeEnabled();
  // The failure is shown inside the pinned composer, never below the fold, in plain words.
  await expect(page.getByRole('alert')).toBeInViewport();
  await expect(page.getByRole('alert')).toHaveText(
    'Couldn’t reach SAM. Check your connection and try again.'
  );
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
          readAction('read-inbox', 'sam_inbox_get'),
          readAction('read-projects', 'sam_projects_list'),
          stopAction,
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
  // Reads collapse to one quiet line; only the effect gets a card.
  await expect(page.getByText('Checked your inbox and projects')).toBeVisible();
  await expect(page.getByText('Exact request')).toHaveCount(1);
  // The confirmation says what will happen, where, and links to the target for review.
  await expect(page.getByText('Needs your confirmation')).toBeVisible();
  await expect(page.getByText('In Website redesign')).toBeVisible();
  await expect(
    page.getByText('This cancels the running work and shuts down its workspace.')
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open chat' })).toHaveAttribute(
    'href',
    /\/projects\/project-1\/chat\/session-1$/
  );
  // While approval is pending the exact recorded request is already open: confirm what you see.
  const exactRequest = page.getByText('"sessionId": "session-1"');
  await expect(exactRequest).toBeVisible();
  await page.getByText('Exact request').click();
  await expect(exactRequest).toBeHidden();
  await page.getByText('Exact request').click();
  await expect(exactRequest).toBeVisible();
  const originalViewport = page.viewportSize()!;
  const confirm = page.getByRole('button', { name: 'Confirm stop' });
  await checkTouchTarget(confirm);
  await checkTouchTarget(page.getByRole('button', { name: 'Keep running' }));
  await checkLayout(page, 'sam-actions');
  await page.setViewportSize({ width: 320, height: 667 });
  await checkTouchTarget(confirm);
  await checkLayout(page, 'sam-actions-narrow');
  await page.setViewportSize(originalViewport);
  await page.getByRole('button', { name: 'Load older messages' }).click();
  await expect(page.locator('article')).toHaveCount(31);
  expect(mock.cursors).toContain('1720:tuple-id');
  await expect(page.locator('article').first()).toContainText('A');
  await expect(page.locator('article script')).toHaveCount(0);
  await checkLayout(page, 'sam-long-history');
  await page.getByRole('button', { name: 'Confirm stop' }).click();
  await expect(page.getByRole('button', { name: 'Confirm stop' })).toHaveCount(0);
  expect(mock.confirmations).toEqual([true]);
  await page.getByLabel('Message SAM').fill('Draft kept while history refreshes');
  await expect(page.getByLabel('Message SAM')).toHaveValue('Draft kept while history refreshes');
});

test('an agent answer awaiting approval shows the proposed answer and target', async ({ page }) => {
  const mock = await mockSam(page, {
    turns: [
      turn('answer', {
        message: 'Let the deploy agent run the migration once',
        response: 'I can answer its permission request. Please confirm below.',
        actions: [
          {
            id: 'answer-1',
            operation: 'sam_agent_answer',
            input_json:
              '{"interactionId":"int-1","optionId":"allow_once","projectId":"project-1","sessionId":"session-1"}',
            state: 'approval_required',
            result_json: null,
          },
        ],
      }),
    ],
  });
  await page.goto('/sam');
  const card = page.getByRole('group', { name: 'Answer an agent' });
  await expect(card.getByText('Needs your confirmation')).toBeVisible();
  await expect(card.getByText('Proposed answer')).toBeVisible();
  await expect(card.getByText('Choose “allow_once”')).toBeVisible();
  await expect(card.getByText('In Website redesign')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open chat' })).toHaveAttribute(
    'href',
    '/projects/project-1/chat/session-1'
  );
  await expect(card.getByText('"optionId": "allow_once"')).toBeVisible();
  await checkTouchTarget(card.getByRole('button', { name: 'Send answer' }));
  await checkLayout(page, 'sam-agent-answer');
  await card.getByRole('button', { name: 'Don’t send' }).click();
  expect(mock.confirmations).toEqual([false]);
});

test('only completed reads join the summary; others keep their own state', async ({ page }) => {
  await mockSam(page, {
    turns: [
      turn('reads', {
        actions: [
          readAction('read-projects', 'sam_projects_list'),
          { ...readAction('read-inbox', 'sam_inbox_get'), state: 'pending' },
          { ...readAction('read-tasks', 'sam_tasks_list'), state: 'uncertain' },
        ],
      }),
    ],
  });
  await page.goto('/sam');
  await expect(page.getByText('Checked projects', { exact: true })).toBeVisible();
  const inbox = page.getByRole('group', { name: 'Check your inbox' });
  await expect(inbox.getByText('In progress')).toBeVisible();
  const tasks = page.getByRole('group', { name: 'List tasks' });
  await expect(tasks.getByText('Outcome unknown')).toBeVisible();
  // Stripped read receipts have nothing further to disclose.
  await expect(page.getByText('Exact request')).toHaveCount(0);
  await checkLayout(page, 'sam-read-states');
});

test('declining a confirmation sends an explicit refusal', async ({ page }) => {
  const mock = await mockSam(page, { turns: [turn('stop', { actions: [stopAction] })] });
  await page.goto('/sam');
  await page.getByRole('button', { name: 'Keep running' }).click();
  await expect(page.getByRole('button', { name: 'Keep running' })).toHaveCount(0);
  expect(mock.confirmations).toEqual([false]);
});

test('unavailable action retains its receipt without confirmation controls', async ({ page }) => {
  const mock = await mockSam(page, {
    turns: [
      turn('revoked', {
        actions: [
          {
            id: 'revoked-action',
            available: false,
            operation: 'sam_work_stop',
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
  await expect(page.getByText('No longer available')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm stop' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Keep running' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open chat' })).toHaveCount(0);
  await expect(page.getByText('Exact request')).toHaveCount(0);
  expect(mock.confirmations).toEqual([]);
});

test('active turn can stop without cancelling project work', async ({ page }) => {
  await mockSam(page, { turns: [turn('running', { state: 'running', response: null })] });
  await page.goto('/sam');
  await expect(page.getByText('Working… You can leave this page and return.')).toBeVisible();
  await expect(page.getByText('SAM · working', { exact: true })).toBeVisible();
  const stopHint = page.getByText('Stopping SAM won’t cancel project work it already started.');
  await expect(stopHint).toBeVisible();
  await checkComposerTouchTargets(page);
  await checkComposerPinned(page);
  await checkLayout(page, 'sam-active-composer');
  await page.setViewportSize({ width: 320, height: 667 });
  await checkComposerTouchTargets(page);
  await checkLayout(page, 'sam-active-composer-narrow');
  await page.getByLabel('Message SAM').fill('My next draft');
  await page.getByRole('button', { name: 'Stop SAM turn' }).click();
  await expect(page.getByText('SAM · cancelled', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message SAM')).toHaveValue('My next draft');
  await expect(stopHint).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
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
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('320px layout keeps the composer and long text within bounds', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await mockSam(page, {
    turns: [turn('narrow', { message: 'longword'.repeat(100), response: 'A'.repeat(300) })],
  });
  await page.goto('/sam');
  await expect(page.getByLabel('Message SAM')).toBeVisible();
  await checkComposerTouchTargets(page);
  await checkComposerPinned(page);
  await checkLayout(page, 'sam-narrow');
});

test('long conversations open at the newest turn above a pinned composer', async ({ page }) => {
  await mockSam(page, {
    turns: Array.from({ length: 12 }, (_, index) =>
      turn(`t${index}`, {
        message: `Question ${index}: what changed in the project since yesterday?`,
        response: `Answer ${index}. ${'Here is a longer grounded update about the work. '.repeat(4)}`,
      })
    ),
  });
  await page.goto('/sam');
  await expect(page.locator('article')).toHaveCount(12);
  await checkComposerPinned(page);
  await expect(page.locator('article').first()).not.toBeInViewport();
  await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toHaveCount(0);
  await checkLayout(page, 'sam-newest-turn');
  // Reading older turns is left alone, and one tap returns to the newest.
  await page.getByTestId('sam-conversation-scroller').evaluate((scroller) => {
    scroller.scrollTop = 0;
  });
  await expect(page.locator('article').first()).toBeInViewport();
  const jump = page.getByRole('button', { name: 'Scroll to bottom' });
  await expect(jump).toBeVisible();
  await checkTouchTarget(jump);
  await checkLayout(page, 'sam-reading-older');
  await jump.click();
  await expect(page.locator('article').last()).toBeInViewport();
  await expect(jump).toHaveCount(0);
});

test('loading older messages keeps the reader on the turn they were reading', async ({ page }) => {
  await mockSam(page, {
    // Enough recent turns to overflow even the tallest audited viewport (tablet).
    turns: Array.from({ length: 12 }, (_, index) =>
      turn(`recent-${index}`, { message: `Recent question ${index}` })
    ),
    older: Array.from({ length: 10 }, (_, index) =>
      turn(`older-${index}`, { message: `Older question ${index}` })
    ),
  });
  await page.goto('/sam');
  const scroller = page.getByTestId('sam-conversation-scroller');
  await expect(page.locator('article')).toHaveCount(12);
  await expect(page.locator('article').last()).toBeInViewport();
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  const reading = page.locator('article').filter({ hasText: 'Recent question 0' });
  await expect(reading).toBeInViewport();
  await expect(page.locator('article').last()).not.toBeInViewport();
  await page.getByRole('button', { name: 'Load older messages' }).click();
  await expect(page.locator('article')).toHaveCount(22);
  // Neither jumped to the oldest turn nor yanked to the bottom.
  await expect(reading).toBeInViewport();
  await expect(
    page.locator('article').filter({ hasText: 'Older question 0' })
  ).not.toBeInViewport();
  await expect(page.locator('article').last()).not.toBeInViewport();
});

test('your messages and SAM replies are visually distinct', async ({ page }) => {
  await mockSam(page, { turns: [turn('bubble', { message: 'Is the deploy healthy?' })] });
  await page.goto('/sam');
  // Located by content, not class name, so the surface assertion is what discriminates.
  const bubble = page.locator('article').getByText('Is the deploy healthy?').locator('..');
  await expect(bubble).toBeVisible();
  // The bubble's surface is a gradient (background-image) or a solid colour.
  const surface = await bubble.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.backgroundColor, image: style.backgroundImage };
  });
  expect(
    surface.color !== 'rgba(0, 0, 0, 0)' || surface.image !== 'none',
    'User message bubble has a real surface'
  ).toBe(true);
  const bubbleBox = (await bubble.boundingBox())!;
  const reply = page.getByText('A grounded update.');
  const replyBox = (await reply.boundingBox())!;
  // Right-aligned user bubble; SAM's reply starts at the conversation's left edge.
  expect(bubbleBox.x).toBeGreaterThan(replyBox.x + 8);
});

test('starter suggestions fill the composer without sending', async ({ page }) => {
  const mock = await mockSam(page);
  await page.goto('/sam');
  const suggestion = page.getByRole('button', { name: 'What needs my attention?' });
  await checkTouchTarget(suggestion);
  await suggestion.click();
  await expect(page.getByLabel('Message SAM')).toHaveValue('What needs my attention?');
  await expect(page.getByLabel('Message SAM')).toBeFocused();
  expect(mock.submissions).toHaveLength(0);
});

test('Ctrl+Enter sends; Enter keeps a new line', async ({ page }) => {
  const mock = await mockSam(page);
  await page.goto('/sam');
  const composer = page.getByLabel('Message SAM');
  await composer.fill('First line');
  await composer.press('Enter');
  await composer.pressSequentially('Second line');
  expect(mock.submissions).toHaveLength(0);
  await composer.press('Control+Enter');
  await expect.poll(() => mock.submissions.length).toBe(1);
  expect(mock.submissions[0]!.message).toBe('First line\nSecond line');
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
  await expect(page.getByText('1 needs attention')).toBeVisible();
  await page.getByText('Project work', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open chat' })).toHaveAttribute(
    'href',
    '/projects/project-1/chat/session-1'
  );
  // The project name comes from the cached project list; no raw IDs are shown.
  await expect(page.getByText(/^Website redesign · In progress · Checked/)).toBeVisible();
  await expect(page.getByText('Untitled task')).toBeVisible();
  await page.getByLabel('Message SAM').fill('Keep this draft while work updates');
  const initialReads = mock.historyReads();
  await expect.poll(mock.historyReads).toBeGreaterThan(initialReads);
  await expect(page.getByLabel('Message SAM')).toHaveValue('Keep this draft while work updates');
  await expect(page.getByRole('link', { name: 'Open chat' })).toBeVisible();
  await checkComposerPinned(page);
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
  await expect(page.getByText('Outcome unknown')).toBeVisible();
  // The review link and the action button must never touch (measured, not eyeballed).
  const openProject = (await page.getByRole('link', { name: 'Open project' }).boundingBox())!;
  const checkOutcome = (await page.getByRole('button', { name: 'Check outcome' }).boundingBox())!;
  const sameRow = Math.abs(openProject.y - checkOutcome.y) < openProject.height;
  if (sameRow)
    expect(checkOutcome.x - (openProject.x + openProject.width)).toBeGreaterThanOrEqual(8);
  else expect(checkOutcome.y).toBeGreaterThanOrEqual(openProject.y + openProject.height);
  await checkLayout(page, 'sam-uncertain');
  await page.getByRole('button', { name: 'Check outcome' }).click();
  await expect(page.getByRole('button', { name: 'Check outcome' })).toHaveCount(0);
  expect(mock.submissions).toHaveLength(0);
});

test('completed and declined receipts read plainly with a link to the work', async ({ page }) => {
  await mockSam(page, {
    turns: [
      turn('done', {
        message: 'Start the login fix in Website redesign',
        response: 'Started. The agent is working in the project chat.',
        actions: [
          readAction('read-profiles', 'sam_profiles_list'),
          {
            id: 'started',
            operation: 'sam_chat_start',
            input_json: '{"projectId":"project-1","message":"Fix the login redirect"}',
            state: 'completed',
            result_json: JSON.stringify({ link: '/projects/project-1/chat/session-9' }),
          },
          {
            id: 'declined',
            operation: 'sam_work_stop',
            input_json: '{"projectId":"project-1","sessionId":"session-2"}',
            state: 'rejected',
            result_json: JSON.stringify({ message: 'Declined by user' }),
          },
        ],
      }),
    ],
  });
  await page.goto('/sam');
  await expect(page.getByText('Checked agent profiles')).toBeVisible();
  const started = page.getByRole('group', { name: 'Start project work' });
  await expect(started.getByText('Done')).toBeVisible();
  await expect(started.getByRole('link', { name: 'Open chat' })).toHaveAttribute(
    'href',
    '/projects/project-1/chat/session-9'
  );
  // Use the live journey assertion against the real Router-rendered relative link.
  await expectDispatchSourceLink(
    page,
    new URL('/projects/project-1/chat/session-9', page.url()).href
  );
  await expect(page.getByText('Declined', { exact: true })).toBeVisible();
  // A declined effect offers nothing to act on.
  await expect(page.getByRole('button', { name: 'Confirm stop' })).toHaveCount(0);
  await checkLayout(page, 'sam-receipts');
});

test('voice recording shows a stop control, blocks sending, then appends the transcript', async ({
  page,
}) => {
  // A synthetic microphone: the real VoiceButton records it with MediaRecorder.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
  });
  const mock = await mockSam(page, { transcript: 'and summarize the open reviews' });
  await page.goto('/sam');
  const composer = page.getByLabel('Message SAM');
  await composer.fill('Check the deploy');
  await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
  const stop = page.getByRole('button', { name: 'Stop recording', exact: true });
  await expect(stop).toBeVisible();
  await checkTouchTarget(stop);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByText('Recording… Tap stop when you’re done.')).toBeVisible();
  await checkLayout(page, 'sam-voice-recording');
  await stop.click();
  await expect(composer).toHaveValue('Check the deploy and summarize the open reviews');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
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
  await page.getByText('Project work', { exact: true }).click();
  const card = page.getByRole('listitem').filter({ hasText: 'Review the change' });
  await expect(card.getByText('2 new updates')).toBeVisible();
  await checkLayout(page, 'sam-unread-work');
  await card.getByRole('button', { name: 'Mark seen' }).click();
  await expect(page.getByText('2 new updates')).toHaveCount(0);
  expect(mock.submissions).toHaveLength(0);
  await expect(page.getByRole('link', { name: 'Open chat' })).toBeVisible();
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
