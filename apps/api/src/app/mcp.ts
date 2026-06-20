import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

import { mcpRoutes } from '../routes/mcp';
import type { ApiApp } from './types';

export function registerMcpCorsPolicy(app: ApiApp): void {
  // MCP uses bearer token auth, not browser cookies. Keep its CORS behavior
  // separate from credentialed browser routes. Register before global CORS so
  // preflight requests are not swallowed by the credentialed app-wide policy,
  // while the actual route can still be mounted after global middleware.
  const mcpCors = cors({
    origin: '*',
    credentials: false,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  });

  const removeCredentialedCors: MiddlewareHandler = async (c, next) => {
    await next();
    c.res.headers.delete('Access-Control-Allow-Credentials');
  };

  app.use('/mcp', mcpCors);
  app.use('/mcp/*', mcpCors);
  app.use('/mcp', removeCredentialedCors);
  app.use('/mcp/*', removeCredentialedCors);
}

export function registerMcpEndpoint(app: ApiApp): void {
  app.route('/mcp', mcpRoutes);
}
