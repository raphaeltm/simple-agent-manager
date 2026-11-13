// Configure @simple-agent-manager/repo-hosting's ports before any route or Durable Object can use it.
import './repo-hosting-wiring';

export { McpRateCounter } from './durable-objects/mcp-rate-counter';
export { WorkspaceBootLog } from './durable-objects/workspace-boot-log';
import { adminAgentEmailRoutes } from './routes/admin-agent-email';
import { cliOperationReceiptRoutes } from './routes/cli-operation-receipts';
import { cliProjectMetadataRoutes } from './routes/cli-project-metadata';
import { projectScheduleRoutes } from './routes/project-schedules';
import { projectStandingWatchRoutes } from './routes/project-standing-watches';
// Re-export Durable Object classes for Cloudflare Workers runtime
export { AdminLogs } from './durable-objects/admin-logs';
export { AiTokenBudgetCounter } from './durable-objects/ai-token-budget-counter';
// Sandbox SDK DO class — retained for experimental toolbox/diagnostics use only.
export { CodexRefreshLock } from './durable-objects/codex-refresh-lock';
export { CredentialSetupSession } from './durable-objects/credential-setup-session';
export { DiagnosisRunner } from './durable-objects/diagnosis-runner';
export { GitHubUserAccessTokenLock } from './durable-objects/github-user-access-token-lock';
export { GitLabUserAccessTokenLock } from './durable-objects/gitlab-user-access-token-lock';
export { HostedGitRepo } from './durable-objects/hosted-git-repo';
export { InteractionStore } from './durable-objects/interaction-store';
export { NodeLifecycle } from './durable-objects/node-lifecycle';
export { NotificationService } from './durable-objects/notification';
export { ProjectAgent } from './durable-objects/project-agent';
export { ProjectOrchestrator } from './durable-objects/project-orchestrator';
export { SamSession } from './durable-objects/sam-session';
export { SetupSessionPool } from './durable-objects/setup-session-pool';
export { TaskRunner } from './durable-objects/task-runner';
export { ProjectData } from './project-data-wiring';
// Inert tombstones: wrangler migrations v7-v9 created these classes for the retired
// anonymous-trial product, so they must stay exported (see durable-objects/retired-trial.ts).
export { TrialCounter, TrialEventBus, TrialOrchestrator } from './durable-objects/retired-trial';
export { SandboxDO } from './durable-objects/sandbox-do';
export { VmAgentContainer } from './durable-objects/vm-agent-container';
export type { Env } from './env';

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { Env } from './env';
import { applyCacheHeaders } from './lib/cache-headers';
import { withRequestScopedD1Bindings } from './lib/d1-session';
import { resolvePagesProxyTarget } from './lib/pages-proxy';
import { analyticsMiddleware } from './middleware/analytics';
import { apiCors } from './middleware/api-cors';
import { handleAppError } from './middleware/app-error-handler';
import { requestLoggingMiddleware } from './middleware/request-logging';
import { accountMapRoutes } from './routes/account-map';
import { activityRoutes } from './routes/activity';
import { adminRoutes } from './routes/admin';
import { adminAiAllowanceRoutes } from './routes/admin-ai-allowance';
import { adminAIProxyRoutes } from './routes/admin-ai-proxy';
import { adminAiUsageRoutes } from './routes/admin-ai-usage';
import { adminAnalyticsRoutes } from './routes/admin-analytics';
import { adminCapacityPoolsRoutes } from './routes/admin-capacity-pools';
import { adminCcBackfillRoutes } from './routes/admin-cc-backfill';
import { adminCostRoutes } from './routes/admin-costs';
import { adminGithubInstallationLeakSweepRoutes } from './routes/admin-github-installation-leak-sweep';
import { adminGithubRepoIdBackfillRoutes } from './routes/admin-github-repo-id-backfill';
import { adminOperationsApprovalRoutes } from './routes/admin-operations-approvals';
import { adminPlatformConfigRoutes } from './routes/admin-platform-config';
import { adminPlatformCredentialRoutes } from './routes/admin-platform-credentials';
import { adminProjectEventRoutes } from './routes/admin-project-events';
import { adminQuotaRoutes } from './routes/admin-quotas';
import { adminRuntimeControlRoutes } from './routes/admin-runtime-controls';
import { adminSandboxRoutes } from './routes/admin-sandbox';
import { adminSettingsRoutes } from './routes/admin-settings';
import { adminUsageRoutes } from './routes/admin-usage';
import { agentRoutes } from './routes/agent';
import { agentCredentialSetupSessionsRoutes } from './routes/agent-credential-setup-sessions';
import { agentModelCatalogRoutes, projectAgentModelRoutes } from './routes/agent-models';
import { agentProfileRoutes } from './routes/agent-profiles';
import { agentSettingsRoutes } from './routes/agent-settings';
import { agentSignInRoutes } from './routes/agent-sign-in';
import { agentsCatalogRoutes } from './routes/agents-catalog';
import { aiProxyRoutes } from './routes/ai-proxy';
import { aiProxyAnthropicRoutes } from './routes/ai-proxy-anthropic';
import { aiProxyPassthroughRoutes } from './routes/ai-proxy-passthrough';
import { analyticsIngestRoutes } from './routes/analytics-ingest';
import { apiTokenRoutes } from './routes/api-tokens';
import { authRoutes } from './routes/auth';
import { bootstrapRoutes } from './routes/bootstrap';
import { cachedCommandRoutes } from './routes/cached-commands';
import { capacityPoolsRoutes } from './routes/capacity-pools';
import { chatRoutes } from './routes/chat';
import { chatStartRoutes } from './routes/chat-start';
import { chatsRoutes } from './routes/chats';
import { cliRoutes } from './routes/cli';
import { clientErrorsRoutes } from './routes/client-errors';
import { codexRefreshRoutes } from './routes/codex-refresh';
import { codexRuntimeRoutes } from './routes/codex-runtime';
import { ccRoutes } from './routes/composable-credentials';
import { connectorMcpRoutes } from './routes/connector-mcp';
import { connectorConsentRoutes, connectorOAuthRoutes } from './routes/connector-oauth';
import { connectorAdminRoutes, connectorSettingsRoutes } from './routes/connector-settings';
import { credentialLimitsRoute } from './routes/credential-limits';
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
import { ideaUpdateRoutes } from './routes/idea-updates';
import { ideaRoutes } from './routes/ideas';
import {
  handleInteractivePreviewRequest,
  isInteractivePreviewRequest,
} from './routes/interactive-preview-host';
import { knowledgeRoutes } from './routes/knowledge';
import { libraryRoutes } from './routes/library';
import { libraryCommentRoutes } from './routes/library-comments';
import { mailboxRoutes } from './routes/mailbox';
import { mcpRoutes } from './routes/mcp';
import { projectMcpConnectionRoutes, userMcpConnectionRoutes } from './routes/mcp-connections';
import { missionRoutes } from './routes/missions';
import { modelCatalogRoutes } from './routes/model-catalog';
import { nodeBootFailureRoutes } from './routes/node-boot-failure';
import { nodeLifecycleRoutes } from './routes/node-lifecycle';
import { nodesRoutes } from './routes/nodes';
import { notificationRoutes } from './routes/notifications';
import { observabilityIngestRoutes } from './routes/observability-ingest';
import { orchestratorRoutes } from './routes/orchestrator';
import { policyRoutes } from './routes/policies';
import { profileRuntimeRoutes } from './routes/profile-runtime';
import { projectAgentRoutes } from './routes/project-agent';
import { projectCommentRoutes } from './routes/project-comments';
import {
  deploymentIdentityTokenRoute,
  gcpDeployCallbackRoute,
  projectDeploymentRoutes,
} from './routes/project-deployment';
import { projectEventChannelRoutes } from './routes/project-event-channels';
import { projectEventSubscriptionRoutes } from './routes/project-event-subscriptions';
import { projectsRoutes } from './routes/projects';
import { acpInteractionCallbackRoute } from './routes/projects/acp-interaction-callback';
import { agentActivityCallbackRoute } from './routes/projects/agent-activity-callback';
import { agentUsageCallbackRoute } from './routes/projects/agent-usage-callback';
import { buildStartedCallbackRoute } from './routes/projects/build-started-callback';
import { composeImageArtifactsCallbackRoute } from './routes/projects/compose-image-artifacts-callback';
import { composePublishReleaseCallbackRoute } from './routes/projects/compose-publish-release-callback';
import { deploymentPublishJobCallbackRoute } from './routes/projects/deployment-publish-job-callback';
import { nodeAcpHeartbeatRoute } from './routes/projects/node-acp-heartbeat';
import { registryPushCredentialsCallbackRoute } from './routes/projects/registry-push-credentials-callback';
import { workspaceEvictionCallbackRoute } from './routes/projects/workspace-eviction-callback';
import { workspaceResourceHistoryCallbackRoute } from './routes/projects/workspace-resource-history-callback';
import { providersRoutes } from './routes/providers';
import { reportIssueRoutes } from './routes/report-issue';
import { resolutionStatusRoute } from './routes/resolution-status';
import { resourceLinkRoutes } from './routes/resource-links';
import { samRoutes } from './routes/sam';
import { createSelfHostGatewayRoutes } from './routes/self-host-gateway';
import { setupRoutes } from './routes/setup';
import { skillRuntimeRoutes } from './routes/skill-runtime';
import { skillRoutes } from './routes/skills';
import { taskCallbackRoute, tasksRoutes } from './routes/tasks';
import { terminalRoutes } from './routes/terminal';
import { transcribeRoutes } from './routes/transcribe';
import { trialRoutes } from './routes/trial';
import { triggerWebhookRoutes } from './routes/trigger-webhooks';
import { signedTriggerWebhookRoutes } from './routes/trigger-webhooks-signed';
import { triggersRoutes } from './routes/triggers';
import { ttsRoutes } from './routes/tts';
import { uiGovernanceRoutes } from './routes/ui-governance';
import { usageRoutes } from './routes/usage';
import { workflowRoutes } from './routes/workflows';
import { workspaceSubdomainProxy } from './routes/workspace-subdomain-proxy';
import { workspacesRoutes } from './routes/workspaces';
import { scheduled } from './scheduled/handler';
import { handleInboundAgentEmail } from './services/agent-email/inbound';
import { agentEmailConfig } from './services/agent-email/setup-state';
import { isAgentSignInEnabled } from './services/agent-sign-in/config';
import { isLocalHostedGitActive } from './services/hosted-git/backend';
import { handleHostedGitRequest, HOSTED_GIT_PATH_PREFIX } from './services/hosted-git/http';
import { isArtifactsAvailable } from './services/platform-capabilities';
import { resolvePublicPlatformCapabilities } from './services/speech-endpoints';
import { isInstantRuntimeAvailable } from './services/vm-agent-container';

