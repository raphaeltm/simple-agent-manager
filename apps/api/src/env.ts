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
  CODEX_REFRESH_LOCK: DurableObjectNamespace;
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
  RATE_LIMIT_CODEX_REFRESH?: string;
  RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS?: string;
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
  // Account Map configuration
  ACCOUNT_MAP_MAX_ENTITIES?: string;
  ACCOUNT_MAP_MAX_SESSIONS_PER_PROJECT?: string;
  ACCOUNT_MAP_CACHE_TTL_SECONDS?: string;
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
  // Heartbeat ACP sweep timeout (per-call timeout for DO heartbeat updates in waitUntil)
  HEARTBEAT_ACP_SWEEP_TIMEOUT_MS?: string;
  // TaskRunner DO configuration (TDF-2: alarm-driven orchestration)
  TASK_RUNNER_STEP_MAX_RETRIES?: string;
  TASK_RUNNER_RETRY_BASE_DELAY_MS?: string;
  TASK_RUNNER_RETRY_MAX_DELAY_MS?: string;
  TASK_RUNNER_AGENT_POLL_INTERVAL_MS?: string;
  TASK_RUNNER_AGENT_READY_TIMEOUT_MS?: string;
  TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS?: string;
  TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS?: string;
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
  // Orchestration tools (retry, dependency, remove, send_message, stop)
  ORCHESTRATOR_MAX_RETRIES_PER_TASK?: string;      // Max retry attempts per task (default: 3)
  ORCHESTRATOR_DEPENDENCY_MAX_EDGES?: string;      // Max dependency edges per project (default: 50)
  ORCHESTRATOR_STOP_GRACE_MS?: string;             // Grace period before hard stop after warning (default: 5000)
  ORCHESTRATOR_MESSAGE_MAX_LENGTH?: string;        // Max length for injected messages to child agents (default: 32768)
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
  // Knowledge graph limits
  KNOWLEDGE_MAX_ENTITIES_PER_PROJECT?: string;     // Max knowledge entities per project (default: 500)
  KNOWLEDGE_MAX_OBSERVATIONS_PER_ENTITY?: string;  // Max observations per entity (default: 100)
  KNOWLEDGE_SEARCH_LIMIT?: string;                 // Max search results (default: 20)
  KNOWLEDGE_AUTO_RETRIEVE_LIMIT?: string;          // Max auto-retrieved observations on session start (default: 20)
  KNOWLEDGE_OBSERVATION_MAX_LENGTH?: string;       // Max observation text length (default: 1000)
  KNOWLEDGE_ENTITY_NAME_MAX_LENGTH?: string;       // Max entity name length (default: 200)
  KNOWLEDGE_DESCRIPTION_MAX_LENGTH?: string;       // Max entity description length (default: 2000)
  KNOWLEDGE_LIST_PAGE_SIZE?: string;               // Default page size for entity list (default: 50)
  KNOWLEDGE_LIST_MAX_PAGE_SIZE?: string;           // Max page size for entity list (default: 200)
  KNOWLEDGE_SEARCH_MAX_LIMIT?: string;             // Max search results cap (default: 100)
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
  // Workspace tool proxy configuration (unified from workspace-mcp)
  WORKSPACE_TOOL_TIMEOUT_MS?: string;             // Timeout for VM agent proxy calls (default: 15000)
  WORKSPACE_TOOL_GITHUB_TIMEOUT_MS?: string;      // Timeout for GitHub API calls (default: 10000)
  WORKSPACE_TOOL_DNS_TIMEOUT_MS?: string;          // Timeout for DNS check calls (default: 10000)
  WORKSPACE_TOOL_COST_PRICING_JSON?: string;       // VM hourly pricing JSON (default: built-in pricing table)
  WORKSPACE_TOOL_CI_RUNS_LIMIT?: string;           // Max CI runs to return (default: 10)
  WORKSPACE_TOOL_DEPLOY_RUNS_LIMIT?: string;       // Max deployment runs to return (default: 5)
  WORKSPACE_TOOL_DIAGNOSTIC_MAX_BYTES?: string;    // Max diagnostic data size in bytes (default: 4096)
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
  // Codex token refresh proxy configuration
  CODEX_REFRESH_PROXY_ENABLED?: string;            // Kill switch: "false" to disable (default: enabled)
  CODEX_REFRESH_LOCK_TIMEOUT_MS?: string;          // Per-user lock timeout (default: 30000)
  CODEX_REFRESH_UPSTREAM_URL?: string;             // OpenAI token endpoint (default: https://auth.openai.com/oauth/token)
  CODEX_REFRESH_UPSTREAM_TIMEOUT_MS?: string;      // Upstream request timeout (default: 10000)
  CODEX_CLIENT_ID?: string;                        // OpenAI OAuth client_id (default: app_EMoamEEZ73f0CkXaXp7hrann)
  CODEX_EXPECTED_SCOPES?: string;                  // Comma-separated expected scopes for upstream validation (warning log only)
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
  BROWSER_PROXY_TIMEOUT_MS?: string;               // Timeout for browser sidecar proxy requests (default: 30000)
  // Neko browser sidecar cloud-init configuration
  NEKO_IMAGE?: string;                             // Docker image for Neko browser sidecar (default: ghcr.io/m1k1o/neko/google-chrome:latest)
  NEKO_PRE_PULL?: string;                          // Pre-pull Neko image during cloud-init: "true" or "false" (default: "true")
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
  // Project file library (all configurable per constitution Principle XI)
  LIBRARY_ENCRYPTION_KEY?: string;               // Purpose-specific KEK for file library (falls back to ENCRYPTION_KEY)
  LIBRARY_UPLOAD_MAX_BYTES?: string;             // Max file size per upload (default: 50MB)
  FILE_PREVIEW_MAX_BYTES?: string;               // Max file size for inline preview (default: 50MB)
  LIBRARY_MAX_FILES_PER_PROJECT?: string;        // Max files per project (default: 500)
  LIBRARY_MAX_TAGS_PER_FILE?: string;            // Max tags per file (default: 20)
  LIBRARY_MAX_TAG_LENGTH?: string;               // Max tag length in chars (default: 50)
  LIBRARY_MAX_FILENAME_LENGTH?: string;           // Max filename length in chars (default: 255)
  LIBRARY_DOWNLOAD_TIMEOUT_MS?: string;          // Download timeout (default: 60000)
  LIBRARY_LIST_DEFAULT_PAGE_SIZE?: string;       // Default page size for list (default: 50)
  LIBRARY_LIST_MAX_PAGE_SIZE?: string;           // Max page size for list (default: 200)
  LIBRARY_KEY_VERSION?: string;                  // KEK version stamped on new encryptions (default: 1)
  LIBRARY_MCP_DOWNLOAD_DIR?: string;             // Workspace directory for library downloads (default: .library)
  LIBRARY_MCP_TRANSFER_TIMEOUT_MS?: string;      // Timeout for VM agent file transfers (default: 60000)
  LIBRARY_MAX_DIRECTORY_DEPTH?: string;          // Max directory nesting depth (default: 10)
  LIBRARY_MAX_DIRECTORY_PATH_LENGTH?: string;    // Max directory path length in chars (default: 500)
  LIBRARY_MAX_DIRECTORIES_PER_PROJECT?: string;  // Max directories per project (default: 500)
  // Compute usage metering
  COMPUTE_USAGE_RECENT_RECORDS_LIMIT?: string;  // Max recent records in admin user detail (default: 50)
  // Compute quota enforcement
  COMPUTE_QUOTA_ENFORCEMENT_ENABLED?: string;    // Kill switch for quota checks (default: true)
  // Event-driven triggers (cron) configuration
  MAX_TRIGGERS_PER_PROJECT?: string;                 // Max triggers per project (default: 10)
  CRON_MIN_INTERVAL_MINUTES?: string;               // Min cron interval in minutes (default: 15)
  CRON_MAX_FIRE_PER_SWEEP?: string;                 // Max triggers to fire per 5-min sweep (default: 5)
  CRON_TEMPLATE_MAX_LENGTH?: string;                // Max prompt template length (default: 8000)
  CRON_TEMPLATE_MAX_FIELD_LENGTH?: string;          // Max per-field interpolated value length (default: 2000)
  TRIGGER_AUTO_PAUSE_AFTER_FAILURES?: string;       // Auto-pause after N consecutive failures (default: 3)
  CRON_SWEEP_ENABLED?: string;                      // Kill switch: "false" to disable cron sweep (default: enabled)
  TRIGGER_NAME_MAX_LENGTH?: string;                 // Max trigger name length (default: 100)
  TRIGGER_MAX_CONCURRENT_LIMIT?: string;            // Upper bound for maxConcurrent per trigger (default: 10)
  // Trigger execution cleanup
  TRIGGER_STALE_EXECUTION_TIMEOUT_MS?: string;      // Timeout before running executions are considered stale (default: 1800000 = 30 min)
  TRIGGER_STALE_QUEUED_TIMEOUT_MS?: string;         // Timeout before queued executions are considered stale (default: 300000 = 5 min)
  TRIGGER_EXECUTION_LOG_RETENTION_DAYS?: string;    // Days to retain completed/failed/skipped execution logs (default: 90)
  TRIGGER_EXECUTION_CLEANUP_ENABLED?: string;       // Kill switch: "false" to disable cleanup sweep (default: enabled)
  TRIGGER_STALE_RECOVERY_BATCH_SIZE?: string;       // Max stale executions to recover per sweep (default: 100)
}
