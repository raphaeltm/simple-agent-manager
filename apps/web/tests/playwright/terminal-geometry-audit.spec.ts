/**
 * Terminal geometry audit (xterm 6 + @xterm/addon-fit 0.11).
 *
 * Renders the real workspace page with the real MultiTerminal and a WebSocket routed to a
 * fake VM agent that keeps a PTY size from the client's create/resize/reattach messages,
 * the same way the agent does. Typing `size` makes the agent print its PTY size and a line
 * of `#` exactly as wide as the PTY. If the PTY size and the rendered grid disagree, that
 * line wraps (PTY too wide), stops short of the pane (PTY too narrow), or the pane shows a
 * different number of rows than the PTY has. Screenshots alone cannot show this.
 */
import { expect, type Page, test, type WebSocketRoute } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const WS_ID = 'ws-geometry-1';
const USER_ID = 'user-geometry-1';
/** xterm 6's overlay scrollbar width, which addon-fit 0.11 reserves on the right. */
const SCROLLBAR_RESERVE_PX = 14;

const MOCK_USER = makeMockUser({
  email: 'geometry@example.com',
  name: 'Geometry User',
  sessionId: 'session-geometry-1',
  userId: USER_ID,
});

const MOCK_WORKSPACE = {
  id: WS_ID,
  name: 'workspace-geometry',
  displayName: 'Geometry Workspace',
  status: 'running',
  nodeId: 'node-geometry-1',
  projectId: null,
  userId: USER_ID,
  vmSize: 'medium',
  vmLocation: 'nbg1',
  workspaceProfile: 'full',
  url: 'http://localhost:4173',
  portsPublic: false,
  chatSessionId: null,
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T10:05:00.000Z',
};

const MOCK_NODE = {
  id: 'node-geometry-1',
  name: 'geometry-node-1',
  status: 'running',
  healthStatus: 'healthy',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  cloudProvider: 'hetzner',
  lastHeartbeatAt: '2026-11-22T10:05:00.000Z',
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T10:05:00.000Z',
};

const MOCK_SYSTEM_INFO = {
  cpu: { loadAvg1: 0.3, loadAvg5: 0.4, loadAvg15: 0.5, numCpu: 4 },
  memory: { usedBytes: 2e9, totalBytes: 8e9, availableBytes: 6e9, usedPercent: 25 },
  disk: { usedBytes: 4e10, totalBytes: 1.2e11, availableBytes: 8e10, usedPercent: 33, mountPath: '/' },
  network: { interface: 'eth0', rxBytes: 1024, txBytes: 2048 },
  uptime: { seconds: 3600, humanFormat: '1h' },
  docker: { version: '27.0.0', containers: 1, containerList: [], error: null },
  software: { goVersion: 'go1.26', nodeVersion: '24', dockerVersion: '27', devcontainerCliVersion: '0.75' },
  agent: { version: '0.1.0', buildDate: '2026-11-22', goRuntime: 'go1.26', goroutines: 12, heapBytes: 2.4e7 },
};

interface PtySession {
  serverId: string;
  rows: number;
  cols: number;
  line: string;
  history: string;
}

/** Fake VM agent: one PTY per session, sized only by what the client sends. */
class FakeAgent {
  sessions = new Map<string, PtySession>();
  inputs: string[] = [];
  resizes: Array<{ sessionId: string; rows: number; cols: number }> = [];
  reattaches: Array<{ sessionId: string; rows: number; cols: number }> = [];
  socket: WebSocketRoute | null = null;

  attach(ws: WebSocketRoute) {
    this.socket = ws;
    ws.onMessage((raw) => this.handle(ws, String(raw)));
  }

  private send(ws: WebSocketRoute, msg: unknown) {
    ws.send(JSON.stringify(msg));
  }

  private output(ws: WebSocketRoute, s: PtySession, data: string) {
    s.history += data;
    this.send(ws, { type: 'output', sessionId: s.serverId, data: { data } });
  }

