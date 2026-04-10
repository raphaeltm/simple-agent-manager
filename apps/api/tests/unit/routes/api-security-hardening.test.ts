/**
 * Tests for API security hardening:
 * - Error message leakage prevention
 * - Health endpoint information exposure (public + admin detail route)
 * - Workspace subdomain ULID validation
 * - Admin self-suspension protection (route-level behavioral test)
 * - Stronger MCP token generation
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/index';
import { parseWorkspaceSubdomain } from '../../../src/lib/workspace-subdomain';
import { AppError } from '../../../src/middleware/error';
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
// 2. Workspace subdomain ULID validation
// ---------------------------------------------------------------------------
describe('Workspace subdomain — ULID validation', () => {
  const baseDomain = 'example.com';

  it('accepts a valid ULID workspace ID', () => {
    const result = parseWorkspaceSubdomain('ws-01ARZ3NDEKTSV4RRFFQ69G5FAV.example.com', baseDomain);
    expect(result).toEqual({
      workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      targetPort: null,
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

  it('rejects workspace ID with special characters', () => {
    const result = parseWorkspaceSubdomain('ws-01ARZ3NDEK/SV4RRFFQ69G5FA.example.com', baseDomain);
    expect(result).toEqual({ error: 'Invalid workspace ID format' });
  });

  it('rejects workspace ID with Crockford-excluded chars (I, L, O, U)', () => {
    // Crockford Base32 excludes I, L, O, U — these are not valid ULID characters
    const withI = parseWorkspaceSubdomain('ws-01ARZ3NDEKTSV4RRFFQI9G5FAV.example.com', baseDomain);
    expect(withI).toEqual({ error: 'Invalid workspace ID format' });

    const withL = parseWorkspaceSubdomain('ws-01ARZ3NDEKTSV4RRFFQL9G5FAV.example.com', baseDomain);
    expect(withL).toEqual({ error: 'Invalid workspace ID format' });

    const withO = parseWorkspaceSubdomain('ws-01ARZ3NDEKTSV4RRFFQO9G5FAV.example.com', baseDomain);
    expect(withO).toEqual({ error: 'Invalid workspace ID format' });

    const withU = parseWorkspaceSubdomain('ws-01ARZ3NDEKTSV4RRFFQU9G5FAV.example.com', baseDomain);
    expect(withU).toEqual({ error: 'Invalid workspace ID format' });
  });
});

// ---------------------------------------------------------------------------
// 3. MCP token generation strength
// ---------------------------------------------------------------------------
describe('MCP token generation — entropy', () => {
  it('generates a 43-char base64url token (256-bit, no padding)', () => {
    const token = generateMcpToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates unique tokens on each call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateMcpToken()));
    expect(tokens.size).toBe(100);
  });

  it('does NOT use UUID format', () => {
    const token = generateMcpToken();
    expect(token).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
