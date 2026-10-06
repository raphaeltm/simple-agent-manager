import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  sql: Object.assign((s: unknown) => s, { raw: (s: unknown) => s }),
  eq: (a: unknown, b: unknown) => [a, b],
  and: (...args: unknown[]) => args,
  desc: (col: unknown) => ({ desc: true, col }),
}));

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

vi.mock('../../../src/durable-objects/migrations', () => ({
  runMigrations: vi.fn(),
}));

vi.mock('@simple-agent-manager/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/shared')>()),
  ACP_SESSION_VALID_TRANSITIONS: {},
  ACP_SESSION_TERMINAL_STATUSES: new Set(),
  ACP_SESSION_DEFAULTS: {
    DETECTION_WINDOW_MS: 30000,
    MAX_FORK_DEPTH: 5,
  },
  DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES: 60,
  DEFAULT_WORKSPACE_PROFILE: 'default',
  PROVIDER_LOCATIONS: {},
}));

vi.mock('../../../src/durable-objects/project-data/comments', () => ({
  createCommentThread: vi.fn(),
  createCommentReply: vi.fn(),
  listCommentThreads: vi.fn(),
  updateCommentThreadStatus: vi.fn(),
}));

const commentStorage = await import('../../../src/durable-objects/project-data/comments');
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
  return {
    storage: {
      sql: {
        exec: vi.fn(() => ({
          toArray: () => [],
          columnNames: [],
          rowsRead: 0,
          rowsWritten: 0,
        })),
      },
      transactionSync: vi.fn((fn: () => unknown) => fn()),
      get: vi.fn(),
      put: vi.fn(),
    },
    id: { toString: () => 'test-do-id' },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
    getWebSockets: vi.fn((tag?: string) => {
      if (tag) return websockets.filter((ws) => ws.tags.includes(tag));
      return [...websockets];
    }),
    getTags: vi.fn((ws: MockWebSocket) => ws.tags),
    acceptWebSocket: vi.fn(),
  };
}

const thread = {
  id: 'thread-1',
  sessionId: 'session-a',
  anchor: { kind: 'message' as const, messageId: 'message-1', quote: null },
  author: { kind: 'human' as const, id: 'user-1', name: 'Ada' },
  body: 'Needs clarification',
  status: 'open' as const,
  createdAt: 1,
  updatedAt: 1,
  sequence: 1,
  version: 1,
  clientMutationId: 'mutation-1',
  sentAt: null,
  sentBy: null,
  resolvedAt: null,
  resolvedBy: null,
  reopenedAt: null,
  reopenedBy: null,
  replies: [],
};

describe('ProjectData DO — comment WebSocket broadcasting', () => {
  let projectData: InstanceType<typeof ProjectData>;
  let sessionASocket: MockWebSocket;
  let sessionBSocket: MockWebSocket;
  let projectSocket: MockWebSocket;

  beforeEach(() => {
    vi.resetAllMocks();
    sessionASocket = createMockWebSocket(['session:session-a']);
    sessionBSocket = createMockWebSocket(['session:session-b']);
    projectSocket = createMockWebSocket([]);
    projectData = new ProjectData(
      createMockCtx([sessionASocket, sessionBSocket, projectSocket]) as any,
      {} as any
    );
  });

  it('broadcasts changed comment threads to matching session and project sockets', () => {
    vi.mocked(commentStorage.createCommentThread).mockReturnValue({
      thread,
      idempotent: false,
      changed: true,
    });

    const result = projectData.createCommentThread({} as never);

    expect(result).toEqual({ thread, idempotent: false });
    expect(sessionASocket.send).toHaveBeenCalledOnce();
    expect(projectSocket.send).toHaveBeenCalledOnce();
    expect(sessionBSocket.send).not.toHaveBeenCalled();

    const event = JSON.parse(sessionASocket._sent[0]);
    expect(event).toEqual({
      type: 'comment.thread.changed',
      payload: {
        sessionId: 'session-a',
        thread,
        reason: 'thread_created',
      },
    });
  });

  it('broadcasts reply and status reasons only when the authoritative state changes', () => {
    vi.mocked(commentStorage.createCommentReply).mockReturnValue({
      thread,
      reply: {
        id: 'reply-1',
        threadId: 'thread-1',
        sessionId: 'session-a',
        author: thread.author,
        body: 'Reply',
        createdAt: 2,
        sequence: 1,
        clientMutationId: 'reply-key',
      },
      idempotent: false,
      changed: true,
    });
    vi.mocked(commentStorage.updateCommentThreadStatus).mockReturnValueOnce({
      thread: { ...thread, status: 'resolved', version: 2 },
      idempotent: false,
      changed: true,
    });
    vi.mocked(commentStorage.updateCommentThreadStatus).mockReturnValueOnce({
      thread: { ...thread, status: 'resolved', version: 2 },
      idempotent: true,
      changed: false,
    });

    projectData.createCommentReply({} as never);
    projectData.updateCommentThreadStatus({ status: 'resolved' } as never);
    projectData.updateCommentThreadStatus({ status: 'resolved' } as never);

    const reasons = sessionASocket._sent.map(
      (message) => JSON.parse(message).payload.reason as string
    );
    expect(reasons).toEqual(['reply_created', 'resolved']);
    expect(projectSocket._sent).toHaveLength(2);
    expect(sessionBSocket._sent).toHaveLength(0);
  });
});
