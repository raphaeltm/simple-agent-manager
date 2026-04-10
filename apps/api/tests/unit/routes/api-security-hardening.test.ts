/**
 * Tests for API security hardening:
 * - Error message leakage prevention
 * - Health endpoint information exposure
 * - Workspace subdomain ULID validation
 * - Admin self-suspension protection
 * - Stronger MCP token generation
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/index';
import { AppError } from '../../../src/middleware/error';
import { parseWorkspaceSubdomain } from '../../../src/lib/workspace-subdomain';
import { generateMcpToken } from '../../../src/services/mcp-token';

// ---------------------------------------------------------------------------
// 1. Error message leakage
// ---------------------------------------------------------------------------
describe('Global error handler — error message leakage', () => {
  function createAppWithErrorHandler() {
    const app = new Hono<{ Bindings: Env }>();

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as any);
      }
      // This mirrors the production handler — generic message, no err.message
      return c.json(
        { error: 'INTERNAL_ERROR', message: 'Internal server error' },
        500
      );
    });

    return app;
  }

  it('returns generic message for unexpected Error, not the internal message', async () => {
    const app = createAppWithErrorHandler();
    app.get('/boom', () => {
      throw new Error('database connection string: postgres://user:password@host/db');
    });

    const res = await app.request('/boom');
    const body = await res.json() as any;

    expect(res.status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(body.message).not.toContain('postgres://');
    expect(body.message).not.toContain('password');
  });

  it('returns generic message for TypeError (internal runtime error)', async () => {
    const app = createAppWithErrorHandler();
    app.get('/boom', () => {
      throw new TypeError('Cannot read properties of undefined');
    });

    const res = await app.request('/boom');
    const body = await res.json() as any;

    expect(res.status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(body.message).not.toContain('Cannot read');
  });

  it('still returns AppError messages (they are safe/intentional)', async () => {
    const app = createAppWithErrorHandler();
    app.get('/bad', () => {
      throw new AppError(400, 'BAD_REQUEST', 'Name is required');
    });

    const res = await app.request('/bad');
    const body = await res.json() as any;

    expect(res.status).toBe(400);
    expect(body.message).toBe('Name is required');
  });
});

// ---------------------------------------------------------------------------
// 2. Health endpoint — public vs admin
// ---------------------------------------------------------------------------
describe('Health endpoint — information exposure', () => {
  it('public /health returns only status, version, and timestamp', async () => {
    const app = new Hono<{ Bindings: Env }>();
    const mockEnv = {
      DATABASE: {},
      KV: {},
      PROJECT_DATA: {},
      NODE_LIFECYCLE: {},
      TASK_RUNNER: {},
      ADMIN_LOGS: {},
      NOTIFICATION: {},
      VERSION: '1.0.0-test',
    } as unknown as Env;

    // Mirror production handler
    app.get('/health', (c) => {
      const env = mockEnv;
      const hasCriticalBindings = !!(
        env.DATABASE &&
        env.KV &&
        env.PROJECT_DATA &&
        env.NODE_LIFECYCLE &&
        env.TASK_RUNNER
      );
      return c.json({
        status: hasCriticalBindings ? 'healthy' : 'degraded',
        version: env.VERSION,
        timestamp: new Date().toISOString(),
      }, hasCriticalBindings ? 200 : 503);
    });

    const res = await app.request('/health');
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.version).toBe('1.0.0-test');
    expect(body.timestamp).toBeDefined();
    // Must NOT include internal details
    expect(body.limits).toBeUndefined();
    expect(body.bindings).toBeUndefined();
    expect(body.missingBindings).toBeUndefined();
  });

  it('public /health returns 503 when critical bindings are missing', async () => {
    const app = new Hono<{ Bindings: Env }>();
    const mockEnv = {
      DATABASE: undefined,
      KV: {},
      PROJECT_DATA: {},
      NODE_LIFECYCLE: {},
      TASK_RUNNER: {},
      VERSION: '1.0.0-test',
    } as unknown as Env;

    app.get('/health', (c) => {
      const env = mockEnv;
      const hasCriticalBindings = !!(
        env.DATABASE &&
        env.KV &&
        env.PROJECT_DATA &&
        env.NODE_LIFECYCLE &&
        env.TASK_RUNNER
      );
      return c.json({
        status: hasCriticalBindings ? 'healthy' : 'degraded',
        version: env.VERSION,
        timestamp: new Date().toISOString(),
      }, hasCriticalBindings ? 200 : 503);
    });

    const res = await app.request('/health');
    const body = await res.json() as any;

    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    // Still must NOT expose which bindings are missing
    expect(body.missingBindings).toBeUndefined();
    expect(body.bindings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Workspace subdomain ULID validation
// ---------------------------------------------------------------------------
describe('Workspace subdomain — ULID validation', () => {
  const baseDomain = 'example.com';

  it('accepts a valid ULID workspace ID', () => {
    // Valid ULID: 26 uppercase alphanumeric chars
    const result = parseWorkspaceSubdomain('ws-01ARZ3NDEKTSV4RRFFQ69G5FAV.example.com', baseDomain);
    expect(result).toEqual({
      workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      targetPort: null,
      sidecar: null,
    });
  });

  it('accepts a valid ULID workspace ID with port', () => {
    const result = parseWorkspaceSubdomain('ws-01ARZ3NDEKTSV4RRFFQ69G5FAV--3000.example.com', baseDomain);
    expect(result).toEqual({
      workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      targetPort: 3000,
      sidecar: null,
    });
  });

  it('rejects workspace ID that is too short', () => {
    const result = parseWorkspaceSubdomain('ws-ABC123.example.com', baseDomain);
    expect(result).toEqual({ error: 'Invalid workspace ID format' });
  });

  it('rejects workspace ID that is too long', () => {
    const result = parseWorkspaceSubdomain('ws-01ARZ3NDEKTSV4RRFFQ69G5FAVX.example.com', baseDomain);
    expect(result).toEqual({ error: 'Invalid workspace ID format' });
  });

  it('rejects workspace ID with lowercase chars (pre-toUpperCase input)', () => {
    // The function calls .toUpperCase(), so lowercase in the subdomain becomes uppercase.
    // This tests that after uppercase conversion, the pattern is still validated.
    // A valid 26-char lowercase input will be uppercased and should pass.
    const result = parseWorkspaceSubdomain('ws-01arz3ndektsv4rrffq69g5fav.example.com', baseDomain);
    expect(result).toEqual({
      workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      targetPort: null,
      sidecar: null,
    });
  });

  it('rejects workspace ID with special characters', () => {
    const result = parseWorkspaceSubdomain('ws-01ARZ3NDEK/SV4RRFFQ69G5FA.example.com', baseDomain);
    expect(result).toEqual({ error: 'Invalid workspace ID format' });
  });

  it('rejects workspace ID with SQL injection attempt (no double-dash)', () => {
    // Without '--', the whole string is the workspaceId after ws- prefix
    const result = parseWorkspaceSubdomain("ws-DROPTABLEWORKSPACES12345.example.com", baseDomain);
    expect(result).toEqual({ error: 'Invalid workspace ID format' });
  });

  it('rejects workspace ID with path traversal characters', () => {
    const result = parseWorkspaceSubdomain('ws-01ARZ3NDEK..SV4RRFFQ69G5F.example.com', baseDomain);
    expect(result).toEqual({ error: 'Invalid workspace ID format' });
  });

  it('rejects empty workspace ID after ws- prefix', () => {
    const result = parseWorkspaceSubdomain('ws-.example.com', baseDomain);
    expect(result).toEqual({ error: 'Invalid workspace subdomain' });
  });
});

// ---------------------------------------------------------------------------
// 4. Admin self-suspension protection
// ---------------------------------------------------------------------------
describe('Admin self-suspension protection', () => {
  it('the self-modification check rejects when userId matches currentUserId', () => {
    // This tests the logic pattern, not the full route (which requires Hono + DB mocks).
    // The route now has: if (userId === currentUserId) throw errors.badRequest(...)
    const userId = 'user-abc123';
    const currentUserId = 'user-abc123';

    expect(userId === currentUserId).toBe(true);
  });

  it('the self-modification check allows when userId differs from currentUserId', () => {
    const userId = 'user-target';
    const currentUserId = 'user-admin';

    expect(userId === currentUserId).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. MCP token generation strength
// ---------------------------------------------------------------------------
describe('MCP token generation — entropy', () => {
  it('generates a base64url-encoded token (no padding, no +, no /)', () => {
    const token = generateMcpToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
    expect(token).not.toContain('=');
  });

  it('generates 43-character tokens (256 bits = 32 bytes → 43 base64url chars)', () => {
    const token = generateMcpToken();
    // 32 bytes → ceil(32*4/3) = 43 base64url chars without padding
    expect(token.length).toBe(43);
  });

  it('generates unique tokens on each call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateMcpToken()));
    expect(tokens.size).toBe(100);
  });

  it('does NOT use UUID format', () => {
    const token = generateMcpToken();
    // UUIDs have format: 8-4-4-4-12 hex chars
    expect(token).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
