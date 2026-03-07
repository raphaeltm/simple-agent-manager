import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock KV namespace
const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

// Mock D1 — drizzle calls prepare().bind().all()/raw()/run()
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

// Mock DO namespace
const mockDoStub = { fetch: vi.fn().mockResolvedValue(new Response('ok')) };
const mockProjectData = {
  idFromName: vi.fn().mockReturnValue('do-id'),
  get: vi.fn().mockReturnValue(mockDoStub),
};

let mockD1 = createMockD1();
const mockEnv = {
  KV: mockKV,
  DATABASE: mockD1 as unknown,
  PROJECT_DATA: mockProjectData,
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

    it('should return all three SAM tools', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/list'));

      expect(res.status).toBe(200);
      const body = await res.json();
      const toolNames = body.result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('get_instructions');
      expect(toolNames).toContain('update_task_status');
      expect(toolNames).toContain('complete_task');
      expect(body.result.tools).toHaveLength(3);
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
});
