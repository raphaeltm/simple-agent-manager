// Re-export Durable Object classes for Cloudflare Workers runtime
export { ProjectData } from './durable-objects/project-data';
export { NodeLifecycle } from './durable-objects/node-lifecycle';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { AppError } from './middleware/error';
import { authRoutes } from './routes/auth';
import { credentialsRoutes } from './routes/credentials';
import { githubRoutes } from './routes/github';
import { workspacesRoutes } from './routes/workspaces';
import { nodesRoutes } from './routes/nodes';
import { terminalRoutes } from './routes/terminal';
import { agentRoutes } from './routes/agent';
import { agentsCatalogRoutes } from './routes/agents-catalog';
import { bootstrapRoutes } from './routes/bootstrap';
import { uiGovernanceRoutes } from './routes/ui-governance';
import { transcribeRoutes } from './routes/transcribe';
import { agentSettingsRoutes } from './routes/agent-settings';
import { clientErrorsRoutes } from './routes/client-errors';
import { projectsRoutes } from './routes/projects';
import { tasksRoutes } from './routes/tasks';
import { chatRoutes } from './routes/chat';
import { activityRoutes } from './routes/activity';
import { taskRunsRoutes } from './routes/task-runs';
import { adminRoutes } from './routes/admin';
import { checkProvisioningTimeouts } from './services/timeout';
import { migrateOrphanedWorkspaces } from './services/workspace-migration';
import { runNodeCleanupSweep } from './scheduled/node-cleanup';
import { recoverStuckTasks } from './scheduled/stuck-tasks';
import { getRuntimeLimits } from './services/limits';
import { recordNodeRoutingMetric } from './services/telemetry';

