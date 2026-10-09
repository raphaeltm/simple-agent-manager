import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { apiCors } from '../../../src/middleware/api-cors';

const app = new Hono<{ Bindings: Env }>();
app.use('*', apiCors);
app.all('*', (c) => c.json({ ok: true }));
const env = { BASE_DOMAIN: 'sam.test' } as Env;
describe('API protocol CORS before route dispatch', () => {
  it.each([
    '/connect/mcp',
    '/connect/mcp/',
    '/oauth/token',
    '/oauth/register',
    '/oauth/revoke',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource/connect/mcp',
  ])('permits the browser Inspector preflight on %s without cookies', async (path) => {
    const response = await app.request(
      path,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:6274',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type,mcp-protocol-version',
        },
      },
      env
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
      'mcp-protocol-version'
    );
  });
  it.each([
    '/oauth/authorize',
    '/api/connector/consent',
    '/api/connector/settings',
    '/api/admin/connector/settings',
    '/oauth/unrecognized',
  ])('does not make cookie-authorized %s public', async (path) => {
    const response = await app.request(
      path,
      { method: 'OPTIONS', headers: { Origin: 'https://attacker.test' } },
      env
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
