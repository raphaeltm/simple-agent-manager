// Re-export Durable Object classes for Cloudflare Workers runtime
export { AdminLogs } from './durable-objects/admin-logs';
export { CodexRefreshLock } from './durable-objects/codex-refresh-lock';
export { NodeLifecycle } from './durable-objects/node-lifecycle';
export { NotificationService } from './durable-objects/notification';
export { ProjectData } from './durable-objects/project-data';
export { TaskRunner } from './durable-objects/task-runner';
export { TrialCounter } from './durable-objects/trial-counter';
export type { Env } from './env';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import * as schema from './db/schema';
import type { Env } from './env';
import { log, serializeError } from './lib/logger';
import { parseWorkspaceSubdomain } from './lib/workspace-subdomain';
import { analyticsMiddleware } from './middleware/analytics';
import { AppError } from './middleware/error';
import { accountMapRoutes } from './routes/account-map';
import { activityRoutes } from './routes/activity';
import { adminRoutes } from './routes/admin';
import { adminAnalyticsRoutes } from './routes/admin-analytics';
import { adminPlatformCredentialRoutes } from './routes/admin-platform-credentials';
import { adminQuotaRoutes } from './routes/admin-quotas';
import { adminUsageRoutes } from './routes/admin-usage';
import { agentRoutes } from './routes/agent';
import { agentProfileRoutes } from './routes/agent-profiles';
import { agentSettingsRoutes } from './routes/agent-settings';
import { agentsCatalogRoutes } from './routes/agents-catalog';
import { aiProxyRoutes } from './routes/ai-proxy';
import { analyticsIngestRoutes } from './routes/analytics-ingest';
import { authRoutes } from './routes/auth';
import { bootstrapRoutes } from './routes/bootstrap';
import { cachedCommandRoutes } from './routes/cached-commands';
import { chatRoutes } from './routes/chat';
import { clientErrorsRoutes } from './routes/client-errors';
import { codexRefreshRoutes } from './routes/codex-refresh';
import { credentialsRoutes } from './routes/credentials';
import { dashboardRoutes } from './routes/dashboard';
import { gcpRoutes } from './routes/gcp';
import { githubRoutes } from './routes/github';
import { googleAuthRoutes } from './routes/google-auth';
import { knowledgeRoutes } from './routes/knowledge';
import { libraryRoutes } from './routes/library';
import { mcpRoutes } from './routes/mcp';
import { nodeLifecycleRoutes } from './routes/node-lifecycle';
import { nodesRoutes } from './routes/nodes';
import { notificationRoutes } from './routes/notifications';
import { deploymentIdentityTokenRoute,gcpDeployCallbackRoute, projectDeploymentRoutes } from './routes/project-deployment';
import { projectsRoutes } from './routes/projects';
import { nodeAcpHeartbeatRoute } from './routes/projects/node-acp-heartbeat';
import { providersRoutes } from './routes/providers';
import { smokeTestTokenRoutes } from './routes/smoke-test-tokens';
import { tasksRoutes } from './routes/tasks';
import { terminalRoutes } from './routes/terminal';
import { transcribeRoutes } from './routes/transcribe';
import { trialRoutes } from './routes/trial';
import { trialOnboardingRoutes } from './routes/trial/index';
import { triggersRoutes } from './routes/triggers';
import { ttsRoutes } from './routes/tts';
import { uiGovernanceRoutes } from './routes/ui-governance';
import { usageRoutes } from './routes/usage';
import { workspacesRoutes } from './routes/workspaces';
import { runAnalyticsForwardJob } from './scheduled/analytics-forward';
import { runComputeUsageCleanup } from './scheduled/compute-usage-cleanup';
import { runCronTriggerSweep } from './scheduled/cron-triggers';
import { runNodeCleanupSweep } from './scheduled/node-cleanup';
import { runObservabilityPurge } from './scheduled/observability-purge';
import { recoverStuckTasks } from './scheduled/stuck-tasks';
import { runTriggerExecutionCleanup } from './scheduled/trigger-execution-cleanup';
import { GcpApiError, sanitizeGcpError } from './services/gcp-errors';
import { signTerminalToken } from './services/jwt';
import { recordNodeRoutingMetric } from './services/telemetry';
import { checkProvisioningTimeouts } from './services/timeout';
import { migrateOrphanedWorkspaces } from './services/workspace-migration';

const app = new Hono<{ Bindings: Env }>();

