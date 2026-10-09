import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

import type { Env } from '../env';
import { resolveCredentialedCorsOrigin } from '../lib/cors-origin';

const protocolPaths = new Set([
  '/connect/mcp',
  '/oauth/token',
  '/oauth/register',
  '/oauth/revoke',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/connect/mcp',
]);
const protocolCors = cors({
  origin: '*',
  credentials: false,
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version', 'MCP-Session-Id'],
  exposeHeaders: ['WWW-Authenticate', 'Retry-After'],
});
const sessionCors = cors({
  origin: (origin, c) => resolveCredentialedCorsOrigin(origin, c.env?.BASE_DOMAIN),
  credentials: true,
  allowHeaders: [
    'Content-Type',
    'Authorization',
    'x-api-key',
    'anthropic-version',
    'anthropic-beta',
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

/** Protocol endpoints use explicit bearer/PKCE authority, never ambient browser cookies. */
export const apiCors: MiddlewareHandler<{ Bindings: Env }> = (c, next) =>
  (protocolPaths.has(c.req.path.replace(/\/$/, '')) ? protocolCors : sessionCors)(c, next);
