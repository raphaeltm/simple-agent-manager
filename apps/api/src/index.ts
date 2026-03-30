// Re-export Durable Object classes for Cloudflare Workers runtime
export { ProjectData } from './durable-objects/project-data';
export { NodeLifecycle } from './durable-objects/node-lifecycle';
export { AdminLogs } from './durable-objects/admin-logs';
export { TaskRunner } from './durable-objects/task-runner';
export { NotificationService } from './durable-objects/notification';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { AppError } from './middleware/error';
import { GcpApiError, sanitizeGcpError } from './services/gcp-errors';
import { authRoutes } from './routes/auth';
import { credentialsRoutes } from './routes/credentials';
import { providersRoutes } from './routes/providers';
import { githubRoutes } from './routes/github';
import { workspacesRoutes } from './routes/workspaces';
import { nodesRoutes } from './routes/nodes';
import { terminalRoutes } from './routes/terminal';
import { agentRoutes } from './routes/agent';
import { agentsCatalogRoutes } from './routes/agents-catalog';
import { bootstrapRoutes } from './routes/bootstrap';
import { uiGovernanceRoutes } from './routes/ui-governance';
import { transcribeRoutes } from './routes/transcribe';
import { ttsRoutes } from './routes/tts';
import { agentSettingsRoutes } from './routes/agent-settings';
import { agentProfileRoutes } from './routes/agent-profiles';
import { clientErrorsRoutes } from './routes/client-errors';
import { projectsRoutes } from './routes/projects';
import { tasksRoutes } from './routes/tasks';
import { chatRoutes } from './routes/chat';
import { cachedCommandRoutes } from './routes/cached-commands';
import { activityRoutes } from './routes/activity';
import { adminRoutes } from './routes/admin';
import { adminAnalyticsRoutes } from './routes/admin-analytics';
import { analyticsIngestRoutes } from './routes/analytics-ingest';
import { dashboardRoutes } from './routes/dashboard';
import { mcpRoutes } from './routes/mcp';
import { notificationRoutes } from './routes/notifications';
import { gcpRoutes } from './routes/gcp';
import { googleAuthRoutes } from './routes/google-auth';
import { smokeTestTokenRoutes } from './routes/smoke-test-tokens';
import { projectDeploymentRoutes, gcpDeployCallbackRoute, deploymentIdentityTokenRoute } from './routes/project-deployment';
import { analyticsMiddleware } from './middleware/analytics';
import { checkProvisioningTimeouts } from './services/timeout';
import { migrateOrphanedWorkspaces } from './services/workspace-migration';
import { runNodeCleanupSweep } from './scheduled/node-cleanup';
import { recoverStuckTasks } from './scheduled/stuck-tasks';
import { runObservabilityPurge } from './scheduled/observability-purge';
import { runAnalyticsForwardJob } from './scheduled/analytics-forward';
import { getRuntimeLimits } from './services/limits';
import { recordNodeRoutingMetric } from './services/telemetry';
import { parseWorkspaceSubdomain } from './lib/workspace-subdomain';
import { signTerminalToken } from './services/jwt';

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
  // Analytics Engine for usage tracking (optional — binding absent in local dev / Miniflare)
  ANALYTICS?: AnalyticsEngineDataset;
  // Observability D1 (error storage — spec 023)
  OBSERVABILITY_DATABASE: D1Database;
  // Durable Objects
  PROJECT_DATA: DurableObjectNamespace;
  NODE_LIFECYCLE: DurableObjectNamespace;
  ADMIN_LOGS: DurableObjectNamespace;
  TASK_RUNNER: DurableObjectNamespace;
  NOTIFICATION: DurableObjectNamespace;
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
  CF_ACCOUNT_ID: string;
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  ENCRYPTION_KEY: string;
  // Purpose-specific secret overrides (fall back to ENCRYPTION_KEY when unset)
  BETTER_AUTH_SECRET?: string;           // BetterAuth session management
  CREDENTIAL_ENCRYPTION_KEY?: string;    // AES-GCM user credential encryption
  GITHUB_WEBHOOK_SECRET?: string;        // GitHub webhook HMAC verification
  // Pages project name for proxying app.* requests
  PAGES_PROJECT_NAME?: string;
  // Pages project name for proxying www.* requests (marketing site)
  WWW_PAGES_PROJECT_NAME?: string;
  // User approval / invite-only mode
  REQUIRE_APPROVAL?: string;
  // Smoke test auth tokens (CI authentication — only set in staging/test environments)
  SMOKE_TEST_AUTH_ENABLED?: string;
  // Smoke test token configuration (all optional with defaults)
  SMOKE_TOKEN_BYTES?: string;              // Random bytes for token generation (default: 32)
  MAX_SMOKE_TOKENS_PER_USER?: string;      // Max active tokens per user (default: 10)
  MAX_SMOKE_TOKEN_NAME_LENGTH?: string;    // Max token name length (default: 100)
  SMOKE_TEST_SESSION_DURATION_SECONDS?: string; // Session lifetime for token login (default: 604800 = 7 days)
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
  RATE_LIMIT_IDENTITY_TOKEN?: string;
  RATE_LIMIT_IDENTITY_TOKEN_WINDOW_SECONDS?: string;
  IDENTITY_TOKEN_CACHE_BUFFER_SECONDS?: string;
  IDENTITY_TOKEN_CACHE_MIN_TTL_SECONDS?: string;
  // Hierarchy limits
  MAX_NODES_PER_USER?: string;
  MAX_WORKSPACES_PER_NODE?: string;
  MAX_AGENT_SESSIONS_PER_WORKSPACE?: string;
  MAX_PROJECTS_PER_USER?: string;
  MAX_BRANCHES_PER_REPO?: string;
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
  // Warm node pooling configuration
  NODE_WARM_TIMEOUT_MS?: string;
  MAX_AUTO_NODE_LIFETIME_MS?: string;
  NODE_WARM_GRACE_PERIOD_MS?: string;
  ORPHANED_WORKSPACE_GRACE_PERIOD_MS?: string;
  // Workspace idle timeout (global default, overridable per-project)
  WORKSPACE_IDLE_TIMEOUT_MS?: string;
  // Task agent configuration
  DEFAULT_TASK_AGENT_TYPE?: string;
  // Built-in profile model overrides (defaults: claude-sonnet-4-5-20250929, claude-opus-4-6)
  BUILTIN_PROFILE_SONNET_MODEL?: string;
  BUILTIN_PROFILE_OPUS_MODEL?: string;
  // Task execution timeout (stuck task recovery)
  TASK_RUN_MAX_EXECUTION_MS?: string;
  TASK_STUCK_QUEUED_TIMEOUT_MS?: string;
  TASK_STUCK_DELEGATED_TIMEOUT_MS?: string;
  // ACP configuration (passed to VMs via environment)
  ACP_INIT_TIMEOUT_MS?: string;
  ACP_RECONNECT_DELAY_MS?: string;
  ACP_RECONNECT_TIMEOUT_MS?: string;
  ACP_MAX_RESTART_ATTEMPTS?: string;
  // Dashboard configuration
  DASHBOARD_INACTIVE_THRESHOLD_MS?: string;
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
  // Observability configuration (spec 023)
  OBSERVABILITY_ERROR_RETENTION_DAYS?: string;
  OBSERVABILITY_ERROR_MAX_ROWS?: string;
  OBSERVABILITY_ERROR_BATCH_SIZE?: string;
  OBSERVABILITY_ERROR_BODY_BYTES?: string;
  OBSERVABILITY_LOG_QUERY_RATE_LIMIT?: string;
  OBSERVABILITY_STREAM_BUFFER_SIZE?: string;
  OBSERVABILITY_STREAM_RECONNECT_DELAY_MS?: string;
  OBSERVABILITY_STREAM_RECONNECT_MAX_DELAY_MS?: string;
  OBSERVABILITY_TREND_DEFAULT_RANGE_HOURS?: string;
  // Node log configuration (cloud-init journal settings)
  LOG_JOURNAL_MAX_USE?: string;
  LOG_JOURNAL_KEEP_FREE?: string;
  LOG_JOURNAL_MAX_RETENTION?: string;
  // Docker daemon DNS servers (comma-separated quoted IPs, default: "1.1.1.1", "8.8.8.8")
  DOCKER_DNS_SERVERS?: string;
  // External API timeouts (milliseconds)
  HETZNER_API_TIMEOUT_MS?: string;
  CF_API_TIMEOUT_MS?: string;
  NODE_AGENT_REQUEST_TIMEOUT_MS?: string;
  // Project data DO limits
  CACHED_COMMANDS_MAX_PER_AGENT?: string;
  CACHED_COMMANDS_MAX_AGENT_TYPE_LENGTH?: string;
  CACHED_COMMANDS_MAX_NAME_LENGTH?: string;
  CACHED_COMMANDS_MAX_DESC_LENGTH?: string;
  MAX_SESSIONS_PER_PROJECT?: string;
  MAX_MESSAGES_PER_SESSION?: string;
  MESSAGE_SIZE_THRESHOLD?: string;
  ACTIVITY_RETENTION_DAYS?: string;
  SESSION_IDLE_TIMEOUT_MINUTES?: string;
  DO_SUMMARY_SYNC_DEBOUNCE_MS?: string;
  // ACP Session Lifecycle (spec 027)
  ACP_SESSION_DETECTION_WINDOW_MS?: string;
  ACP_SESSION_MAX_FORK_DEPTH?: string;
  // Branch name generation (chat-first submit)
  BRANCH_NAME_PREFIX?: string;
  BRANCH_NAME_MAX_LENGTH?: string;
  // AI task title generation (Workers AI)
  TASK_TITLE_MODEL?: string;
  TASK_TITLE_MAX_LENGTH?: string;
  TASK_TITLE_TIMEOUT_MS?: string;
  TASK_TITLE_GENERATION_ENABLED?: string;
  TASK_TITLE_SHORT_MESSAGE_THRESHOLD?: string;
  TASK_TITLE_MAX_RETRIES?: string;
  TASK_TITLE_RETRY_DELAY_MS?: string;
  TASK_TITLE_RETRY_MAX_DELAY_MS?: string;
  // Context summarization (conversation forking)
  CONTEXT_SUMMARY_MODEL?: string;
  CONTEXT_SUMMARY_MAX_LENGTH?: string;
  CONTEXT_SUMMARY_TIMEOUT_MS?: string;
  CONTEXT_SUMMARY_MAX_MESSAGES?: string;
  CONTEXT_SUMMARY_RECENT_MESSAGES?: string;
  CONTEXT_SUMMARY_SHORT_THRESHOLD?: string;
  CONTEXT_SUMMARY_HEAD_MESSAGES?: string;
  CONTEXT_SUMMARY_HEURISTIC_RECENT_MESSAGES?: string;
  // Idle cleanup configuration
  IDLE_CLEANUP_RETRY_DELAY_MS?: string;
  IDLE_CLEANUP_MAX_RETRIES?: string;
  // TaskRunner DO configuration (TDF-2: alarm-driven orchestration)
  TASK_RUNNER_STEP_MAX_RETRIES?: string;
  TASK_RUNNER_RETRY_BASE_DELAY_MS?: string;
  TASK_RUNNER_RETRY_MAX_DELAY_MS?: string;
  TASK_RUNNER_AGENT_POLL_INTERVAL_MS?: string;
  TASK_RUNNER_AGENT_READY_TIMEOUT_MS?: string;
  TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS?: string;
  TASK_RUNNER_PROVISION_POLL_INTERVAL_MS?: string;
  // Callback token refresh threshold (ratio of token lifetime, default 0.5)
  CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO?: string;
  // MCP token TTL in seconds (default 14400 = 4 hours, aligned with task max execution time)
  MCP_TOKEN_TTL_SECONDS?: string;
  // MCP HTTP-level rate limiting (per task/agent)
  MCP_RATE_LIMIT?: string;                          // Max requests per window (default: 120)
  MCP_RATE_LIMIT_WINDOW_SECONDS?: string;           // Rate limit window in seconds (default: 60)
  // MCP dispatch_task limits (agent-to-agent task spawning)
  MCP_DISPATCH_MAX_DEPTH?: string;                // Max dispatch chain depth (default: 3)
  MCP_DISPATCH_MAX_PER_TASK?: string;             // Max tasks a single agent can dispatch (default: 5)
  MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT?: string;   // Max concurrent agent-dispatched tasks per project (default: 10)
  MCP_DISPATCH_DESCRIPTION_MAX_LENGTH?: string;   // Max description length for dispatched tasks (default: 32000)
  MCP_DISPATCH_MAX_REFERENCES?: string;            // Max reference URLs per dispatch (default: 20)
  MCP_DISPATCH_MAX_REFERENCE_LENGTH?: string;      // Max length per reference string (default: 500)
  MCP_DISPATCH_MAX_PRIORITY?: string;              // Max priority for agent-dispatched tasks (default: 100)
  // MCP get_session_messages limits
  MCP_MESSAGE_LIST_LIMIT?: string;                 // Default raw tokens per request (default: 50)
  MCP_MESSAGE_LIST_MAX?: string;                   // Max raw tokens per request (default: 200)
  MCP_MESSAGE_SEARCH_MAX?: string;                 // Max search results for search_messages (default: 20)
  // Configurable content limits
  MAX_TASK_MESSAGE_LENGTH?: string;
  MAX_ACTIVITY_MESSAGE_LENGTH?: string;
  MAX_LOG_MESSAGE_LENGTH?: string;
  MAX_OUTPUT_SUMMARY_LENGTH?: string;
  MAX_ACP_PROMPT_BYTES?: string;
  MAX_ACP_CONTEXT_BYTES?: string;
  MAX_MESSAGES_PER_BATCH?: string;
  MAX_MESSAGES_PAYLOAD_BYTES?: string;
  MAX_AGENT_SESSION_LABEL_LENGTH?: string;
  MAX_AGENT_CREDENTIAL_SYNC_BYTES?: string;
  MCP_TASK_DESCRIPTION_SNIPPET_LENGTH?: string;
  MCP_IDEA_CONTEXT_MAX_LENGTH?: string;            // Max length for idea link context string (default: 500)
  MCP_IDEA_CONTENT_MAX_LENGTH?: string;            // Max length for idea content/description (default: 65536)
  MCP_IDEA_LIST_LIMIT?: string;                    // Default page size for list_ideas (default: 20)
  MCP_IDEA_LIST_MAX?: string;                      // Max page size for list_ideas (default: 100)
  MCP_IDEA_SEARCH_MAX?: string;                    // Max results for search_ideas (default: 20)
  MCP_IDEA_TITLE_MAX_LENGTH?: string;              // Max length for idea title (default: 200)
  MCP_SESSION_TOPIC_MAX_LENGTH?: string;           // Max length for session topic (default: 200)
  // Text-to-speech (Workers AI)
  TTS_MODEL?: string;
  TTS_SPEAKER?: string;
  TTS_ENCODING?: string;
  TTS_CLEANUP_MODEL?: string;
  TTS_MAX_TEXT_LENGTH?: string;
  TTS_TIMEOUT_MS?: string;
  TTS_CLEANUP_TIMEOUT_MS?: string;
  TTS_CLEANUP_MAX_TOKENS?: string;
  TTS_R2_PREFIX?: string;
  TTS_ENABLED?: string;
  TTS_CHUNK_SIZE?: string;
  TTS_MAX_CHUNKS?: string;
  TTS_SUMMARY_THRESHOLD?: string;
  TTS_RETRY_ATTEMPTS?: string;
  TTS_RETRY_BASE_DELAY_MS?: string;
  // VM agent TLS configuration
  VM_AGENT_PROTOCOL?: string;  // "https" (default) or "http"
  VM_AGENT_PORT?: string;      // "8443" (default) or custom port
  // Origin CA certificate/key (injected into cloud-init for VM TLS)
  ORIGIN_CA_CERT?: string;
  ORIGIN_CA_KEY?: string;
  // Notification system configuration
  MAX_NOTIFICATIONS_PER_USER?: string;
  NOTIFICATION_AUTO_DELETE_AGE_MS?: string;
  NOTIFICATION_PAGE_SIZE?: string;
  NOTIFICATION_PROGRESS_BATCH_WINDOW_MS?: string;
  NOTIFICATION_DEDUP_WINDOW_MS?: string;
  NOTIFICATION_FULL_BODY_LENGTH?: string;
  // Google OAuth (for GCP OIDC integration)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // GCP OIDC configuration
  GCP_IDENTITY_TOKEN_EXPIRY_SECONDS?: string;
  GCP_TOKEN_CACHE_TTL_SECONDS?: string;
  GCP_API_TIMEOUT_MS?: string;
  GCP_OPERATION_POLL_TIMEOUT_MS?: string;
  GCP_STS_SCOPE?: string;
  GCP_SA_IMPERSONATION_SCOPES?: string;
  GCP_SA_TOKEN_LIFETIME_SECONDS?: string;
  GCP_WIF_POOL_ID?: string;
  GCP_WIF_PROVIDER_ID?: string;
  GCP_SERVICE_ACCOUNT_ID?: string;
  GCP_DEFAULT_ZONE?: string;
  GCP_IMAGE_FAMILY?: string;
  GCP_IMAGE_PROJECT?: string;
  GCP_DISK_SIZE_GB?: string;
  // GCP deployment (project-level OIDC for Defang)
  GCP_DEPLOY_WIF_POOL_ID?: string;
  GCP_DEPLOY_WIF_PROVIDER_ID?: string;
  GCP_DEPLOY_SERVICE_ACCOUNT_ID?: string;
  GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS?: string;
  GCP_STS_TOKEN_URL?: string;
  GCP_IAM_CREDENTIALS_BASE_URL?: string;
  GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS?: string;
  GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS?: string;
  // Analytics Engine configuration
  ANALYTICS_ENABLED?: string;                   // "true" (default) or "false"
  ANALYTICS_SKIP_ROUTES?: string;               // Comma-separated route patterns to skip
  ANALYTICS_SQL_API_URL?: string;               // Override Analytics Engine SQL API URL
  ANALYTICS_DEFAULT_PERIOD_DAYS?: string;       // Default query period (default: 30)
  ANALYTICS_DATASET?: string;                   // Dataset name (default: "sam_analytics")
  ANALYTICS_TOP_EVENTS_LIMIT?: string;          // Max events in top events query (default: 50)
  ANALYTICS_GEO_LIMIT?: string;                 // Max countries in geo distribution (default: 50)
  ANALYTICS_RETENTION_WEEKS?: string;           // Retention cohort lookback weeks (default: 12)
  ANALYTICS_WEBSITE_TRAFFIC_TOP_PAGES_LIMIT?: string; // Max top pages per section in website traffic (default: 20)
  // Analytics ingest endpoint (Phase 2 — client-side events)
  ANALYTICS_INGEST_ENABLED?: string;             // "true" (default) or "false"
  RATE_LIMIT_ANALYTICS_INGEST?: string;          // Rate limit per IP per hour (default: 500)
  MAX_ANALYTICS_INGEST_BATCH_SIZE?: string;      // Max events per batch (default: 25)
  MAX_ANALYTICS_INGEST_BODY_BYTES?: string;      // Max request body bytes (default: 65536)
  // Analytics forwarding (Phase 4 — external event export)
  ANALYTICS_FORWARD_ENABLED?: string;             // "true" to enable forwarding (default: "false")
  ANALYTICS_FORWARD_EVENTS?: string;              // Comma-separated event names to forward (default: key conversions)
  ANALYTICS_FORWARD_LOOKBACK_HOURS?: string;      // Hours of data to query per run (default: 25)
  ANALYTICS_FORWARD_CURSOR_KEY?: string;          // KV key for last-forwarded timestamp (default: "analytics-forward-cursor")
  SEGMENT_WRITE_KEY?: string;                     // Segment write key (enables Segment forwarding)
  SEGMENT_API_URL?: string;                       // Segment batch endpoint (default: https://api.segment.io/v1/batch)
  SEGMENT_MAX_BATCH_SIZE?: string;                // Max events per Segment batch (default: 100)
  GA4_MEASUREMENT_ID?: string;                    // GA4 measurement ID (enables GA4 forwarding)
  GA4_API_SECRET?: string;                        // GA4 API secret
  GA4_API_URL?: string;                           // GA4 Measurement Protocol endpoint (default: https://www.google-analytics.com/mp/collect)
  GA4_MAX_BATCH_SIZE?: string;                    // Max events per GA4 request (default: 25)
  ANALYTICS_FORWARD_SQL_LIMIT?: string;           // Max rows per forwarding query (default: 10000)
  ANALYTICS_SQL_FETCH_TIMEOUT_MS?: string;        // Timeout for Analytics Engine SQL API fetch (default: 30000)
  SEGMENT_FETCH_TIMEOUT_MS?: string;              // Timeout for Segment API fetch (default: 30000)
  GA4_FETCH_TIMEOUT_MS?: string;                  // Timeout for GA4 API fetch (default: 30000)
  // File proxy configuration (chat file browser)
  FILE_PROXY_TIMEOUT_MS?: string;                  // Timeout for VM agent file proxy requests (default: 15000)
  FILE_PROXY_MAX_RESPONSE_BYTES?: string;          // Max response body size from VM agent file proxy (default: 2097152 = 2MB)
  FILE_RAW_PROXY_MAX_BYTES?: string;              // Max response size for raw binary file proxy (default: 52428800 = 50MB)
  // File upload/download configuration
  // Note: Per-file size enforcement (FILE_UPLOAD_MAX_BYTES) is delegated to the VM agent.
  // The API layer only enforces batch size via Content-Length pre-check.
  FILE_UPLOAD_BATCH_MAX_BYTES?: string;            // Max total batch upload size forwarded to VM agent (default: 262144000 = 250MB)
  FILE_UPLOAD_TIMEOUT_MS?: string;                 // Timeout for upload proxy requests in ms (default: 120000)
  FILE_DOWNLOAD_TIMEOUT_MS?: string;               // Timeout for download proxy requests in ms (default: 60000)
  FILE_DOWNLOAD_MAX_BYTES?: string;                // Max file download size forwarded from VM agent (default: 52428800 = 50MB)
  // R2 S3-compatible credentials (for presigned URL generation — task file attachments)
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  // R2 bucket name (runtime — set by wrangler sync script; used for presigned URL generation)
  R2_BUCKET_NAME?: string;
  // Task attachment upload limits (all configurable per constitution Principle XI)
  ATTACHMENT_UPLOAD_MAX_BYTES?: string;
  ATTACHMENT_UPLOAD_BATCH_MAX_BYTES?: string;
  ATTACHMENT_MAX_FILES?: string;
  ATTACHMENT_PRESIGN_EXPIRY_SECONDS?: string;
  // Timeout for transferring attachments from R2 to workspace VM (default: 60000ms)
  ATTACHMENT_TRANSFER_TIMEOUT_MS?: string;
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

  // Defense-in-depth: sanitize GcpApiError if it escapes route-level catch blocks
  if (err instanceof GcpApiError) {
    const safe = sanitizeGcpError(err, 'global-handler');
    return c.json({ error: 'GCP_UPSTREAM_ERROR', message: safe }, 502);
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
    return c.json({ error: 'INVALID_WORKSPACE', message: parsed.error }, 400);
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
  console.log(JSON.stringify({
    event: 'ws_proxy_route',
    workspaceId,
    nodeId: workspace.nodeId || workspaceId,
    backendHostname,
    targetPort,
    method: c.req.raw.method,
    path: url.pathname,
  }));
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
      console.error(JSON.stringify({
        event: 'port_proxy_token_error',
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      }));
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

// Analytics Engine — writes one data point per request (non-blocking, fire-and-forget)
app.use('*', analyticsMiddleware());

app.use('*', cors({
  origin: (origin, c) => {
    if (!origin) return null;
    const baseDomain = c.env?.BASE_DOMAIN || '';
    // Allow localhost for development
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return origin;
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

// Health check
app.get('/health', (c) => {
  const limits = getRuntimeLimits(c.env);

  // Verify critical bindings are available (catches wrangler.toml misconfiguration)
  const bindings: Record<string, boolean> = {
    DATABASE: !!c.env.DATABASE,
    KV: !!c.env.KV,
    PROJECT_DATA: !!c.env.PROJECT_DATA,
    NODE_LIFECYCLE: !!c.env.NODE_LIFECYCLE,
    TASK_RUNNER: !!c.env.TASK_RUNNER,
    ADMIN_LOGS: !!c.env.ADMIN_LOGS,
    NOTIFICATION: !!c.env.NOTIFICATION,
  };

  const missingBindings = Object.entries(bindings)
    .filter(([, available]) => !available)
    .map(([name]) => name);

  if (missingBindings.length > 0) {
    return c.json({
      status: 'degraded',
      version: c.env.VERSION,
      timestamp: new Date().toISOString(),
      limits,
      bindings,
      missingBindings,
    }, 503);
  }

  return c.json({
    status: 'healthy',
    version: c.env.VERSION,
    timestamp: new Date().toISOString(),
    limits,
    bindings,
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

// API routes
app.route('/api/auth', authRoutes);
app.route('/api/auth', smokeTestTokenRoutes);
app.route('/api/credentials', credentialsRoutes);
app.route('/api/providers', providersRoutes);
app.route('/api/github', githubRoutes);
app.route('/api/nodes', nodesRoutes);
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
// ORDERING IS CRITICAL: deploymentIdentityTokenRoute MUST be mounted before
// projectsRoutes. projectsRoutes has use('/*', requireAuth()) which leaks to
// all siblings at the same base path — mounting identity token route first
// causes it to match and return before the session auth middleware runs.
// Reversing this order silently breaks GCP agent deployments with 401.
// See docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md
app.route('/api/projects', deploymentIdentityTokenRoute);
app.route('/api/projects', projectsRoutes);
app.route('/api/projects/:projectId/tasks', tasksRoutes);
app.route('/api/projects/:projectId/sessions', chatRoutes);
app.route('/api/projects/:projectId/cached-commands', cachedCommandRoutes);
app.route('/api/projects/:projectId/activity', activityRoutes);
app.route('/api/projects/:projectId/agent-profiles', agentProfileRoutes);
app.route('/api/projects', projectDeploymentRoutes);
app.route('/api/deployment', gcpDeployCallbackRoute);
app.route('/api/admin', adminRoutes);
app.route('/api/admin/analytics', adminAnalyticsRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/gcp', gcpRoutes);
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

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'cron.started',
      cron: controller.cron,
      type: isDailyForward ? 'daily-forward' : 'sweep',
    }));

    // Daily analytics forwarding (Phase 4) — use ctx.waitUntil to keep the
    // isolate alive for the full duration of multi-step external API calls.
    if (isDailyForward) {
      ctx.waitUntil((async () => {
        const forward = await runAnalyticsForwardJob(env);
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'info',
          event: 'cron.completed',
          cron: controller.cron,
          type: 'daily-forward',
          forwardEnabled: forward.enabled,
          forwardEventsQueried: forward.eventsQueried,
          forwardSegmentSent: forward.segment.sent,
          forwardGA4Sent: forward.ga4.sent,
          forwardCursorUpdated: forward.cursorUpdated,
        }));
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

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'cron.completed',
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
    }));
  },
};