// Global error handler — catches errors from all routes including subrouters.
// Must use app.onError() instead of middleware try/catch because Hono's
// app.route() subrouter errors don't propagate to parent middleware.
app.onError((err, c) => {
  log.error('request_error', serializeError(err));

  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
  }

  // Defense-in-depth: sanitize GcpApiError if it escapes route-level catch blocks
  if (err instanceof GcpApiError) {
    const safe = sanitizeGcpError(err, 'global-handler');
    return c.json({ error: 'GCP_UPSTREAM_ERROR', message: safe }, 502);
  }

  return c.json(
    {
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
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
// workspace requests to the actual VM running the agent on the configured port.
// vm-{id} DNS records are orange-clouded; CF edge terminates TLS and re-encrypts
// to the VM agent's Origin CA cert. This handles both HTTP and WebSocket requests.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const hostname = url.hostname;
  const baseDomain = c.env?.BASE_DOMAIN || '';

  // Parse workspace ID and optional port from subdomain.
  const parsed = parseWorkspaceSubdomain(hostname, baseDomain);
  if (!parsed) {
    await next();
    return;
  }
  if ('error' in parsed) {
    log.info('ws_proxy_invalid_subdomain', { hostname, reason: parsed.error });
    return c.json({ error: 'INVALID_WORKSPACE', message: 'Invalid workspace subdomain' }, 400);
  }
  const { workspaceId, targetPort } = parsed;

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

  // Proxy to the VM agent via its proxied (orange-clouded) backend hostname.
  // Cloudflare Workers cannot fetch IP addresses directly (Error 1003),
  // so we use the {id}.vm.{domain} hostname. The two-level subdomain bypasses
  // the wildcard Worker route *.{domain}/* (which only matches one level).
  const routedNodeId = (workspace.nodeId || workspaceId).toLowerCase();
  const backendHostname = `${routedNodeId}.vm.${baseDomain}`;
  log.info('ws_proxy_route', {
    workspaceId,
    nodeId: workspace.nodeId || workspaceId,
    backendHostname,
    targetPort,
    method: c.req.raw.method,
    path: url.pathname,
  });
  recordNodeRoutingMetric({
    metric: 'ws_proxy_route',
    nodeId: workspace.nodeId || workspaceId,
    workspaceId,
  }, c.env);
  const vmAgentProtocol = c.env.VM_AGENT_PROTOCOL || 'https';
  const vmAgentPort = c.env.VM_AGENT_PORT || '8443';
  const vmUrl = new URL(c.req.url);
  vmUrl.protocol = `${vmAgentProtocol}:`;
  vmUrl.hostname = backendHostname;
  vmUrl.port = vmAgentPort;

  // Route port-specific requests to the VM agent's port proxy endpoint.
  // ws-{id}--3000.example.com/foo → {backend}/workspaces/{id}/ports/3000/foo
  if (targetPort !== null) {
    const subPath = url.pathname === '/' ? '' : url.pathname;
    vmUrl.pathname = `/workspaces/${workspaceId}/ports/${targetPort}${subPath}`;

    // Inject a workspace-scoped JWT so the VM agent can authenticate this request.
    // Port-forwarded URLs are accessed directly by browsers which have no pre-existing
    // workspace session cookie or token. The Worker is a trusted intermediary that has
    // already validated the workspace exists and is running.
    try {
      const { token } = await signTerminalToken('port-proxy', workspaceId, c.env);
      vmUrl.searchParams.set('token', token);
    } catch (err) {
      log.error('port_proxy_token_error', {
        workspaceId,
        ...serializeError(err),
      });
      return c.json({ error: 'TOKEN_ERROR', message: 'Failed to generate port proxy token' }, 500);
    }
  }

  // Strip client-supplied routing headers and inject trusted routing context.
  const headers = new Headers(c.req.raw.headers);
  headers.delete('x-sam-node-id');
  headers.delete('x-sam-workspace-id');
  headers.delete('x-forwarded-host');
  headers.set('X-SAM-Node-Id', (workspace.nodeId || workspaceId));
  headers.set('X-SAM-Workspace-Id', workspaceId);

  // Preserve the original client-facing hostname (e.g., ws-abc123--3000.example.com)
  // so the VM agent can forward it to container services. The fetch() to the VM agent
  // rewrites the Host header to the VM hostname for Cloudflare edge routing, losing
  // the original. X-Forwarded-Proto is always https since clients connect via CF edge.
  headers.set('X-Forwarded-Host', hostname);
  headers.set('X-Forwarded-Proto', 'https');

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
  log.info('http.request', {
    method: c.req.method,
    path,
    status: c.res.status,
    durationMs,
  });
});

// Analytics Engine — writes one data point per request (non-blocking, fire-and-forget)
app.use('*', analyticsMiddleware());

app.use('*', cors({
  origin: (origin, c) => {
    if (!origin) return null;
    const baseDomain = c.env?.BASE_DOMAIN || '';
    // Allow localhost only in development (BASE_DOMAIN contains 'localhost' or is empty)
    const isDevEnvironment = !baseDomain || baseDomain.includes('localhost');
    try {
      const url = new URL(origin);
      if (isDevEnvironment && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return origin;
    } catch {
      // Malformed origin — reject
      return null;
    }
    // Allow subdomains of the configured BASE_DOMAIN (e.g., app.example.com, api.example.com)
    if (baseDomain) {
      try {
        const url = new URL(origin);
        if (url.hostname === baseDomain || url.hostname.endsWith(`.${baseDomain}`)) return origin;
      } catch {
        return null;
      }
    }
    // Reject all other origins — returning null prevents Access-Control-Allow-Origin
    // from being set, which blocks credentialed cross-origin requests from unknown sites.
    return null;
  },
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Health check — public endpoint returns minimal info only
app.get('/health', (c) => {
  // Check critical bindings to determine status, but don't expose details
  const hasCriticalBindings = !!(
    c.env.DATABASE &&
    c.env.KV &&
    c.env.PROJECT_DATA &&
    c.env.NODE_LIFECYCLE &&
    c.env.TASK_RUNNER
  );

  return c.json({
    status: hasCriticalBindings ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
  }, hasCriticalBindings ? 200 : 503);
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

// OIDC Discovery endpoint — used by GCP Workload Identity Federation to verify SAM as an IdP
app.get('/.well-known/openid-configuration', async (c) => {
  const { getOidcDiscovery } = await import('./services/jwt');
  const discovery = getOidcDiscovery(c.env);
  c.header('Cache-Control', 'public, max-age=3600');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.json(discovery);
});

// API routes — codex refresh and smoke test routes registered before BetterAuth catch-all.
// codexRefreshRoutes uses workspace callback token auth (query param), not session auth.
// smokeTestTokenRoutes uses dedicated smoke test token auth, not session auth.
// Both must be mounted before authRoutes to avoid BetterAuth's wildcard catch-all.
app.route('/api/auth', codexRefreshRoutes);
app.route('/api/auth', smokeTestTokenRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/credentials', credentialsRoutes);
app.route('/api/providers', providersRoutes);
app.route('/api/github', githubRoutes);
app.route('/api/nodes', nodesRoutes);
app.route('/api/nodes', nodeLifecycleRoutes);
app.route('/api/workspaces', workspacesRoutes);
app.route('/api/terminal', terminalRoutes);
app.route('/api/agent', agentRoutes);
app.route('/api/agents', agentsCatalogRoutes);
app.route('/api/bootstrap', bootstrapRoutes);
app.route('/api/ui-governance', uiGovernanceRoutes);
app.route('/api/transcribe', transcribeRoutes);
app.route('/api/tts', ttsRoutes);
app.route('/api/agent-settings', agentSettingsRoutes);
app.route('/api/client-errors', clientErrorsRoutes);
app.route('/api/t', analyticsIngestRoutes);
// ORDERING IS CRITICAL: Routes using callback JWT auth MUST be mounted before
// projectsRoutes. projectsRoutes has use('/*', requireAuth()) which leaks to
// all siblings at the same base path — mounting these routes first causes them
// to match and return before the session auth middleware runs.
// See docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md
// See .claude/rules/06-api-patterns.md (Hono middleware scoping)
app.route('/api/projects', deploymentIdentityTokenRoute);
app.route('/api/projects', nodeAcpHeartbeatRoute);
app.route('/api/projects', projectsRoutes);
app.route('/api/projects/:projectId/tasks', tasksRoutes);
app.route('/api/projects/:projectId/sessions', chatRoutes);
app.route('/api/projects/:projectId/cached-commands', cachedCommandRoutes);
app.route('/api/projects/:projectId/activity', activityRoutes);
app.route('/api/projects/:projectId/library', libraryRoutes);
app.route('/api/projects/:projectId/agent-profiles', agentProfileRoutes);
app.route('/api/projects/:projectId/triggers', triggersRoutes);
app.route('/api/projects/:projectId/knowledge', knowledgeRoutes);
app.route('/api/projects', projectDeploymentRoutes);
app.route('/api/deployment', gcpDeployCallbackRoute);
app.route('/api/admin', adminRoutes);
app.route('/api/admin/analytics', adminAnalyticsRoutes);
app.route('/api/admin/platform-credentials', adminPlatformCredentialRoutes);
app.route('/api/admin/quotas', adminQuotaRoutes);
app.route('/api/admin/usage', adminUsageRoutes);
app.route('/api/usage', usageRoutes);
app.route('/api/account-map', accountMapRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api', trialRoutes);
app.route('/api/trial', trialOnboardingRoutes);
app.route('/api/gcp', gcpRoutes);
app.route('/ai/v1', aiProxyRoutes);
app.route('/auth/google', googleAuthRoutes);
// MCP endpoint CORS override — MCP uses Bearer token auth (not cookies/sessions),
// so it needs credentials: false + origin: '*' to allow VM agent requests from any origin.
// This must run after the global CORS middleware to overwrite its headers.
app.use('/mcp/*', cors({
  origin: '*',
  credentials: false,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
}));
// Explicitly remove Access-Control-Allow-Credentials set by the global CORS middleware.
// origin: '*' + credentials: true is invalid in the CORS spec and browsers reject it.
app.use('/mcp/*', async (c, next) => {
  await next();
  c.res.headers.delete('Access-Control-Allow-Credentials');
});
// MCP server endpoint — at /mcp (not /api/mcp) because VM agents use this URL
// and it uses its own task-scoped Bearer token auth, not session auth.
app.route('/mcp', mcpRoutes);

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
   * Two cron schedules:
   * - Every 5 minutes: operational cleanup (provisioning, nodes, tasks, observability)
   * - Daily at 03:00 UTC: analytics event forwarding to external platforms
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const isDailyForward = controller.cron === '0 3 * * *';

    log.info('cron.started', {
      cron: controller.cron,
      type: isDailyForward ? 'daily-forward' : 'sweep',
    });

    // Daily analytics forwarding (Phase 4) — use ctx.waitUntil to keep the
    // isolate alive for the full duration of multi-step external API calls.
    if (isDailyForward) {
      ctx.waitUntil((async () => {
        const forward = await runAnalyticsForwardJob(env);
        log.info('cron.completed', {
          cron: controller.cron,
          type: 'daily-forward',
          forwardEnabled: forward.enabled,
          forwardEventsQueried: forward.eventsQueried,
          forwardSegmentSent: forward.segment.sent,
          forwardGA4Sent: forward.ga4.sent,
          forwardCursorUpdated: forward.cursorUpdated,
        });
      })());
      return;
    }

    // 5-minute operational sweep
    // Check for stuck provisioning workspaces
    const timedOut = await checkProvisioningTimeouts(env.DATABASE, env, env.OBSERVABILITY_DATABASE);

    // Migrate orphaned workspaces (those with NULL projectId) to projects
    const db = drizzle(env.DATABASE, { schema });
    const migrated = await migrateOrphanedWorkspaces(db);

    // Clean up stale warm nodes and expired auto-provisioned nodes
    const nodeCleanup = await runNodeCleanupSweep(env);

    // Recover stuck tasks (queued/delegated/in_progress past timeout)
    const stuckTasks = await recoverStuckTasks(env);

    // Purge expired observability errors (retention + row count limits)
    const observabilityPurge = await runObservabilityPurge(env);

    // Fire due cron triggers
    const cronTriggers = await runCronTriggerSweep(env);

    // Recover stale trigger executions and purge old logs
    const triggerCleanup = await runTriggerExecutionCleanup(env);

    // Close orphaned compute_usage records
    const computeUsageClosed = await runComputeUsageCleanup(env);

    log.info('cron.completed', {
      cron: controller.cron,
      type: 'sweep',
      provisioningTimedOut: timedOut,
      workspacesMigrated: migrated,
      staleNodesDestroyed: nodeCleanup.staleDestroyed,
      lifetimeNodesDestroyed: nodeCleanup.lifetimeDestroyed,
      lifetimeNodesSkipped: nodeCleanup.lifetimeSkipped,
      nodeCleanupErrors: nodeCleanup.errors,
      orphanedWorkspacesFlagged: nodeCleanup.orphanedWorkspacesFlagged,
      orphanedNodesFlagged: nodeCleanup.orphanedNodesFlagged,
      stuckTasksFailedQueued: stuckTasks.failedQueued,
      stuckTasksFailedDelegated: stuckTasks.failedDelegated,
      stuckTasksFailedInProgress: stuckTasks.failedInProgress,
      stuckTasksHeartbeatSkipped: stuckTasks.heartbeatSkipped,
      stuckTaskErrors: stuckTasks.errors,
      stuckTaskDoHealthChecked: stuckTasks.doHealthChecked,
      observabilityPurgedByAge: observabilityPurge.deletedByAge,
      observabilityPurgedByCount: observabilityPurge.deletedByCount,
      cronTriggersChecked: cronTriggers.checked,
      cronTriggersFired: cronTriggers.fired,
      cronTriggersSkipped: cronTriggers.skipped,
      cronTriggersFailed: cronTriggers.failed,
      triggerExecStaleRecovered: triggerCleanup.staleRecovered,
      triggerExecStaleQueuedRecovered: triggerCleanup.staleQueuedRecovered,
      triggerExecRetentionPurged: triggerCleanup.retentionPurged,
      triggerExecCleanupErrors: triggerCleanup.errors,
      computeUsageOrphansClosed: computeUsageClosed,
    });
  },
};