const app = new Hono<{ Bindings: Env }>();

// Global error handler — catches errors from all routes including subrouters.
// Must use app.onError() instead of middleware try/catch because Hono's
// app.route() subrouter errors don't propagate to parent middleware.
app.onError(handleAppError);

// Signed preview-host requests bypass session auth, credentialed CORS, Pages,
// and workspace cookie handling.
app.use('*', async (c, next) => {
  if (isInteractivePreviewRequest(c.req.raw, c.env)) {
    return handleInteractivePreviewRequest(c.req.raw, c.env);
  }
  await next();
});

// Proxy non-API subdomains to their respective Cloudflare Pages deployments (or, on a
// self-hosted deployment with an ASSETS binding, serve app.* from the Worker's assets).
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
    hasWebAssets: c.env.ASSETS !== undefined,
  });

  // Self-hosted deployments serve the web UI from the Worker's static assets. (`c.env.ASSETS`
  // is re-checked only so TypeScript narrows the optional binding.)
  if (pagesTarget.type === 'assets' && c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

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

// Proxy requests for workspace subdomains (ws-{id}.*) to the VM agent (routes/workspace-subdomain-proxy.ts).
app.use('*', workspaceSubdomainProxy);

app.use('*', requestLoggingMiddleware());

// Analytics Engine — writes one data point per request (non-blocking, fire-and-forget)
app.use('*', analyticsMiddleware());

app.use('*', apiCors);

// Git smart HTTP for SAM-hosted repositories (self-host). Authenticated per request with a
// repository token, not a session cookie, so it sits before every session-auth router. Inactive
// (falls through to 404) unless this install uses the local hosted git backend.
app.all(`${HOSTED_GIT_PATH_PREFIX}*`, async (c, next) => {
  if (!isLocalHostedGitActive(c.env)) return next();
  const response = await handleHostedGitRequest(c.req.raw, c.env);
  return response ?? next();
});

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
  applyCacheHeaders(c, 'public-config');
  return c.json({ enabled: isArtifactsAvailable(c.env) });
});

