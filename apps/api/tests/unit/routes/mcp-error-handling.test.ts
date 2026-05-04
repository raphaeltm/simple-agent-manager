/**
 * Tests for MCP tools/call error handling.
 *
 * Verifies that when a tool handler throws an unhandled exception,
 * the MCP endpoint returns a proper JSON-RPC error response (not HTTP 500).
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock KV namespace
const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

// Mock D1
function createMockD1() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn(),
    raw: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    batch: vi.fn(),
    _stmt: stmt,
  };
}

// Mock DO namespaces — searchKnowledgeObservations throws to simulate DO failure
const mockDoStub = {
  fetch: vi.fn().mockResolvedValue(new Response('ok')),
  ensureProjectId: vi.fn(),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  getSession: vi.fn().mockResolvedValue(null),
  getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
  searchMessages: vi.fn().mockReturnValue([]),
  linkSessionIdea: vi.fn(),
  unlinkSessionIdea: vi.fn(),
  getIdeasForSession: vi.fn().mockReturnValue([]),
  getSessionsForIdea: vi.fn().mockReturnValue([]),
  updateSessionTopic: vi.fn().mockResolvedValue(true),
  // Knowledge DO methods — will be configured per test
  searchKnowledgeObservations: vi.fn(),
  listKnowledgeEntities: vi.fn(),
  getKnowledgeEntityByName: vi.fn(),
  getRelevantKnowledge: vi.fn(),
  confirmKnowledgeObservation: vi.fn(),
};
const mockProjectData = {
  idFromName: vi.fn().mockReturnValue('do-id'),
  get: vi.fn().mockReturnValue(mockDoStub),
};
const mockTaskRunnerStub = {
  start: vi.fn().mockResolvedValue(undefined),
};
const mockTaskRunner = {
  idFromName: vi.fn().mockReturnValue('task-runner-do-id'),
  get: vi.fn().mockReturnValue(mockTaskRunnerStub),
};
const mockAI = {
  run: vi.fn().mockResolvedValue({ response: 'Generated title' }),
};
const mockNotificationStub = {
  createNotification: vi.fn().mockResolvedValue({ id: 'notif-1', type: 'needs_input' }),
};
const mockNotification = {
  idFromName: vi.fn().mockReturnValue('notif-do-id'),
  get: vi.fn().mockReturnValue(mockNotificationStub),
};

let mockD1 = createMockD1();
const mockEnv = {
  KV: mockKV,
  DATABASE: mockD1 as unknown,
  PROJECT_DATA: mockProjectData,
  TASK_RUNNER: mockTaskRunner,
  AI: mockAI,
  NOTIFICATION: mockNotification,
  BASE_DOMAIN: 'example.com',
};

const validTokenData = {
  taskId: 'task-123',
  projectId: 'proj-456',
  userId: 'user-789',
  workspaceId: 'ws-abc',
  createdAt: '2026-03-07T00:00:00Z',
};

function jsonRpcRequest(method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method,
    ...(params ? { params } : {}),
  };
}

async function mcpPost(
  app: Hono,
  body: unknown,
  token: string = 'valid-token',
) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }, mockEnv);
}

describe('MCP tools/call error handling', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    mockEnv.DATABASE = mockD1;

    // Valid token by default
    mockKV.get.mockResolvedValue(validTokenData);

    const { mcpRoutes } = await import('../../../src/routes/mcp');
    app = new Hono();
    app.route('/mcp', mcpRoutes);
  });

  it('returns JSON-RPC error (not HTTP 500) when search_knowledge handler throws', async () => {
    // Make the DO stub throw to simulate a transient DO communication failure
    mockDoStub.searchKnowledgeObservations.mockRejectedValue(
      new Error('Durable Object unavailable'),
    );

    const res = await mcpPost(app, jsonRpcRequest('tools/call', {
      name: 'search_knowledge',
      arguments: { query: 'test' },
    }));

    // Should return 200 with JSON-RPC error, NOT HTTP 500
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32603); // INTERNAL_ERROR
    expect(body.error.message).toContain('Durable Object unavailable');
  });

  it('returns JSON-RPC error when get_project_knowledge handler throws', async () => {
    mockDoStub.listKnowledgeEntities.mockRejectedValue(
      new Error('Durable Object unavailable'),
    );

    const res = await mcpPost(app, jsonRpcRequest('tools/call', {
      name: 'get_project_knowledge',
      arguments: {},
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toContain('Durable Object unavailable');
  });

  it('returns JSON-RPC error when confirm_knowledge handler throws', async () => {
    mockDoStub.confirmKnowledgeObservation.mockRejectedValue(
      new Error('Durable Object unavailable'),
    );

    const res = await mcpPost(app, jsonRpcRequest('tools/call', {
      name: 'confirm_knowledge',
      arguments: { observationId: 'obs-123' },
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toContain('Durable Object unavailable');
  });

  it('preserves requestId in error response for client correlation', async () => {
    mockDoStub.searchKnowledgeObservations.mockRejectedValue(
      new Error('DO failure'),
    );

    const res = await mcpPost(app, jsonRpcRequest('tools/call', {
      name: 'search_knowledge',
      arguments: { query: 'test' },
    }));

    const body = await res.json();
    expect(body.id).toBe(1); // Must match the request id
    expect(body.error).toBeDefined();
  });

  it('catches errors from any tool handler via the outer try/catch', async () => {
    // Simulate a failure in get_relevant_knowledge by making the DO throw
    mockDoStub.getRelevantKnowledge.mockRejectedValue(
      new Error('Network error'),
    );

    const res = await mcpPost(app, jsonRpcRequest('tools/call', {
      name: 'get_relevant_knowledge',
      arguments: { context: 'some context' },
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32603);
  });
});
