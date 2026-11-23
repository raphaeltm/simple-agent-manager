import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  requireExactBrowserOrigin,
  requireTrustedWriteOrigin,
} from '../../../src/lib/browser-write-origin';

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
  { label: 'empty origin', headers: { Origin: '' } },
  { label: 'missing origin', headers: { 'Sec-Fetch-Site': 'same-site' } },
  { label: 'same-origin metadata without Origin', headers: { 'Sec-Fetch-Site': 'same-origin' } },
  { label: 'user-initiated metadata without Origin', headers: { 'Sec-Fetch-Site': 'none' } },
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

  it('admits the local Vite app only when BASE_DOMAIN is local', async () => {
    const localEnv = { BASE_DOMAIN: 'localhost:8787' } as Env;
    const fromVite = { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-site' };

    const next = vi.fn();
    const local = await makeApp(next).request(
      '/write',
      { method: 'POST', headers: fromVite },
      localEnv
    );
    expect(local.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();

    const notLoopback = vi.fn();
    const spoofed = await makeApp(notLoopback).request(
      '/write',
      { method: 'POST', headers: { Origin: 'http://evil.localhost.example.test:5173' } },
      localEnv
    );
    expect(spoofed.status).toBe(403);
    expect(notLoopback).not.toHaveBeenCalled();

    const deployed = vi.fn();
    const response = await makeApp(deployed).request(
      '/write',
      { method: 'POST', headers: fromVite },
      env
    );
    expect(response.status).toBe(403);
    expect(deployed).not.toHaveBeenCalled();
  });

  it.each([
    ['look-alike suffix', 'http://localhost.evil.example:5173'],
    ['https loopback', 'https://localhost:5173'],
    ['workspace host under a local base', 'http://ws-attacker--3000.localhost:8787'],
    // Ports do not separate sites: another local app is same-site with the Vite app.
    ['another app on a different localhost port', 'http://localhost:3000'],
    ['another app on a different 127.0.0.1 port', 'http://127.0.0.1:8080'],
    ['loopback without the app port', 'http://localhost'],
  ])('refuses a %s origin even when BASE_DOMAIN is local', async (_label, origin) => {
    const next = vi.fn();
    const response = await makeApp(next).request(
      '/write',
      { method: 'POST', headers: { Origin: origin } },
      { BASE_DOMAIN: 'localhost:8787' } as Env
    );
    expect(response.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('admits the 127.0.0.1 loopback app under a local BASE_DOMAIN', async () => {
    const next = vi.fn();
    const response = await makeApp(next).request(
      '/write',
      { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173' } },
      { BASE_DOMAIN: 'localhost:8787' } as Env
    );
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it('applies the same exact local origin to the strict interaction guard', () => {
    const localEnv = { BASE_DOMAIN: 'localhost:8787' } as Env;
    const call = (origin: string) => () =>
      requireExactBrowserOrigin({
        req: { header: (name) => (name === 'Origin' ? origin : undefined) },
        env: localEnv,
      });
    expect(call('http://localhost:5173')).not.toThrow();
    expect(call('http://localhost:3000')).toThrow();
  });
});
