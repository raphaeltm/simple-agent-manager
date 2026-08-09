import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { requestLoggingMiddleware } from '../../../src/middleware/request-logging';

describe('requestLoggingMiddleware', () => {
  it('does not emit a request event for the tail-worker ingest path', async () => {
    const info = vi.fn();
    const app = new Hono();
    app.use('*', requestLoggingMiddleware({ info }));
    app.post('/api/admin/observability/logs/ingest', (c) => c.json({ subscribers: 0 }));

    const response = await app.request('/api/admin/observability/logs/ingest', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(info).not.toHaveBeenCalled();
  });

  it('preserves structured logging for every other request path', async () => {
    const info = vi.fn();
    const app = new Hono();
    app.use('*', requestLoggingMiddleware({ info }));
    app.get('/api/projects', (c) => c.json({ ok: true }, 201));

    await app.request('/api/projects');

    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      'http.request',
      expect.objectContaining({ method: 'GET', path: '/api/projects', status: 201 })
    );
  });
});
