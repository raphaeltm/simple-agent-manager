import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  sql: Object.assign((s: unknown) => s, { raw: (s: unknown) => s }),
  eq: (a: unknown, b: unknown) => [a, b],
  and: (...args: unknown[]) => args,
  desc: (col: unknown) => ({ desc: true, col }),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Record<string, unknown>;

    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../../../src/durable-objects/migrations', () => ({
  runMigrations: vi.fn(),
}));

vi.mock('@simple-agent-manager/shared', () => ({
  ACP_SESSION_DEFAULTS: {
    DETECTION_WINDOW_MS: 30000,
    MAX_FORK_DEPTH: 5,
  },
  ACP_SESSION_TERMINAL_STATUSES: new Set(),
  ACP_SESSION_VALID_TRANSITIONS: {},
  DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS: 30 * 60 * 1000,
  DEFAULT_WORKSPACE_PROFILE: 'default',
  PROVIDER_LOCATIONS: {},
  WORKSPACE_IDLE_CHECK_INTERVAL_MS: 60 * 1000,
}));

const { ProjectData } = await import('../../../src/durable-objects/project-data');

type SqlResult = {
  toArray: () => Record<string, unknown>[];
  columnNames: string[];
  rowsRead: number;
  rowsWritten: number;
};

type MockWebSocket = WebSocket & {
  tags: string[];
  sent: string[];
};

type QueryHandler = (query: string, args: unknown[]) => Record<string, unknown>[];

function sqlResult(rows: Record<string, unknown>[] = []): SqlResult {
  return {
    toArray: () => rows,
    columnNames: [],
    rowsRead: rows.length,
    rowsWritten: 0,
  };
}

function createMockWebSocket(tags: string[] = []): MockWebSocket {
  const sent: string[] = [];
  return {
    tags,
    sent,
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
  } as unknown as MockWebSocket;
}

function createMockCtx(queryHandler: QueryHandler) {
  const sockets: MockWebSocket[] = [];
  const sqlExec = vi.fn((query: string, ...args: unknown[]) => sqlResult(queryHandler(query, args)));

  return {
    storage: {
      sql: { exec: sqlExec },
      transactionSync: vi.fn((fn: () => void) => fn()),
    },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
    getTags: vi.fn((ws: MockWebSocket) => ws.tags),
    getWebSockets: vi.fn((tag?: string) => {
      if (!tag) return [...sockets];
      return sockets.filter((ws) => ws.tags.includes(tag));
    }),
    acceptWebSocket: vi.fn((ws: MockWebSocket, tags?: string[]) => {
      ws.tags = tags ?? [];
      sockets.push(ws);
    }),
    sqlExec,
  };
}

function createProjectData(queryHandler: QueryHandler) {
  const ctx = createMockCtx(queryHandler);
  const projectData = new ProjectData(ctx as unknown as DurableObjectState, {
    DO_SUMMARY_SYNC_DEBOUNCE_MS: '999999',
    SESSION_IDLE_TIMEOUT_MINUTES: '15',
  });
  return { ctx, projectData };
}

function parseSent(socket: MockWebSocket) {
  return socket.sent.map((message) => JSON.parse(message) as { type: string; message?: string; messageId?: string; sessionId?: string });
}

describe('ProjectData DO session validation behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects WebSocket messages targeting a different session than the socket tag', async () => {
    const { ctx, projectData } = createProjectData(() => []);
    const socket = createMockWebSocket(['session:session-a']);

    await projectData.webSocketMessage(
      socket,
      JSON.stringify({ type: 'message.send', sessionId: 'session-b', role: 'user', content: 'hello' }),
    );

    expect(ctx.sqlExec).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO chat_messages'),
      expect.anything(),
    );
    expect(parseSent(socket)).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Session mismatch'),
      }),
    );
  });

  it('rejects WebSocket messages for missing sessions before persistence', async () => {
    const { ctx, projectData } = createProjectData((query) => {
      if (query.includes('SELECT id, status FROM chat_sessions')) return [];
      return [];
    });
    const socket = createMockWebSocket(['session:missing-session']);

    await projectData.webSocketMessage(
      socket,
      JSON.stringify({ type: 'message.send', sessionId: 'missing-session', role: 'user', content: 'hello' }),
    );

    expect(ctx.sqlExec).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO chat_messages'),
      expect.anything(),
    );
    expect(parseSent(socket)).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('not found'),
      }),
    );
  });

  it('rejects WebSocket messages for non-active sessions before persistence', async () => {
    const { ctx, projectData } = createProjectData((query) => {
      if (query.includes('SELECT id, status FROM chat_sessions')) {
        return [{ id: 'session-a', status: 'stopped' }];
      }
      return [];
    });
    const socket = createMockWebSocket(['session:session-a']);

    await projectData.webSocketMessage(
      socket,
      JSON.stringify({ type: 'message.send', sessionId: 'session-a', role: 'user', content: 'hello' }),
    );

    expect(ctx.sqlExec).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO chat_messages'),
      expect.anything(),
    );
    expect(parseSent(socket)).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('not active'),
      }),
    );
  });

  it('persists and acknowledges valid WebSocket user messages', async () => {
    const { ctx, projectData } = createProjectData((query) => {
      if (query.includes('SELECT id, status FROM chat_sessions')) return [{ id: 'session-a', status: 'active' }];
      if (query.includes('SELECT message_count FROM chat_sessions')) return [{ message_count: 0 }];
      if (query.includes('SELECT id FROM chat_messages')) return [];
      if (query.includes('COALESCE(MAX(sequence), 0)')) return [{ max_seq: 0 }];
      if (query.includes('SELECT topic FROM chat_sessions')) return [{ topic: null }];
      if (query.includes('SELECT workspace_id FROM chat_sessions')) return [{ workspace_id: null }];
      if (query.includes('SELECT session_id FROM idle_cleanup_schedule')) return [];
      return [];
    });
    const socket = createMockWebSocket(['session:session-a']);

    await projectData.webSocketMessage(
      socket,
      JSON.stringify({ type: 'message.send', sessionId: 'session-a', role: 'assistant', content: '  hello  ' }),
    );

    expect(ctx.sqlExec).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO chat_messages'),
      expect.any(String),
      'session-a',
      'user',
      'hello',
      null,
      expect.any(Number),
      1,
    );
    expect(parseSent(socket)).toContainEqual(
      expect.objectContaining({
        type: 'message.ack',
        sessionId: 'session-a',
        messageId: expect.any(String),
      }),
    );
  });

  it('rejects batch persistence to stopped sessions', async () => {
    const { projectData } = createProjectData((query) => {
      if (query.includes('SELECT id, message_count, topic, status FROM chat_sessions')) {
        return [{ id: 'session-a', message_count: 0, topic: null, status: 'stopped' }];
      }
      return [];
    });

    await expect(
      projectData.persistMessageBatch('session-a', [
        {
          messageId: 'message-1',
          role: 'assistant',
          content: 'hello',
          toolMetadata: null,
          timestamp: new Date(0).toISOString(),
        },
      ]),
    ).rejects.toThrow('Session session-a is stopped and cannot accept messages');
  });
});
