/**
 * Documentation screenshot for the SAM assistant guide
 * (apps/www/src/content/docs/docs/guides/sam-assistant.md, "What the cards under an answer mean"):
 * a conversation where SAM started work in a project (a Done card) and asks before stopping other
 * work (a Needs your confirmation card), with Project work above.
 *
 * Drives the REAL /sam page with mocked API data and asserts on what rendered before capturing
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). Stress, error and streaming cases
 * live in `sam-assistant-audit.spec.ts`; these fixtures are ordinary on purpose.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-sam-assistant \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, test } from '@playwright/test';

import { makeMockUser, seedTheme } from './audit-helpers';
import { docsShot } from './docs-shot';

const USER_ID = 'user-docs-sam';
const MOCK_USER = makeMockUser({
  email: 'dana@example.com',
  name: 'Dana Reyes',
  sessionId: 'session-docs-sam',
  userId: USER_ID,
});

const NOW = Date.now();
const MIN = 60_000;

function project(id: string, name: string, repository: string) {
  return {
    id,
    name,
    repository,
    repoProvider: 'github',
    defaultBranch: 'main',
    userId: USER_ID,
    installationId: 'inst-docs',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    summary: {
      activeWorkspaceCount: 1,
      activeSessionCount: 1,
      lastActivityAt: null,
      taskCountsByStatus: {},
      linkedWorkspaces: 0,
    },
  };
}

const PROJECTS = [
  project('proj-payments', 'Payments API', 'acme/payments-api'),
  project('proj-website', 'Website redesign', 'acme/website'),
];

/** Read receipts arrive stripped to `{}` by the server projection. */
function read(id: string, operation: string) {
  return { id, operation, input_json: '{}', state: 'completed', result_json: null };
}

const TURNS = [
  {
    id: 'turn-docs-start',
    request_key: 'request-docs-start',
    message: 'Start a fix for the flaky checkout test in Payments API, with Careful Builder',
    state: 'completed',
    response: 'Started. Careful Builder is working on it in a Payments API chat.',
    error: null,
    actions: [
      read('read-docs-profiles', 'sam_profiles_list'),
      {
        id: 'action-docs-start',
        operation: 'sam_chat_start',
        input_json: JSON.stringify({
          projectId: 'proj-payments',
          agentProfileId: 'profile-careful-builder',
          message: 'Find out why the checkout test fails now and then on main, and fix it.',
        }),
        state: 'completed',
        result_json: JSON.stringify({ link: '/projects/proj-payments/chat/session-checkout' }),
      },
    ],
  },
  {
    id: 'turn-docs-stop',
    request_key: 'request-docs-stop',
    message: 'Stop the React upgrade in Website redesign, it’s not happening this sprint',
    state: 'completed',
    response:
      'The **Upgrade to React 20** chat in Website redesign is still running. Stopping it ends its work, so confirm below if that’s what you want.',
    error: null,
    actions: [
      read('read-docs-chats', 'sam_chats_list'),
      {
        id: 'action-docs-stop',
        operation: 'sam_work_stop',
        input_json: JSON.stringify({ projectId: 'proj-website', sessionId: 'session-react' }),
        state: 'approval_required',
        result_json: null,
      },
    ],
  },
];

const WORK = [
  {
    actionId: 'action-docs-start',
    taskTitle: 'Fix the flaky checkout test',
    projectName: 'Payments API',
    projectId: 'proj-payments',
    taskId: 'task-docs-checkout',
    sessionId: 'session-checkout',
    status: 'in_progress',
    link: '/projects/proj-payments/chat/session-checkout',
    observedAt: NOW - 2 * MIN,
    attention: false,
    updates: { unread: 1, lastEventType: 'task.progress', lastEventAt: NOW - 2 * MIN },
  },
];

async function mockSam(page: Page) {
  await page.addInitScript(
    (id) => localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true'),
    USER_ID
  );
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path.includes('/api/auth/')) return respond(MOCK_USER);
    if (path === '/api/sam/settings') return respond({ enabled: true, available: true });
    if (path === '/api/sam/turns')
      return respond({
        conversationId: 'conversation-docs',
        legacyHistoryAvailable: false,
        turns: TURNS,
        nextCursor: null,
        work: WORK,
      });
    if (path.endsWith('/stream')) return route.fulfill({ status: 204 });
    if (path === '/api/projects') return respond({ projects: PROJECTS });
    if (path === '/api/notifications') return respond({ notifications: [], unreadCount: 0 });
    // A finished setup, so the navigation shows no "Complete Setup" prompt.
    if (path === '/api/credentials')
      return respond([{ id: 'cred-docs-hetzner', provider: 'hetzner', createdAt: '2026-09-01' }]);
    if (path === '/api/credentials/agent')
      return respond({ credentials: [{ agentType: 'claude-code', isActive: true }] });
    if (path === '/api/github/installations')
      return respond([{ id: 'inst-docs', accountName: 'acme', accountType: 'Organization' }]);
    if (path === '/api/agents') return respond({ agents: [] });
    return respond({});
  });
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

test('docs: SAM starts work and asks before stopping other work', async ({ page }) => {
  await seedTheme(page, 'dark');
  // Tall enough for both turns on a desktop; the phone is fitted to the newest turn below.
  if (isMobile(page)) await page.setViewportSize({ width: 375, height: 940 });
  else await page.setViewportSize({ width: 1280, height: 1200 });
  await mockSam(page);
  await page.goto('/sam');

  const started = page.getByRole('group', { name: 'Start project work' });
  await expect(started.getByText('Done')).toBeVisible();
  await expect(started.getByRole('link', { name: 'Open chat' })).toHaveAttribute(
    'href',
    '/projects/proj-payments/chat/session-checkout'
  );
  const stop = page.getByRole('group', { name: 'Stop work' });
  await expect(stop.getByText('Needs your confirmation')).toBeVisible();
  await expect(stop.getByText('In Website redesign')).toBeVisible();
  await expect(stop.getByRole('button', { name: 'Confirm stop' })).toBeVisible();
  await expect(stop.getByRole('button', { name: 'Keep running' })).toBeVisible();
  await expect(page.getByText('Checked agent profiles')).toBeVisible();
  await expect(page.getByText('Project work', { exact: true })).toBeVisible();
  await expect(page.getByText('1 new update').first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Complete Setup' })).toHaveCount(0);

  if (isMobile(page)) {
    // Fit the phone screen to the newest turn, which the conversation keeps at the bottom, so the
    // image starts 12px above that turn rather than partway through the one before it. 16px is
    // the conversation's bottom padding.
    const turn = page.getByRole('region', { name: 'Conversation' }).locator('article').last();
    const turnHeight = await turn.evaluate((element) => element.getBoundingClientRect().height);
    const scrollerHeight = await page
      .getByTestId('sam-conversation-scroller')
      .evaluate((element) => element.clientHeight);
    const height = page.viewportSize()!.height - scrollerHeight + Math.ceil(turnHeight) + 16 + 12;
    await page.setViewportSize({ width: 375, height });
    await expect(turn).toBeInViewport({ ratio: 1 });
  }
  await page.mouse.move(2, 2);
  await docsShot(page, isMobile(page) ? 'sam-assistant-mobile' : 'sam-assistant');
});
