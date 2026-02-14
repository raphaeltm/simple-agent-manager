import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../src/index';
import { clientErrorsRoutes } from '../../../src/routes/client-errors';

// Mock auth middleware
vi.mock('../../../src/middleware/auth', () => ({
  optionalAuth: () => vi.fn((_c: any, next: any) => next()),
}));

// Mock rate-limit middleware — pass through
vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: () => vi.fn((_c: any, next: any) => next()),
  getRateLimit: () => 30,
}));

describe('Client Errors Routes', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();

    app = new Hono<{ Bindings: Env }>();

    // Add error handler to match production behavior
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });

    app.route('/api/client-errors', clientErrorsRoutes);
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
      message: 'Something broke',
      source: 'VoiceButton',
      stack: 'Error: Something broke\n  at VoiceButton.tsx:42',
      url: 'https://app.example.com/workspaces/ws-123',
      userAgent: 'Mozilla/5.0',
      timestamp: '2026-02-14T12:00:00Z',
      ...overrides,
    };
  }

  describe('POST /api/client-errors', () => {
    it('should accept a valid batch and return 204', async () => {
      const res = await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody([validEntry()]),
      }, createEnv());

      expect(res.status).toBe(204);
    });

    it('should accept multiple entries in a batch', async () => {
      const entries = [
        validEntry({ message: 'Error 1' }),
        validEntry({ message: 'Error 2', source: 'window.onerror' }),
        validEntry({ message: 'Error 3', level: 'warn' }),
      ];

      const res = await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv());

      expect(res.status).toBe(204);
    });

    it('should log each entry via console.error', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [
        validEntry({ message: 'Error A' }),
        validEntry({ message: 'Error B' }),
      ];

      await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv());

      expect(spy).toHaveBeenCalledTimes(2);

      // First call
      expect(spy).toHaveBeenCalledWith('[client-error]', expect.objectContaining({
        level: 'error',
        message: 'Error A',
        source: 'VoiceButton',
      }));

      // Second call
      expect(spy).toHaveBeenCalledWith('[client-error]', expect.objectContaining({
        message: 'Error B',
      }));

      spy.mockRestore();
    });

    it('should return 204 for empty batch', async () => {
      const res = await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody([]),
      }, createEnv());

      expect(res.status).toBe(204);
    });

    it('should return 400 for invalid JSON body', async () => {
      const res = await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      }, createEnv());

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('BAD_REQUEST');
      expect(body.message).toContain('Invalid JSON');
    });

    it('should return 400 when body lacks errors array', async () => {
      const res = await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [] }),
      }, createEnv());

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('"errors"');
    });

    it('should return 400 when errors is not an array', async () => {
      const res = await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ errors: 'not-array' }),
      }, createEnv());

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('array');
    });

    it('should return 400 when batch exceeds max size', async () => {
      const entries = Array.from({ length: 30 }, (_, i) =>
        validEntry({ message: `Error ${i}` })
      );

      const res = await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv());

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Batch too large');
    });

    it('should respect configurable MAX_CLIENT_ERROR_BATCH_SIZE', async () => {
      const entries = Array.from({ length: 5 }, (_, i) =>
        validEntry({ message: `Error ${i}` })
      );

      const res = await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv({ MAX_CLIENT_ERROR_BATCH_SIZE: '3' }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('max 3');
    });

    it('should skip malformed entries without message', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [
        { source: 'VoiceButton' }, // missing message
        validEntry({ message: 'Valid one' }),
      ];

      await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv());

      // Only the valid entry should be logged
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('[client-error]', expect.objectContaining({
        message: 'Valid one',
      }));

      spy.mockRestore();
    });

    it('should skip entries without source', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [
        { message: 'No source here' }, // missing source
        validEntry({ message: 'Has source' }),
      ];

      await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv());

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('[client-error]', expect.objectContaining({
        message: 'Has source',
      }));

      spy.mockRestore();
    });

    it('should truncate long messages', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const longMessage = 'x'.repeat(3000);
      const entries = [validEntry({ message: longMessage })];

      await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv());

      const loggedEntry = spy.mock.calls[0][1] as Record<string, unknown>;
      const loggedMessage = loggedEntry.message as string;
      expect(loggedMessage.length).toBeLessThanOrEqual(2048 + 3); // +3 for '...'

      spy.mockRestore();
    });

    it('should default level to error when invalid', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [validEntry({ level: 'critical' })]; // invalid level

      await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv());

      const loggedEntry = spy.mock.calls[0][1] as Record<string, unknown>;
      expect(loggedEntry.level).toBe('error');

      spy.mockRestore();
    });

    it('should pass through valid levels (warn, info)', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [
        validEntry({ level: 'warn' }),
        validEntry({ level: 'info' }),
      ];

      await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv());

      const warnEntry = spy.mock.calls[0][1] as Record<string, unknown>;
      const infoEntry = spy.mock.calls[1][1] as Record<string, unknown>;
      expect(warnEntry.level).toBe('warn');
      expect(infoEntry.level).toBe('info');

      spy.mockRestore();
    });

    it('should include context when provided', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const ctx = { phase: 'transcription', retries: 3 };
      const entries = [validEntry({ context: ctx })];

      await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv());

      const loggedEntry = spy.mock.calls[0][1] as Record<string, unknown>;
      expect(loggedEntry.context).toEqual(ctx);

      spy.mockRestore();
    });

    it('should handle null/non-object entries in batch', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const entries = [null, 'string-entry', 42, validEntry()];

      await app.request('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(entries),
      }, createEnv());

      // Only the valid entry should be logged
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
    });
  });
});
