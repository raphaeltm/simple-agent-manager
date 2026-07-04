/**
 * EXPERIMENTAL — TanStack Virtual vs react-virtuoso scroll audit.
 *
 * Records mobile screen video of scripted scrolling through a large,
 * token-fragmented conversation (raw rows as persisted for ACTIVE sessions:
 * assistant token chunks, thinking chunks, tool rows merged by toolCallId).
 * The fixture intentionally mirrors production shape where "messages" are
 * unmaterialized tokens until session completion.
 *
 * TanStack path enabled via `?virtualizer=tanstack`.
 * See task sam/use-sam-mcp-tools-01kwpv. Not a production test surface.
 *
 * Run (video):
 *   npx playwright test chat-virtualizer-tanstack-audit --project="iPhone 14 (390x844)"
 */
import { expect, type Page, type Route, test } from '@playwright/test';

// Video must be enabled at file top level (describe-scoped use() is rejected).
test.use({ video: 'on' });

// ---------------------------------------------------------------------------
// Mock identities
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// Token-fragmented fixture generator (deterministic)
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: Record<string, unknown> | null;
  createdAt: number;
  sequence: number;
}

/** Deterministic PRNG (mulberry32) so runs are reproducible. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  'virtualizer scroll anchor measure resize layout cache token stream chunk render frame jank stable offset viewport overscan estimate dynamic height card tool call metadata fragment merge materialize session'.split(
    ' '
  );

function words(rng: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rng() * WORDS.length)]);
  return out.join(' ');
}

const TOOL_KINDS = ['read', 'edit', 'execute', 'search'] as const;
const TOOL_PATHS = [
  'apps/web/src/components/project-message-view/index.tsx',
  'apps/web/src/components/project-message-view/useSessionLifecycle.ts',
  'packages/acp-client/src/components/AcpConversationItemView.tsx',
  'apps/api/src/durable-objects/project-data/messaging.ts',
  'packages/vm-agent/internal/acp/session_host_process_and_a_very_long_suffix_for_wrapping_checks.go',
];

/**
 * Generates ~`turns` conversation turns of RAW rows the way an active session
 * persists them: user row, thinking chunks, tool rows (initial + status
 * updates, merged client-side by toolCallId), assistant token chunks.
 */
function generateRawRows(turns: number, seed = 42): RawRow[] {
  const rng = makeRng(seed);
  const rows: RawRow[] = [];
  let ts = 1767225600000; // 2026-01-01
  let seq = 0;

  const push = (turn: number, n: number, role: string, content: string, toolMetadata: Record<string, unknown> | null = null) => {
    ts += 200 + Math.floor(rng() * 1500);
    seq += 1;
    rows.push({
      id: `msg-t${turn}-${n}`,
      sessionId: 'session-1',
      role,
      content,
      toolMetadata,
      createdAt: ts,
      sequence: seq,
    });
  };

  for (let t = 0; t < turns; t++) {
    let n = 0;
    // 1 user message
    push(t, n++, 'user', `Turn ${t}: ${words(rng, 8 + Math.floor(rng() * 20))}?`);

    // 3-5 thinking chunks (merge into one thinking item)
    const thinkChunks = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < thinkChunks; i++) {
      push(t, n++, 'thinking', `${words(rng, 4 + Math.floor(rng() * 10))} `);
    }

    // 2-5 tool calls, each = initial row + 1-2 update rows (merged by toolCallId)
    const toolCalls = 2 + Math.floor(rng() * 4);
    for (let c = 0; c < toolCalls; c++) {
      const toolCallId = `tool-t${t}-c${c}`;
      const kind = TOOL_KINDS[Math.floor(rng() * TOOL_KINDS.length)];
      const path = TOOL_PATHS[Math.floor(rng() * TOOL_PATHS.length)];
      push(t, n++, 'tool', '', {
        toolCallId,
        kind,
        title: `${kind === 'execute' ? 'Run' : kind === 'search' ? 'Grep' : kind === 'edit' ? 'Edit' : 'Read'} ${path}`,
        toolName: kind === 'execute' ? 'Bash' : kind === 'search' ? 'Grep' : kind === 'edit' ? 'Edit' : 'Read',
        rawInput: { file_path: path, query: words(rng, 3) },
        status: 'in_progress',
        locations: [{ path, line: 1 + Math.floor(rng() * 400) }],
      });
      const updates = 1 + Math.floor(rng() * 2);
      for (let u = 0; u < updates; u++) {
        const last = u === updates - 1;
        push(t, n++, 'tool', '', {
          toolCallId,
          status: last ? 'completed' : 'in_progress',
          ...(last
            ? {
                rawOutput: {
                  stdout: Array.from({ length: 2 + Math.floor(rng() * 8) }, () => words(rng, 6 + Math.floor(rng() * 8))).join('\n'),
                },
              }
            : {}),
        });
      }
    }

    // 15-40 assistant token chunks (merge into one agent_message)
    const tokenChunks = 15 + Math.floor(rng() * 26);
    for (let i = 0; i < tokenChunks; i++) {
      const chunkWords = 1 + Math.floor(rng() * 5);
      push(t, n++, 'assistant', `${words(rng, chunkWords)} `);
    }
  }

  return rows;
}

