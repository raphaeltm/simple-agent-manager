/**
 * PROTOTYPE ONLY — an in-browser mock API so the REAL project chat page (app shell, session
 * header, tool rail, composer) renders on a phone with no backend. It patches `fetch` and
 * `WebSocket` before the app boots. The route table mirrors `setupGlassChatMocks` in
 * `tests/playwright/sam-glass-fixtures.ts`.
 *
 * Sending a message echoes it back over the fake chat socket and streams a canned reply, so
 * the composer can be tried for real. Remove before merge to main.
 */
import {
  PROTO_CANNED_REPLIES,
  PROTO_MESSAGES,
  PROTO_PROJECT,
  PROTO_PROJECT_ID,
  PROTO_SESSION_ID,
  PROTO_SESSIONS,
  PROTO_TASKS,
  PROTO_USER,
} from './mock-data';

type Json = Record<string, unknown> | unknown[];

const messages: Array<Record<string, unknown>> = [...PROTO_MESSAGES];
let replyIndex = 0;

function idleState(activity: 'idle' | 'prompting' = 'idle') {
  return {
    activity,
    activityAt: Date.now(),
    statusError: null,
    currentPlan: null,
    planUpdatedAt: null,
    promptStartedAt: activity === 'prompting' ? Date.now() : null,
    agentType: 'claude-code',
    lastStopReason: null,
    runtimeWorkState: null,
    runtimeWorkCount: null,
    runtimeWorkSource: null,
    runtimeWorkUpdatedAt: null,
    runtimeWorkProgressAt: null,
    recoveryStatus: null,
  };
}

const openSession = PROTO_SESSIONS[0];

function route(path: string, url: URL, method: string, body: unknown): Json {
  if (path.includes('/api/auth/')) return PROTO_USER;
  if (path === '/api/notifications/unread-count') return { count: 0 };
  if (path.startsWith('/api/notifications')) {
    return { notifications: [], unreadCount: 0, nextCursor: null };
  }
  if (path === '/api/credentials/agent') {
    return { credentials: [{ agentType: 'claude-code', isActive: true }] };
  }
  if (path.startsWith('/api/credentials')) {
    return [{ id: 'cred-proto-hetzner', provider: 'hetzner', name: 'Hetzner' }];
  }
  if (path === '/api/github/installations') {
    return [{ id: 'inst-1', accountName: 'raphaeltm', accountType: 'User' }];
  }
  if (path === '/api/agents') return { agents: [] };
  if (path === '/api/nodes') return [];
  if (path === '/api/trial/status') return { available: false };
  if (path === '/api/workspaces') return [];
  if (path === '/api/projects') return { projects: [PROTO_PROJECT], nextCursor: null };
  if (path.startsWith('/api/chats')) {
    return {
      sessions: PROTO_SESSIONS.map((s) => ({ ...s, projectName: PROTO_PROJECT.name })),
      hasMore: false,
    };
  }

  const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
  if (!match) return {};
  const sub = match[2] ?? '';
  const sessionBase = `/sessions/${PROTO_SESSION_ID}`;

  if (sub === '') return PROTO_PROJECT;
  if (sub === '/members') return { members: [], inviteLinks: [], accessRequests: [] };
  if (sub === '/comment-threads') return { threads: [], total: 0 };
  if (sub === '/sessions') {
    return { sessions: PROTO_SESSIONS, total: PROTO_SESSIONS.length, hasMore: false };
  }
  if (/^\/sessions\/[^/]+\/state$/.test(sub)) return idleState();
  if (sub === `${sessionBase}/prompt` && method === 'POST') {
    const content = (body as { content?: string } | null)?.content ?? '';
    simulateTurn(content);
    return { status: 'delivered', sessionId: PROTO_SESSION_ID };
  }
  if (sub === sessionBase) {
    return { session: openSession, messages, hasMore: false, state: idleState() };
  }
  if (sub === `${sessionBase}/messages`) return { messages, hasMore: false };
  const otherSession = sub.match(/^\/sessions\/([^/]+)$/);
  if (otherSession) {
    const session = PROTO_SESSIONS.find((s) => s.id === otherSession[1]) ?? openSession;
    return { session, messages: [], hasMore: false, state: idleState() };
  }
  if (sub === '/tasks') return { tasks: PROTO_TASKS, nextCursor: null };
  if (sub.startsWith('/tasks/')) return PROTO_TASKS[0] ?? {};
  if (sub.endsWith('/files/list')) return { path: '.', entries: [] };
  if (sub.endsWith('/git/status')) return { staged: [], unstaged: [], untracked: [] };
  if (sub === '/agent-profiles' || sub === '/skills') return { items: [] };
  if (sub === '/agent-profiles/picker') {
    return { usage: [], hiddenProfileIds: [], usageWindowDays: 30 };
  }
  if (sub === '/triggers') return { triggers: [] };
  if (/\/commands|\/cached-commands/.test(sub)) return { commands: [] };
  void url;
  return { items: [], subscriptions: [], nextCursor: null, total: 0, hasMore: false };
}

// ── Fake chat socket ─────────────────────────────────────────────────────────

const openSockets = new Set<FakeSocket>();

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  url: string;
  protocol = '';
  extensions = '';
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    setTimeout(() => {
      this.readyState = 1;
      openSockets.add(this);
      this.fire('open', new Event('open'));
    }, 30);
  }

  private fire(type: string, ev: Event) {
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof handler === 'function') (handler as (e: Event) => void).call(this, ev);
    this.dispatchEvent(ev);
  }

  emit(data: unknown) {
    if (this.readyState !== 1) return;
    this.fire('message', new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  send(raw: string) {
    try {
      if (JSON.parse(raw)?.type === 'ping') setTimeout(() => this.emit({ type: 'pong' }), 10);
    } catch {
      /* ignore non-JSON frames */
    }
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    openSockets.delete(this);
    this.fire('close', new CloseEvent('close', { code, wasClean: true }));
  }
}

function broadcast(data: unknown) {
  for (const socket of openSockets) {
    if (socket.url.includes(PROTO_SESSION_ID)) socket.emit(data);
  }
}

function pushMessage(role: string, content: string) {
  const message = {
    id: `proto-live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sessionId: PROTO_SESSION_ID,
    role,
    content,
    toolMetadata: null,
    createdAt: Date.now(),
    sequence: messages.length + 1,
  };
  messages.push(message);
  broadcast({ type: 'message.new', payload: { ...message, messageId: message.id } });
}

function simulateTurn(content: string) {
  if (!content.trim()) return;
  setTimeout(() => pushMessage('user', content), 150);
  const reply = PROTO_CANNED_REPLIES[replyIndex % PROTO_CANNED_REPLIES.length] ?? 'Done.';
  replyIndex += 1;
  const activity = (value: 'prompting' | 'idle') =>
    broadcast({
      type: 'session.activity',
      payload: { sessionId: PROTO_SESSION_ID, activity: value, promptStartedAt: Date.now() },
    });
  setTimeout(() => activity('prompting'), 200);
  setTimeout(() => pushMessage('assistant', reply), 1400);
  setTimeout(() => activity('idle'), 1600);
}

// ── Install ──────────────────────────────────────────────────────────────────

export function installChatSurfaceMocks() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.href
    );
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    const json = route(url.pathname, url, method, body);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${PROTO_USER.user.id}`, 'true');
}

export const CHAT_SURFACE_PROTOTYPE_URL = `/projects/${PROTO_PROJECT_ID}/chat/${PROTO_SESSION_ID}`;