// Cloudflare bindings type
export interface Env {
  // D1 Database
  DATABASE: D1Database;
  // KV for sessions
  KV: KVNamespace;
  // R2 for VM Agent binaries
  R2: R2Bucket;
  // Workers AI for speech-to-text transcription
  AI: Ai;
  // Durable Objects
  PROJECT_DATA: DurableObjectNamespace;
  NODE_LIFECYCLE: DurableObjectNamespace;
  // Environment variables
  BASE_DOMAIN: string;
  VERSION: string;
  // Secrets
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_SLUG?: string; // GitHub App slug for install URL
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  ENCRYPTION_KEY: string;
  // Pages project name for proxying app.* requests
  PAGES_PROJECT_NAME?: string;
  // Pages project name for proxying www.* requests (marketing site)
  WWW_PAGES_PROJECT_NAME?: string;
  // User approval / invite-only mode
  REQUIRE_APPROVAL?: string;
  // Optional configurable values (per constitution principle XI)
  TERMINAL_TOKEN_EXPIRY_MS?: string;
  CALLBACK_TOKEN_EXPIRY_MS?: string;
  BOOTSTRAP_TOKEN_TTL_SECONDS?: string;
  PROVISIONING_TIMEOUT_MS?: string;
  DNS_TTL_SECONDS?: string;
  // Rate limiting (per hour)
  RATE_LIMIT_WORKSPACE_CREATE?: string;
  RATE_LIMIT_TERMINAL_TOKEN?: string;
  RATE_LIMIT_CREDENTIAL_UPDATE?: string;
  RATE_LIMIT_ANONYMOUS?: string;
  // Hierarchy limits
  MAX_NODES_PER_USER?: string;
  MAX_WORKSPACES_PER_USER?: string;
  MAX_WORKSPACES_PER_NODE?: string;
  MAX_AGENT_SESSIONS_PER_WORKSPACE?: string;
  MAX_PROJECTS_PER_USER?: string;
  MAX_TASKS_PER_PROJECT?: string;
  MAX_TASK_DEPENDENCIES_PER_TASK?: string;
  TASK_LIST_DEFAULT_PAGE_SIZE?: string;
  TASK_LIST_MAX_PAGE_SIZE?: string;
  MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT?: string;
  MAX_PROJECT_RUNTIME_FILES_PER_PROJECT?: string;
  MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES?: string;
  MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES?: string;
  MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH?: string;
  TASK_CALLBACK_TIMEOUT_MS?: string;
  TASK_CALLBACK_RETRY_MAX_ATTEMPTS?: string;
  NODE_HEARTBEAT_STALE_SECONDS?: string;
  NODE_AGENT_READY_TIMEOUT_MS?: string;
  NODE_AGENT_READY_POLL_INTERVAL_MS?: string;
  // Task run configuration (autonomous execution)
  TASK_RUN_NODE_CPU_THRESHOLD_PERCENT?: string;
  TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT?: string;
  TASK_RUN_CLEANUP_DELAY_MS?: string;
  WORKSPACE_READY_TIMEOUT_MS?: string;
  WORKSPACE_READY_POLL_INTERVAL_MS?: string;
  WORKSPACE_READY_MAX_POLL_INTERVAL_MS?: string;
  // Warm node pooling configuration
  NODE_WARM_TIMEOUT_MS?: string;
  MAX_AUTO_NODE_LIFETIME_MS?: string;
  NODE_WARM_GRACE_PERIOD_MS?: string;
  // Task execution timeout (stuck task recovery)
  TASK_RUN_MAX_EXECUTION_MS?: string;
  TASK_STUCK_QUEUED_TIMEOUT_MS?: string;
  TASK_STUCK_DELEGATED_TIMEOUT_MS?: string;
  // ACP configuration (passed to VMs via environment)
  ACP_INIT_TIMEOUT_MS?: string;
  ACP_RECONNECT_DELAY_MS?: string;
  ACP_RECONNECT_TIMEOUT_MS?: string;
  ACP_MAX_RESTART_ATTEMPTS?: string;
  // Boot log configuration
  BOOT_LOG_TTL_SECONDS?: string;
  BOOT_LOG_MAX_ENTRIES?: string;
  // Voice-to-text transcription (Workers AI)
  WHISPER_MODEL_ID?: string;
  MAX_AUDIO_SIZE_BYTES?: string;
  MAX_AUDIO_DURATION_SECONDS?: string;
  RATE_LIMIT_TRANSCRIBE?: string;
  // Client error reporting
  RATE_LIMIT_CLIENT_ERRORS?: string;
  MAX_CLIENT_ERROR_BATCH_SIZE?: string;
  MAX_CLIENT_ERROR_BODY_BYTES?: string;
  // VM agent error reporting
  MAX_VM_AGENT_ERROR_BODY_BYTES?: string;
  MAX_VM_AGENT_ERROR_BATCH_SIZE?: string;
  // Node log configuration (cloud-init journal settings)
  LOG_JOURNAL_MAX_USE?: string;
  LOG_JOURNAL_KEEP_FREE?: string;
  LOG_JOURNAL_MAX_RETENTION?: string;
  // External API timeouts (milliseconds)
  HETZNER_API_TIMEOUT_MS?: string;
  CF_API_TIMEOUT_MS?: string;
  NODE_AGENT_REQUEST_TIMEOUT_MS?: string;
  // Project data DO limits
  MAX_SESSIONS_PER_PROJECT?: string;
  MAX_MESSAGES_PER_SESSION?: string;
  MESSAGE_SIZE_THRESHOLD?: string;
  ACTIVITY_RETENTION_DAYS?: string;
  SESSION_IDLE_TIMEOUT_MINUTES?: string;
  DO_SUMMARY_SYNC_DEBOUNCE_MS?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Global error handler — catches errors from all routes including subrouters.
// Must use app.onError() instead of middleware try/catch because Hono's
// app.route() subrouter errors don't propagate to parent middleware.
app.onError((err, c) => {
  console.error('Request error:', err);

  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.statusCode as any);
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  return c.json(
    {
      error: 'INTERNAL_ERROR',
      message,
    },
    500
  );
});

