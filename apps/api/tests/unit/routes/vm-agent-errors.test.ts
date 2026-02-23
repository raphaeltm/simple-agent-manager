import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../src/index';

// Mock JWT verification — accept any token
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn().mockResolvedValue({ workspace: 'node-123' }),
  signCallbackToken: vi.fn(),
  signNodeManagementToken: vi.fn(),
}));

// Mock auth middleware — allow all
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));

// Mock node-auth middleware
vi.mock('../../../src/middleware/node-auth', () => ({
  requireNodeOwnership: vi.fn(),
}));

// Mock drizzle
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    get: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  }),
}));

// Mock drizzle-orm operators
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

// Mock schema
vi.mock('../../../src/db/schema', () => ({
  nodes: { id: 'id', userId: 'userId', status: 'status', createdAt: 'createdAt' },
  workspaces: { id: 'id', userId: 'userId', nodeId: 'nodeId', status: 'status' },
  agentSessions: { workspaceId: 'workspaceId' },
}));

// Mock services
vi.mock('../../../src/services/limits', () => ({
  getRuntimeLimits: vi.fn().mockReturnValue({ maxNodesPerUser: 5 }),
}));

vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: vi.fn(),
  deleteNodeResources: vi.fn(),
  provisionNode: vi.fn(),
  stopNodeResources: vi.fn(),
}));

vi.mock('../../../src/services/node-agent', () => ({
  createWorkspaceOnNode: vi.fn(),
  listNodeEventsOnNode: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
}));

vi.mock('../../../src/services/telemetry', () => ({
  recordNodeRoutingMetric: vi.fn(),
}));

// Import after mocking
import { nodesRoutes } from '../../../src/routes/nodes';