// ~40 turns ≈ 1,600+ raw rows → ~250-300 rendered ConversationItems
const ALL_ROWS = generateRawRows(40);
// Split: "earlier page" (for the prepend test) vs the main window.
//
// IMPORTANT: split at a TURN boundary (a user row), not an arbitrary raw-row
// offset. The token→message converter (chatMessagesToConversationItems) merges
// consecutive assistant/thinking chunks into one item keyed by the FIRST
// chunk's id. A mid-turn split means the prepended page's trailing chunks
// merge with the main window's leading chunks after load-more, so the item
// that was previously first CHANGES ID. Key-based scroll anchoring (TanStack
// getItemKey) then cannot re-find its anchor and the viewport jumps to the
// prepended content. That seam-identity hazard is a real product issue for
// token-fragmented (active/unmaterialized) sessions paginated by createdAt —
// documented in the task findings — but here we isolate the virtualizer's own
// prepend behavior by keeping item identities stable across the seam.
const SPLIT_AT = ALL_ROWS.findIndex((r) => r.id === 'msg-t5-0');
const EARLIER_ROWS = ALL_ROWS.slice(0, SPLIT_AT);
const MAIN_ROWS = ALL_ROWS.slice(SPLIT_AT);

// ---------------------------------------------------------------------------
// API mocks (correct shapes: {session, messages, hasMore, state} / {sessions, total})
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  id: 'session-1',
  workspaceId: null,
  taskId: null,
  topic: 'TanStack Virtual scroll audit',
  status: 'stopped', // stopped + no workspace → no polling / WS / workspace fetch churn
  messageCount: ALL_ROWS.length,
  startedAt: ALL_ROWS[0].createdAt,
  endedAt: ALL_ROWS[ALL_ROWS.length - 1].createdAt,
  createdAt: ALL_ROWS[0].createdAt,
  agentCompletedAt: ALL_ROWS[ALL_ROWS.length - 1].createdAt,
  lastMessageAt: ALL_ROWS[ALL_ROWS.length - 1].createdAt,
  isIdle: false,
  isTerminated: true,
  workspaceUrl: null,
  cleanupAt: null,
  agentSessionId: null,
  agentType: 'claude-code',
  attention: null,
};

