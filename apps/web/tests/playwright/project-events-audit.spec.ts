import { expect, type Page, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

const PROJECT = 'events-project';
const SESSION = 'events-session';
const BASE = `/api/projects/${PROJECT}`;
const USER = makeMockUser({
  email: 'member@example.test',
  name: 'Ordinary member',
  sessionId: 'auth-session',
  userId: 'member',
});
const NOW = Date.now();
const dueInput = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString().slice(0, 16);
const LONG = 'unbroken'.repeat(35);
const TEXT = `日本語 🚀 <script>alert("untrusted")</script> https://example.test/${LONG} ${'Review evidence and explain outcomes. '.repeat(16)}`;
const project = {
  id: PROJECT,
  name: 'Event operations',
  repository: 'example/events',
  repoProvider: 'github',
  status: 'active',
  userId: 'owner',
  defaultBranch: 'main',
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  summary: {
    activeWorkspaceCount: 0,
    activeSessionCount: 1,
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
};
const session = {
  id: SESSION,
  projectId: PROJECT,
  status: 'sleeping',
  topic: 'Review delivery outcomes',
  workspaceId: null,
  agentSessionId: 'agent-session',
  isIdle: true,
  isMine: true,
  agentCompletedAt: NOW - 60_000,
  messageCount: 1,
  startedAt: NOW - 120_000,
  endedAt: null,
  taskId: 'task-session',
  task: {
    id: 'task-session',
    status: 'in_progress',
    title: 'Review delivery outcomes',
    taskMode: 'conversation',
    executionStep: 'running',
    outputBranch: null,
  },
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
};
const subscription = (i: number, stress: boolean) => ({
  id: `subscription-${i}`,
  reason: stress && i === 0 ? LONG : i === 1 ? 'A' : `Follow checks ${i}`,
  owner: {
    type: i === 2 ? 'standing_watch' : 'agent',
    id: 'agent-session',
    name: stress ? LONG : 'Review agent',
  },
  state: 'active',
  filter: {
    version: 1,
    source: ['github'],
    eventType: 'workflow_run.completed',
    subjectId: stress ? LONG : 'commit-123',
  },
  deliveryPreference: {
    requested: 'existing_session_prompt',
    resolved: 'queued_for_prompt_delivery',
    target: { sessionId: SESSION, taskId: 'task-session' },
  },
  createdAt: NOW,
  expiresAt: NOW + 60_000,
  lastMatchedAt: null,
  cancelReason: null,
});
const schedule = (i: number, stress: boolean) => ({
  id: `schedule-${i}`,
  version: 1,
  creatorUserId: 'member',
  creatorSessionId: SESSION,
  dueAt: NOW + 3600_000,
  expiresAt: NOW + 7200_000,
  displayTimezone: 'UTC',
  createdAt: NOW,
  state: i === 1 ? 'ambiguous' : i === 2 ? 'admitted' : i === 3 ? 'failed' : 'pending',
  reason: stress ? LONG : `Check release ${i}`,
  action: {
    kind: 'message_session',
    sessionId: SESSION,
    prompt: stress ? TEXT : 'Review the release checks.',
  },
  attemptCount: i,
  lastError: i === 3 ? 'Target session is unavailable' : null,
  resultSessionId: i === 2 ? SESSION : null,
});
const watch = (i: number, stress: boolean) => ({
  id: `watch-${i}`,
  version: 1,
  creatorUserId: 'member',
  createdAt: NOW,
  state: 'active',
  reason: stress && i === 0 ? LONG : `Watch review ${i}`,
  filter: { version: 1, source: 'github', eventType: 'pull_request_review.submitted' },
  action: {
    kind: 'start_session',
    prompt: stress ? TEXT : 'Review feedback.',
    agentProfileId: null,
    skillId: null,
  },
  cooldownMs: 60_000,
  maxConcurrent: 1,
  maxExecutions: 5,
  executionCount: 2,
  nextEligibleAt: NOW - 1,
  lastError: null,
});

type Options = {
  recovery?: boolean;
  stress?: boolean;
  empty?: boolean;
  viewer?: boolean;
  many?: boolean;
  error?: boolean;
};
async function mocks(page: Page, options: Options = {}) {
  const calls: Array<{
    path: string;
    body: Record<string, unknown>;
    method: string;
    search: string;
  }> = [];
  const state = {
    error: options.error ?? false,
    mutationError: false,
    recoveryHold: null as Promise<void> | null,
    recoveryVersion: 3,
    outcomes: 'normal' as 'normal' | 'empty' | 'error',
  };
  await page.addInitScript((id) => {
    localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true');
    localStorage.setItem('sam-theme', 'dark');
  }, USER.user.id);
  await setupAuditRoutes(page, (path, respond, route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const body = method === 'POST' ? route.request().postDataJSON() : {};
    calls.push({ path, body, method, search: url.search });
    if (path === '/api/auth/get-session') return respond(200, USER);
    if (path === '/api/projects') return respond(200, { projects: [project], nextCursor: null });
    if (path === BASE) return respond(200, project);
    if (path === `${BASE}/members`)
      return respond(200, {
        members: [
          {
            userId: 'member',
            role: options.viewer ? 'viewer' : 'member',
            status: 'active',
            user: USER.user,
          },
        ],
      });
    if (path === `${BASE}/sessions`)
      return respond(200, {
        sessions:
          url.searchParams.get('offset') === '25'
            ? [{ ...session, id: 'other-session', topic: 'Another target' }]
            : [session],
        total: 26,
      });
    if (path === `${BASE}/sessions/${SESSION}`)
      return respond(200, {
        session,
        messages: [
          {
            id: 'message-1',
            sessionId: SESSION,
            role: 'assistant',
            content: 'Ready to review delivery outcomes.',
            createdAt: NOW,
          },
        ],
        hasMore: false,
        state: { activity: 'idle', activityAt: NOW },
      });
    if (path.endsWith('/state')) return respond(200, { activity: 'idle', activityAt: NOW });
    if (path.endsWith('/messages')) return respond(200, { messages: [], hasMore: false });
    if (path === `${BASE}/agent-profiles` || path === `${BASE}/skills`)
      return respond(200, {
        items: [{ id: path.endsWith('skills') ? 'skill-1' : 'profile-1', name: 'Release review' }],
      });
    const count = options.empty ? 0 : options.many ? 25 : 4;
    const second = url.searchParams.has('cursor');
    if (/\/(event-subscriptions|schedules|standing-watches|event-channels)(\/|$)/.test(path)) {
      if (method === 'POST' && path.endsWith('/reconcile')) {
        const finish = () =>
          state.mutationError
            ? respond(409, { error: 'CONFLICT', message: 'This record changed elsewhere.' })
            : respond(200, {
                schedule: { ...schedule(0, false), version: ++state.recoveryVersion },
                changed: true,
                idempotent: !body.retrySubmission,
                recovery: {
                  outcome: body.retrySubmission ? 'retry_scheduled' : 'unresolved',
                  message: body.retrySubmission
                    ? 'Task submission retry scheduled with the original identity.'
                    : 'No final receipt is available. The action may still be running.',
                },
              });
        return state.recoveryHold ? state.recoveryHold.then(finish) : finish();
      }
      if (method === 'POST')
        return state.mutationError
          ? respond(409, { error: 'CONFLICT', message: 'This record changed elsewhere.' })
          : respond(200, { actionAlreadyAdmitted: false });
      if (state.error)
        return respond(500, {
          error: 'INTERNAL_ERROR',
          message: 'Events are temporarily unavailable.',
        });
      if (path.endsWith('/deliveries')) {
        if (state.outcomes === 'error')
          return respond(500, {
            error: 'INTERNAL_ERROR',
            message: 'Delivery outcomes are temporarily unavailable.',
          });
        return respond(200, {
          deliveries:
            state.outcomes === 'empty'
              ? []
              : ['delivered', 'acked', 'ambiguous', 'failed'].map((status, i) => ({
                  id: `delivery-${i}`,
                  state: status,
                  deliveryChannel: 'prompt_queue',
                  deliveredVia: i === 0 ? 'prompt_queue' : i === 1 ? 'pull' : null,
                  requestedDelivery: 'existing_session_prompt',
                  resolvedDelivery: 'queued_for_prompt_delivery',
                  createdAt: NOW,
                  updatedAt: NOW,
                  deliveredAt: i < 2 ? NOW : null,
                  ackedAt: i === 1 ? NOW : null,
                  terminalAt: i > 1 ? NOW : null,
                  terminalReason: i === 3 ? TEXT : null,
                })),
          hasMore: state.outcomes === 'normal',
        });
      }
      if (path === `${BASE}/event-subscriptions`)
        return respond(200, {
          subscriptions: Array.from({ length: count }, (_, i) => subscription(i, !!options.stress)),
          hasMore: options.many,
          limit: 25,
        });
      if (path === `${BASE}/schedules`)
        return respond(200, {
          schedules: Array.from({ length: second ? (options.many ? 5 : 1) : count }, (_, i) =>
            options.recovery
              ? {
                  ...schedule(i, false),
                  version: state.recoveryVersion,
                  state: i === 0 || i === 1 ? 'ambiguous' : 'admitted',
                  action:
                    i === 1
                      ? schedule(i, false).action
                      : {
                          kind: 'start_session',
                          prompt: 'Review checks.',
                          agentProfileId: null,
                          skillId: null,
                        },
                  execution: {
                    kind: i === 1 ? 'message_session' : 'start_session',
                    status:
                      i === 0
                        ? 'unavailable'
                        : i === 1
                          ? 'queued'
                          : i === 2
                            ? 'completed'
                            : 'in_progress',
                    checkedAt: NOW,
                    deliveryId: null,
                    taskId: i === 1 ? null : 'stable-task',
                    sessionId: i === 2 ? SESSION : null,
                    receiptState: i === 0 ? 'pending' : 'submitted',
                    error: i === 0 ? TEXT : null,
                    retrySubmissionAllowed: i === 0,
                    submissionDeadline: i === 0 ? NOW + 7200_000 : NOW - 1,
                  },
                }
              : schedule(second ? 50 + i : i, !!options.stress)
          ),
          nextCursor: second || options.empty ? null : 'schedules-page-2',
        });
      if (path === `${BASE}/standing-watches`)
        return respond(200, {
          watches: Array.from({ length: second ? (options.many ? 5 : 1) : count }, (_, i) =>
            watch(second ? 50 + i : i, !!options.stress)
          ),
          nextCursor: second || options.empty ? null : 'watches-page-2',
        });
      if (path === `${BASE}/event-channels`)
        return respond(200, {
          channels: Array.from({ length: second ? (options.many ? 5 : 1) : count }, (_, i) => ({
            id: `channel-${i}`,
            name: options.stress && i === 0 ? LONG : `release-${second ? 50 : i}`,
            lifetimeCount: 300,
            lastPublishedAt: NOW,
          })),
          nextCursor: second || options.empty ? null : 'channels-page-2',
        });
      if (path.endsWith('/history'))
        return respond(200, {
          events: options.empty
            ? []
            : [
                {
                  sequence: second ? 26 : 1,
                  event: {
                    id: `event-${second}`,
                    receivedAt: NOW,
                    display: { title: options.stress ? LONG : 'Release update' },
                    metadata: { message: options.stress ? TEXT : 'Checks passed.' },
                  },
                },
              ],
          watermark: 40,
          retentionGap: true,
          hasMore: !second,
          cursor: 'history-page-2',
        });
    }
    if (
      ['/api/github/installations', '/api/credentials', '/api/nodes', '/api/agents'].includes(path)
    )
      return respond(200, []);
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path.endsWith('/tasks') || path === '/api/dashboard/active-tasks')
      return respond(200, { tasks: [], total: 0 });
    if (path === '/api/chats' || path === '/api/chats/recent')
      return respond(200, { sessions: [], total: 0, groups: [] });
    if (path.endsWith('/triggers')) return respond(200, { triggers: [] });
    if (path === '/api/notifications')
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    if (path === '/api/account-map')
      return respond(200, { projects: [], sessions: [], nodes: [], workspaces: [] });
    return respond(200, {});
  });
  return { calls, state };
}
async function open(page: Page, section = 'subscriptions') {
  await page.goto(`/projects/${PROJECT}/events?section=${section}`);
  await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
}
async function audit(page: Page, name: string) {
  const form = page.locator('form');
  if (await form.count()) {
    await form.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await screenshot(page, `project-events-${name}-top`);
    await form.getByRole('button', { name: 'Close', exact: true }).scrollIntoViewIfNeeded();
  }
  await screenshot(page, `project-events-${name}`);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  const root = page.getByRole('navigation', { name: 'Event sections' }).locator('..');
  const bounds = await root.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    viewport: innerWidth,
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
}
const sections = [
  ['subscriptions', 'Subscriptions'],
  ['schedules', 'Schedules'],
  ['watches', 'Standing watches'],
  ['channels', 'Channels'],
] as const;

test.describe('Project Events real-router audit', () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ timezoneId: 'UTC' });
  test('long untrusted content on every tab and channel history', async ({ page }) => {
    await mocks(page, { stress: true });
    await open(page);
    for (const [id, label] of sections) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(
        page.getByRole('region', { name: label, exact: true }).locator('article').first()
      ).toBeVisible();
      await audit(page, `${id}-long`);
    }
    await page.getByRole('button', { name: 'Read history' }).first().click();
    const history = page.getByRole('region', { name: `History for ${LONG}`, exact: true });
    await expect(history.getByText(TEXT, { exact: true })).toBeVisible();
    await expect(history).toBeInViewport();
    await expect(history.locator('script')).toHaveCount(0);
    await audit(page, 'channel-history-long');
    await page.getByRole('button', { name: 'Next messages' }).click();
    await expect(history.getByText('#26', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh history' }).click();
    await expect(history.getByText('#1 ·', { exact: false })).toBeVisible();
  });
  test('empty tabs and recoverable read errors', async ({ page }) => {
    const { state } = await mocks(page, { empty: true });
    await open(page);
    for (const [id, label] of sections) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByText('Nothing here yet.', { exact: false })).toBeVisible();
      await audit(page, `${id}-empty`);
      state.error = true;
      await page
        .getByRole('region', { name: label, exact: true })
        .getByRole('button', { name: /^Refresh/ })
        .click();
      await expect(page.getByRole('alert')).toContainText('Events are temporarily unavailable.', {
        timeout: 15000,
      });
      await audit(page, `${id}-error`);
      state.error = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByText('Nothing here yet.', { exact: false })).toBeVisible();
    }
  });
  test('ordinary member creates both schedule actions, handles conflict, reschedules and cancels', async ({
    page,
  }) => {
    const { calls, state } = await mocks(page);
    await open(page, 'schedules');
    await page.getByRole('button', { name: 'Schedule once', exact: true }).click();
    const form = page.locator('form');
    await form.getByLabel('Prompt').fill(TEXT);
    await form.getByLabel('Agent profile').selectOption('profile-1');
    await form.getByLabel('Skill', { exact: true }).selectOption('skill-1');
    await form.getByLabel('Run at').fill(dueInput(24));
    await form.getByLabel('Expires at').fill(dueInput(25));
    await audit(page, 'schedule-new-session-form');
    state.mutationError = true;
    await form.getByRole('button', { name: 'Create schedule' }).click();
    await expect(form.getByRole('alert')).toContainText('This record changed elsewhere');
    await expect(form.getByLabel('Prompt')).toHaveValue(TEXT);
    await audit(page, 'schedule-form-conflict');
    state.mutationError = false;
    await form.getByRole('button', { name: 'Create schedule' }).click();
    await expect(page.getByText('Schedule created.', { exact: true })).toBeVisible();
    const posts = calls.filter((c) => c.path === `${BASE}/schedules` && c.method === 'POST');
    expect(posts[1].body).toMatchObject({
      action: {
        kind: 'start_session',
        agentProfileId: 'profile-1',
        skillId: 'skill-1',
        prompt: TEXT,
      },
      displayTimezone: 'UTC',
    });
    expect(posts[0].body.idempotencyKey).toBe(posts[1].body.idempotencyKey);
    await page.getByRole('button', { name: 'Schedule once', exact: true }).click();
    await form.getByLabel('Action', { exact: true }).selectOption('message_session');
    await form.getByLabel('Target session').selectOption(SESSION);
    await form.getByRole('button', { name: 'More sessions' }).click();
    await expect(form.getByLabel('Target session')).toHaveValue(SESSION);
    await form.getByLabel('Target session').selectOption('other-session');
    await form.getByLabel('Prompt').fill('Follow up');
    await form.getByLabel('Run at').fill(dueInput(24));
    await form.getByLabel('Expires at').fill(dueInput(25));
    await audit(page, 'schedule-message-session-form');
    await form.getByRole('button', { name: 'Create schedule' }).click();
    await expect(page.getByText('Schedule created.', { exact: true })).toBeVisible();
    expect(
      calls.filter((c) => c.path === `${BASE}/schedules` && c.method === 'POST').at(-1)?.body.action
    ).toMatchObject({ kind: 'message_session', sessionId: 'other-session', prompt: 'Follow up' });
    const card = page
      .getByRole('region', { name: 'Schedules', exact: true })
      .locator('article')
      .first();
    await card.getByRole('button', { name: 'Reschedule', exact: true }).click();
    await form.getByLabel('Run at').fill(dueInput(48));
    await form.getByLabel('Expires at').fill(dueInput(49));
    await audit(page, 'reschedule-form');
    await form.getByRole('button', { name: 'Save new time' }).click();
    await expect(page.getByText('Schedule updated.', { exact: true })).toBeVisible();
    expect(calls.find((c) => c.path.endsWith('/reschedule'))?.body.expectedVersion).toBe(1);
    await card.getByRole('button', { name: 'Cancel schedule' }).click();
    await card.getByLabel('Cancellation reason (optional)').fill('No longer needed');
    await card.getByRole('button', { name: 'Confirm cancellation' }).scrollIntoViewIfNeeded();
    await audit(page, 'schedule-cancel-confirmation');
    await card.getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(card.getByText('Schedule cancelled.')).toBeVisible();
    expect(calls.find((c) => c.path === `${BASE}/schedules/schedule-0/cancel`)?.body).toEqual({
      expectedVersion: 1,
      reason: 'No longer needed',
    });
  });
  test('watch filters, create, edit, pause, revoke and subscription cancel', async ({ page }) => {
    const { calls } = await mocks(page);
    await open(page, 'watches');
    await page.getByRole('button', { name: 'Create watch', exact: true }).click();
    const form = page.locator('form');
    await form.getByLabel('Prompt').fill('Review feedback');
    await form.getByRole('button', { name: 'Create watch', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Set at least one event filter');
    await form.getByLabel('Source', { exact: true }).fill('github, agent.channel');
    await form.getByLabel('Reason (optional)').fill(LONG);
    await audit(page, 'watch-create-form');
    await form.getByRole('button', { name: 'Create watch', exact: true }).click();
    await expect(page.getByText('Watch saved.', { exact: true })).toBeVisible();
    expect(
      calls.find((c) => c.path === `${BASE}/standing-watches` && c.method === 'POST')?.body.filter
    ).toEqual({ version: 1, source: ['github', 'agent.channel'] });
    const card = page
      .getByRole('region', { name: 'Standing watches', exact: true })
      .locator('article')
      .first();
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(form.getByLabel('Source', { exact: true })).toHaveValue('github');
    await form.getByLabel('Action', { exact: true }).selectOption('message_session');
    await form.getByLabel('Target session').selectOption(SESSION);
    await audit(page, 'watch-edit-form');
    await form.getByRole('button', { name: 'Save watch' }).click();
    await expect(form).toHaveCount(0);
    expect(calls.find((c) => c.path.endsWith('/update'))?.body).toMatchObject({
      expectedVersion: 1,
      action: { kind: 'message_session', sessionId: SESSION },
    });
    await card.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(card.getByText('Watch paused.', { exact: false })).toBeVisible();
    expect(calls.find((c) => c.path.endsWith('/pause'))?.body).toEqual({
      expectedVersion: 1,
      paused: true,
    });
    await card.getByRole('button', { name: 'Revoke', exact: true }).click();
    await card.getByRole('button', { name: 'Confirm revocation' }).scrollIntoViewIfNeeded();
    await audit(page, 'watch-revoke-confirmation');
    await card.getByRole('button', { name: 'Confirm revocation' }).click();
    await expect(card.getByText('Watch revoked.')).toBeVisible();
    await page.getByRole('button', { name: 'Subscriptions', exact: true }).click();
    const sub = page
      .getByRole('region', { name: 'Subscriptions', exact: true })
      .locator('article')
      .first();
    await sub.getByRole('button', { name: 'Cancel subscription' }).click();
    await sub.getByLabel('Cancellation reason (optional)').fill('Finished');
    await sub.getByRole('button', { name: 'Confirm cancellation' }).scrollIntoViewIfNeeded();
    await audit(page, 'subscription-cancel-confirmation');
    await sub.getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(sub.getByText('Subscription cancelled.')).toBeVisible();
    expect(
      calls.find((c) => c.path === `${BASE}/event-subscriptions/subscription-0/cancel`)?.body
    ).toEqual({ reason: 'Finished' });
  });
  test('viewers retain read access while write controls stay absent', async ({ page }) => {
    const { calls } = await mocks(page, { viewer: true });
    await open(page);
    for (const [id, label] of sections) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(
        page.getByRole('region', { name: label, exact: true }).locator('article').first()
      ).toBeVisible();
      await expect(
        page.getByRole('button', {
          name: /^(Schedule once|Create watch|Cancel subscription|Reschedule|Cancel schedule|Pause|Revoke|Edit)$/,
        })
      ).toHaveCount(0);
      await audit(page, `${id}-viewer`);
    }
    expect(calls.filter((c) => c.method === 'POST' && c.path.startsWith(BASE))).toHaveLength(0);
  });
  test('many records scroll and opaque pagination navigates', async ({ page }) => {
    const { calls } = await mocks(page, { many: true });
    await open(page);
    await expect(page.getByText('Showing a limited set', { exact: false })).toBeVisible();
    await audit(page, 'subscriptions-many');
    for (const [id, label] of sections.slice(1)) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const panel = page.getByRole('region', { name: label, exact: true });
      await expect(panel.locator('article')).toHaveCount(25);
      await panel.locator('article').last().scrollIntoViewIfNeeded();
      await audit(page, `${id}-many-scrolled`);
      await panel
        .getByRole('button', {
          name: id === 'channels' ? 'Next channels' : 'Next page',
          exact: true,
        })
        .click();
      await expect(panel.locator('article')).toHaveCount(5);
      await panel.getByRole('button', { name: 'First page' }).click();
      await expect(panel.locator('article')).toHaveCount(25);
    }
    expect(calls.some((c) => c.search.includes('cursor=schedules-page-2'))).toBe(true);
    expect(calls.some((c) => c.search.includes('cursor=watches-page-2'))).toBe(true);
    expect(calls.some((c) => c.search.includes('cursor=channels-page-2'))).toBe(true);
  });
  test('delivery outcomes load only on inspection and support viewers, refresh, errors and empty state', async ({
    page,
  }) => {
    const { calls, state } = await mocks(page, { viewer: true });
    await open(page);
    const card = page
      .getByRole('region', { name: 'Subscriptions', exact: true })
      .locator('article')
      .first();
    await expect(card.getByRole('button', { name: 'Inspect delivery' })).toBeVisible();
    await expect(card.getByRole('region', { name: 'Recent delivery outcomes' })).toHaveCount(0);
    expect(calls.filter((call) => call.path.endsWith('/deliveries'))).toHaveLength(0);
    await card.getByRole('button', { name: 'Inspect delivery' }).click();
    const outcomes = card.getByRole('region', { name: 'Recent delivery outcomes' });
    await expect(outcomes).toBeInViewport();
    await expect(outcomes.getByRole('listitem')).toHaveCount(4);
    await expect(outcomes.getByText('delivered', { exact: true })).toBeVisible();
    await expect(outcomes.getByText('acked', { exact: true })).toBeVisible();
    await expect(outcomes.getByText('Session prompt', { exact: true })).toBeVisible();
    await expect(outcomes.getByText('Event tools', { exact: true })).toBeVisible();
    await expect(
      outcomes.getByText('Delivery confirms transport receipt', { exact: false })
    ).toBeVisible();
    expect(calls.find((call) => call.path.endsWith('/deliveries'))?.search).toBe('?limit=25');
    await audit(page, 'subscription-delivery-outcomes');
    await outcomes.getByRole('listitem').last().scrollIntoViewIfNeeded();
    await expect(outcomes.getByText(`Reason: ${TEXT}`, { exact: true })).toBeVisible();
    await expect(outcomes.locator('script')).toHaveCount(0);
    await audit(page, 'subscription-delivery-outcomes-long-failure');
    state.outcomes = 'error';
    await outcomes.getByRole('button', { name: 'Refresh outcomes' }).click();
    await expect(outcomes.getByRole('alert')).toContainText(
      'Delivery outcomes are temporarily unavailable.'
    );
    await expect(outcomes.getByText('Showing recent deliveries.', { exact: false })).toHaveCount(0);
    await audit(page, 'subscription-delivery-outcomes-error');
    state.outcomes = 'empty';
    await outcomes.getByRole('button', { name: 'Try again' }).click();
    await expect(outcomes.getByText('No delivery outcomes recorded yet.')).toBeVisible();
    await audit(page, 'subscription-delivery-outcomes-empty');
    await card.getByRole('button', { name: 'Hide delivery outcomes' }).click();
    await expect(outcomes).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Inspect delivery' })).toBeVisible();
  });
  test('schedule execution separates receipts and confirms eligible versioned task retries', async ({
    page,
  }) => {
    const { calls, state } = await mocks(page, { recovery: true });
    await open(page, 'schedules');
    const cards = page.getByRole('region', { name: 'Schedules', exact: true }).locator('article');
    const execution = cards.first().getByRole('region', { name: 'Action execution' });
    await expect(execution.getByText('unavailable', { exact: true })).toBeVisible();
    await expect(
      cards
        .nth(1)
        .getByRole('region', { name: 'Action execution' })
        .getByText('queued', { exact: true })
    ).toBeVisible();
    await expect(
      cards
        .nth(2)
        .getByRole('region', { name: 'Action execution' })
        .getByText('completed', { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retry task submission', exact: true })
    ).toHaveCount(1);
    await execution.scrollIntoViewIfNeeded();
    await audit(page, 'schedule-execution');
    await execution.getByRole('button', { name: 'Retry task submission', exact: true }).click();
    const confirm = execution.getByRole('button', { name: 'Confirm task submission retry' });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    await audit(page, 'schedule-retry-confirmation');
    state.mutationError = true;
    await confirm.click();
    await expect(execution.getByRole('alert')).toContainText('This record changed elsewhere.');
    await expect(confirm).toBeVisible();
    expect(calls.filter((call) => call.path.endsWith('/reconcile')).at(-1)?.body).toEqual({
      expectedVersion: 3,
      retrySubmission: true,
    });
    await execution.getByRole('alert').scrollIntoViewIfNeeded();
    await audit(page, 'schedule-retry-conflict');
    state.mutationError = false;
    let release!: () => void;
    state.recoveryHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await execution.getByRole('button', { name: 'Reconcile receipt' }).click();
    await expect(confirm).toBeDisabled();
    release();
    await expect(execution.getByRole('status')).toContainText('No final receipt is available.');
    state.recoveryHold = null;
    expect(calls.filter((call) => call.path.endsWith('/reconcile')).at(-1)?.body).toEqual({
      expectedVersion: 3,
    });
    await execution.getByRole('button', { name: 'Retry task submission', exact: true }).click();
    await confirm.click();
    await expect(execution.getByRole('status')).toContainText(
      'Task submission retry scheduled with the original identity.'
    );
    expect(calls.filter((call) => call.path.endsWith('/reconcile')).at(-1)?.body).toEqual({
      expectedVersion: 4,
      retrySubmission: true,
    });
    await execution.getByRole('status').scrollIntoViewIfNeeded();
    await audit(page, 'schedule-retry-outcome');
    const messageExecution = cards.nth(1).getByRole('region', { name: 'Action execution' });
    await messageExecution.getByRole('button', { name: 'Reconcile receipt' }).click();
    expect(calls.filter((call) => call.path.endsWith('/reconcile')).at(-1)?.body).toEqual({
      expectedVersion: 5,
    });
    await expect(messageExecution.getByRole('button', { name: /Retry|replay/i })).toHaveCount(0);
  });
  test('viewers see schedule execution without recovery write controls', async ({ page }) => {
    const { calls } = await mocks(page, { viewer: true, recovery: true });
    await open(page, 'schedules');
    await expect(page.getByRole('region', { name: 'Action execution' })).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Reconcile receipt' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Retry task submission/ })).toHaveCount(0);
    await audit(page, 'schedule-execution-viewer');
    expect(
      calls.filter((call) => call.method === 'POST' && call.path.startsWith(BASE))
    ).toHaveLength(0);
  });
  test('session header enters contextual Events and preserves scope across tabs', async ({
    page,
  }) => {
    const { calls } = await mocks(page);
    await page.goto(`/projects/${PROJECT}/chat/${SESSION}`);
    const entry = page.getByRole('link', { name: 'Events & schedules' });
    await expect(entry).toBeVisible({ timeout: 20_000 });
    await expect(entry).toBeInViewport();
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'project-events-session-entry');
    await entry.click();
    await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`events\\?sessionId=${SESSION}`));
    await audit(page, 'session-scoped');
    await page.getByRole('button', { name: 'Schedules', exact: true }).click();
    await page.getByRole('button', { name: 'Schedule once', exact: true }).click();
    await expect(page.getByLabel('Target session')).toHaveValue(SESSION);
    expect(
      calls.some((c) => c.path === `${BASE}/schedules` && c.search.includes(`sessionId=${SESSION}`))
    ).toBe(true);
    await page.getByRole('button', { name: 'Standing watches', exact: true }).click();
    await expect(
      page.getByText('Subscriptions, schedules, and standing watches are scoped to', {
        exact: false,
      })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Create watch', exact: true }).click();
    await expect(page.getByLabel('Target session')).toHaveValue(SESSION);
    await page.getByRole('button', { name: 'Schedules', exact: true }).click();
    await page.getByRole('button', { name: 'Show whole project' }).click();
    await expect(page).not.toHaveURL(/sessionId=/);
    await expect(page.getByRole('heading', { name: 'Schedules', exact: true })).toBeVisible();
    await expect(page.locator('form')).toHaveCount(0);
    await page.getByRole('link', { name: 'Open triggers and webhook audit' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/triggers`));
    if (page.viewportSize()!.width < 768) {
      await page.getByRole('button', { name: 'Open navigation menu' }).click();
      await expect(page.getByRole('dialog', { name: 'Navigation menu' })).toBeInViewport();
      await expect(
        page
          .getByRole('dialog', { name: 'Navigation menu' })
          .getByRole('button', { name: 'Events', exact: true })
      ).toBeInViewport();
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await screenshot(page, 'project-events-navigation-drawer');
      await page
        .getByRole('dialog', { name: 'Navigation menu' })
        .getByRole('button', { name: 'Events', exact: true })
        .click();
    } else {
      await page.getByRole('link', { name: 'Events', exact: true }).click();
    }
    await expect(page.getByRole('heading', { name: 'Events', exact: true })).toBeVisible();
  });
});
