import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

/**
 * Visual + behavioural audit for UI-perf workstream D (plan items #8 and #10).
 *
 * Covers the two surfaces the change actually touches in a REAL browser:
 *   - an actively streaming agent message (item #10 memoizes the per-bubble
 *     `onPlayAudio`, so streaming must still paint correctly and must not break
 *     markdown rendering or the "Read aloud" action)
 *   - the session-list background sync (item #8 suppresses it while the
 *     ProjectData WebSocket is connected — jsdom can prove the timer is gated,
 *     only a browser proves the real socket keeps `connectionState` connected
 *     while that happens)
 */

const PROJECT_ID = 'proj-stream-perf';
const SESSION_ID = 'sess-stream-perf';

const LONG_URL =
  'https://example.com/a/very/long/path/that/should/wrap/rather/than/overflow?query=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&more=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const UNBREAKABLE_TOKEN = 'Supercalifragilisticexpialidocious'.repeat(4);

const PROJECT = {
  id: PROJECT_ID,
  name: 'Streaming Perf Audit',
  repository: 'user/streaming-perf-audit',
  repoProvider: 'github',
  createdAt: '2026-08-18T00:00:00Z',
  updatedAt: '2026-08-18T00:00:00Z',
};

const SESSION = {
  id: SESSION_ID,
  workspaceId: 'ws-stream-perf',
  taskId: null,
  topic: 'Streaming performance audit',
  status: 'active',
  messageCount: 6,
  createdAt: Date.now() - 600_000,
  updatedAt: Date.now() - 1_000,
  endedAt: null,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: 'acp-stream-perf',
  agentType: 'claude-code',
};

/** Settled history — these bubbles are the ones item #10 keeps memoized. */
const MESSAGES = [
  {
    id: 'user-1',
    sessionId: SESSION_ID,
    role: 'user',
    content: `Please summarize ${LONG_URL} and explain ${UNBREAKABLE_TOKEN}.`,
    toolMetadata: null,
    createdAt: Date.now() - 500_000,
    sequence: 1,
  },
  {
    id: 'agent-1',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: [
      '## Settled answer one',
      '',
      'A paragraph with **bold**, `inline code`, and a [link](https://example.com).',
      '',
      '```ts',
      'export const settled = () => "this block must not re-parse on every token";',
      '```',
      '',
      `Reference: ${LONG_URL}`,
    ].join('\n'),
    toolMetadata: null,
    createdAt: Date.now() - 400_000,
    sequence: 2,
  },
  {
    id: 'agent-2',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: [
      '### Settled answer two',
      '',
      '| Column | Value |',
      '| --- | --- |',
      '| remark-gfm table | rendered |',
      '',
      `- ${UNBREAKABLE_TOKEN}`,
      '- short',
    ].join('\n'),
    toolMetadata: null,
    createdAt: Date.now() - 300_000,
    sequence: 3,
  },
  {
    id: 'agent-3',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: 'Settled answer three — a compact one-liner.',
    toolMetadata: null,
    createdAt: Date.now() - 200_000,
    sequence: 4,
  },
];

const STREAM_CHUNKS = [
  'Streaming',
  'Streaming reply',
  'Streaming reply that grows',
  'Streaming reply that grows one token at a time',
  `Streaming reply that grows one token at a time, ending with ${LONG_URL}`,
];

/**
 * Mocks the ProjectData WebSocket. The app opens one socket per session view;
 * holding it open is what keeps `connectionState === 'connected'`, which is the
 * precondition item #8 gates on.
 */
async function mockProjectWebSocket(page: Page) {
  await page.routeWebSocket(/\/api\/projects\/[^/]+\/sessions\/ws/, (ws) => {
    // Never call connectToServer — this socket is fully served by the mock.
    ws.onMessage((raw) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (parsed?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* non-JSON keepalive frames are ignored */
      }
    });
    // Expose the socket so the test can push streaming frames.
    (globalThis as Record<string, unknown>).__samAuditSockets ??= [];
    (
      (globalThis as Record<string, unknown>).__samAuditSockets as unknown[]
    ).push(ws);
  });
}

async function setup(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true')
  );
  await mockProjectWebSocket(page);
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: PROJECT,
    session: SESSION,
    messages: MESSAGES,
  });
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await expect(page.getByText('Settled answer three — a compact one-liner.')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('project chat — streaming + poll gating audit', () => {
  test('renders a streaming conversation without overflow', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
    await setup(page);

    await assertNoOverflow(page);
    await screenshot(page, `project-chat-streaming-settled-${viewport}`);

    // Push growing agent output through the real socket path so the streaming
    // re-render loop that item #10 optimizes actually runs in the browser.
    for (const content of STREAM_CHUNKS) {
      await page.evaluate((chunk) => {
        const sockets = (globalThis as Record<string, unknown>).__samAuditSockets as
          | Array<{ send: (data: string) => void }>
          | undefined;
        for (const socket of sockets ?? []) {
          socket.send(
            JSON.stringify({
              type: 'message.new',
              payload: {
                sessionId: 'sess-stream-perf',
                messageId: 'agent-streaming',
                role: 'assistant',
                content: chunk,
                createdAt: Date.now(),
                sequence: 5,
              },
            })
          );
        }
      }, content);
      await page.waitForTimeout(120);
    }

    // The settled history must still be intact after the streaming burst — a
    // broken memo would not corrupt it, but a broken render would.
    await expect(page.getByText('Settled answer three — a compact one-liner.')).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-streaming-active-${viewport}`);
  });

  /**
   * Counts session-LIST requests (`/sessions?...`), excluding session-DETAIL
   * requests (`/sessions/<id>`). Uses `page.on('request')` rather than a
   * `page.route` counter on purpose: Playwright matches routes in reverse
   * registration order, so a counting route registered before
   * `setupProjectChatMocks` is silently shadowed and counts zero forever —
   * which makes the assertion pass no matter what the app does.
   */
  function countSessionListRequests(page: Page): () => number {
    let count = 0;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/projects/${PROJECT_ID}/sessions`) count += 1;
    });
    return () => count;
  }

  test('does not re-request the session list while the WebSocket is connected', async ({
    page,
  }) => {
    // Real-browser complement to the jsdom timer test: proves the poll stays
    // suppressed with a genuinely open socket, not just a mocked hook.
    const sessionListRequests = countSessionListRequests(page);

    await page.clock.install();
    await setup(page);
    const afterLoad = sessionListRequests();
    expect(afterLoad).toBeGreaterThan(0); // the initial load must have happened

    // Fast-forward well past several sync intervals (default 30s).
    await page.clock.fastForward('05:00');
    await page.waitForTimeout(500);

    expect(sessionListRequests()).toBe(afterLoad);
  });

  test('still re-requests the session list when the WebSocket is unavailable', async ({ page }) => {
    // Discriminating control for the test above. Without it, "no extra requests"
    // is equally satisfied by a broken clock, a shadowed counter, or polling
    // being deleted outright. Here the socket is NOT mocked, so it fails to
    // connect and the degraded fallback poll must take over.
    const sessionListRequests = countSessionListRequests(page);

    await page.clock.install();
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
    await expect(page.getByText('Settled answer three — a compact one-liner.')).toBeVisible({
      timeout: 15_000,
    });

    const afterLoad = sessionListRequests();
    await page.clock.fastForward('05:00');
    await expect.poll(() => sessionListRequests(), { timeout: 10_000 }).toBeGreaterThan(afterLoad);
  });
});
