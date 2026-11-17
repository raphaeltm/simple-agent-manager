import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { requireTrustedWriteOrigin } from '../../../src/lib/browser-write-origin';

const env = { BASE_DOMAIN: 'example.test' } as Env;
const rejectedBrowserWrites: Array<{ label: string; headers: Record<string, string> }> = [
  {
    label: 'same-site workspace',
    headers: {
      Origin: 'https://ws-attacker--3000.example.test',
      'Sec-Fetch-Site': 'same-site',
    },
  },
  {
    label: 'workspace without Fetch Metadata',
    headers: { Origin: 'https://ws-attacker--3000.example.test' },
  },
  { label: 'allowlisted docs origin', headers: { Origin: 'https://docs.example.test' } },
  {
    label: 'cross-site metadata',
    headers: {
      Origin: 'https://app.example.test',
      'Sec-Fetch-Site': 'cross-site',
    },
  },
  { label: 'opaque origin', headers: { Origin: 'null' } },
  { label: 'missing origin', headers: { 'Sec-Fetch-Site': 'same-site' } },
];

function makeApp(next = vi.fn()) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.post('/write', requireTrustedWriteOrigin('multipart'), (c) => {
    next();
    return c.json({ ok: true });
  });
  return app;
}

describe('trusted write origin', () => {
  it('accepts the exact app origin with same-site Fetch Metadata', async () => {
    const next = vi.fn();
    const response = await makeApp(next).request(
      '/write',
      {
        method: 'POST',
        headers: {
          Origin: 'https://app.example.test',
          'Sec-Fetch-Site': 'same-site',
        },
      },
      env
    );

    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it.each(rejectedBrowserWrites)('rejects $label browser writes', async ({ headers }) => {
    const next = vi.fn();
    const response = await makeApp(next).request('/write', { method: 'POST', headers }, env);

    expect(response.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('preserves authenticated non-browser clients without browser provenance headers', async () => {
    const next = vi.fn();
    const response = await makeApp(next).request('/write', { method: 'POST' }, env);

    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });
});