// Proxy non-API subdomains to their respective Cloudflare Pages deployments.
// The Worker wildcard route *.{domain}/* intercepts ALL subdomains, so we must
// proxy app.* and www.* requests to Pages before any other middleware runs.
// The apex domain is redirected to www.* for the marketing site.
app.use('*', async (c, next) => {
  const hostname = new URL(c.req.url).hostname;
  const baseDomain = c.env?.BASE_DOMAIN || '';
  if (!baseDomain) { await next(); return; }

  // Proxy app.* to web UI Pages project
  if (hostname === `app.${baseDomain}`) {
    const pagesUrl = new URL(c.req.url);
    pagesUrl.hostname = `${c.env.PAGES_PROJECT_NAME || 'sam-web-prod'}.pages.dev`;
    return fetch(new Request(pagesUrl.toString(), c.req.raw));
  }

  // Proxy www.* to marketing site Pages project
  if (hostname === `www.${baseDomain}`) {
    const pagesUrl = new URL(c.req.url);
    pagesUrl.hostname = `${c.env.WWW_PAGES_PROJECT_NAME || 'sam-www'}.pages.dev`;
    return fetch(new Request(pagesUrl.toString(), c.req.raw));
  }

  // Redirect apex domain to www
  if (hostname === baseDomain) {
    const wwwUrl = new URL(c.req.url);
    wwwUrl.hostname = `www.${baseDomain}`;
    return c.redirect(wwwUrl.toString(), 301);
  }

  await next();
});

// Proxy requests for workspace subdomains (ws-{id}.*) to the VM agent.
// The wildcard DNS *.{domain} routes through this Worker, so we must proxy
// workspace requests to the actual VM running the agent on port 8080.
// This handles both HTTP and WebSocket (Upgrade) requests.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const hostname = url.hostname;
  const baseDomain = c.env?.BASE_DOMAIN || '';

  if (!baseDomain || !hostname.startsWith('ws-') || !hostname.endsWith(`.${baseDomain}`)) {
    await next();
    return;
  }

  // Extract workspace ID from subdomain: ws-{id}.{domain} → {id}
  // DNS hostnames are case-insensitive (lowercased), but workspace IDs (ULIDs) are uppercase.
  const subdomain = hostname.replace(`.${baseDomain}`, '');
  const workspaceId = subdomain.replace(/^ws-/, '').toUpperCase();

  if (!workspaceId) {
    return c.json({ error: 'INVALID_WORKSPACE', message: 'Invalid workspace subdomain' }, 400);
  }

  // Look up workspace routing metadata from D1.
  const db = drizzle(c.env.DATABASE, { schema });
  const workspace = await db
    .select({
      nodeId: schema.workspaces.nodeId,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();

  if (!workspace) {
    return c.json({ error: 'NOT_FOUND', message: 'Workspace not found' }, 404);
  }

  if (workspace.status !== 'running' && workspace.status !== 'recovery') {
    // Allow boot-log WebSocket during creation for real-time streaming
    if (workspace.status === 'creating' && url.pathname === '/boot-log/ws') {
      // Fall through to proxy
    } else {
      return c.json({ error: 'NOT_READY', message: `Workspace is ${workspace.status}` }, 503);
    }
  }

  // Proxy to the VM agent via its DNS-only backend hostname.
  // Cloudflare Workers cannot fetch IP addresses directly (Error 1003),
  // so we use the vm-{id}.{domain} hostname which resolves directly to the VM IP.
  const routedNodeId = (workspace.nodeId || workspaceId).toLowerCase();
  const backendHostname = `vm-${routedNodeId}.${baseDomain}`;
  console.log(JSON.stringify({
    event: 'ws_proxy_route',
    workspaceId,
    nodeId: workspace.nodeId || workspaceId,
    backendHostname,
    method: c.req.raw.method,
    path: url.pathname,
  }));
  recordNodeRoutingMetric({
    metric: 'ws_proxy_route',
    nodeId: workspace.nodeId || workspaceId,
    workspaceId,
  }, c.env);
  const vmUrl = new URL(c.req.url);
  vmUrl.protocol = 'http:';
  vmUrl.hostname = backendHostname;
  vmUrl.port = '8080';

  // Strip client-supplied routing headers and inject trusted routing context.
  const headers = new Headers(c.req.raw.headers);
  headers.delete('x-sam-node-id');
  headers.delete('x-sam-workspace-id');
  headers.set('X-SAM-Node-Id', (workspace.nodeId || workspaceId));
  headers.set('X-SAM-Workspace-Id', workspaceId);

  return fetch(vmUrl.toString(), {
    method: c.req.raw.method,
    headers,
    body: c.req.raw.body,
    // @ts-expect-error — Cloudflare Workers support duplex for streaming request bodies
    duplex: c.req.raw.body ? 'half' : undefined,
  });
});

