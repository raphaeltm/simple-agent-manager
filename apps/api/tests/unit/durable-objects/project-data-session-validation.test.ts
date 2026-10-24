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

vi.mock('@simple-agent-manager/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/shared')>()),
  ACP_SESSION_DEFAULTS: {
    DETECTION_WINDOW_MS: 30000,
    MAX_FORK_DEPTH: 5,
  },
  ACP_SESSION_TERMINAL_STATUSES: new Set(),
  ACP_SESSION_VALID_TRANSITIONS: {},
  DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES: 60,
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
type MessageSendPayload = {
  type: 'message.send';
  sessionId: string;
  role: string;
  content: string;
};

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
  const sqlExec = vi.fn((query: string, ...args: unknown[]) =>
    sqlResult(queryHandler(query, args))
  );

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
  return socket.sent.map(
    (message) =>
      JSON.parse(message) as {
        type: string;
        message?: string;
        messageId?: string;
        sessionId?: string;
      }
  );
}

async function expectMessageSendRejected(input: {
  socketTags: string[];
  payload: MessageSendPayload;
  queryHandler: QueryHandler;
  error: string;
}) {
  const { ctx, projectData } = createProjectData(input.queryHandler);
  const socket = createMockWebSocket(input.socketTags);

  await projectData.webSocketMessage(socket, JSON.stringify(input.payload));

  expect(ctx.sqlExec).not.toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO chat_messages'),
    expect.anything()
  );
  expect(parseSent(socket)).toContainEqual(
    expect.objectContaining({
      type: 'error',
      message: expect.stringContaining(input.error),
    })
  );
}

describe('ProjectData DO session validation behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a failed sleep runtime lookup outside the concurrency gate and remains reusable', async () => {
    const { ctx, projectData } = createProjectData(() => []);
    const lookupError = new Error('D1 runtime lookup unavailable');
    const first = vi.fn().mockRejectedValueOnce(lookupError).mockResolvedValueOnce(null);
    projectData.env.DATABASE = { prepare: () => ({ bind: () => ({ first }) }) };
    const gateOutcomes: unknown[] = [];
    const gateErrors: unknown[] = [];
    ctx.blockConcurrencyWhile.mockImplementation(async (callback) => {
      try {
        const outcome = await callback();
        gateOutcomes.push(outcome);
        return outcome;
      } catch (error) {
        // Cloudflare resets the object when this callback rejects.
        gateErrors.push(error);
        throw error;
      }
    });
    ctx.sqlExec.mockClear();
    const runtimeGuard = {
      projectId: 'project-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
      nodeId: 'node-1',
      evictionGeneration: null,
      claimId: 'claim-1',
    };

    await expect(projectData.sleepSession('session-1', { runtimeGuard })).rejects.toBe(lookupError);
    expect(gateErrors).toEqual([]);
    expect(gateOutcomes).toEqual([{ ok: false, error: lookupError }]);
    expect(ctx.sqlExec).not.toHaveBeenCalled();

    await expect(projectData.sleepSession('session-1', { runtimeGuard })).resolves.toBe(false);
    expect(first).toHaveBeenCalledTimes(2);
    expect(gateErrors).toEqual([]);
    expect(ctx.sqlExec).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'an active session the socket is tagged for',
      socketTags: ['session:session-a'],
      payload: {
        type: 'message.send' as const,
        sessionId: 'session-a',
        role: 'user',
        content: 'hello',
      },
    },
    {
      name: 'a different session than the socket tag',
      socketTags: ['session:session-a'],
      payload: {
        type: 'message.send' as const,
        sessionId: 'session-b',
        role: 'user',
        content: 'hello',
      },
    },
    {
      name: 'an assistant-role message',
      socketTags: ['session:session-a'],
      payload: {
        type: 'message.send' as const,
        sessionId: 'session-a',
        role: 'assistant',
        content: 'hello',
      },
    },
  ])(
    'never persists a WebSocket message.send for $name (gap G1)',
    async ({ socketTags, payload }) => {
      // Any connected project member used to be able to write a user message into any active
      // session over the browser socket, unauthenticated as to who they were. Prompts now come
      // only from authorized REST delivery, so the socket refuses every write.
      await expectMessageSendRejected({
        socketTags,
        payload,
        queryHandler: (query: string) => {
          if (query.includes('SELECT id, status FROM chat_sessions')) {
            return [{ id: 'session-a', status: 'active' }];
          }
          return [];
        },
        error: 'not supported',
      });
    }
  );

  it('still answers pings on a socket that tried to write (liveness control)', async () => {
    const { projectData } = createProjectData(() => []);
    const socket = createMockWebSocket(['session:session-a']);

    await projectData.webSocketMessage(
      socket,
      JSON.stringify({ type: 'message.send', sessionId: 'session-a', role: 'user', content: 'hi' })
    );
    await projectData.webSocketMessage(socket, JSON.stringify({ type: 'ping' }));

    const sent = parseSent(socket);
    expect(sent.map((message) => message.type)).toEqual(['error', 'pong']);
    expect(sent.some((message) => message.type === 'message.ack')).toBe(false);
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
      ])
    ).rejects.toThrow('Session session-a is stopped and cannot accept messages');
  });
});