  private handle(ws: WebSocketRoute, raw: string) {
    const msg = JSON.parse(raw) as { type: string; sessionId?: string; data?: Record<string, unknown> };
    switch (msg.type) {
      case 'list_sessions':
        this.send(ws, {
          type: 'session_list',
          data: {
            sessions: [...this.sessions.values()].map((s) => ({
              sessionId: s.serverId,
              status: 'running',
              createdAt: '2026-11-22T10:00:00.000Z',
            })),
          },
        });
        return;
      case 'create_session': {
        const d = msg.data as { sessionId: string; rows: number; cols: number };
        // The VM agent keys the PTY by the client's session ID (websocket.go create_session).
        const s: PtySession = { serverId: d.sessionId, rows: d.rows, cols: d.cols, line: '', history: '' };
        this.sessions.set(s.serverId, s);
        this.send(ws, { type: 'session_created', data: { sessionId: s.serverId, workingDirectory: '/workspaces/app' } });
        this.output(ws, s, '$ ');
        return;
      }
      case 'reattach_session': {
        const d = msg.data as { sessionId: string; rows: number; cols: number };
        const s = this.sessions.get(d.sessionId);
        if (!s) return;
        s.rows = d.rows;
        s.cols = d.cols;
        this.reattaches.push({ ...d });
        this.send(ws, { type: 'session_reattached', data: { sessionId: s.serverId } });
        this.send(ws, { type: 'scrollback', sessionId: s.serverId, data: { data: s.history } });
        return;
      }
      case 'resize': {
        const s = msg.sessionId ? this.sessions.get(msg.sessionId) : undefined;
        const d = msg.data as { rows: number; cols: number };
        if (!s) return;
        s.rows = d.rows;
        s.cols = d.cols;
        this.resizes.push({ sessionId: s.serverId, ...d });
        return;
      }
      case 'input': {
        const s = msg.sessionId ? this.sessions.get(msg.sessionId) : undefined;
        const data = (msg.data as { data: string }).data;
        this.inputs.push(data);
        // Escape sequences (arrows, Alt+Arrow) are cursor motion, not command text.
        if (!s || data.startsWith('\x1b')) return;
        for (const ch of data) {
          if (ch === '\r') {
            this.output(ws, s, '\r\n');
            this.run(ws, s, s.line.trim());
            s.line = '';
          } else if (ch >= ' ' && ch !== '\x7f') {
            s.line += ch;
            this.output(ws, s, ch);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private run(ws: WebSocketRoute, s: PtySession, command: string) {
    if (command === 'size') {
      // Like `stty size; printf '%*s\n' "$(tput cols)" | tr ' ' '#'`
      this.output(ws, s, `${s.rows} ${s.cols}\r\n${'#'.repeat(s.cols)}\r\n$ `);
    } else if (command === 'seq') {
      const lines = Array.from({ length: 150 }, (_, i) => `line-${i + 1}`).join('\r\n');
      this.output(ws, s, `${lines}\r\n$ `);
    } else {
      this.output(ws, s, '$ ');
    }
  }

  /** Most recently created PTY. */
  latest(): PtySession {
    const all = [...this.sessions.values()];
    return all[all.length - 1]!;
  }

  /** PTY created first (terminal tab 1). */
  first(): PtySession {
    return [...this.sessions.values()][0]!;
  }
}

async function setupMocks(page: Page, agent: FakeAgent) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER_ID);

  await page.routeWebSocket(/\/terminal\/ws/, (ws) => agent.attach(ws));
  // Any other socket (notifications etc.) is accepted and left silent.
  await page.routeWebSocket((url) => !url.pathname.includes('/terminal/ws'), () => undefined);

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return json(MOCK_USER);
    if (path.startsWith('/api/notifications')) return json({ notifications: [], unreadCount: 0 });
    if (path === '/api/terminal/token') {
      return json({
        token: 'geometry-token',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        workspaceUrl: MOCK_WORKSPACE.url,
      });
    }
    if (path === `/api/workspaces/${WS_ID}`) return json(MOCK_WORKSPACE);
    if (path === `/api/workspaces/${WS_ID}/agent-sessions`) return json([]);
    if (path === '/api/workspaces') return json([MOCK_WORKSPACE]);
    if (path === `/api/nodes/${MOCK_NODE.id}`) return json(MOCK_NODE);
    if (path === `/api/nodes/${MOCK_NODE.id}/system-info`) return json(MOCK_SYSTEM_INFO);
    if (path.startsWith(`/api/nodes/${MOCK_NODE.id}/`)) return json({ events: [], entries: [], nextCursor: null });
    if (path === '/api/projects') return json({ projects: [], nextCursor: null });
    if (path === '/api/agents') return json({ agents: [] });
    if (path === '/api/credentials') return json([]);
    if (path === '/api/credentials/agent') return json({ credentials: [] });
    if (path === '/api/github/installations') return json([]);
    return json({});
  });

  await page.route(`**/workspaces/${WS_ID}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) return route.fallback();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.endsWith('/agent-sessions')) return json({ sessions: [] });
    if (path.endsWith('/events')) return json({ events: [], nextCursor: null });
    if (path.endsWith('/ports')) return json({ ports: [] });
    if (path.endsWith('/worktrees')) return json({ worktrees: [] });
    return json({});
  });
}

interface Geometry {
  hostWidth: number;
  hostHeight: number;
  hostRight: number;
  screenWidth: number;
  screenHeight: number;
  domRows: number;
  cellWidth: number;
  cellHeight: number;
  /** The last full-width `#` line, as rendered. */
  hashLength: number;
  hashRight: number;
  /** Row after the `#` line: a wrapped PTY line would continue with `#` here. */
  rowAfterHash: string;
}

/** Measure the visible terminal: the host element, the xterm grid and the last `#` line. */
async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const term = [...document.querySelectorAll<HTMLElement>('.xterm')].find((el) => el.offsetParent !== null);
    if (!term) throw new Error('no visible .xterm');
    const host = term.parentElement!.getBoundingClientRect();
    const screen = term.querySelector('.xterm-screen')!.getBoundingClientRect();
    const rows = [...term.querySelectorAll<HTMLElement>('.xterm-rows > div')];
    const index = rows.map((r) => r.textContent ?? '').findLastIndex((t) => /^#+\s*$/.test(t));
    if (index < 0) throw new Error('no # line rendered');
    const hashRow = rows[index]!;
    const range = document.createRange();
    range.selectNodeContents(hashRow);
    const textRect = range.getBoundingClientRect();
    const hashLength = (hashRow.textContent ?? '').trimEnd().length;
    return {
      hostWidth: host.width,
      hostHeight: host.height,
      hostRight: host.right,
      screenWidth: screen.width,
      screenHeight: screen.height,
      domRows: rows.length,
      cellWidth: textRect.width / hashLength,
      cellHeight: screen.height / rows.length,
      hashLength,
      hashRight: textRect.right,
      rowAfterHash: rows[index + 1]?.textContent ?? '',
    };
  });
}