// Structured request/response logging middleware.
// Emits one JSON log per request with method, path, status, and duration.
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const durationMs = Date.now() - start;
  const path = new URL(c.req.url).pathname;
  // Skip noisy health checks from structured logs
  if (path === '/health') return;
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'http.request',
    method: c.req.method,
    path,
    status: c.res.status,
    durationMs,
  }));
});

// Hono built-in logger (kept for dev convenience, can be removed in production)
app.use('*', logger());
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
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Health check
app.get('/health', (c) => {
  const limits = getRuntimeLimits(c.env);
  return c.json({
    status: 'healthy',
    version: c.env.VERSION,
    timestamp: new Date().toISOString(),
    limits,
  });
});

// JWKS endpoint (must be at root level)
// Add cache headers per constitution principle XI
app.get('/.well-known/jwks.json', async (c) => {
  const { getJWKS } = await import('./services/jwt');
  const jwks = await getJWKS(c.env);
  c.header('Cache-Control', 'public, max-age=3600');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.json(jwks);
});

// API routes
app.route('/api/auth', authRoutes);
app.route('/api/credentials', credentialsRoutes);
app.route('/api/github', githubRoutes);
app.route('/api/nodes', nodesRoutes);
app.route('/api/workspaces', workspacesRoutes);
app.route('/api/terminal', terminalRoutes);
app.route('/api/agent', agentRoutes);
app.route('/api/agents', agentsCatalogRoutes);
app.route('/api/bootstrap', bootstrapRoutes);
app.route('/api/ui-governance', uiGovernanceRoutes);
app.route('/api/transcribe', transcribeRoutes);
app.route('/api/agent-settings', agentSettingsRoutes);
app.route('/api/client-errors', clientErrorsRoutes);
app.route('/api/projects', projectsRoutes);
app.route('/api/projects/:projectId/tasks', tasksRoutes);
app.route('/api/projects/:projectId/sessions', chatRoutes);
app.route('/api/projects/:projectId/activity', activityRoutes);
app.route('/api/projects/:projectId/tasks', taskRunsRoutes);
app.route('/api/admin', adminRoutes);

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
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'cron.started',
    }));

    // Check for stuck provisioning workspaces
    const timedOut = await checkProvisioningTimeouts(env.DATABASE);

    // Migrate orphaned workspaces (those with NULL projectId) to projects
    const db = drizzle(env.DATABASE, { schema });
    const migrated = await migrateOrphanedWorkspaces(db);

    // Clean up stale warm nodes and expired auto-provisioned nodes
    const nodeCleanup = await runNodeCleanupSweep(env);

    // Recover stuck tasks (queued/delegated/in_progress past timeout)
    const stuckTasks = await recoverStuckTasks(env);

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'cron.completed',
      provisioningTimedOut: timedOut,
      workspacesMigrated: migrated,
      staleNodesDestroyed: nodeCleanup.staleDestroyed,
      lifetimeNodesDestroyed: nodeCleanup.lifetimeDestroyed,
      nodeCleanupErrors: nodeCleanup.errors,
      stuckTasksFailedQueued: stuckTasks.failedQueued,
      stuckTasksFailedDelegated: stuckTasks.failedDelegated,
      stuckTasksFailedInProgress: stuckTasks.failedInProgress,
      stuckTaskErrors: stuckTasks.errors,
    }));
  },
};
