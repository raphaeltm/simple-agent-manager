// Re-export Durable Object classes for Cloudflare Workers runtime
export { AdminLogs } from './durable-objects/admin-logs';
export { AiTokenBudgetCounter } from './durable-objects/ai-token-budget-counter';
// Sandbox SDK DO class — retained for experimental toolbox/diagnostics use only.
export { CodexRefreshLock } from './durable-objects/codex-refresh-lock';
export { CredentialSetupSession } from './durable-objects/credential-setup-session';
export { GitHubUserAccessTokenLock } from './durable-objects/github-user-access-token-lock';
export { GitLabUserAccessTokenLock } from './durable-objects/gitlab-user-access-token-lock';
export { NodeLifecycle } from './durable-objects/node-lifecycle';
export { NotificationService } from './durable-objects/notification';
export { ProjectAgent } from './durable-objects/project-agent';
export { ProjectData } from './durable-objects/project-data';
export { ProjectOrchestrator } from './durable-objects/project-orchestrator';
export { SamSession } from './durable-objects/sam-session';
export { SetupSessionPool } from './durable-objects/setup-session-pool';
export { TaskRunner } from './durable-objects/task-runner';
export { TrialCounter } from './durable-objects/trial-counter';
export { TrialEventBus } from './durable-objects/trial-event-bus';
export { TrialOrchestrator } from './durable-objects/trial-orchestrator';
export { VmAgentContainer } from './durable-objects/vm-agent-container';
export type { Env } from './env';
export { Sandbox as SandboxDO } from '@cloudflare/sandbox';

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { createAuth } from './auth';
import * as schema from './db/schema';
import type { Env } from './env';
import { resolveCredentialedCorsOrigin } from './lib/cors-origin';
import { log, serializeError } from './lib/logger';
import { resolvePagesProxyTarget } from './lib/pages-proxy';
import { parseWorkspaceSubdomain } from './lib/workspace-subdomain';
import { analyticsMiddleware } from './middleware/analytics';
import { AppError } from './middleware/error';
import { accountMapRoutes } from './routes/account-map';
import { activityRoutes } from './routes/activity';
import { adminRoutes } from './routes/admin';
import { adminAiAllowanceRoutes } from './routes/admin-ai-allowance';
import { adminAIProxyRoutes } from './routes/admin-ai-proxy';
import { adminAiUsageRoutes } from './routes/admin-ai-usage';
import { adminAnalyticsRoutes } from './routes/admin-analytics';
import { adminCcBackfillRoutes } from './routes/admin-cc-backfill';
import { adminCostRoutes } from './routes/admin-costs';
import { adminGithubInstallationLeakSweepRoutes } from './routes/admin-github-installation-leak-sweep';
import { adminGithubRepoIdBackfillRoutes } from './routes/admin-github-repo-id-backfill';
import { adminPlatformConfigRoutes } from './routes/admin-platform-config';
import { adminPlatformCredentialRoutes } from './routes/admin-platform-credentials';
import { adminQuotaRoutes } from './routes/admin-quotas';
import { adminSandboxRoutes } from './routes/admin-sandbox';
import { adminTrialsRoutes } from './routes/admin-trials';
import { adminUsageRoutes } from './routes/admin-usage';
import { agentRoutes } from './routes/agent';
import { agentProfileRoutes } from './routes/agent-profiles';
import { agentSettingsRoutes } from './routes/agent-settings';
import { agentsCatalogRoutes } from './routes/agents-catalog';
import { aiProxyRoutes } from './routes/ai-proxy';
import { aiProxyAnthropicRoutes } from './routes/ai-proxy-anthropic';
import { aiProxyPassthroughRoutes } from './routes/ai-proxy-passthrough';
import { analyticsIngestRoutes } from './routes/analytics-ingest';
import { apiTokenRoutes } from './routes/api-tokens';
import { authRoutes } from './routes/auth';
import { bootstrapRoutes } from './routes/bootstrap';
import { cachedCommandRoutes } from './routes/cached-commands';
import { chatRoutes } from './routes/chat';
import { chatStartRoutes } from './routes/chat-start';
import { chatsRoutes } from './routes/chats';
import { cliRoutes } from './routes/cli';
import { clientErrorsRoutes } from './routes/client-errors';
import { codexRefreshRoutes } from './routes/codex-refresh';
import { ccRoutes } from './routes/composable-credentials';
import { agentCredentialSetupSessionsRoutes } from './routes/agent-credential-setup-sessions';
import { credentialsRoutes } from './routes/credentials';
import { dashboardRoutes } from './routes/dashboard';
import { deployReleaseCallbackRoute } from './routes/deploy-release-callback';
import { deploymentCustomDomainRoutes } from './routes/deployment-custom-domains';
import { deploymentEnvironmentConfigRoutes } from './routes/deployment-environment-config';
import { deploymentEnvironmentRoutes } from './routes/deployment-environments';
import { deploymentReleaseEventsCallbackRoute } from './routes/deployment-release-events-callback';
import { deploymentReleaseRoutes } from './routes/deployment-releases';
import { deploymentSecretRoutes } from './routes/deployment-secrets';
import { deploymentVolumeRoutes } from './routes/deployment-volumes';
import { deviceFlowRoutes } from './routes/device-flow';
import { gcpRoutes } from './routes/gcp';
import { githubRoutes } from './routes/github';
import { gitlabRoutes } from './routes/gitlab';
import { googleAuthRoutes } from './routes/google-auth';
import { knowledgeRoutes } from './routes/knowledge';
import { libraryRoutes } from './routes/library';
import { mailboxRoutes } from './routes/mailbox';
import { mcpRoutes } from './routes/mcp';
import { missionRoutes } from './routes/missions';
import { modelCatalogRoutes } from './routes/model-catalog';
import { nodeLifecycleRoutes } from './routes/node-lifecycle';
import { nodesRoutes } from './routes/nodes';
import { notificationRoutes } from './routes/notifications';
import { observabilityIngestRoutes } from './routes/observability-ingest';
import { orchestratorRoutes } from './routes/orchestrator';
import { policyRoutes } from './routes/policies';
import { profileRuntimeRoutes } from './routes/profile-runtime';
import { projectAgentRoutes } from './routes/project-agent';
import {
  deploymentIdentityTokenRoute,
  gcpDeployCallbackRoute,
  projectDeploymentRoutes,
} from './routes/project-deployment';
import { projectsRoutes } from './routes/projects';
import { agentActivityCallbackRoute } from './routes/projects/agent-activity-callback';
import { composeImageArtifactsCallbackRoute } from './routes/projects/compose-image-artifacts-callback';
import { composePublishReleaseCallbackRoute } from './routes/projects/compose-publish-release-callback';
import { deploymentPublishJobCallbackRoute } from './routes/projects/deployment-publish-job-callback';
import { nodeAcpHeartbeatRoute } from './routes/projects/node-acp-heartbeat';
import { registryPushCredentialsCallbackRoute } from './routes/projects/registry-push-credentials-callback';
import { providersRoutes } from './routes/providers';
import { resolutionStatusRoute } from './routes/resolution-status';
import { samRoutes } from './routes/sam';
import { setupRoutes } from './routes/setup';
import { skillRuntimeRoutes } from './routes/skill-runtime';
import { skillRoutes } from './routes/skills';
import { taskCallbackRoute, tasksRoutes } from './routes/tasks';
import { terminalRoutes } from './routes/terminal';
import { transcribeRoutes } from './routes/transcribe';
import { trialRoutes } from './routes/trial';
import { trialOnboardingRoutes } from './routes/trial/index';
import { triggerWebhookRoutes } from './routes/trigger-webhooks';
import { triggersRoutes } from './routes/triggers';
import { ttsRoutes } from './routes/tts';
import { uiGovernanceRoutes } from './routes/ui-governance';
import { usageRoutes } from './routes/usage';
import { workspacesRoutes } from './routes/workspaces';
import { runAnalyticsForwardJob } from './scheduled/analytics-forward';
import { runScheduledComposeImageArtifactCleanup } from './scheduled/compose-image-artifact-cleanup';
import { runComputeUsageCleanup } from './scheduled/compute-usage-cleanup';
import { runCronTriggerSweep } from './scheduled/cron-triggers';
import { runNodeCleanupSweep } from './scheduled/node-cleanup';
import { runObservabilityPurge } from './scheduled/observability-purge';
import { runSessionTaskReconciliation } from './scheduled/session-task-reconciliation';
import { runSetupSessionSweep } from './scheduled/setup-session-sweep';
import { recoverStuckTasks } from './scheduled/stuck-tasks';
import { runTrialExpireSweep } from './scheduled/trial-expire';
import { runTrialRolloverAudit } from './scheduled/trial-rollover';
import { runTrialWaitlistCleanup } from './scheduled/trial-waitlist-cleanup';
import { runTriggerExecutionCleanup } from './scheduled/trigger-execution-cleanup';
import { runMonthlyCostAggregation } from './services/ai-monthly-cost-cron';
import { GcpApiError, sanitizeGcpError } from './services/gcp-errors';
import { signTerminalToken, verifyPortAccessToken, verifyTerminalToken } from './services/jwt';
import { recordNodeRoutingMetric } from './services/telemetry';
import { checkProvisioningTimeouts } from './services/timeout';
import { fetchVmAgentContainer, getVmAgentContainerConfig } from './services/vm-agent-container';
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
  if (!baseDomain) {
    await next();
    return;
  }

  const pagesTarget = resolvePagesProxyTarget(hostname, {
    baseDomain,
    appPagesProjectName: c.env.PAGES_PROJECT_NAME,
    wwwPagesProjectName: c.env.WWW_PAGES_PROJECT_NAME,
  });

  if (pagesTarget.type === 'missing-config') {
    return c.text(pagesTarget.message, 503);
  }

  if (pagesTarget.type === 'proxy') {
    const pagesUrl = new URL(c.req.url);
    pagesUrl.hostname = pagesTarget.hostname;
    return fetch(new Request(pagesUrl.toString(), c.req.raw));
  }

  if (pagesTarget.type === 'redirect') {
    const wwwUrl = new URL(c.req.url);
    wwwUrl.hostname = pagesTarget.hostname;
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

  // --- Port-access authentication (cookie + token handshake) ---
  // For port-specific subdomains (ws-{id}--{port}), check the port-access cookie
  // and ?port_token= query param BEFORE the normal session/terminal-token paths.
  // This is necessary because BetterAuth cookies are scoped to api.{BASE_DOMAIN}
  // and are NOT sent to ws-{id}--{port}.{BASE_DOMAIN} subdomains.
  let userId: string | null = null;
  let portAccessRedirect: Response | null = null;
  let publicPortAccess = false;

  if (targetPort !== null) {
    // 5a: Check sam_port_access cookie (subsequent requests)
    const cookieHeader = c.req.raw.headers.get('cookie') || '';
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)sam_port_access=([^\s;]+)/);
    if (cookieMatch?.[1]) {
      try {
        const payload = await verifyPortAccessToken(cookieMatch[1], c.env);
        if (payload.workspace === workspaceId && payload.port === targetPort) {
          userId = payload.subject;
        }
      } catch {
        // Cookie expired or invalid — fall through to token check
      }
    }

    // 5b: Check ?port_token= query param (initial request from expose_port URL)
    if (!userId) {
      const portToken = url.searchParams.get('port_token');
      if (portToken) {
        try {
          const payload = await verifyPortAccessToken(portToken, c.env);
          if (payload.workspace === workspaceId && payload.port === targetPort) {
            // Set cookie and 302 redirect to strip token from URL
            const cookieMaxAge = c.env.PORT_ACCESS_COOKIE_MAX_AGE_SECONDS
              ? parseInt(c.env.PORT_ACCESS_COOKIE_MAX_AGE_SECONDS, 10)
              : 14400;
            const redirectUrl = new URL(url.toString());
            redirectUrl.searchParams.delete('port_token');
            portAccessRedirect = new Response(null, {
              status: 302,
              headers: {
                Location: redirectUrl.toString(),
                'Set-Cookie': `sam_port_access=${portToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${cookieMaxAge}`,
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer',
              },
            });
            userId = payload.subject;
          }
        } catch (err) {
          log.warn('ws_proxy_port_token_rejected', {
            workspaceId,
            targetPort,
            ...serializeError(err),
          });
        }
      }
    }

    if (!userId) {
      const db = drizzle(c.env.DATABASE, { schema });
      const publicWorkspace = await db
        .select({
          userId: schema.workspaces.userId,
          portsPublicEnabled: schema.workspaces.portsPublicEnabled,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .get();

      if (publicWorkspace?.portsPublicEnabled) {
        userId = publicWorkspace.userId;
        publicPortAccess = true;
      }
    }

    // 5f: HTML error page for expired/invalid port access
    if (!userId) {
      return new Response(
        `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Session expired</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#333}
h1{font-size:1.4rem}code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:0.9em}</style>
</head><body>
<h1>Session expired</h1>
<p>Your access to this port has expired or is invalid.</p>
<p>Ask the agent to run <code>expose_port</code> again for a fresh link.</p>
</body></html>`,
        {
          status: 401,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        }
      );
    }

    // Return the 302 redirect after we confirm the DB lookup passes below
    // (moved after DB check to ensure ownership is validated first)
  }

  // --- Standard session/terminal-token authentication (non-port or fallback) ---
  if (!userId) {
    const auth = await createAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    userId = session?.user.id ?? null;
  }

  if (!userId) {
    const token = url.searchParams.get('token');
    if (!token) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
    }

    try {
      const payload = await verifyTerminalToken(token, c.env);
      if (payload.workspace !== workspaceId || payload.subject === 'port-proxy') {
        return c.json({ error: 'UNAUTHORIZED', message: 'Invalid workspace token' }, 401);
      }
      userId = payload.subject;
    } catch (err) {
      log.warn('ws_proxy_terminal_token_rejected', {
        workspaceId,
        ...serializeError(err),
      });
      return c.json({ error: 'UNAUTHORIZED', message: 'Invalid workspace token' }, 401);
    }
  }

  // Look up workspace routing metadata from D1.
  const db = drizzle(c.env.DATABASE, { schema });
  const workspace = await db
    .select({
      nodeId: schema.workspaces.nodeId,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
    .get();

  if (!workspace) {
    return c.json({ error: 'NOT_FOUND', message: 'Workspace not found' }, 404);
  }

  const nodeRuntime = workspace.nodeId
    ? ((
        await db
          .select({ runtime: schema.nodes.runtime })
          .from(schema.nodes)
          .where(eq(schema.nodes.id, workspace.nodeId))
          .get()
      )?.runtime ?? 'vm')
    : 'vm';

  if (workspace.status !== 'running' && workspace.status !== 'recovery') {
    // Allow boot-log WebSocket during creation for real-time streaming
    if (workspace.status === 'creating' && url.pathname === '/boot-log/ws') {
      // Fall through to proxy
    } else {
      return c.json({ error: 'NOT_READY', message: `Workspace is ${workspace.status}` }, 503);
    }
  }

  // 5b continued: Return the 302 redirect now that ownership is verified.
  // This ensures the cookie is only set after the D1 ownership check passes.
  if (portAccessRedirect) {
    return portAccessRedirect;
  }

  if (nodeRuntime === 'cf-container') {
    const containerConfig = getVmAgentContainerConfig(c.env);
    if (!containerConfig.enabled) {
      return c.json(
        { error: 'CF_CONTAINER_DISABLED', message: 'Container workspace runtime is disabled' },
        503
      );
    }
    if (!c.env.VM_AGENT_CONTAINER) {
      return c.json(
        { error: 'CF_CONTAINER_UNAVAILABLE', message: 'VM agent container binding is unavailable' },
        503
      );
    }

    const containerId = workspace.nodeId || workspaceId;
    const vmAgentPort = containerConfig.vmAgentPort;
    const containerUrl = new URL(`http://localhost:${vmAgentPort}`);
    containerUrl.pathname = url.pathname;
    containerUrl.search = url.search;

    if (targetPort !== null) {
      const subPath = url.pathname === '/' ? '' : url.pathname;
      containerUrl.pathname = `/workspaces/${workspaceId}/ports/${targetPort}${subPath}`;
      containerUrl.searchParams.delete('port_token');
      try {
        const { token } = await signTerminalToken('port-proxy', workspaceId, c.env);
        containerUrl.searchParams.set('token', token);
      } catch (err) {
        log.error('cf_container_port_proxy_token_error', {
          workspaceId,
          ...serializeError(err),
        });
        return c.json(
          { error: 'TOKEN_ERROR', message: 'Failed to generate port proxy token' },
          500
        );
      }
    }

    const headers = new Headers(c.req.raw.headers);
    headers.delete('x-sam-node-id');
    headers.delete('x-sam-workspace-id');
    headers.delete('x-forwarded-host');
    headers.set('X-SAM-Node-Id', workspace.nodeId || workspaceId);
    headers.set('X-SAM-Workspace-Id', workspaceId);
    headers.set('X-Forwarded-Host', hostname);
    headers.set('X-Forwarded-Proto', 'https');

    log.info('ws_proxy_cf_container_route', {
      workspaceId,
      nodeId: containerId,
      containerId,
      vmAgentPort,
      targetPort,
      publicPortAccess,
      method: c.req.raw.method,
      path: url.pathname,
    });
    recordNodeRoutingMetric(
      {
        metric: 'ws_proxy_route',
        nodeId: containerId,
        workspaceId,
      },
      c.env
    );

    const containerRequest = new Request(containerUrl.toString(), {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-expect-error — Cloudflare Workers support duplex for streaming request bodies
      duplex: c.req.raw.body ? 'half' : undefined,
    });
    const response = await fetchVmAgentContainer(c.env, containerId, containerRequest, vmAgentPort);

    if (targetPort !== null) {
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('set-cookie');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
    return response;
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
    publicPortAccess,
    method: c.req.raw.method,
    path: url.pathname,
  });
  recordNodeRoutingMetric(
    {
      metric: 'ws_proxy_route',
      nodeId: workspace.nodeId || workspaceId,
      workspaceId,
    },
    c.env
  );
  const vmAgentProtocol = c.env.VM_AGENT_PROTOCOL || 'https';
  const vmAgentPort = c.env.VM_AGENT_PORT || '8443';
  const vmUrl = new URL(`${vmAgentProtocol}://${backendHostname}:${vmAgentPort}`);
  vmUrl.pathname = url.pathname;
  vmUrl.search = url.search;

  // Route port-specific requests to the VM agent's port proxy endpoint.
  // ws-{id}--3000.example.com/foo → {backend}/workspaces/{id}/ports/3000/foo
  if (targetPort !== null) {
    const subPath = url.pathname === '/' ? '' : url.pathname;
    vmUrl.pathname = `/workspaces/${workspaceId}/ports/${targetPort}${subPath}`;

    // Strip port_token from the proxied URL (it was already validated above).
    vmUrl.searchParams.delete('port_token');

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
  headers.set('X-SAM-Node-Id', workspace.nodeId || workspaceId);
  headers.set('X-SAM-Workspace-Id', workspaceId);

  // Preserve the original client-facing hostname (e.g., ws-abc123--3000.example.com)
  // so the VM agent can forward it to container services. The fetch() to the VM agent
  // rewrites the Host header to the VM hostname for Cloudflare edge routing, losing
  // the original. X-Forwarded-Proto is always https since clients connect via CF edge.
  headers.set('X-Forwarded-Host', hostname);
  headers.set('X-Forwarded-Proto', 'https');

  const response = await fetch(vmUrl.toString(), {
    method: c.req.raw.method,
    headers,
    body: c.req.raw.body,
    // @ts-expect-error — Cloudflare Workers support duplex for streaming request bodies
    duplex: c.req.raw.body ? 'half' : undefined,
  });

  // 5e: Strip Set-Cookie headers from container responses on port-proxy path.
  // Prevents a malicious container app from overwriting the sam_port_access cookie.
  if (targetPort !== null) {
    const headers = new Headers(response.headers);
    headers.delete('set-cookie');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
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

app.use(
  '*',
  cors({
    origin: (origin, c) => {
      return resolveCredentialedCorsOrigin(origin, c.env?.BASE_DOMAIN);
    },
    credentials: true,
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'x-api-key',
      'anthropic-version',
      'anthropic-beta',
    ],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);

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

  return c.json(
    {
      status: hasCriticalBindings ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
    },
    hasCriticalBindings ? 200 : 503
  );
});

// Public config — exposes feature flags the UI needs before auth
app.get('/api/config/artifacts-enabled', (c) => {
  return c.json({ enabled: c.env.ARTIFACTS_ENABLED === 'true' && !!c.env.ARTIFACTS });
});

// Public config — which login providers are configured, so the login surfaces
// only render a provider button when that provider is actually usable. Google
// here means the LOGIN client (getGoogleLoginOAuthConfig), never the infra/GCP one.
app.get('/api/config/login-providers', async (c) => {
  const { getGitHubOAuthConfig, getGitLabOAuthConfig, getGoogleLoginOAuthConfig } =
    await import('./services/platform-config');
  const [github, google, gitlab] = await Promise.all([
    getGitHubOAuthConfig(c.env),
    getGoogleLoginOAuthConfig(c.env),
    getGitLabOAuthConfig(c.env),
  ]);
  return c.json({ github: github !== null, google: google !== null, gitlab: gitlab !== null });
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
// apiTokenRoutes uses dedicated API token auth, not session auth.
// Both must be mounted before authRoutes to avoid BetterAuth's wildcard catch-all.
app.route('/api/auth', codexRefreshRoutes);
app.route('/api/auth', apiTokenRoutes);
app.route('/api/auth', deviceFlowRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/setup', setupRoutes);
app.route('/api/credentials', resolutionStatusRoute);
app.route('/api/credentials', credentialsRoutes);
app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);
app.route('/api/cc', ccRoutes);
app.route('/api/providers', providersRoutes);
app.route('/api/github', githubRoutes);
app.route('/api/gitlab', gitlabRoutes);
// Callback JWT routes — MUST be before session-auth node routes.
app.route('/api/nodes', deployReleaseCallbackRoute); // Deploy node fetches signed release payload.
app.route('/api/nodes', deploymentReleaseEventsCallbackRoute); // Deploy node reports apply events.
app.route('/api/nodes', nodesRoutes);
app.route('/api/nodes', nodeLifecycleRoutes);
app.route('/api/workspaces', workspacesRoutes);
app.route('/api/terminal', terminalRoutes);
app.route('/api/agent', agentRoutes);
app.route('/api/agents', agentsCatalogRoutes);
app.route('/api/model-catalog', modelCatalogRoutes);
app.route('/api/bootstrap', bootstrapRoutes);
app.route('/api/ui-governance', uiGovernanceRoutes);
app.route('/api/transcribe', transcribeRoutes);
app.route('/api/tts', ttsRoutes);
app.route('/api/agent-settings', agentSettingsRoutes);
app.route('/api/client-errors', clientErrorsRoutes);
app.route('/api/cli', cliRoutes);
app.route('/api/chats', chatsRoutes);
app.route('/api/t', analyticsIngestRoutes);
app.route('/api/webhooks', triggerWebhookRoutes);
// ORDERING IS CRITICAL: Routes using callback JWT auth MUST be mounted before
// projectsRoutes. projectsRoutes has use('/*', requireAuth()) which leaks to
// all siblings at the same base path — mounting these routes first causes them
// to match and return before the session auth middleware runs.
// See docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md
// See .claude/rules/06-api-patterns.md (Hono middleware scoping)
app.route('/api/projects', deploymentIdentityTokenRoute);
app.route('/api/projects', nodeAcpHeartbeatRoute);
app.route('/api/projects', agentActivityCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', taskCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', registryPushCredentialsCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', composeImageArtifactsCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', composePublishReleaseCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', deploymentPublishJobCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', projectsRoutes);
app.route('/api/projects/:projectId/tasks', tasksRoutes);
app.route('/api/projects/:projectId/sessions', chatStartRoutes);
app.route('/api/projects/:projectId/sessions', chatRoutes);
app.route('/api/projects/:projectId/cached-commands', cachedCommandRoutes);
app.route('/api/projects/:projectId/activity', activityRoutes);
app.route('/api/projects/:projectId/library', libraryRoutes);
app.route('/api/projects/:projectId/agent-profiles/:profileId/runtime', profileRuntimeRoutes);
app.route('/api/projects/:projectId/agent-profiles', agentProfileRoutes);
app.route('/api/projects/:projectId/skills/:skillId/runtime', skillRuntimeRoutes);
app.route('/api/projects/:projectId/skills', skillRoutes);
app.route('/api/projects/:projectId/triggers', triggersRoutes);
app.route('/api/projects/:projectId/knowledge', knowledgeRoutes);
app.route('/api/projects/:projectId/mailbox', mailboxRoutes);
app.route('/api/projects/:projectId/missions', missionRoutes);
app.route('/api/projects/:projectId/orchestrator', orchestratorRoutes);
app.route('/api/projects/:projectId/policies', policyRoutes);
app.route('/api/projects/:projectId/agent', projectAgentRoutes);
app.route('/api/projects', projectDeploymentRoutes);
app.route('/api/projects', deploymentEnvironmentRoutes);
app.route('/api/projects', deploymentCustomDomainRoutes);
app.route('/api/projects', deploymentEnvironmentConfigRoutes);
app.route('/api/projects', deploymentReleaseRoutes);
app.route('/api/projects', deploymentSecretRoutes);
app.route('/api/projects', deploymentVolumeRoutes);
app.route('/api/deployment', gcpDeployCallbackRoute);
app.route('/api/admin/observability/logs/ingest', observabilityIngestRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/admin/ai-proxy', adminAIProxyRoutes);
app.route('/api/admin/analytics', adminAnalyticsRoutes);
app.route('/api/admin/analytics/ai-usage', adminAiUsageRoutes);
app.route('/api/admin/platform-config', adminPlatformConfigRoutes);
app.route('/api/admin/platform-credentials', adminPlatformCredentialRoutes);
app.route('/api/admin/trials', adminTrialsRoutes);
app.route('/api/admin/quotas', adminQuotaRoutes);
app.route('/api/admin/usage', adminUsageRoutes);
app.route('/api/admin/costs', adminCostRoutes);
app.route('/api/admin/cc-backfill', adminCcBackfillRoutes);
app.route('/api/admin/github-repo-id-backfill', adminGithubRepoIdBackfillRoutes);
app.route('/api/admin/github-installation-leak-sweep', adminGithubInstallationLeakSweepRoutes);
app.route('/api/admin/sandbox', adminSandboxRoutes);
app.route('/api/admin/ai-allowance', adminAiAllowanceRoutes);
app.route('/api/usage', usageRoutes);
app.route('/api/account-map', accountMapRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/sam', samRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api', trialRoutes);
app.route('/api/trial', trialOnboardingRoutes);
app.route('/api/gcp', gcpRoutes);
app.route('/ai/v1', aiProxyRoutes);
app.route('/ai/anthropic/v1', aiProxyAnthropicRoutes);
app.route('/ai/proxy', aiProxyPassthroughRoutes);
app.route('/auth/google', googleAuthRoutes);
// MCP endpoint CORS override — MCP uses Bearer token auth (not cookies/sessions),
// so it needs credentials: false + origin: '*' to allow VM agent requests from any origin.
// This must run after the global CORS middleware to overwrite its headers.
app.use(
  '/mcp/*',
  cors({
    origin: '*',
    credentials: false,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  })
);
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
  return c.json(
    {
      error: 'NOT_FOUND',
      message: 'Endpoint not found',
    },
    404
  );
});

// Export handler with scheduled (cron) support
export default {
  fetch: app.fetch,

  /**
   * Scheduled (cron) handler for background tasks.
   * Cron schedules:
   * - Every 5 minutes: operational cleanup (provisioning, nodes, tasks, observability, trial expiry)
   * - Hourly at :30: monthly AI cost aggregation per user (Gateway logs → KV cache)
   * - Daily at 03:00 UTC: analytics event forwarding to external platforms
   * - Daily at 04:00 UTC (configurable via TRIAL_CRON_WAITLIST_CLEANUP): trial waitlist purge
   * - Monthly at 03:00 UTC on the 1st (configurable via TRIAL_CRON_ROLLOVER_CRON): trial counter rollover audit
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const rolloverCron = env.TRIAL_CRON_ROLLOVER_CRON ?? '0 5 1 * *';
    const waitlistCleanupCron = env.TRIAL_CRON_WAITLIST_CLEANUP ?? '0 4 * * *';

    const isDailyForward = controller.cron === '0 3 * * *';
    const isMonthlyCostAggregation = controller.cron === '30 * * * *';
    const isTrialRollover = controller.cron === rolloverCron;
    const isTrialWaitlistCleanup = controller.cron === waitlistCleanupCron;

    const cronType = isDailyForward
      ? 'daily-forward'
      : isMonthlyCostAggregation
        ? 'monthly-cost-aggregation'
        : isTrialRollover
          ? 'trial-rollover'
          : isTrialWaitlistCleanup
            ? 'trial-waitlist-cleanup'
            : 'sweep';

    log.info('cron.started', {
      cron: controller.cron,
      type: cronType,
    });

    // Hourly: aggregate per-user monthly AI cost from Gateway logs → KV cache.
    if (isMonthlyCostAggregation) {
      ctx.waitUntil(
        (async () => {
          const result = await runMonthlyCostAggregation(env);
          log.info('cron.completed', {
            cron: controller.cron,
            type: 'monthly-cost-aggregation',
            monthlyCostEnabled: result.enabled,
            monthlyCostUsersUpdated: result.usersUpdated,
            monthlyCostTotalEntries: result.totalEntries,
            monthlyCostErrors: result.errors,
          });
        })()
      );
      return;
    }

    // Daily analytics forwarding (Phase 4) — use ctx.waitUntil to keep the
    // isolate alive for the full duration of multi-step external API calls.
    if (isDailyForward) {
      ctx.waitUntil(
        (async () => {
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
        })()
      );
      return;
    }

    // Monthly trial counter rollover audit (prune old DO counter rows, verify month-key drift).
    if (isTrialRollover) {
      ctx.waitUntil(
        (async () => {
          const rollover = await runTrialRolloverAudit(env);
          log.info('cron.completed', {
            cron: controller.cron,
            type: 'trial-rollover',
            trialRolloverMonthKey: rollover.monthKey,
            trialRolloverPruned: rollover.pruned,
          });
        })()
      );
      return;
    }

    // Daily trial waitlist cleanup (purge notified-and-aged rows).
    if (isTrialWaitlistCleanup) {
      ctx.waitUntil(
        (async () => {
          const waitlist = await runTrialWaitlistCleanup(env);
          log.info('cron.completed', {
            cron: controller.cron,
            type: 'trial-waitlist-cleanup',
            trialWaitlistPurged: waitlist.purged,
          });
        })()
      );
      return;
    }

    // 5-minute operational sweep
    // Recover stuck tasks first so unrelated cleanup failures cannot suppress lifecycle repair.
    const stuckTasks = await recoverStuckTasks(env);

    // Check for stuck provisioning workspaces
    const timedOut = await checkProvisioningTimeouts(env.DATABASE, env, env.OBSERVABILITY_DATABASE);

    // Migrate orphaned workspaces (those with NULL projectId) to projects
    const db = drizzle(env.DATABASE, { schema });
    const migrated = await migrateOrphanedWorkspaces(db);

    // Clean up stale warm nodes and expired auto-provisioned nodes
    const nodeCleanup = await runNodeCleanupSweep(env);

    // Purge expired observability errors (retention + row count limits)
    const observabilityPurge = await runObservabilityPurge(env);

    // Fire due cron triggers
    const cronTriggers = await runCronTriggerSweep(env);

    // Recover stale trigger executions and purge old logs
    const triggerCleanup = await runTriggerExecutionCleanup(env);
    // Repair a bounded page of legacy taskless user-visible chat sessions.
    const sessionTaskRepair = await runSessionTaskReconciliation(env);

    // Reclaim expired guided credential-setup sessions (bounded — rule 47).
    const setupSessionSweep = await runSetupSessionSweep(env, ctx);

    // Clean up abandoned R2 compose image artifacts. The cleanup module is
    // interval-gated through KV so the 5-minute sweep does not scan R2 every run.
    const composeArtifactCleanup = await runScheduledComposeImageArtifactCleanup(env);

    // Close orphaned compute_usage records
    const computeUsageClosed = await runComputeUsageCleanup(env);

    // Expire stale pending/ready trial rows (cap slot is NOT refunded — it was
    // consumed for the month).
    const trialExpire = await runTrialExpireSweep(env);

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
      webhookDeliveriesPurged: triggerCleanup.webhookDeliveriesPurged,
      triggerExecCleanupErrors: triggerCleanup.errors,
      sessionTaskRepairScanned: sessionTaskRepair.scanned,
      sessionTaskRepairRepaired: sessionTaskRepair.repaired,
      sessionTaskRepairReused: sessionTaskRepair.reused,
      sessionTaskRepairErrors: sessionTaskRepair.errors,
      sessionTaskRepairResidual: sessionTaskRepair.residual,
      composeArtifactCleanupSkipped: composeArtifactCleanup.skipped,
      composeArtifactCleanupSkipReason: composeArtifactCleanup.skipReason,
      composeArtifactCleanupScanned: composeArtifactCleanup.scannedObjects,
      composeArtifactCleanupReferencedKeys: composeArtifactCleanup.referencedKeys,
      composeArtifactCleanupRetainedReferenced: composeArtifactCleanup.retainedReferenced,
      composeArtifactCleanupRetainedYoung: composeArtifactCleanup.retainedYoung,
      composeArtifactCleanupDeleted: composeArtifactCleanup.deletedObjects,
      composeArtifactCleanupDeletedBytes: composeArtifactCleanup.deletedBytes,
      composeArtifactCleanupErrors: composeArtifactCleanup.errors,
      computeUsageOrphansClosed: computeUsageClosed,
      trialExpired: trialExpire.expired,
      trialProjectsLinked: trialExpire.projectsLinked,
      trialWorkspacesDeleted: trialExpire.workspacesDeleted,
      trialNodesDeleted: trialExpire.nodesDeleted,
      trialCleanupErrors: trialExpire.cleanupErrors,
      setupSessionsSwept: setupSessionSweep.toreDown,
      setupSessionOrphansForced: setupSessionSweep.orphansForced,
      setupSessionSweepErrors: setupSessionSweep.errors,
    });
  },
};