// Public config — which platform services this installation has, so the UI can hide entry
// points that cannot work here (services/platform-capabilities.ts). Booleans only.
app.get('/api/config/platform-capabilities', async (c) => {
  applyCacheHeaders(c, 'public-config');
  return c.json(await resolvePublicPlatformCapabilities(c.env));
});

// Public config — whether agents can run on Instant (Cloudflare Containers) with no cloud account.
app.get('/api/config/instant-runtime', (c) => {
  applyCacheHeaders(c, 'public-config');
  return c.json({ enabled: isInstantRuntimeAvailable(c.env) });
});

// Public config — whether this deployment can receive and send agent email (preview).
app.get('/api/config/agent-email', async (c) => {
  applyCacheHeaders(c, 'public-config');
  return c.json(await agentEmailConfig(c.env));
});

// The VAPID public key is runtime configuration: deploy-generated keys do not
// exist when the web bundle is built. Never expose the corresponding private key.
app.get('/api/config/vapid-public-key', (c) => {
  applyCacheHeaders(c, 'public-config');
  const publicKey = c.env.VAPID_PUBLIC_KEY?.trim() || null;
  return c.json({ publicKey });
});

// Public config — which login providers are configured, so the login surfaces
// only render a provider button when that provider is actually usable. Google
// here means the LOGIN client (getGoogleLoginOAuthConfig), never the infra/GCP one. Email
// means this deployment can send sign-in codes (services/email-sign-in.ts).
app.get('/api/config/login-providers', async (c) => {
  const { getGitHubOAuthConfig, getGitLabOAuthConfig, getGoogleLoginOAuthConfig } =
    await import('./services/platform-config');
  const [github, google, gitlab] = await Promise.all([
    getGitHubOAuthConfig(c.env),
    getGoogleLoginOAuthConfig(c.env),
    getGitLabOAuthConfig(c.env),
  ]);
  const { emailSignInAvailable } = await import('./services/email-sign-in');
  applyCacheHeaders(c, 'public-config');
  return c.json({
    github: github !== null,
    google: google !== null,
    gitlab: gitlab !== null,
    email: emailSignInAvailable(c.env),
    // Shown on the sign-in page so anyone using the instance can tell it accepts agent
    // sign-in. A boolean only: the trusted issuer and allowlists are not published.
    agentSignIn: isAgentSignInEnabled(c.env),
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

// OIDC Discovery endpoint — used by GCP Workload Identity Federation to verify SAM as an IdP
app.get('/.well-known/openid-configuration', async (c) => {
  const { getOidcDiscovery } = await import('./services/jwt');
  const discovery = getOidcDiscovery(c.env);
  c.header('Cache-Control', 'public, max-age=3600');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.json(discovery);
});

// External workload identities have their own issuer; internal SAM JWTs keep theirs.
app.get('/oidc/.well-known/openid-configuration', async (c) => {
  const { getWorkloadDiscovery } = await import('./services/workload-identity-token');
  c.header('Cache-Control', 'public, max-age=3600');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.json(getWorkloadDiscovery(c.env));
});
app.get('/oidc/.well-known/jwks.json', async (c) => {
  const { getWorkloadJWKS } = await import('./services/workload-identity-token');
  c.header('Cache-Control', 'public, max-age=3600');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.json(await getWorkloadJWKS(c.env));
});

// API routes — codex refresh and smoke test routes registered before BetterAuth catch-all.
// codexRefreshRoutes uses workspace callback token auth (query param), not session auth.
// apiTokenRoutes uses dedicated API token auth, not session auth.
// Both must be mounted before authRoutes to avoid BetterAuth's wildcard catch-all.
app.route('/api/auth', codexRefreshRoutes);
app.route('/api/auth', apiTokenRoutes);
// Agent sign-in through workload identity. Steps aside (falls through) when AGENT_SIGN_IN_TRUST
// is not configured, so the path then answers exactly as an unknown /api/auth route.
app.route('/api/auth', agentSignInRoutes);
app.route('/api/auth', deviceFlowRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/setup', setupRoutes);
// Self-hosted box gateway (frps plugin, Caddy forward_auth). Own secret auth, no session
// middleware; 404 unless REVERSE_TUNNEL_GATEWAY_SECRET is configured (routes/self-host-gateway.ts).
app.route(
  '/api/self-host/gateway',
  createSelfHostGatewayRoutes((request, env, ctx) => app.fetch(request, env, ctx))
);
app.route('/api/credentials', resolutionStatusRoute);
app.route('/api/credentials', credentialLimitsRoute);
app.route('/api/credentials', credentialsRoutes);
app.route('/api/capacity-pools', capacityPoolsRoutes);
app.route('/api/agent-credential-setup-sessions', agentCredentialSetupSessionsRoutes);
app.route('/api/mcp-connections', userMcpConnectionRoutes);
app.route('/api/cc', ccRoutes);
app.route('/api/providers', providersRoutes);
app.route('/api/github', githubRoutes);
app.route('/api/gitlab', gitlabRoutes);
// Callback JWT routes — MUST be before session-auth node routes.
app.route('/api/nodes', deployReleaseCallbackRoute); // Deploy node fetches signed release payload.
app.route('/api/nodes', deploymentReleaseEventsCallbackRoute); // Deploy node reports apply events.
// Node boot callbacks authenticate with node JWTs, before session-auth middleware.
app.route('/api/nodes', nodeBootFailureRoutes);
app.route('/api/nodes', nodesRoutes);
app.route('/api/nodes', nodeLifecycleRoutes);
app.route('/api/workspaces', workspacesRoutes);
app.route('/api/terminal', terminalRoutes);
app.route('/api/agent', agentRoutes);
app.route('/api/acp/codex-runtime', codexRuntimeRoutes);
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
// Signed senders (Slack, HMAC) cannot present SAM's token: POST /api/webhooks/in/:triggerId.
app.route('/api/webhooks', signedTriggerWebhookRoutes);
// ORDERING IS CRITICAL: Routes using callback JWT auth MUST be mounted before
// projectsRoutes. projectsRoutes has use('/*', requireAuth()) which leaks to
// all siblings at the same base path — mounting these routes first causes them
// to match and return before the session auth middleware runs.
// See docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md
// See .claude/rules/06-api-patterns.md (Hono middleware scoping)
app.route('/api/projects', deploymentIdentityTokenRoute);
app.route('/api/projects', nodeAcpHeartbeatRoute);
app.route('/api/projects', acpInteractionCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', agentActivityCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', agentUsageCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', buildStartedCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', taskCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', registryPushCredentialsCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', composeImageArtifactsCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', composePublishReleaseCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', deploymentPublishJobCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', workspaceEvictionCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', workspaceResourceHistoryCallbackRoute); // Must be before projectsRoutes — uses callback JWT, not session auth
app.route('/api/projects', projectsRoutes);
app.route('/api/projects/:projectId/ideas', ideaRoutes);
app.route('/api/projects/:projectId/tasks', tasksRoutes);
app.route('/api/projects/:projectId/operation-receipts', cliOperationReceiptRoutes);
app.route('/api/projects/:projectId/cli', cliProjectMetadataRoutes);
app.route('/api/projects/:projectId/sessions', chatStartRoutes);
app.route('/api/projects/:projectId/sessions', chatRoutes);
app.route('/api/projects/:projectId/ideas', ideaUpdateRoutes);
app.route('/api/projects/:projectId/comments', projectCommentRoutes);
app.route('/api/projects/:projectId/event-subscriptions', projectEventSubscriptionRoutes);
app.route('/api/projects/:projectId/schedules', projectScheduleRoutes);
app.route('/api/projects/:projectId/standing-watches', projectStandingWatchRoutes);
app.route('/api/projects/:projectId/event-channels', projectEventChannelRoutes);
app.route('/api/projects/:projectId/cached-commands', cachedCommandRoutes);
app.route('/api/projects/:projectId/activity', activityRoutes);
app.route('/api/projects/:projectId/library', libraryRoutes);
app.route('/api/projects/:projectId', resourceLinkRoutes);
app.route('/api/projects/:projectId/library', libraryCommentRoutes);
app.route('/api/projects/:projectId/agent-profiles/:profileId/runtime', profileRuntimeRoutes);
app.route('/api/projects/:projectId/agent-profiles', agentProfileRoutes);
app.route('/api/projects/:projectId/skills/:skillId/runtime', skillRuntimeRoutes);
app.route('/api/projects/:projectId/skills', skillRoutes);
app.route('/api/projects/:projectId/agent-models', projectAgentModelRoutes);
app.route('/api/projects/:projectId/mcp-connections', projectMcpConnectionRoutes);
app.route('/api/projects/:projectId/triggers', triggersRoutes);
app.route('/api/projects/:projectId/knowledge', knowledgeRoutes);
app.route('/api/projects/:projectId/mailbox', mailboxRoutes);
app.route('/api/projects/:projectId/missions', missionRoutes);
app.route('/api/projects/:projectId/workflows', workflowRoutes);
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
app.route('/api/admin/capacity-pools', adminCapacityPoolsRoutes);
app.route('/api/admin/ai-proxy', adminAIProxyRoutes);
app.route('/api/admin/analytics', adminAnalyticsRoutes);
app.route('/api/admin/analytics/ai-usage', adminAiUsageRoutes);
app.route('/api/admin/platform-config', adminPlatformConfigRoutes);
app.route('/api/admin/platform-credentials', adminPlatformCredentialRoutes);
app.route('/api/admin/project-events', adminProjectEventRoutes);
app.route('/api/admin/quotas', adminQuotaRoutes);
app.route('/api/admin/agent-email', adminAgentEmailRoutes);
app.route('/api/admin/runtime-controls', adminRuntimeControlRoutes);
app.route('/api/admin/operations/approvals', adminOperationsApprovalRoutes);
app.route('/api/admin/settings', adminSettingsRoutes);
app.route('/api/admin/usage', adminUsageRoutes);
app.route('/api/admin/costs', adminCostRoutes);
app.route('/api/admin/cc-backfill', adminCcBackfillRoutes);
app.route('/api/admin/github-repo-id-backfill', adminGithubRepoIdBackfillRoutes);
app.route('/api/admin/github-installation-leak-sweep', adminGithubInstallationLeakSweepRoutes);
app.route('/api/admin/sandbox', adminSandboxRoutes);
app.route('/api/admin/ai-allowance', adminAiAllowanceRoutes);
app.route('/api/usage', usageRoutes);
app.route('/api/agent-models', agentModelCatalogRoutes);
app.route('/api/report-issue', reportIssueRoutes);
app.route('/api/account-map', accountMapRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/sam', samRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api', trialRoutes);
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
app.route('/', connectorOAuthRoutes);
app.route('/connect/mcp', connectorMcpRoutes);
app.route('/api/connector/consent', connectorConsentRoutes);
app.route('/api/connector', connectorSettingsRoutes);
app.route('/api/admin/connector', connectorAdminRoutes);

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

// Export HTTP and scheduled Worker entry points.
//
// `fetch` runs the whole request against a single request-scoped D1 session per database
// (`lib/d1-session.ts`), so one request pays one trans-Atlantic round trip to the primary
// instead of one per query. `scheduled` deliberately keeps the raw bindings: cron sweeps
// own terminal verdicts and must read exactly what they read today
// (`.claude/rules/53`, `/58`, `/66`). Durable Objects are constructed by the runtime with
// the real env and are likewise unaffected.
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, withRequestScopedD1Bindings(env), ctx),
  scheduled,
  // Email Routing deliveries for agent email triggers (preview). Raw bindings, like
  // `scheduled`: it is not a browser request.
  email: async (message: ForwardableEmailMessage, env: Env) => {
    await handleInboundAgentEmail(message, env);
  },
};
