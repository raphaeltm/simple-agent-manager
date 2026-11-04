/**
 * Cold deep link to a project chat: request ordering and the loading indicator (rule 17).
 *
 * A cold `/projects/:id/chat/:sessionId` used to read serially — project detail, then the
 * session list, then the transcript — and every step drew its own spinner in a different
 * place. This spec holds each response open in turn (rule 62: the test owns the
 * ordering) and asserts, through the real route:
 *
 *  1. the session list and the URL-named transcript are requested while the project
 *     detail is still outstanding;
 *  2. the spinner keeps the same vertical position from the project-loading state to
 *     the transcript-loading state (measured coordinates, not a screenshot);
 *  3. the transcript renders while the session list is still outstanding.
 */

import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockProject, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});
const MOCK_PROJECT = makeMockProject();
const PROJECT_ID = 'proj-test-1';
const LONG_TOPIC =
  'Investigate why the cold chat deep link waits for every request in turn before showing ' +
  'the conversation, including a very long unbroken token https://example.com/' +
  'a'.repeat(120);

const NOW = Date.now();

function makeSession(i: number) {
  return {
    id: `session-${i}`,
    projectId: PROJECT_ID,
    taskId: null,
    topic: i === 1 ? LONG_TOPIC : `Chat number ${i} about something ordinary`,
    status: 'stopped',
    workspaceId: null,
    nodeId: null,
    branch: null,
    messageCount: 4,
    // Recent, so the sidebar lists them rather than folding them into "Older".
    startedAt: NOW - i * 60_000,
    lastMessageAt: NOW - i * 30_000,
    createdAt: NOW - i * 60_000,
    endedAt: NOW - i * 20_000,
    viewerAccess: 'owner',
  };
}
const SESSIONS = Array.from({ length: 32 }, (_, i) => makeSession(i + 1));
const MESSAGES = [
  {
    id: 'msg-1',
    sessionId: 'session-1',
    role: 'user',
    content: 'Why does opening this chat take so long?',
    messageIndex: 0,
    createdAt: '2026-01-15T10:01:00Z',
  },
  {
    id: 'msg-2',
    sessionId: 'session-1',
    role: 'assistant',
    content: 'The transcript waited behind the project detail and the session list.',
    messageIndex: 1,
    createdAt: '2026-01-15T10:02:00Z',
  },
];

/** A response held open until the test releases it, reporting when it was requested. */
interface Gate {
  requested: Promise<void>;
  markRequested: () => void;
  wait: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  const g = {} as Gate;
  g.wait = new Promise<void>((resolve) => {
    g.release = resolve;
  });
  g.requested = new Promise<void>((resolve) => {
    g.markRequested = resolve;
  });
  return g;
}

async function setupMocks(page: Page, gates: { project: Gate; list: Gate; transcript: Gate }) {
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const held = async (g: Gate, body: unknown) => {
      g.markRequested();
      await g.wait;
      return respond(body);
    };

    if (path.includes('/api/auth/')) return respond(MOCK_USER);
    if (path.startsWith('/api/notifications/preferences')) return respond({});
    if (path.startsWith('/api/notifications'))
      return respond({ notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond([]);
    if (path.startsWith('/api/github/installations')) return respond([]);
    if (path.startsWith('/api/report-issue/config')) return respond({ enabled: false });
    if (path === '/api/agents') return respond([]);
    if (path === '/api/projects') return respond([MOCK_PROJECT]);

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '') return held(gates.project, MOCK_PROJECT);
      if (subPath === '/sessions') return held(gates.list, { sessions: SESSIONS, total: 32 });
      if (subPath === '/sessions/session-1') {
        return held(gates.transcript, {
          session: SESSIONS[0],
          messages: MESSAGES,
          hasMore: false,
          state: null,
        });
      }
      if (subPath === '/agent-profiles') return respond({ items: [] });
      if (subPath === '/cached-commands') return respond({ commands: [] });
      if (subPath === '/tasks') return respond({ tasks: [] });
      return respond({});
    }
    return respond({});
  });
}

/** Centre of the one visible loading spinner. */
async function spinnerCentre(page: Page) {
  const spinners = page.locator('[role="status"][aria-label="Loading"]');
  await expect(spinners).toHaveCount(1);
  const box = await spinners.first().boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

for (const viewport of [
  { name: 'mobile', width: 375, height: 667, isMobile: true },
  { name: 'desktop', width: 1280, height: 800, isMobile: false },
]) {
  test.describe(`Cold chat deep link — ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
    });

    test('reads in parallel and keeps one loading indicator in place', async ({ page }) => {
      await page.addInitScript(() => {
        window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true');
      });
      const gates = { project: gate(), list: gate(), transcript: gate() };
      await setupMocks(page, gates);
      await page.goto(`/projects/${PROJECT_ID}/chat/session-1`);

      // 1. Everything the URL names is requested while the project is still held.
      await Promise.all([
        gates.project.requested,
        gates.list.requested,
        gates.transcript.requested,
      ]);
      await expect(page.getByTestId('project-loading')).toBeVisible();
      const projectSpinner = await spinnerCentre(page);
      await screenshot(page, `chat-cold-load-project-${viewport.name}`);

      // 2. Project lands; the transcript is still held. Same spinner height.
      gates.project.release();
      await expect(page.getByTestId('chat-loading')).toBeVisible();
      const transcriptSpinner = await spinnerCentre(page);
      expect(Math.abs(transcriptSpinner.y - projectSpinner.y)).toBeLessThanOrEqual(4);
      if (viewport.isMobile) {
        expect(Math.abs(transcriptSpinner.x - projectSpinner.x)).toBeLessThanOrEqual(4);
      }
      await screenshot(page, `chat-cold-load-transcript-${viewport.name}`);

      // 3. Transcript lands while the session list is still held.
      gates.transcript.release();
      await expect(page.getByText('The transcript waited behind')).toBeVisible();
      await expect(page.getByText('No chats yet. Start a new one above.')).toHaveCount(0);
      if (!viewport.isMobile) {
        await expect(page.getByText('Loading chats…')).toBeVisible();
      }
      await screenshot(page, `chat-cold-load-list-pending-${viewport.name}`);

      gates.list.release();
      if (!viewport.isMobile) {
        await expect(page.getByText('Chat number 32 about something ordinary')).toBeAttached();
      }
      await expect(page.getByText('The transcript waited behind')).toBeVisible();
      await assertNoOverflow(page);
      await screenshot(page, `chat-cold-load-loaded-${viewport.name}`);
    });
  });
}