describe('VM Agent Errors Route', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();

    app = new Hono<{ Bindings: Env }>();

    // Add error handler
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });

    app.route('/api/nodes', nodesRoutes);
  });

  function createEnv(overrides: Partial<Env> = {}): Env {
    return {
      ...overrides,
    } as Env;
  }

  function makeBody(errors: unknown[]) {
    return JSON.stringify({ errors });
  }

  function validEntry(overrides: Record<string, unknown> = {}) {
    return {
      level: 'error',
      message: 'Agent crashed on startup',
      source: 'acp-gateway',
      stack: 'Error: failed to start agent\n  at gateway.go:312',
      workspaceId: 'ws-abc',
      timestamp: '2026-02-14T12:00:00Z',
      ...overrides,
    };
  }

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer test-callback-token',
  };

  describe('POST /api/nodes/:id/errors', () => {
    it('should accept a valid batch and return 204', async () => {
      const res = await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody([validEntry()]),
      }, createEnv());

      expect(res.status).toBe(204);
    });

    it('should accept multiple entries', async () => {
      const entries = [
        validEntry({ message: 'Error 1' }),
        validEntry({ message: 'Error 2', source: 'agent-install' }),
        validEntry({ message: 'Error 3', level: 'warn' }),
      ];

      const res = await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv());

      expect(res.status).toBe(204);
    });

    it('should log each entry via console.error with [vm-agent-error] prefix', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [
        validEntry({ message: 'Error A' }),
        validEntry({ message: 'Error B' }),
      ];

      await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv());

      expect(spy).toHaveBeenCalledWith('[vm-agent-error]', expect.objectContaining({
        level: 'error',
        message: 'Error A',
        source: 'acp-gateway',
        nodeId: 'node-123',
      }));

      expect(spy).toHaveBeenCalledWith('[vm-agent-error]', expect.objectContaining({
        message: 'Error B',
        nodeId: 'node-123',
      }));

      spy.mockRestore();
    });

    it('should include nodeId in log output', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody([validEntry()]),
      }, createEnv());

      const loggedEntry = spy.mock.calls.find(
        (call) => call[0] === '[vm-agent-error]'
      );
      expect(loggedEntry).toBeDefined();
      expect((loggedEntry![1] as Record<string, unknown>).nodeId).toBe('node-123');

      spy.mockRestore();
    });

    it('should return 204 for empty batch', async () => {
      const res = await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody([]),
      }, createEnv());

      expect(res.status).toBe(204);
    });

    it('should return 400 for invalid JSON', async () => {
      const res = await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: { ...authHeaders },
        body: 'not-json',
      }, createEnv());

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid JSON');
    });

    it('should return 400 when body lacks errors array', async () => {
      const res = await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ data: [] }),
      }, createEnv());

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('"errors"');
    });

    it('should return 400 when batch exceeds max size', async () => {
      const entries = Array.from({ length: 15 }, (_, i) =>
        validEntry({ message: `Error ${i}` })
      );

      const res = await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv());

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Batch too large');
    });

    it('should respect configurable MAX_VM_AGENT_ERROR_BATCH_SIZE', async () => {
      const entries = Array.from({ length: 5 }, (_, i) =>
        validEntry({ message: `Error ${i}` })
      );

      const res = await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv({ MAX_VM_AGENT_ERROR_BATCH_SIZE: '3' }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('max 3');
    });

    it('should skip malformed entries without message', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [
        { source: 'acp-gateway' }, // missing message
        validEntry({ message: 'Valid one' }),
      ];

      await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv());

      const vmAgentCalls = spy.mock.calls.filter(
        (call) => call[0] === '[vm-agent-error]'
      );
      expect(vmAgentCalls.length).toBe(1);
      expect((vmAgentCalls[0][1] as Record<string, unknown>).message).toBe('Valid one');

      spy.mockRestore();
    });

    it('should skip entries without source', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [
        { message: 'No source' }, // missing source
        validEntry({ message: 'Has source' }),
      ];

      await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv());

      const vmAgentCalls = spy.mock.calls.filter(
        (call) => call[0] === '[vm-agent-error]'
      );
      expect(vmAgentCalls.length).toBe(1);
      expect((vmAgentCalls[0][1] as Record<string, unknown>).message).toBe('Has source');

      spy.mockRestore();
    });

    it('should truncate long messages', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const longMessage = 'x'.repeat(3000);
      const entries = [validEntry({ message: longMessage })];

      await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv());

      const vmAgentCalls = spy.mock.calls.filter(
        (call) => call[0] === '[vm-agent-error]'
      );
      const loggedMessage = (vmAgentCalls[0][1] as Record<string, unknown>).message as string;
      expect(loggedMessage.length).toBeLessThanOrEqual(2048 + 3); // +3 for '...'

      spy.mockRestore();
    });

    it('should default level to error when invalid', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [validEntry({ level: 'info' })]; // 'info' not valid for VM agent errors

      await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv());

      const vmAgentCalls = spy.mock.calls.filter(
        (call) => call[0] === '[vm-agent-error]'
      );
      const loggedLevel = (vmAgentCalls[0][1] as Record<string, unknown>).level;
      expect(loggedLevel).toBe('error'); // 'info' is not in VALID_VM_ERROR_LEVELS

      spy.mockRestore();
    });

    it('should pass through valid warn level', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [validEntry({ level: 'warn' })];

      await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv());

      const vmAgentCalls = spy.mock.calls.filter(
        (call) => call[0] === '[vm-agent-error]'
      );
      const loggedLevel = (vmAgentCalls[0][1] as Record<string, unknown>).level;
      expect(loggedLevel).toBe('warn');

      spy.mockRestore();
    });

    it('should include workspaceId and context when provided', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const ctx = { step: 'agent_crash', exitCode: 127 };
      const entries = [validEntry({ workspaceId: 'ws-xyz', context: ctx })];

      await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv());

      const vmAgentCalls = spy.mock.calls.filter(
        (call) => call[0] === '[vm-agent-error]'
      );
      const logged = vmAgentCalls[0][1] as Record<string, unknown>;
      expect(logged.workspaceId).toBe('ws-xyz');
      expect(logged.context).toEqual(ctx);

      spy.mockRestore();
    });

    it('should handle null/non-object entries in batch', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [null, 'string', 42, validEntry()];

      await app.request('/api/nodes/node-123/errors', {
        method: 'POST',
        headers: authHeaders,
        body: makeBody(entries),
      }, createEnv());

      const vmAgentCalls = spy.mock.calls.filter(
        (call) => call[0] === '[vm-agent-error]'
      );
      expect(vmAgentCalls.length).toBe(1);

      spy.mockRestore();
    });
  });
});
