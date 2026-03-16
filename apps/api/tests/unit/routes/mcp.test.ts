import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock KV namespace
const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

// Mock D1 — drizzle calls prepare().bind().all()/raw()/run()
// Note: drizzle v0.34+ uses .raw() for queries with specific column selection
// (db.select({id: ...})) and .all() for full select (db.select()).
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

/**
 * Helper: set mock D1 results for BOTH .all() and .raw() paths.
 * Drizzle uses .all() for select() and .raw() for select({...}).
 * For .raw(), data must be array-of-arrays (positional values).
 */
function mockD1Results(stmt: ReturnType<typeof createMockD1>['_stmt'], rows: Record<string, unknown>[]) {
  // For .all() path: { results: [row_objects] }
  stmt.all.mockResolvedValue({ results: rows });
  // For .raw() path: [array_of_values] — drizzle maps positionally
  const rawRows = rows.map((row) => Object.values(row));
  stmt.raw.mockResolvedValue(rawRows);
}

// Mock DO namespace — includes RPC methods used by project-data service
const mockDoStub = {
  fetch: vi.fn().mockResolvedValue(new Response('ok')),
  ensureProjectId: vi.fn(),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  getSession: vi.fn().mockResolvedValue(null),
  getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
  searchMessages: vi.fn().mockReturnValue([]),
};
const mockProjectData = {
  idFromName: vi.fn().mockReturnValue('do-id'),
  get: vi.fn().mockReturnValue(mockDoStub),
};

// Mock TaskRunner DO namespace
const mockTaskRunnerStub = {
  start: vi.fn().mockResolvedValue(undefined),
};
const mockTaskRunner = {
  idFromName: vi.fn().mockReturnValue('task-runner-do-id'),
  get: vi.fn().mockReturnValue(mockTaskRunnerStub),
};

// Mock Workers AI
const mockAI = {
  run: vi.fn().mockResolvedValue({ response: 'Generated title' }),
};

