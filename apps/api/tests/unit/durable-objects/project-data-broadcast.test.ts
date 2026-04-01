/**
 * Unit tests for ProjectData DO session-scoped WebSocket broadcasting.
 *
 * Verifies that broadcastEvent filters messages to session-subscribed sockets
 * and project-wide (untagged) sockets correctly.
 */
import { beforeEach,describe, expect, it, vi } from 'vitest';

// Mock drizzle-orm to provide sql template tag (needed by observability-schema.ts)
vi.mock('drizzle-orm', () => ({
  sql: Object.assign((s: unknown) => s, { raw: (s: unknown) => s }),
  eq: (a: unknown, b: unknown) => [a, b],
  and: (...args: unknown[]) => args,
  desc: (col: unknown) => ({ desc: true, col }),
}));

// Mock the cloudflare:workers module
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Mock the migrations module
vi.mock('../../../src/durable-objects/migrations', () => ({
  runMigrations: vi.fn(),
}));

// Mock the shared package
vi.mock('@simple-agent-manager/shared', () => ({
  ACP_SESSION_VALID_TRANSITIONS: {},
  ACP_SESSION_TERMINAL_STATUSES: new Set(),
  ACP_SESSION_DEFAULTS: {
    DETECTION_WINDOW_MS: 30000,
    MAX_FORK_DEPTH: 5,
  },
  DEFAULT_WORKSPACE_PROFILE: 'default',
  PROVIDER_LOCATIONS: {},
}));

const { ProjectData } = await import('../../../src/durable-objects/project-data');

interface MockWebSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  tags: string[];
  _sent: string[];
}

function createMockWebSocket(tags: string[] = []): MockWebSocket {
  const sent: string[] = [];
  return {
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
    tags,
    _sent: sent,
  };
}

function createMockCtx(websockets: MockWebSocket[] = []) {
  const sqlExecResults: any[] = [];

  return {
    storage: {
      sql: {
        exec: vi.fn(() => ({
          toArray: () => sqlExecResults,
          columnNames: [],
          rowsRead: 0,
          rowsWritten: 0,
        })),
      },
      get: vi.fn(),
      put: vi.fn(),
      transactionSync: vi.fn((fn: () => void) => fn()),
    },
    id: { toString: () => 'test-do-id' },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
    getWebSockets: vi.fn((tag?: string) => {
      if (tag) {
        return websockets.filter((ws) => ws.tags.includes(tag));
      }
      return [...websockets];
    }),
    getTags: vi.fn((ws: MockWebSocket) => ws.tags),
    acceptWebSocket: vi.fn((ws: MockWebSocket, tags?: string[]) => {
      if (tags) ws.tags = tags;
      websockets.push(ws);
    }),
    _websockets: websockets,
    _sqlExecResults: sqlExecResults,
  };
}

function createMockEnv() {
  return {
    DATABASE: {} as any,
    DO_SUMMARY_SYNC_DEBOUNCE_MS: '999999', // Prevent timer from running
  };
}

