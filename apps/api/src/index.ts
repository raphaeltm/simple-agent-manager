import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { errorHandler } from './middleware/error';
import { authRoutes } from './routes/auth';
import { credentialsRoutes } from './routes/credentials';
import { githubRoutes } from './routes/github';
import { workspacesRoutes } from './routes/workspaces';
import { terminalRoutes } from './routes/terminal';
import { agentRoutes } from './routes/agent';
import { bootstrapRoutes } from './routes/bootstrap';
import { checkProvisioningTimeouts } from './services/timeout';

// Cloudflare bindings type
export interface Env {
  // D1 Database
  DATABASE: D1Database;
  // KV for sessions
  KV: KVNamespace;
  // R2 for VM Agent binaries
  R2: R2Bucket;
  // Environment variables
  BASE_DOMAIN: string;
  VERSION: string;
  // Secrets
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  ENCRYPTION_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', errorHandler());
app.use('*', cors({
  origin: (origin, c) => {
    const baseDomain = c.env?.BASE_DOMAIN || '';
    // Allow localhost for development
    if (origin?.includes('localhost')) return origin;
    // Allow same domain and subdomains
    if (origin?.includes(baseDomain)) return origin;
    return origin;
  },
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    version: c.env.VERSION,
    timestamp: new Date().toISOString(),
  });
});

// JWKS endpoint (must be at root level)
app.get('/.well-known/jwks.json', async (c) => {
  const { getJWKS } = await import('./services/jwt');
  const jwks = await getJWKS(c.env);
  return c.json(jwks);
});

// API routes
app.route('/api/auth', authRoutes);
app.route('/api/credentials', credentialsRoutes);
app.route('/api/github', githubRoutes);
app.route('/api/workspaces', workspacesRoutes);
app.route('/api/terminal', terminalRoutes);
app.route('/api/agent', agentRoutes);
app.route('/api/bootstrap', bootstrapRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({
    error: 'NOT_FOUND',
    message: 'Endpoint not found',
  }, 404);
});

// Export handler with scheduled (cron) support
export default {
  fetch: app.fetch,

  /**
   * Scheduled (cron) handler for background tasks.
   * Runs every 5 minutes (configured in wrangler.toml).
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log('Cron triggered:', new Date().toISOString());

    // Check for stuck provisioning workspaces
    const timedOut = await checkProvisioningTimeouts(env.DATABASE);

    console.log(`Cron completed: ${timedOut} workspace(s) timed out`);
  },
};
