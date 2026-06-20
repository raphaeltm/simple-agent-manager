import { Hono } from 'hono';

import type { Env } from '../env';
import { registerErrorHandling, registerNotFound } from './errors';
import { registerMcpCorsPolicy, registerMcpEndpoint } from './mcp';
import { registerGlobalMiddleware } from './middleware';
import { registerPagesProxy } from './pages-proxy';
import { registerPublicRoutes } from './public-routes';
import { registerApiRoutes } from './register-routes';
import type { ApiApp } from './types';
import { registerWellKnownRoutes } from './well-known';
import { registerWorkspaceProxy } from './workspace-proxy';

export function createApiApp(): ApiApp {
  const app = new Hono<{ Bindings: Env }>();

  registerErrorHandling(app);
  registerPagesProxy(app);
  registerWorkspaceProxy(app);
  registerMcpCorsPolicy(app);
  registerGlobalMiddleware(app);
  registerPublicRoutes(app);
  registerWellKnownRoutes(app);
  registerApiRoutes(app);
  registerMcpEndpoint(app);
  registerNotFound(app);

  return app;
}
