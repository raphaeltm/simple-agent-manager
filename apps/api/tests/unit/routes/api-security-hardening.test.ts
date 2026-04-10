/**
 * Tests for API security hardening:
 * - Error message leakage prevention
 *
 * Other hardening coverage lives in:
 * - `lib/workspace-subdomain.test.ts`
 * - `routes/admin-security.test.ts`
 * - `services/mcp-token.test.ts`
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/index';
import { AppError } from '../../../src/middleware/error';

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
      throw new Error('database connection failed for tenant primary');
    });

    const res = await app.request('/boom');
    const body = await res.json() as any;

    expect(res.status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(body.message).not.toContain('tenant primary');
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