let mockD1 = createMockD1();
const mockEnv = {
  KV: mockKV,
  DATABASE: mockD1 as unknown,
  PROJECT_DATA: mockProjectData,
  TASK_RUNNER: mockTaskRunner,
  AI: mockAI,
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

async function mcpRequest(
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

describe('MCP Routes', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    mockEnv.DATABASE = mockD1;
    const { mcpRoutes } = await import('../../../src/routes/mcp');
    app = new Hono();
    app.route('/mcp', mcpRoutes);
  });

  // ─── Authentication ──────────────────────────────────────────────────

  describe('Authentication', () => {
    it('should return 401 without Authorization header', async () => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jsonRpcRequest('initialize')),
      }, mockEnv);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toContain('Unauthorized');
    });

    it('should return 401 for invalid token', async () => {
      mockKV.get.mockResolvedValue(null);

      const res = await mcpRequest(app, jsonRpcRequest('initialize'), 'invalid-token');

      expect(res.status).toBe(401);
    });

    it('should accept valid MCP token', async () => {
      mockKV.get.mockResolvedValue(validTokenData);

      const res = await mcpRequest(app, jsonRpcRequest('initialize'));

      expect(res.status).toBe(200);
    });

    it('should validate token via KV with correct key', async () => {
      mockKV.get.mockResolvedValue(validTokenData);

      await mcpRequest(app, jsonRpcRequest('ping'), 'my-token-123');

      expect(mockKV.get).toHaveBeenCalledWith('mcp:my-token-123', { type: 'json' });
    });
  });

  // ─── MCP Protocol ───────────────────────────────────────────────────

  describe('MCP Protocol', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should handle initialize request', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('initialize'));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result.protocolVersion).toBe('2025-03-26');
      expect(body.result.serverInfo.name).toBe('sam-mcp');
      expect(body.result.capabilities.tools).toBeDefined();
    });

    it('should handle ping request', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('ping'));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toEqual({});
    });

    it('should return METHOD_NOT_FOUND for unknown method', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('nonexistent/method'));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain('nonexistent/method');
    });

    it('should reject non-2.0 JSON-RPC', async () => {
      const res = await mcpRequest(app, { jsonrpc: '1.0', id: 1, method: 'ping' });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32600);
    });

    it('should return parse error for invalid JSON', async () => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-token',
        },
        body: 'not valid json{',
      }, mockEnv);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32700);
    });

    it('should preserve request ID in response', async () => {
      const res = await mcpRequest(app, { jsonrpc: '2.0', id: 42, method: 'ping' });

      const body = await res.json();
      expect(body.id).toBe(42);
    });

    it('should handle null request ID', async () => {
      const res = await mcpRequest(app, { jsonrpc: '2.0', id: null, method: 'ping' });

      const body = await res.json();
      expect(body.id).toBeNull();
    });
  });

  // ─── tools/list ────────────────────────────────────────────────────

  describe('tools/list', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should return all SAM tools', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/list'));

      expect(res.status).toBe(200);
      const body = await res.json();
      const toolNames = body.result.tools.map((t: { name: string }) => t.name);
      // Task lifecycle tools
      expect(toolNames).toContain('get_instructions');
      expect(toolNames).toContain('update_task_status');
      expect(toolNames).toContain('complete_task');
      // Project awareness tools
      expect(toolNames).toContain('list_tasks');
      expect(toolNames).toContain('get_task_details');
      expect(toolNames).toContain('search_tasks');
      expect(toolNames).toContain('list_sessions');
      expect(toolNames).toContain('get_session_messages');
      expect(toolNames).toContain('search_messages');
      expect(toolNames).toContain('dispatch_task');
      expect(body.result.tools).toHaveLength(10);
    });

    it('should include MUST call directive in get_instructions description', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/list'));

      const body = await res.json();
      const getInstructions = body.result.tools.find(
        (t: { name: string }) => t.name === 'get_instructions',
      );
      expect(getInstructions.description).toContain('MUST call this tool');
    });

    it('should include input schemas for all tools', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/list'));

      const body = await res.json();
      for (const tool of body.result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('should require message parameter for update_task_status', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/list'));

      const body = await res.json();
      const updateTool = body.result.tools.find(
        (t: { name: string }) => t.name === 'update_task_status',
      );
      expect(updateTool.inputSchema.required).toContain('message');
    });
  });

  // ─── tools/call routing ────────────────────────────────────────────

  describe('tools/call routing', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should return error for unknown tool name', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'nonexistent_tool',
        arguments: {},
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain('nonexistent_tool');
    });

    it('should reject update_task_status without message', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'update_task_status',
        arguments: {},
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
    });

    it('should reject update_task_status with empty message', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'update_task_status',
        arguments: { message: '   ' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
    });
  });

  // ─── list_tasks ────────────────────────────────────────────────────

  describe('list_tasks', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should return tasks from the project', async () => {
      mockD1Results(mockD1._stmt, [
        {
          id: 'task-other',
          title: 'Other task',
          description: 'Some work',
          status: 'in_progress',
          priority: 1,
          output_branch: 'sam/other',
          output_pr_url: null,
          output_summary: null,
          created_at: '2026-03-14T00:00:00Z',
          updated_at: '2026-03-14T01:00:00Z',
        },
      ]);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'list_tasks',
        arguments: {},
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBeDefined();
      const data = JSON.parse(body.result.content[0].text);
      expect(data.tasks).toBeDefined();
      expect(Array.isArray(data.tasks)).toBe(true);
    });

    it('should accept status filter', async () => {
      mockD1Results(mockD1._stmt, []);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'list_tasks',
        arguments: { status: 'completed' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBeDefined();
    });

    it('should accept limit parameter', async () => {
      mockD1Results(mockD1._stmt, []);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'list_tasks',
        arguments: { limit: 5 },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBeDefined();
    });
  });

  // ─── get_task_details ────────────────────────────────────────────────

  describe('get_task_details', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should return task details when found', async () => {
      mockD1Results(mockD1._stmt, [{
        id: 'task-other',
        title: 'Another task',
        description: 'Full description here',
        status: 'completed',
        priority: 2,
        output_branch: 'sam/other',
        output_pr_url: 'https://github.com/user/repo/pull/1',
        output_summary: 'Did some work',
        error_message: null,
        created_at: '2026-03-14T00:00:00Z',
        updated_at: '2026-03-14T01:00:00Z',
        started_at: '2026-03-14T00:05:00Z',
        completed_at: '2026-03-14T01:00:00Z',
      }]);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'get_task_details',
        arguments: { taskId: 'task-other' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBeDefined();
      const data = JSON.parse(body.result.content[0].text);
      expect(data.id).toBe('task-other');
      expect(data.description).toBe('Full description here');
    });

    it('should return error when task not found', async () => {
      mockD1Results(mockD1._stmt, []);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'get_task_details',
        arguments: { taskId: 'nonexistent' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('not found');
    });

    it('should require taskId', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'get_task_details',
        arguments: {},
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
    });
  });

  // ─── search_tasks ───────────────────────────────────────────────────

  describe('search_tasks', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should search tasks by keyword', async () => {
      mockD1Results(mockD1._stmt, [{
        id: 'task-match',
        title: 'Fix authentication bug',
        description: 'The login flow is broken',
        status: 'in_progress',
        priority: 1,
        output_branch: null,
        output_pr_url: null,
        output_summary: null,
        updated_at: '2026-03-14T00:00:00Z',
      }]);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'search_tasks',
        arguments: { query: 'authentication' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      const data = JSON.parse(body.result.content[0].text);
      expect(data.tasks).toBeDefined();
      expect(data.query).toBe('authentication');
    });

    it('should reject empty query', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'search_tasks',
        arguments: { query: '' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
    });

    it('should reject query shorter than 2 characters', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'search_tasks',
        arguments: { query: 'a' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
    });

    it('should require query parameter', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'search_tasks',
        arguments: {},
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  // ─── list_sessions ──────────────────────────────────────────────────

  describe('list_sessions', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should return sessions from the project', async () => {
      mockDoStub.listSessions.mockResolvedValue({
        sessions: [
          {
            id: 'sess-1',
            topic: 'Fix bug',
            status: 'stopped',
            messageCount: 42,
            taskId: 'task-other',
            workspaceId: 'ws-1',
            startedAt: 1710000000000,
            endedAt: 1710003600000,
          },
        ],
        total: 1,
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'list_sessions',
        arguments: {},
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      const data = JSON.parse(body.result.content[0].text);
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].id).toBe('sess-1');
      expect(data.sessions[0].topic).toBe('Fix bug');
      expect(data.total).toBe(1);
    });

    it('should accept status filter', async () => {
      mockDoStub.listSessions.mockResolvedValue({ sessions: [], total: 0 });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'list_sessions',
        arguments: { status: 'active' },
      }));

      expect(res.status).toBe(200);
      expect(mockDoStub.listSessions).toHaveBeenCalledWith('active', expect.any(Number), 0, null);
    });
  });

  // ─── get_session_messages ───────────────────────────────────────────

  describe('get_session_messages', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should return messages for a valid session', async () => {
      mockDoStub.getSession.mockResolvedValue({
        id: 'sess-1',
        topic: 'Fix bug',
        taskId: 'task-other',
      });
      mockDoStub.getMessages.mockResolvedValue({
        messages: [
          { id: 'msg-1', role: 'user', content: 'Please fix the bug', createdAt: 1710000000000 },
          { id: 'msg-2', role: 'assistant', content: 'I will fix it now', createdAt: 1710000001000 },
        ],
        hasMore: false,
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'get_session_messages',
        arguments: { sessionId: 'sess-1' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      const data = JSON.parse(body.result.content[0].text);
      expect(data.messages).toHaveLength(2);
      expect(data.sessionId).toBe('sess-1');
      expect(data.topic).toBe('Fix bug');
      expect(data.hasMore).toBe(false);
    });

    it('should return error for non-existent session', async () => {
      mockDoStub.getSession.mockResolvedValue(null);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'get_session_messages',
        arguments: { sessionId: 'nonexistent' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('not found');
    });

    it('should require sessionId', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'get_session_messages',
        arguments: {},
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
    });

    it('should default to user and assistant roles', async () => {
      mockDoStub.getSession.mockResolvedValue({ id: 'sess-1', topic: null, taskId: null });
      mockDoStub.getMessages.mockResolvedValue({ messages: [], hasMore: false });

      await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'get_session_messages',
        arguments: { sessionId: 'sess-1' },
      }));

      expect(mockDoStub.getMessages).toHaveBeenCalledWith(
        'sess-1',
        expect.any(Number),
        null,
        ['user', 'assistant'],
      );
    });
  });

  // ─── search_messages ────────────────────────────────────────────────

  describe('search_messages', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should search messages across sessions', async () => {
      mockDoStub.searchMessages.mockReturnValue([
        {
          id: 'msg-1',
          sessionId: 'sess-1',
          role: 'user',
          snippet: '...discussing the authentication flow...',
          createdAt: 1710000000000,
          sessionTopic: 'Auth work',
          sessionTaskId: 'task-other',
        },
      ]);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'search_messages',
        arguments: { query: 'authentication' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      const data = JSON.parse(body.result.content[0].text);
      expect(data.results).toHaveLength(1);
      expect(data.results[0].snippet).toContain('authentication');
      expect(data.query).toBe('authentication');
    });

    it('should reject empty query', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'search_messages',
        arguments: { query: '' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
    });

    it('should reject query shorter than 2 characters', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'search_messages',
        arguments: { query: 'x' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it('should accept optional sessionId filter', async () => {
      mockDoStub.searchMessages.mockReturnValue([]);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'search_messages',
        arguments: { query: 'test', sessionId: 'sess-1' },
      }));

      expect(res.status).toBe(200);
      expect(mockDoStub.searchMessages).toHaveBeenCalledWith(
        'test',
        'sess-1',
        ['user', 'assistant'],
        expect.any(Number),
      );
    });
  });

  // ─── dispatch_task ──────────────────────────────────────────────────

  describe('dispatch_task', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should reject empty description', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: '' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('description is required');
    });

    it('should reject missing description', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: {},
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
    });

    it('should reject description exceeding max length', async () => {
      const longDescription = 'a'.repeat(33_000);
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: longDescription },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('maximum length');
    });

    it('should reject invalid vmSize', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Build feature X', vmSize: 'gigantic' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('vmSize');
    });

    it('should reject when current task not found', async () => {
      // Current task query returns empty
      mockD1Results(mockD1._stmt, []);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Build feature X' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('Current task not found');
    });

    it('should reject when dispatch depth would exceed limit', async () => {
      // Current task with dispatch_depth = 3 (at the limit)
      mockD1Results(mockD1._stmt, [{
        id: 'task-123',
        dispatch_depth: 3,
        output_branch: 'sam/parent',
        status: 'in_progress',
      }]);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Build feature X' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('Dispatch depth limit exceeded');
    });

    it('should include dispatch_task in tools/list with required description', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/list'));

      const body = await res.json();
      const dispatchTool = body.result.tools.find(
        (t: { name: string }) => t.name === 'dispatch_task',
      );
      expect(dispatchTool).toBeDefined();
      expect(dispatchTool.inputSchema.required).toContain('description');
      expect(dispatchTool.description).toContain('Dispatch a new task');
      expect(dispatchTool.description).toContain('Rate-limited');
    });

    it('should reject dispatch from a task in terminal status', async () => {
      // Current task is completed
      mockD1Results(mockD1._stmt, [{
        id: 'task-123',
        dispatch_depth: 0,
        output_branch: 'sam/parent',
        status: 'completed',
      }]);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Follow up work' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('completed');
    });

    it('should reject dispatch from a failed task', async () => {
      mockD1Results(mockD1._stmt, [{
        id: 'task-123',
        dispatch_depth: 0,
        output_branch: 'sam/parent',
        status: 'failed',
      }]);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Retry the work' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('failed');
    });

    /**
     * Helper to set up sequential D1 mocks for dispatch_task happy path.
     * The handler makes these D1 queries in order:
     * 1. raw() — current task (id, dispatchDepth, outputBranch, status)
     * 2. raw() — child count (count(*))
     * 3. raw() — active dispatched count (count(*))
     * 4. raw() — credential check (id)
     * 5. all() — project (full select)
     * 6. run() — task insert
     * 7. run() — status event insert
     * 8. DO — createSession + persistMessage
     * 9. raw() — user lookup (name, email, githubId)
     * 10. DO — startTaskRunnerDO
     * 11. run() — (possible further inserts)
     */
    // Project data used across dispatch tests
    const mockProject = {
      id: 'proj-456',
      name: 'Test Project',
      repository: 'user/repo',
      defaultBranch: 'main',
      installationId: 'inst-1',
      defaultVmSize: null,
      defaultWorkspaceProfile: null,
      defaultProvider: null,
      defaultAgentType: null,
    };

    function setupHappyPathMocks() {
      // The handler makes many sequential D1 queries. Drizzle may use
      // either .raw() or .all() depending on query shape. We set a
      // persistent .all() default for the project query and chain
      // .raw() mocks for positional-result queries.
      mockD1._stmt.all.mockResolvedValue({ results: [mockProject] });

      // Sequential .raw() calls
      mockD1._stmt.raw
        .mockResolvedValueOnce([['task-123', 0, 'sam/parent', 'in_progress']]) // current task
        .mockResolvedValueOnce([[0]])  // child count
        .mockResolvedValueOnce([[0]])  // active dispatched count
        .mockResolvedValueOnce([['cred-1']])  // credential
        // project query may also use .raw() — add extra entries
        .mockResolvedValueOnce([Object.values(mockProject)]) // project (if raw)
        .mockResolvedValueOnce([['User', 'user@test.com', '12345']]);  // user lookup

      // .run() for inserts (task + status event + possible failure recovery)
      mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      // DO mocks — createSession returns a session ID
      mockDoStub.createSession = vi.fn().mockResolvedValue('sess-new-1');
      mockDoStub.persistMessage = vi.fn().mockResolvedValue('msg-new-1');
    }

    it('should dispatch task successfully (happy path)', async () => {
      setupHappyPathMocks();

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: {
          description: 'Build the notification system',
          vmSize: 'medium',
          priority: 2,
          references: ['specs/014-notifications/spec.md', 'apps/api/src/routes/notifications.ts'],
        },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();

      const data = JSON.parse(body.result.content[0].text);
      expect(data.taskId).toBeDefined();
      expect(data.sessionId).toBe('sess-new-1');
      expect(data.branchName).toBeDefined();
      expect(data.status).toBe('queued');
      expect(data.dispatchDepth).toBe(1);
      expect(data.url).toContain('app.example.com');
      expect(data.url).toContain('proj-456');
      expect(data.message).toContain('dispatched successfully');
    });

    it('should reject when per-task dispatch limit is reached', async () => {
      // Current task query
      mockD1._stmt.raw
        .mockResolvedValueOnce([['task-123', 0, 'sam/parent', 'in_progress']]) // current task
        .mockResolvedValueOnce([[5]]);  // child count = 5 (at default limit)

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'One more task' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('Per-task dispatch limit');
    });

    it('should reject when per-project active limit is reached', async () => {
      mockD1._stmt.raw
        .mockResolvedValueOnce([['task-123', 0, 'sam/parent', 'in_progress']]) // current task
        .mockResolvedValueOnce([[2]])   // child count = 2 (under limit)
        .mockResolvedValueOnce([[10]]); // active dispatched = 10 (at default limit)

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Another dispatched task' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain('active agent-dispatched tasks');
    });

    it('should reject when cloud credentials are missing', async () => {
      mockD1._stmt.raw
        .mockResolvedValueOnce([['task-123', 0, 'sam/parent', 'in_progress']]) // current task
        .mockResolvedValueOnce([[0]])   // child count
        .mockResolvedValueOnce([[0]])   // active dispatched count
        .mockResolvedValueOnce([]);     // no credential

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Build feature Y' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('Cloud provider credentials required');
    });

    it('should handle session creation failure gracefully', async () => {
      const sessionProject = {
        id: 'proj-456', name: 'Test', repository: 'user/repo',
        defaultBranch: 'main', installationId: 'inst-1',
        defaultVmSize: null, defaultWorkspaceProfile: null,
        defaultProvider: null, defaultAgentType: null,
      };

      // Use persistent defaults for .all() and .run() (same pattern as setupHappyPathMocks)
      mockD1._stmt.all.mockResolvedValue({ results: [sessionProject] });
      mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      mockD1._stmt.raw
        .mockResolvedValueOnce([['task-123', 0, 'sam/parent', 'in_progress']]) // current task
        .mockResolvedValueOnce([[0]])   // child count
        .mockResolvedValueOnce([[0]])   // active dispatched count
        .mockResolvedValueOnce([['cred-1']])  // credential
        .mockResolvedValueOnce([Object.values(sessionProject)]); // project (if raw path)

      // Session creation fails
      mockDoStub.createSession = vi.fn().mockRejectedValue(new Error('DO unavailable'));

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Build feature Z' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32603); // INTERNAL_ERROR
      expect(body.error.message).toContain('Failed to create chat session');
    });

    it('should handle TaskRunner DO failure gracefully', async () => {
      setupHappyPathMocks();

      // Override TaskRunner to fail
      mockTaskRunnerStub.start.mockRejectedValueOnce(new Error('DO crashed'));

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Build feature W' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32603); // INTERNAL_ERROR
      expect(body.error.message).toContain('Failed to start task runner');
    });

    it('should reject dispatching from a cancelled task', async () => {
      mockD1._stmt.raw
        .mockResolvedValueOnce([['task-123', 0, 'sam/parent', 'cancelled']]);

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Build something' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain("'cancelled' status");
    });

    it('should clamp priority to max allowed value', async () => {
      setupHappyPathMocks();

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'High priority task', priority: 99999 },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      // Should succeed (priority clamped, not rejected)
      expect(body.result).toBeDefined();
      expect(body.result.content[0].text).toContain('dispatched');
    });

    it('should return error when project is not found', async () => {
      // All checks pass but project query returns empty
      mockD1._stmt.all.mockResolvedValue({ results: [] }); // no project
      mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      mockD1._stmt.raw
        .mockResolvedValueOnce([['task-123', 0, 'sam/parent', 'in_progress']]) // current task
        .mockResolvedValueOnce([[0]])   // child count
        .mockResolvedValueOnce([[0]])   // active dispatched count
        .mockResolvedValueOnce([['cred-1']]); // credential exists

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Build feature X' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('Project not found');
    });

    it('should verify TaskRunner DO receives correct config', async () => {
      setupHappyPathMocks();

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'dispatch_task',
        arguments: { description: 'Build notification system', vmSize: 'large' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBeDefined();

      // Verify TaskRunner DO was called with correct arguments
      expect(mockTaskRunnerStub.start).toHaveBeenCalledTimes(1);
      const startInput = mockTaskRunnerStub.start.mock.calls[0][0];
      expect(startInput.projectId).toBe('proj-456');
      expect(startInput.userId).toBe('user-789');
      expect(startInput.config.vmSize).toBe('large');
    });
  });

  // ─── Token lifecycle across task completion ──────────────────────────

  describe('Token lifecycle', () => {
    beforeEach(() => {
      mockKV.get.mockResolvedValue(validTokenData);
    });

    it('should NOT revoke token when complete_task succeeds', async () => {
      // Mock the D1 update to indicate a successful completion
      mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'complete_task',
        arguments: { summary: 'Done' },
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBeDefined();
      expect(body.result.content[0].text).toContain('completed');

      // Token must NOT be deleted from KV — the MCP connection outlives
      // individual tasks (scoped to ACP session / workspace lifetime)
      expect(mockKV.delete).not.toHaveBeenCalled();
    });

    it('should allow tool calls after complete_task (token still valid)', async () => {
      // First call: complete_task
      mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
      const completeRes = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'complete_task',
        arguments: { summary: 'Task done' },
      }));
      expect(completeRes.status).toBe(200);

      // Token was NOT revoked, so KV still returns valid data
      expect(mockKV.delete).not.toHaveBeenCalled();

      // Second call: get_instructions should still authenticate successfully
      // (KV.get still returns valid token data since it was not revoked)
      // get_instructions makes two queries: tasks then projects
      mockD1._stmt.all
        .mockResolvedValueOnce({
          results: [{
            id: 'task-123',
            title: 'Test task',
            description: 'A test task',
            status: 'completed',
            priority: 0,
            outputBranch: 'sam/test',
          }],
        })
        .mockResolvedValueOnce({
          results: [{
            id: 'proj-456',
            name: 'Test Project',
            repository: 'user/repo',
            defaultBranch: 'main',
          }],
        });

      const instructionsRes = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'get_instructions',
        arguments: {},
      }));
      // The key assertion: request authenticates (200, not 401)
      // because the token was NOT revoked after complete_task
      expect(instructionsRes.status).toBe(200);
    });

    it('should allow update_task_status after complete_task (token still valid)', async () => {
      // First: complete_task
      mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
      await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'complete_task',
        arguments: { summary: 'Done' },
      }));

      expect(mockKV.delete).not.toHaveBeenCalled();

      // Second: update_task_status — token still valid, but handler may
      // reject based on task state (which is correct business logic,
      // not an auth failure)
      mockD1._stmt.all.mockResolvedValue({
        results: [{ id: 'task-123', status: 'completed' }],
      });

      const updateRes = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'update_task_status',
        arguments: { message: 'Follow-up update' },
      }));
      expect(updateRes.status).toBe(200);
      // The request should authenticate successfully (200, not 401)
      // The handler may reject based on task state, but that's business
      // logic — the auth layer should not block the request
    });
  });
});