/** Text of each rendered row of the visible terminal. */
async function rowTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const term = [...document.querySelectorAll<HTMLElement>('.xterm')].find((el) => el.offsetParent !== null);
    return [...(term?.querySelectorAll<HTMLElement>('.xterm-rows > div') ?? [])].map((r) => (r.textContent ?? '').trimEnd());
  });
}

async function typeInTerminal(page: Page, text: string) {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/**
 * Ask the fake PTY for its size and assert it equals what is on screen: the full-width line
 * fits one row, reaches the right edge of the usable area, and the PTY row count equals the
 * rendered rows.
 */
async function expectPtyMatchesScreen(page: Page, agent: FakeAgent, label: string) {
  // Let debounced ResizeObserver/rAF fits land first (MultiTerminal debounces by 100ms).
  let seen = -1;
  await expect
    .poll(async () => {
      const settled = agent.resizes.length === seen;
      seen = agent.resizes.length;
      return settled;
    }, { intervals: [300] })
    .toBe(true);
  const resizesBefore = agent.resizes.length;
  await typeInTerminal(page, 'size');
  const pty = agent.latest();
  await expect
    .poll(async () => (await measure(page).catch(() => null))?.hashLength, { message: `${label}: # line` })
    .toBe(pty.cols);
  const g = await measure(page);

  // No wrap: the PTY-wide line is one rendered row.
  expect(g.rowAfterHash.startsWith('#'), `${label}: # line wrapped`).toBe(false);
  // Rightmost column visible: the line ends inside the pane, left of the scrollbar.
  expect(g.hashRight, `${label}: last column clipped`).toBeLessThanOrEqual(g.hostRight - SCROLLBAR_RESERVE_PX + 0.5);
  expect(g.screenWidth, `${label}: grid wider than pane`).toBeLessThanOrEqual(g.hostWidth + 0.5);
  // Fills the pane: less than one spare column beyond the scrollbar reserve.
  const spare = g.hostWidth - SCROLLBAR_RESERVE_PX - pty.cols * g.cellWidth;
  expect(spare, `${label}: unused width ${spare}px`).toBeGreaterThanOrEqual(-0.5);
  expect(spare, `${label}: unused width ${spare}px`).toBeLessThan(g.cellWidth);
  // Rows: PTY rows are exactly the rendered rows, which fill the pane height.
  expect(g.domRows, `${label}: rendered rows`).toBe(pty.rows);
  expect(g.screenHeight, `${label}: grid taller than pane`).toBeLessThanOrEqual(g.hostHeight + 0.5);
  expect(g.hostHeight - g.screenHeight, `${label}: unused height`).toBeLessThan(g.cellHeight);
  // Typing `size` must not itself have resized anything.
  expect(agent.resizes.length).toBe(resizesBefore);
  return { pty: { rows: pty.rows, cols: pty.cols }, g };
}

async function openTerminal(page: Page, agent: FakeAgent) {
  await setupMocks(page, agent);
  await page.goto(`/workspaces/${WS_ID}`);
  await expect.poll(() => agent.sessions.size, { message: 'session created' }).toBe(1);
  await expect(page.locator('.xterm-rows')).toContainText('$');
  await page.locator('.xterm').first().click();
}

test.describe('Terminal geometry (xterm 6)', () => {
  // The reconnect case waits out MultiTerminal's 3s RECONNECT_DELAY_MS.
  test.describe.configure({ timeout: 45_000 });

  test('PTY size matches the rendered grid on load, resize, rotation and panel resize', async ({ page }) => {
    const agent = new FakeAgent();
    await openTerminal(page, agent);
    const viewport = page.viewportSize()!;

    const initial = await expectPtyMatchesScreen(page, agent, 'initial');
    await assertNoOverflow(page);
    await screenshot(page, 'terminal-geometry-full-width-line', { scopeToProject: true });

    // Window resize (mobile rotation when the viewport is a phone).
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await expect.poll(() => agent.latest().cols, { message: 'resize after rotation' }).not.toBe(initial.pty.cols);
    const rotated = await expectPtyMatchesScreen(page, agent, 'rotated');
    await assertNoOverflow(page);
    await screenshot(page, 'terminal-geometry-rotated', { scopeToProject: true });

    await page.setViewportSize(viewport);
    await expect.poll(() => agent.latest().cols).toBe(initial.pty.cols);
    await expectPtyMatchesScreen(page, agent, 'rotated back');
    expect(rotated.pty.cols).not.toBe(initial.pty.cols);

    // Panel resize: the terminal pane narrows with no window resize event, so only the
    // ResizeObserver path can catch it.
    await page.evaluate(() => {
      const term = [...document.querySelectorAll<HTMLElement>('.xterm')].find((el) => el.offsetParent !== null)!;
      term.closest<HTMLElement>('.multi-terminal-container')!.style.width = '70%';
    });
    await expect.poll(() => agent.latest().cols, { message: 'resize after panel resize' }).toBeLessThan(initial.pty.cols);
    await expectPtyMatchesScreen(page, agent, 'panel resized');
  });

  test('hidden terminal tab re-fits when activated after a resize', async ({ page }) => {
    const agent = new FakeAgent();
    await openTerminal(page, agent);
    const viewport = page.viewportSize()!;
    const first = await expectPtyMatchesScreen(page, agent, 'tab 1');

    await page.getByRole('button', { name: 'Create terminal or chat session' }).click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect.poll(() => agent.sessions.size).toBe(2);
    await expect(page.getByRole('tab', { name: /Terminal tab:/ })).toHaveCount(2);
    await page.locator('.xterm').filter({ visible: true }).click();
    await expectPtyMatchesScreen(page, agent, 'tab 2');

    // Resize while tab 1 is display:none, then activate it.
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await expectPtyMatchesScreen(page, agent, 'tab 2 rotated');
    const tab1 = agent.first();
    expect(tab1.cols, 'hidden tab is still at its old size').toBe(first.pty.cols);

    await page.getByRole('tab', { name: /Terminal tab:/ }).first().click();
    await expect.poll(() => agent.first().cols, { message: 'tab 1 refit' }).not.toBe(first.pty.cols);
    await page.locator('.xterm').filter({ visible: true }).click();
    const reactivated = await expectPtyMatchesScreen(page, agent, 'tab 1 reactivated');
    expect(agent.latest().serverId).not.toBe(agent.first().serverId);
    expect(reactivated.pty.cols).toBe(agent.first().cols);
    await assertNoOverflow(page);
    await screenshot(page, 'terminal-geometry-reactivated-tab', { scopeToProject: true });
  });

  test('input, Alt+Arrow word motion, scrollback and reconnect replay', async ({ page }) => {
    const agent = new FakeAgent();
    await openTerminal(page, agent);

    // Output and scrollback: 150 lines scroll; the viewport can scroll back to line 1.
    await typeInTerminal(page, 'seq');
    await expect.poll(() => rowTexts(page)).toContain('line-150');
    expect(await rowTexts(page)).not.toContain('line-1');
    await page.locator('.xterm').first().hover();
    for (let i = 0; i < 200 && !(await rowTexts(page)).includes('line-1'); i++) {
      await page.mouse.wheel(0, -1000);
      await page.waitForTimeout(20);
    }
    expect(await rowTexts(page), 'scrolled back to the first line').toContain('line-1');
    await screenshot(page, 'terminal-geometry-scrollback', { scopeToProject: true });

    // Typing returns the viewport to the prompt.
    await page.locator('.xterm').first().click();
    agent.inputs = [];
    await page.keyboard.press('Alt+ArrowLeft');
    await page.keyboard.press('Alt+ArrowRight');
    // Chromium on Linux: xterm 5.5 sent Ctrl+Arrow sequences for Alt+Arrow.
    await expect.poll(() => agent.inputs).toEqual(['\x1b[1;5D', '\x1b[1;5C']);

    // Reconnect: the agent drops the socket; the client reattaches at its current size and
    // the scrollback replay renders.
    const before = await expectPtyMatchesScreen(page, agent, 'before reconnect');
    await agent.socket!.close();
    await expect.poll(() => agent.reattaches.length, { timeout: 15_000, message: 'reattach' }).toBe(1);
    expect(agent.reattaches[0]).toEqual({ sessionId: agent.first().serverId, ...before.pty });
    await expect(page.getByText('Reconnecting...')).toHaveCount(0);
    await expect(page.locator('.xterm-rows')).toContainText('$');
    await page.locator('.xterm').first().click();
    await expectPtyMatchesScreen(page, agent, 'after reconnect');
    await assertNoOverflow(page);
  });
});