describe('ProjectData DO — session-scoped broadcasting', () => {
  let projectData: InstanceType<typeof ProjectData>;
  let mockCtx: ReturnType<typeof createMockCtx>;
  let sessionASocket: MockWebSocket;
  let sessionBSocket: MockWebSocket;
  let untaggedSocket: MockWebSocket;

  beforeEach(() => {
    sessionASocket = createMockWebSocket(['session:session-a']);
    sessionBSocket = createMockWebSocket(['session:session-b']);
    untaggedSocket = createMockWebSocket([]);

    mockCtx = createMockCtx([sessionASocket, sessionBSocket, untaggedSocket]);
    projectData = new ProjectData(mockCtx as any, createMockEnv() as any);
  });

  describe('WebSocket upgrade with session tag', () => {
    it('accepts WebSocket with session tag from query param', async () => {
      const freshCtx = createMockCtx([]);
      const pd = new ProjectData(freshCtx as any, createMockEnv() as any);

      const clientWs = createMockWebSocket();
      const serverWs = createMockWebSocket();
      vi.stubGlobal(
        'WebSocketPair',
        class {
          0 = clientWs;
          1 = serverWs;
        }
      );

      try {
        await pd.fetch(
          new Request('https://do.internal/ws?sessionId=a1b2c3d4-e5f6-7890-abcd-ef1234567890', {
            headers: { Upgrade: 'websocket' },
          })
        );
      } catch {
        // Expected in Node.js — status 101 not supported
      }

      expect(freshCtx.acceptWebSocket).toHaveBeenCalledWith(serverWs, ['session:a1b2c3d4-e5f6-7890-abcd-ef1234567890']);
    });

    it('accepts WebSocket without tags when no sessionId param', async () => {
      const freshCtx = createMockCtx([]);
      const pd = new ProjectData(freshCtx as any, createMockEnv() as any);

      const clientWs = createMockWebSocket();
      const serverWs = createMockWebSocket();
      vi.stubGlobal(
        'WebSocketPair',
        class {
          0 = clientWs;
          1 = serverWs;
        }
      );

      try {
        await pd.fetch(
          new Request('https://do.internal/ws', {
            headers: { Upgrade: 'websocket' },
          })
        );
      } catch {
        // Expected in Node.js — status 101 not supported
      }

      expect(freshCtx.acceptWebSocket).toHaveBeenCalledWith(serverWs, []);
    });

    it('rejects WebSocket upgrade with malformed sessionId', async () => {
      const freshCtx = createMockCtx([]);
      const pd = new ProjectData(freshCtx as any, createMockEnv() as any);

      const response = await pd.fetch(
        new Request('https://do.internal/ws?sessionId=../../../etc/passwd', {
          headers: { Upgrade: 'websocket' },
        })
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid sessionId format');
      expect(freshCtx.acceptWebSocket).not.toHaveBeenCalled();
    });
  });

  describe('session-scoped message broadcast', () => {
    it('sends message.new only to subscribed session socket and untagged sockets', async () => {
      // Set up the SQL mock to return a valid session and next sequence
      mockCtx.storage.sql.exec = vi.fn((query: string, ..._args: any[]) => {
        if (query.includes('SELECT workspace_id FROM chat_sessions')) {
          return {
            toArray: () => [{ workspace_id: null }],
            columnNames: [],
            rowsRead: 1,
            rowsWritten: 0,
          };
        }
        if (query.includes('SELECT') && query.includes('chat_sessions')) {
          return {
            toArray: () => [{ id: 'session-a', status: 'active', message_count: 0 }],
            columnNames: [],
            rowsRead: 1,
            rowsWritten: 0,
          };
        }
        if (query.includes('MAX(sequence)') || query.includes('COALESCE')) {
          return {
            toArray: () => [{ max_seq: 0 }],
            columnNames: [],
            rowsRead: 1,
            rowsWritten: 0,
          };
        }
        return {
          toArray: () => [],
          columnNames: [],
          rowsRead: 0,
          rowsWritten: 0,
        };
      });

      // Persist a message to session-a — this triggers broadcastEvent('message.new', ..., 'session-a')
      await projectData.persistMessage('session-a', 'user', 'Hello', null);

      // Session A socket should receive the message
      expect(sessionASocket.send).toHaveBeenCalled();
      const sentA = JSON.parse(sessionASocket._sent[0]);
      expect(sentA.type).toBe('message.new');
      expect(sentA.payload.sessionId).toBe('session-a');

      // Session B socket should NOT receive the message
      expect(sessionBSocket.send).not.toHaveBeenCalled();

      // Untagged socket should receive the message (project-wide listener)
      expect(untaggedSocket.send).toHaveBeenCalled();
      const sentUntagged = JSON.parse(untaggedSocket._sent[0]);
      expect(sentUntagged.type).toBe('message.new');
      expect(sentUntagged.payload.sessionId).toBe('session-a');
    });

    it('sends session.created to ALL sockets (intentional project-wide event)', async () => {
      mockCtx.storage.sql.exec = vi.fn((query: string) => {
        if (query.includes('COUNT(*)')) {
          return { toArray: () => [{ cnt: 0 }], columnNames: [], rowsRead: 1, rowsWritten: 0 };
        }
        if (query.includes('MAX(sort_order)')) {
          return { toArray: () => [{ max_sort: 0 }], columnNames: [], rowsRead: 1, rowsWritten: 0 };
        }
        return { toArray: () => [], columnNames: [], rowsRead: 0, rowsWritten: 0 };
      });

      await projectData.createSession(null, 'New session');

      // All three sockets should receive session.created
      expect(sessionASocket.send).toHaveBeenCalled();
      expect(sessionBSocket.send).toHaveBeenCalled();
      expect(untaggedSocket.send).toHaveBeenCalled();

      const sentA = JSON.parse(sessionASocket._sent[0]);
      expect(sentA.type).toBe('session.created');
    });
  });
});
