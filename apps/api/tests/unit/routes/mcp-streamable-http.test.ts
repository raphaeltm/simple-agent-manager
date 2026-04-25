/**
 * Tests for MCP Streamable HTTP compliance.
 *
 * Verifies that SAM's /mcp endpoint correctly handles:
 * - JSON-RPC notifications (no `id` field) → 202 Accepted with no body
 * - GET requests → 405 Method Not Allowed
 * - DELETE requests → 405 Method Not Allowed
 * - Full Codex-style lifecycle: initialize → notifications/initialized → tools/list → tools/call
 * - Regression: existing request methods still return 200 with JSON-RPC responses
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Mock DO namespaces
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

/** Build a JSON-RPC request (has `id` field). */
function jsonRpcRequest(method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method,
    ...(params ? { params } : {}),
  };
}

/** Build a JSON-RPC notification (NO `id` field). */
function jsonRpcNotification(method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
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

describe('MCP Streamable HTTP Compliance', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T01:00:00Z'));
    mockD1 = createMockD1();
    mockEnv.DATABASE = mockD1;

    // Valid token by default
    mockKV.get.mockResolvedValue(validTokenData);

    const { mcpRoutes } = await import('../../../src/routes/mcp');
    app = new Hono();
    app.route('/mcp', mcpRoutes);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Notification handling (202 with no body) ─────────────────────────

  describe('Notifications (no id field)', () => {
    it('should return 202 with no body for notifications/initialized', async () => {
      const res = await mcpPost(app, jsonRpcNotification('notifications/initialized'));

      expect(res.status).toBe(202);
      const body = await res.text();
      expect(body).toBe('');
    });

    it('should return 202 with no body for notifications/cancelled', async () => {
      const res = await mcpPost(app, jsonRpcNotification('notifications/cancelled', {
        requestId: '1',
        reason: 'User cancelled',
      }));

      expect(res.status).toBe(202);
      const body = await res.text();
      expect(body).toBe('');
    });

    it('should return 202 with no body for notifications/progress', async () => {
      const res = await mcpPost(app, jsonRpcNotification('notifications/progress', {
        progressToken: 'tok-1',
        progress: 50,
        total: 100,
      }));

      expect(res.status).toBe(202);
      const body = await res.text();
      expect(body).toBe('');
    });

    it('should return 202 for unknown notifications', async () => {
      const res = await mcpPost(app, jsonRpcNotification('notifications/some_future_notification'));

      expect(res.status).toBe(202);
      const body = await res.text();
      expect(body).toBe('');
    });

    it('should return 202 for any method sent as notification (no id)', async () => {
      // Even a method like "foo/bar" should get 202 if no id is present
      const res = await mcpPost(app, jsonRpcNotification('foo/bar'));

      expect(res.status).toBe(202);
      const body = await res.text();
      expect(body).toBe('');
    });

    it('should NOT return 202 when id is explicitly null (that is a request, not a notification)', async () => {
      // JSON-RPC spec: id=null is a valid request id, only absent id means notification
      const res = await mcpPost(app, {
        jsonrpc: '2.0',
        id: null,
        method: 'unknown/method',
      });

      // Should hit the method switch and get "Method not found" since it's a request with id
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32601);
    });

    it('should return 401 for unauthenticated notification, not 202', async () => {
      mockKV.get.mockResolvedValue(null); // invalid token
      const res = await mcpPost(app, jsonRpcNotification('notifications/initialized'));
      expect(res.status).toBe(401);
    });

    it('should not consume rate limit quota for notifications', async () => {
      // Send a notification — rate limit KV should not be called
      const putCallsBefore = mockKV.put.mock.calls.length;
      await mcpPost(app, jsonRpcNotification('notifications/initialized'));
      // Notification auth still performs one KV.get and one KV.put to refresh the token TTL.
      // The early return should skip any additional rate-limit KV operations.
      const kvGetCalls = mockKV.get.mock.calls;
      expect(kvGetCalls.length).toBe(1);
      expect(kvGetCalls[0][0]).toBe('mcp:valid-token');
      expect(mockKV.put.mock.calls.length).toBe(putCallsBefore + 1);
      expect(mockKV.put.mock.calls[putCallsBefore]?.[0]).toBe('mcp:valid-token');
    });
  });

  // ─── GET and DELETE → 405 ─────────────────────────────────────────────

  describe('HTTP method restrictions', () => {
    it('should return 405 with Allow header for GET /mcp', async () => {
      const res = await app.request('/mcp', {
        method: 'GET',
      }, mockEnv);

      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    });

    it('should return 405 with Allow header for DELETE /mcp', async () => {
      const res = await app.request('/mcp', {
        method: 'DELETE',
      }, mockEnv);

      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    });
  });

  // ─── Full Codex-style lifecycle ───────────────────────────────────────

  describe('Codex lifecycle: initialize → notifications/initialized → tools/list → tools/call', () => {
    it('should complete the full MCP handshake lifecycle', async () => {
      // Step 1: initialize — expect 200 with server info
      const initRes = await mcpPost(app, jsonRpcRequest('initialize'));
      expect(initRes.status).toBe(200);
      const initBody = await initRes.json();
      expect(initBody.result).toBeDefined();
      expect(initBody.result.protocolVersion).toBe('2025-03-26');
      expect(initBody.result.serverInfo.name).toBe('sam-mcp');
      expect(initBody.id).toBe(1);

      // Step 2: notifications/initialized — expect 202 with no body
      const notifRes = await mcpPost(app, jsonRpcNotification('notifications/initialized'));
      expect(notifRes.status).toBe(202);
      const notifBody = await notifRes.text();
      expect(notifBody).toBe('');

      // Step 3: tools/list — expect 200 with tool list
      const listRes = await mcpPost(app, jsonRpcRequest('tools/list'));
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.result).toBeDefined();
      expect(listBody.result.tools).toBeDefined();
      expect(Array.isArray(listBody.result.tools)).toBe(true);
      expect(listBody.result.tools.length).toBeGreaterThan(0);

      // Step 4: tools/call — expect 200 with JSON-RPC response (not 202)
      // We verify the HTTP status and response format, not the tool's internal logic
      const callRes = await mcpPost(app, jsonRpcRequest('tools/call', {
        name: 'get_instructions',
        arguments: {},
      }));
      expect(callRes.status).toBe(200);
      const callBody = await callRes.json();
      expect(callBody.jsonrpc).toBe('2.0');
      expect(callBody.id).toBe(1);
    });
  });

  // ─── Regression: existing methods still work ──────────────────────────

  describe('Regression: existing request methods', () => {
    it('initialize returns 200 with JSON-RPC response', async () => {
      const res = await mcpPost(app, jsonRpcRequest('initialize'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result.protocolVersion).toBeDefined();
    });

    it('ping returns 200 with JSON-RPC response', async () => {
      const res = await mcpPost(app, jsonRpcRequest('ping'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result).toBeDefined();
    });

    it('tools/list returns 200 with JSON-RPC response', async () => {
      const res = await mcpPost(app, jsonRpcRequest('tools/list'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jsonrpc).toBe('2.0');
      expect(body.result.tools).toBeDefined();
    });

    it('unknown method with id returns JSON-RPC error (not 202)', async () => {
      const res = await mcpPost(app, jsonRpcRequest('nonexistent/method'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain('Method not found');
    });

    it('batch JSON-RPC array returns 400 error (not 500)', async () => {
      const res = await mcpPost(app, [
        jsonRpcRequest('initialize'),
        jsonRpcRequest('tools/list'),
      ]);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain('Batch requests are not supported');
    });
  });
});