async function setupApiMocks(page: Page, opts: { hasMore?: boolean } = {}) {
  const { hasMore = false } = opts;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      if (subPath === '/sessions') return respond(200, { sessions: [MOCK_SESSION], total: 1 });

      if (subPath === '/sessions/session-1/state') {
        return respond(200, { state: null, agentSessionId: null, agentType: 'claude-code' });
      }

      if (subPath === '/sessions/session-1') {
        const before = url.searchParams.get('before');
        if (before) {
          // Earlier page for the load-more / prepend-stability test.
          const cutoff = Number(before);
          const earlier = EARLIER_ROWS.filter((r) => r.createdAt < cutoff);
          return respond(200, {
            session: MOCK_SESSION,
            messages: earlier,
            hasMore: false,
            state: null,
          });
        }
        return respond(200, {
          session: MOCK_SESSION,
          messages: hasMore ? MAIN_ROWS : ALL_ROWS,
          hasMore,
          state: null,
        });
      }

      if (subPath === '/tasks') return respond(200, []);
      if (subPath === '/agents') return respond(200, []);
      if (subPath === '/skills') return respond(200, []);
      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects') return respond(200, [MOCK_PROJECT]);
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Scroll scripting helpers
// ---------------------------------------------------------------------------

const TANSTACK_SCROLLER = '[data-virtualizer="tanstack"]';
const VIRTUOSO_SCROLLER = '[data-testid="virtuoso-scroller"]';

/** rAF-driven scroll: `frames` frames of `dyPerFrame` px each. */
async function scrollBy(page: Page, selector: string, dyPerFrame: number, frames: number) {
  await page.evaluate(
    ({ selector, dyPerFrame, frames }) =>
      new Promise<void>((resolve) => {
        const el = document.querySelector(selector);
        if (!el) return resolve();
        let i = 0;
        const step = () => {
          el.scrollBy(0, dyPerFrame);
          i += 1;
          if (i < frames) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    { selector, dyPerFrame, frames }
  );
}

async function waitForConversation(page: Page, selector: string) {
  await page.waitForSelector(selector, { timeout: 15000 });
  // Let initial bottom-pin + measurements settle.
  await page.waitForTimeout(1500);
}

async function runScrollScenario(page: Page, selector: string) {
  // Slow scroll up (reading pace) — the jank-sensitive direction:
  // items above the viewport get measured as they enter.
  await scrollBy(page, selector, -12, 300);
  await page.waitForTimeout(400);

  // Fast flick up.
  await scrollBy(page, selector, -80, 60);
  await page.waitForTimeout(600);

  // Scroll back down.
  await scrollBy(page, selector, 40, 150);
  await page.waitForTimeout(400);

  // Jump to bottom via the scroll button if visible.
  const btn = page.locator('button[aria-label="Scroll to bottom"]');
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(1200);
  }
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Chat virtualizer — TanStack Virtual (mobile)', () => {
  test('scripted scroll through token-fragmented conversation', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1?virtualizer=tanstack');
    await waitForConversation(page, TANSTACK_SCROLLER);

    // Virtualization is active: rendered rows << total items.
    const renderedCount = await page.locator(`${TANSTACK_SCROLLER} [data-index]`).count();
    expect(renderedCount).toBeGreaterThan(0);
    expect(renderedCount).toBeLessThan(100);

    await assertNoHorizontalOverflow(page);
    await runScrollScenario(page, TANSTACK_SCROLLER);
    await assertNoHorizontalOverflow(page);

    // We should be back at (or near) the bottom after scroll-to-bottom.
    const nearBottom = await page.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    }, TANSTACK_SCROLLER);
    expect(nearBottom).toBe(true);
  });

  test('prepend (load earlier) does not shift the visible window', async ({ page }) => {
    await setupApiMocks(page, { hasMore: true });
    await page.goto('/projects/proj-test-1/chat/session-1?virtualizer=tanstack');
    await waitForConversation(page, TANSTACK_SCROLLER);

    // Scroll to the top of the loaded window so the button is on screen.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      el.scrollTop = 0;
    }, TANSTACK_SCROLLER);
    await page.waitForTimeout(800);

    const loadBtn = page.getByRole('button', { name: /load earlier/i });
    await expect(loadBtn).toBeVisible();

    // Anchor: track the first fully visible virtual row by its content.
    const anchor = await page.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      const rows = Array.from(document.querySelectorAll(`${sel} [data-index]`));
      const visible = rows.find((r) => r.getBoundingClientRect().bottom > 100);
      if (!visible) return null;
      return {
        text: (visible.textContent ?? '').slice(0, 120),
        top: visible.getBoundingClientRect().top,
        index: Number(visible.getAttribute('data-index')),
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
      };
    }, TANSTACK_SCROLLER);
    expect(anchor).not.toBeNull();

    await loadBtn.click();
    await page.waitForTimeout(1500);

    // Because keys are stable and offsets anchor to the end, the same item
    // should still be rendered at (approximately) the same viewport position.
    const after = await page.evaluate(
      ({ sel, text }) => {
        const el = document.querySelector(sel)!;
        const rows = Array.from(document.querySelectorAll(`${sel} [data-index]`));
        const match = rows.find((r) => (r.textContent ?? '').slice(0, 120) === text);
        const indexes = rows
          .map((r) => Number(r.getAttribute('data-index')))
          .sort((a, b) => a - b);
        return {
          count: rows.length,
          found: !!match,
          top: match ? match.getBoundingClientRect().top : null,
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          firstIndex: indexes[0] ?? null,
          lastIndex: indexes[indexes.length - 1] ?? null,
          firstVisibleText: (rows
            .find((r) => r.getBoundingClientRect().bottom > 100)
            ?.textContent ?? '').slice(0, 120),
        };
      },
      { sel: TANSTACK_SCROLLER, text: anchor!.text }
    );

    console.log('[prepend-stability] anchor:', JSON.stringify(anchor));
    console.log('[prepend-stability] after:', JSON.stringify(after));

    // The viewport should still contain rendered rows (no blank screen).
    expect(after.count).toBeGreaterThan(0);
    // The anchored item must still be mounted (not virtualized far away).
    expect(after.found).toBe(true);
    const delta = Math.abs((after.top ?? 0) - anchor!.top);
    console.log(`[prepend-stability] anchored item shifted by ${delta.toFixed(1)}px`);
    expect(delta).toBeLessThan(60);
  });
});

test.describe('Chat virtualizer — Virtuoso baseline (mobile)', () => {
  test('scripted scroll through token-fragmented conversation', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');
    await waitForConversation(page, VIRTUOSO_SCROLLER);

    await assertNoHorizontalOverflow(page);
    await runScrollScenario(page, VIRTUOSO_SCROLLER);
    await assertNoHorizontalOverflow(page);
  });
});
