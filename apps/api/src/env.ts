// FILE SIZE EXCEPTION: Single flat Worker environment contract (one Env interface) — splitting fields across extends-chain fragments mid-hotfix creates import/review churn without behavior benefit. Tracked split: tasks/backlog/2026-07-19-split-env-interface.md. See .claude/rules/18-file-size-limits.md
import type { Sandbox } from '@cloudflare/sandbox';

import type { VmAgentContainer } from './durable-objects/vm-agent-container';
import type { TaskRecoveryEnv } from './task-recovery-env';
import type { WebhookTriggerEnv } from './webhook-trigger-env';

export interface Env extends WebhookTriggerEnv, TaskRecoveryEnv {
  // D1 Database
  DATABASE: D1Database;
  // KV for sessions
  KV: KVNamespace;
  // R2 for VM Agent binaries
  R2: R2Bucket;
  // Workers AI for speech-to-text transcription
  AI: Ai;
  // Cloudflare Artifacts for SAM-native Git repos (optional — absent when ARTIFACTS_ENABLED is falsy)
  ARTIFACTS?: {
    create(
      name: string,
      opts?: { description?: string; setDefaultBranch?: string }
    ): Promise<{
      id: string;
      name: string;
      remote: string;
      token: string;
      default_branch: string;
    }>;
    delete(name: string): Promise<boolean>;
    get(name: string): Promise<{
      id: string;
      name: string;
      remote: string;
      defaultBranch: string;
      createToken(
        scope?: 'read' | 'write',
        ttl?: number
      ): Promise<{
        id: string;
        plaintext: string;
        scope: string;
        expiresAt?: string;
        expires_at?: string;
      }>;
    }>;
  };
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
  GITHUB_USER_ACCESS_TOKEN_LOCK: DurableObjectNamespace;
  GITLAB_USER_ACCESS_TOKEN_LOCK?: DurableObjectNamespace;
  TRIAL_COUNTER: DurableObjectNamespace;
  TRIAL_EVENT_BUS: DurableObjectNamespace;
  TRIAL_ORCHESTRATOR: DurableObjectNamespace;
  PROJECT_ORCHESTRATOR: DurableObjectNamespace;
  SAM_SESSION: DurableObjectNamespace;
  PROJECT_AGENT: DurableObjectNamespace;
  AI_TOKEN_BUDGET_COUNTER?: DurableObjectNamespace;
  // Guided agent credential setup terminal (Cloudflare Sandbox) — per-session state
  // machine + capture loop, and a singleton concurrency-admission pool. Optional so
  // Miniflare tests that don't exercise the feature need not bind them.
  CREDENTIAL_SETUP_SESSION?: DurableObjectNamespace;
  SETUP_SESSION_POOL?: DurableObjectNamespace;
  // Raw Cloudflare Container for productized instant-session vm-agent runtime
  VM_AGENT_CONTAINER?: DurableObjectNamespace<VmAgentContainer>;
  // Sandbox SDK (experimental toolbox/diagnostics substrate, not the product vm-agent supervisor)
  SANDBOX?: DurableObjectNamespace<Sandbox>;
  // Environment variables
  BASE_DOMAIN: string;
  VERSION: string;
  // Secrets
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string; // GitHub App slug for install URL
  GITLAB_HOST?: string; // Optional GitLab OAuth host fallback, e.g. https://gitlab.com
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  GITLAB_API_TIMEOUT_MS?: string; // Timeout for GitLab API calls in ms (default: 30000)
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  CF_ACCOUNT_ID: string;
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  ENCRYPTION_KEY: string;
  // Purpose-specific secret overrides (fall back to ENCRYPTION_KEY when unset)
  BETTER_AUTH_SECRET?: string; // BetterAuth session management
  CREDENTIAL_ENCRYPTION_KEY?: string; // AES-GCM user credential encryption
  GITHUB_WEBHOOK_SECRET?: string; // GitHub webhook HMAC verification
  SETUP_TOKEN?: string; // Plaintext first-run setup token, dashboard-readable while setup is incomplete
  SETUP_FORCE?: string; // "true" reopens /setup for lockout recovery
  SETUP_RATE_LIMIT_MAX_ATTEMPTS?: string; // Max setup-token attempts per identifier/window (default: 10)
  SETUP_RATE_LIMIT_WINDOW_SECONDS?: string; // Setup-token attempt window in seconds (default: 900)
  // Guided credential setup terminal (Codex login via Cloudflare Sandbox)
  CODEX_SETUP_TERMINAL_ENABLED?: string; // "true" enables the guided Codex login terminal (default: off)
  MAX_CONCURRENT_SETUP_SESSIONS?: string; // Concurrency sub-cap below the Sandbox container max_instances (default: 2)
  SETUP_SESSION_TTL_MS?: string; // Setup session lifetime in ms before auto-teardown (default: 900000 = 15 min)
  SETUP_SESSION_CAPTURE_POLL_MS?: string; // auth.json capture poll interval in ms (default: 3000)
  CREDENTIAL_SETUP_TERMINAL_TOKEN_EXPIRY_MS?: string; // Setup terminal WS token TTL in ms (default: 300000 = 5 min)
  SETUP_SESSION_SWEEP_MAX_CANDIDATES?: string; // Max expired sessions torn down per cron sweep (default: 50)
  POOL_LEASE_BUFFER_MS?: string; // Grace beyond TTL before a leaked pool lease self-prunes (default: 300000 = 5 min)
  // Deployment signing keys (Ed25519 — separate from callback JWT)
  DEPLOY_SIGNING_PRIVATE_KEY?: string; // Base64-encoded Ed25519 private key for payload signing
  DEPLOY_SIGNING_PUBLIC_KEY?: string; // Base64-encoded Ed25519 public key delivered to deployment nodes
  // Pages project name for proxying app.* requests
  PAGES_PROJECT_NAME?: string;
  // Pages project name for proxying www.* requests (marketing site)
  WWW_PAGES_PROJECT_NAME?: string;
  // User approval / invite-only mode
  REQUIRE_APPROVAL?: string;
  // Smoke test auth tokens (CI authentication — only set in staging/test environments)
  API_TOKEN_BYTES?: string; // Random bytes for token generation (default: 32)
  MAX_API_TOKENS_PER_USER?: string; // Max active tokens per user (default: 10)
  MAX_API_TOKEN_NAME_LENGTH?: string; // Max token name length (default: 100)
  API_TOKEN_SESSION_DURATION_SECONDS?: string; // Session lifetime for token login (default: 604800 = 7 days)
  PROJECT_INVITE_TOKEN_BYTES?: string; // Random bytes for project invite links (default: 32)
  PROJECT_INVITE_DEFAULT_EXPIRY_DAYS?: string; // Default invite-link lifetime (default: 7)
  PROJECT_INVITE_MAX_EXPIRY_DAYS?: string; // Maximum invite-link lifetime (default: 30)
  PROJECT_OFFBOARDING_PLAN_TTL_SECONDS?: string; // Preview plan lifetime before apply must recompute (default: 900 = 15 min)
  DEVICE_FLOW_CODE_TTL_SECONDS?: string;
  DEVICE_FLOW_POLL_INTERVAL_SECONDS?: string;
  RATE_LIMIT_DEVICE_CODE_CREATE?: string;
  RATE_LIMIT_DEVICE_POLL?: string;
  // Optional configurable values (per constitution principle XI)
  TERMINAL_TOKEN_EXPIRY_MS?: string;
  CALLBACK_TOKEN_EXPIRY_MS?: string;
  PORT_ACCESS_TOKEN_EXPIRY_MS?: string; // Port access JWT expiry in ms (default: 900000 = 15 min)
  PORT_ACCESS_COOKIE_MAX_AGE_SECONDS?: string; // Port access cookie Max-Age in seconds (default: 14400 = 4 hr)
  LOCAL_FORWARD_TOKEN_EXPIRY_MS?: string; // CLI local-forward JWT expiry in ms (default: 300000 = 5 min)
  BOOTSTRAP_TOKEN_TTL_SECONDS?: string;
  PROVISIONING_TIMEOUT_MS?: string;
  DNS_TTL_SECONDS?: string;
  DOH_RESOLVER_URL?: string; // Cloudflare DoH resolver base for custom-domain verification (default: https://cloudflare-dns.com/dns-query)
  DOH_TIMEOUT_MS?: string; // Timeout for DoH custom-domain lookups in ms (default: 10000)
  DEPLOY_PAYLOAD_EXPIRY_SECONDS?: string;
  DEPLOYMENT_ROUTE_PORT_BASE?: string;
  DEPLOYMENT_ROUTE_PORT_SPAN?: string;
  AGENT_DEPLOYMENT_RESERVED_ENVIRONMENT_NAMES?: string; // Comma-separated names agents cannot create via MCP (default: prod,production)
  MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE?: string;
  DEPLOYMENT_DEFAULT_VM_SIZE?: string; // Default VM size for deployment nodes (default: small)
  DEPLOYMENT_MODEL_RUNNER_VM_SIZE?: string; // VM size for deployment nodes running Docker Model Runner (default: medium)
  DEPLOYMENT_DEFAULT_MEMORY_LIMIT_MB?: string; // Default per-service memory limit for compose-publish applies (default: 256)
  DEPLOYMENT_LOG_MAX_SIZE?: string; // Default json-file log max-size for compose-publish applies (default: 10m)
  DEPLOYMENT_LOG_MAX_FILE?: string; // Default json-file log max-file for compose-publish applies (default: 3)
  MCP_DEPLOYMENT_COMPOSE_PREVIEW_MAX_BYTES?: string; // Max composeYaml bytes accepted by deployment route preview MCP tool
  COMPOSE_IMAGE_ARTIFACT_MAX_BYTES?: string; // Max single docker-save archive size for R2 compose-publish MVP
  COMPOSE_IMAGE_ARTIFACT_UPLOAD_URL_TTL_SECONDS?: string; // Presigned upload URL TTL for compose image artifacts
  COMPOSE_IMAGE_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS?: string; // Presigned download URL TTL for compose image artifacts
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_ENABLED?: string; // Kill switch: "false" disables abandoned artifact cleanup (default: enabled)
  COMPOSE_IMAGE_ARTIFACT_ABANDONED_RETENTION_HOURS?: string; // Hours to keep unreferenced uploaded artifacts before cleanup (default: 48)
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_BATCH_SIZE?: string; // Max abandoned compose artifacts to delete per cleanup run (default: 50)
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_INTERVAL_HOURS?: string; // Minimum hours between R2 cleanup scans from cron (default: 24)
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_LAST_RUN_KV_KEY?: string; // KV key for cleanup interval gating
  SESSION_SNAPSHOT_TTL_DAYS?: string; // Runtime hibernate snapshot retention (default: 7)
  SESSION_SNAPSHOT_R2_PREFIX?: string; // R2 key prefix for runtime hibernate snapshots
  SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES?: string; // Max combined home/WIP snapshot size (default: 104857600)
  SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES?: string; // Max individual file/dir included by vm-agent scanner (default: 52428800)
  SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS?: string; // No-progress upload/download watchdog window (default: 30000)
  SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES?: string; // Max snapshot control-plane JSON request size (default: 262144)
  DEPLOY_ACME_EMAIL?: string; // Contact email for deployment-node ACME certificates
  DEPLOY_ACME_CA?: string; // ACME CA directory override for deployment nodes
  DEPLOY_COMPOSE_CMD?: string; // Docker Compose command override on deployment nodes
  DEPLOY_HEALTH_TIMEOUT?: string; // Deployment health check timeout as Go duration (default: 5m)
  // Rate limiting (per hour)
  RATE_LIMIT_WORKSPACE_CREATE?: string;
  RATE_LIMIT_TERMINAL_TOKEN?: string;
  RATE_LIMIT_CREDENTIAL_UPDATE?: string;
  RATE_LIMIT_ANONYMOUS?: string;
  RATE_LIMIT_TRIAL_CREATE?: string;
  RATE_LIMIT_IDENTITY_TOKEN?: string;
  RATE_LIMIT_IDENTITY_TOKEN_WINDOW_SECONDS?: string;
  /**
   * Max Codex refresh requests per user per window. Defaults to 30. Enforced
   * atomically by CodexRefreshLock DO using ctx.storage (not KV). See
   * {@link CodexRefreshEnv} in codex-refresh-lock.ts for the authoritative
   * declaration — this is a Worker-level re-export so operators can configure
   * the variable via wrangler.toml / `wrangler secret put`.
   */
  RATE_LIMIT_CODEX_REFRESH_PER_HOUR?: string;
  RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS?: string;
  IDENTITY_TOKEN_CACHE_BUFFER_SECONDS?: string;
  IDENTITY_TOKEN_CACHE_MIN_TTL_SECONDS?: string;
  // Hierarchy limits
  MAX_NODES_PER_USER?: string;
  MAX_WORKSPACES_PER_NODE?: string;
  MAX_AGENT_SESSIONS_PER_WORKSPACE?: string;
  MAX_PROJECTS_PER_USER?: string;
  MAX_BRANCHES_PER_REPO?: string;
  GITHUB_REPO_ID_BACKFILL_BATCH_SIZE?: string; // Max projects healed per bulk backfill invocation (default: 50)
  GITHUB_INSTALLATION_LEAK_SWEEP_BATCH_SIZE?: string; // Max personal installations checked per leak-sweep invocation (default: 50)
  MAX_TASKS_PER_PROJECT?: string;
  MAX_TASK_DEPENDENCIES_PER_TASK?: string;
  MAX_SECRETS_PER_ENVIRONMENT?: string;
  TASK_LIST_DEFAULT_PAGE_SIZE?: string;
  TASK_LIST_MAX_PAGE_SIZE?: string;
  MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT?: string;
  MAX_PROJECT_RUNTIME_FILES_PER_PROJECT?: string;
  MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES?: string;
  MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES?: string;
  MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH?: string;
  MAX_DEPLOYMENT_ENV_VARS_PER_ENVIRONMENT?: string;
  MAX_DEPLOYMENT_ENV_VALUE_BYTES?: string;
  MAX_DEPLOYMENT_ENV_TOTAL_BYTES?: string;
  AGENT_SETTINGS_VALIDATION_LIMITS?: string;
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
  CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT?: string; // Max terminal cf-container nodes to destroy per cron run (default: 25)
  // Workspace idle timeout (global default, overridable per-project)
  WORKSPACE_IDLE_TIMEOUT_MS?: string;
  // Auto-delete stopped workspaces after this TTL (default: 300000 = 5 minutes)
  WORKSPACE_STOPPED_TTL_MS?: string;
  // Task agent configuration
  DEFAULT_TASK_AGENT_TYPE?: string;
  // Task execution timeout (stuck task recovery)
  TASK_RUN_MAX_EXECUTION_MS?: string;
  TASK_RUN_HARD_TIMEOUT_MS?: string;
  TASK_STUCK_QUEUED_TIMEOUT_MS?: string;
  TASK_STUCK_DELEGATED_TIMEOUT_MS?: string;
  CLAUDE_CODE_COMPACTION_LOOP_DETECTOR_ENABLED?: string;
  CLAUDE_CODE_COMPACTION_LOOP_RECENT_MESSAGE_LIMIT?: string;
  CLAUDE_CODE_COMPACTION_LOOP_WINDOW_MESSAGES?: string;
  CLAUDE_CODE_COMPACTION_LOOP_MIN_PAIRS?: string;
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
  // Swap file configuration
  SWAP_SIZE_MB?: string; // Swap file size in MB (default: 2048, set to "0" to disable)
  SWAP_SWAPPINESS?: string; // vm.swappiness value 0-100 (default: 60)
  // Hetzner base image override (e.g., "ubuntu-24.04" to roll back from the
  // default "docker-ce" marketplace image). Only applies to Hetzner nodes.
  HETZNER_BASE_IMAGE?: string;
  // Hetzner capacity retry configuration (for transient 422 errors)
  HETZNER_CAPACITY_RETRY_INITIAL_DELAY_MS?: string;
  HETZNER_CAPACITY_RETRY_MAX_DELAY_MS?: string;
  HETZNER_CAPACITY_RETRY_MAX_ATTEMPTS?: string;
  HETZNER_CAPACITY_RETRY_BUDGET_MS?: string;
  // Vultr provider tuning (optional; DEFAULT_VULTR_* apply otherwise)
  VULTR_REGION?: string;
  VULTR_OS_NAME?: string;
  VULTR_API_TIMEOUT_MS?: string;
  VULTR_IP_POLL_TIMEOUT_MS?: string;
  VULTR_IP_POLL_INTERVAL_MS?: string;
  // External API timeouts (milliseconds)
  HETZNER_API_TIMEOUT_MS?: string;
  CF_API_TIMEOUT_MS?: string;
  AGENT_CREDENTIAL_VALIDATION_TIMEOUT_MS?: string;
  NODE_AGENT_REQUEST_TIMEOUT_MS?: string;
  // Project data DO limits
  CACHED_COMMANDS_MAX_PER_AGENT?: string;
  CACHED_COMMANDS_MAX_AGENT_TYPE_LENGTH?: string;
  CACHED_COMMANDS_MAX_NAME_LENGTH?: string;
  CACHED_COMMANDS_MAX_DESC_LENGTH?: string;
  MAX_SESSIONS_PER_PROJECT?: string;
  MAX_MESSAGES_PER_SESSION?: string;
  DOCUMENT_CARD_RAW_OUTPUT_MAX_BYTES?: string; // Max document-card rawOutput bytes preserved in compact message metadata (default: 16384)
  MESSAGE_SIZE_THRESHOLD?: string;
  ACTIVITY_RETENTION_DAYS?: string;
  SESSION_IDLE_TIMEOUT_MINUTES?: string;
  SESSION_ACTIVITY_STALE_THRESHOLD_MS?: string;
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
  TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH?: string;
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
  // Durable Object RPC retry configuration for transient reset/overload errors
  DO_RETRY_MAX_ATTEMPTS?: string;
  DO_RETRY_BASE_DELAY_MS?: string;
  DO_RETRY_MAX_DELAY_MS?: string;
  // TaskRunner DO configuration (TDF-2: alarm-driven orchestration)
  TASK_RUNNER_STEP_MAX_RETRIES?: string;
  TASK_RUNNER_RETRY_BASE_DELAY_MS?: string;
  TASK_RUNNER_RETRY_MAX_DELAY_MS?: string;
  TASK_RUNNER_AGENT_POLL_INTERVAL_MS?: string;
  TASK_RUNNER_AGENT_READY_TIMEOUT_MS?: string;
  TASK_RUNNER_WORKSPACE_DISPATCH_TIMEOUT_MS?: string;
  TASK_RUNNER_WORKSPACE_DISPATCH_BASE_DELAY_MS?: string;
  TASK_RUNNER_WORKSPACE_DISPATCH_MAX_DELAY_MS?: string;
  TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS?: string;
  TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS?: string;
  TASK_RUNNER_PROVISION_POLL_INTERVAL_MS?: string;
  TASK_RUNNER_PROVISION_TIMEOUT_MS?: string;
  // Callback token refresh threshold (ratio of token lifetime, default 0.5)
  CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO?: string;
  // MCP token TTL in seconds (default 28800 = 8 hours, inactivity timeout with sliding window)
  MCP_TOKEN_TTL_SECONDS?: string;
  // MCP token maximum lifetime in seconds regardless of activity (default 86400 = 24 hours)
  MCP_TOKEN_MAX_LIFETIME_SECONDS?: string;
  // MCP HTTP-level rate limiting (per task/agent)
  MCP_RATE_LIMIT?: string; // Max requests per window (default: 120)
  MCP_RATE_LIMIT_WINDOW_SECONDS?: string; // Rate limit window in seconds (default: 60)
  // MCP dispatch_task limits (agent-to-agent task spawning)
  MCP_DISPATCH_MAX_DEPTH?: string; // Max dispatch chain depth (default: 3)
  MCP_DISPATCH_MAX_PER_TASK?: string; // Max tasks a single agent can dispatch (default: 5)
  MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT?: string; // Max concurrent agent-dispatched tasks per project (default: 10)
  MCP_DISPATCH_DESCRIPTION_MAX_LENGTH?: string; // Max description length for dispatched tasks (default: 32000)
  MCP_DISPATCH_MAX_REFERENCES?: string; // Max reference URLs per dispatch (default: 20)
  MCP_DISPATCH_MAX_REFERENCE_LENGTH?: string; // Max length per reference string (default: 500)
  MCP_DISPATCH_MAX_PRIORITY?: string; // Max priority for agent-dispatched tasks (default: 100)
  // Orchestration tools (retry, dependency, remove, send_message, stop)
  ORCHESTRATOR_MAX_RETRIES_PER_TASK?: string; // Max retry attempts per task (default: 3)
  ORCHESTRATOR_DEPENDENCY_MAX_EDGES?: string; // Max dependency edges per project (default: 50)
  ORCHESTRATOR_STOP_GRACE_MS?: string; // Grace period before hard stop after warning (default: 5000)
  ORCHESTRATOR_MESSAGE_MAX_LENGTH?: string; // Max length for injected messages to child agents (default: 32768)
  // Attention markers
  HUMAN_INPUT_TIMEOUT_MS?: string; // Attention marker expiry for needs_input (default: 7200000 = 2 hours)
  // Task reconciliation (inactivity check-in)
  TASK_RECONCILIATION_IDLE_MS?: string; // Idle threshold before SAM check-in (default: 300000 = 5 minutes)
  TASK_RECONCILIATION_RESPONSE_DEADLINE_MS?: string; // Response deadline after check-in (default: 60000 = 1 minute)
  TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS?: string; // In-flight prompt observation threshold (default: 1800000 = 30 minutes)
  TASK_RECONCILIATION_PROMPT_HARD_STALL_MS?: string; // In-flight prompt cancel threshold (default: 7200000 = 2 hours)
  TASK_RECONCILIATION_MIN_ALARM_DELAY_MS?: string; // Minimum reconciliation alarm delay (default: 10000 = 10 seconds)
  TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP?: string; // Max candidates processed per alarm sweep (default: 5)
  TASK_RECONCILIATION_NODE_HEARTBEAT_STALE_MS?: string; // Node heartbeat freshness threshold for reconciliation delivery (default: 300000 = 5 minutes)
  TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS?: string; // Short timeout for reconciliation-originated node calls (default: 5000 = 5 seconds)
  // Durable mailbox (Phase 1 orchestrator messaging)
  MAILBOX_ACK_TIMEOUT_MS?: string; // Ack timeout before re-delivery (default: 300000)
  MAILBOX_REDELIVERY_MAX_ATTEMPTS?: string; // Max delivery attempts before expiry (default: 5)
  MAILBOX_TTL_MS?: string; // Default message TTL (default: 3600000)
  MAILBOX_DELIVERY_POLL_INTERVAL_MS?: string; // DO alarm sweep interval (default: 30000)
  MAILBOX_MAX_MESSAGES_PER_PROJECT?: string; // Max active messages per project (default: 1000)
  MAILBOX_MESSAGE_MAX_LENGTH?: string; // Max message content length (default: 32768)
  // MCP get_session_messages limits
  MCP_MESSAGE_LIST_LIMIT?: string; // Default raw tokens per request (default: 50)
  MCP_MESSAGE_LIST_MAX?: string; // Max raw tokens per request (default: 200)
  MCP_MESSAGE_SEARCH_MAX?: string; // Max search results for search_messages (default: 20)
  MCP_DEPLOYMENT_LOG_DEFAULT_LIMIT?: string; // Default deployment log rows for read_deployment_logs (default: 200)
  MCP_DEPLOYMENT_LOG_MAX_LIMIT?: string; // Max deployment log rows for read_deployment_logs (default: 1000)
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
  MCP_IDEA_CONTEXT_MAX_LENGTH?: string; // Max length for idea link context string (default: 500)
  MCP_IDEA_CONTENT_MAX_LENGTH?: string; // Max length for idea content/description (default: 65536)
  MCP_IDEA_LIST_LIMIT?: string; // Default page size for list_ideas (default: 20)
  MCP_IDEA_LIST_MAX?: string; // Max page size for list_ideas (default: 100)
  MCP_IDEA_SEARCH_MAX?: string; // Max results for search_ideas (default: 20)
  MCP_IDEA_TITLE_MAX_LENGTH?: string; // Max length for idea title (default: 200)
  MCP_SESSION_TOPIC_MAX_LENGTH?: string; // Max length for session topic (default: 200)
  // Knowledge graph limits
  KNOWLEDGE_MAX_ENTITIES_PER_PROJECT?: string; // Max knowledge entities per project (default: 500)
  KNOWLEDGE_MAX_OBSERVATIONS_PER_ENTITY?: string; // Max observations per entity (default: 100)
  KNOWLEDGE_SEARCH_LIMIT?: string; // Max search results (default: 20)
  KNOWLEDGE_AUTO_RETRIEVE_LIMIT?: string; // Max auto-retrieved observations on session start (default: 20)
  KNOWLEDGE_AUTO_RETRIEVE_MIN_CONFIDENCE?: string; // Min confidence for auto-retrieved observations (default: 0.8)
  KNOWLEDGE_AUTO_RETRIEVE_HIGH_CONFIDENCE_LIMIT?: string; // Max high-confidence observations to retrieve (default: 50)
  KNOWLEDGE_OBSERVATION_MAX_LENGTH?: string; // Max observation text length (default: 1000)
  KNOWLEDGE_ENTITY_NAME_MAX_LENGTH?: string; // Max entity name length (default: 200)
  KNOWLEDGE_DESCRIPTION_MAX_LENGTH?: string; // Max entity description length (default: 2000)
  KNOWLEDGE_LIST_PAGE_SIZE?: string; // Default page size for entity list (default: 50)
  KNOWLEDGE_LIST_MAX_PAGE_SIZE?: string; // Max page size for entity list (default: 200)
  KNOWLEDGE_SEARCH_MAX_LIMIT?: string; // Max search results cap (default: 100)
  // Mission orchestration limits
  MISSION_MAX_PER_PROJECT?: string; // Max missions per project (default: 50)
  MISSION_MAX_STATE_ENTRIES?: string; // Max state entries per mission (default: 200)
  MISSION_MAX_HANDOFFS?: string; // Max handoff packets per mission (default: 100)
  MISSION_TITLE_MAX_LENGTH?: string; // Max mission title length (default: 200)
  MISSION_DESCRIPTION_MAX_LENGTH?: string; // Max mission description length (default: 5000)
  MISSION_STATE_TITLE_MAX_LENGTH?: string; // Max state entry title length (default: 200)
  MISSION_STATE_CONTENT_MAX_LENGTH?: string; // Max state entry content length (default: 2000)
  HANDOFF_SUMMARY_MAX_LENGTH?: string; // Max handoff summary length (default: 5000)
  HANDOFF_MAX_FACTS?: string; // Max facts per handoff (default: 50)
  HANDOFF_MAX_OPEN_QUESTIONS?: string; // Max open questions per handoff (default: 20)
  HANDOFF_MAX_ARTIFACT_REFS?: string; // Max artifact refs per handoff (default: 30)
  HANDOFF_MAX_SUGGESTED_ACTIONS?: string; // Max suggested actions per handoff (default: 20)
  MISSION_LIST_PAGE_SIZE?: string; // Default mission list page size (default: 20)
  MISSION_LIST_MAX_PAGE_SIZE?: string; // Max mission list page size (default: 100)
  // Project Orchestrator (Phase 3)
  ORCHESTRATOR_SCHEDULING_INTERVAL_MS?: string; // Scheduling loop interval (default: 30000)
  ORCHESTRATOR_STALL_TIMEOUT_MS?: string; // Stall detection threshold (default: 1200000)
  ORCHESTRATOR_MAX_DISPATCHES_PER_CYCLE?: string; // Max dispatches per cycle (default: 5)
  ORCHESTRATOR_MAX_ACTIVE_TASKS_PER_MISSION?: string; // Max active tasks per mission (default: 5)
  ORCHESTRATOR_DECISION_LOG_MAX_ENTRIES?: string; // Max decision log entries (default: 500)
  ORCHESTRATOR_RECENT_DECISIONS_LIMIT?: string; // Recent decisions in status (default: 20)
  ORCHESTRATOR_QUEUE_MAX_ENTRIES?: string; // Max scheduling queue entries (default: 100)
  // Policy Propagation (Phase 4)
  POLICY_MAX_PER_PROJECT?: string; // Max active policies per project (default: 100)
  POLICY_TITLE_MAX_LENGTH?: string; // Max policy title length (default: 200)
  POLICY_CONTENT_MAX_LENGTH?: string; // Max policy content length (default: 2000)
  POLICY_LIST_PAGE_SIZE?: string; // Default policy list page size (default: 50)
  POLICY_LIST_MAX_PAGE_SIZE?: string; // Max policy list page size (default: 200)
  POLICY_DEFAULT_CONFIDENCE?: string; // Default policy confidence (default: 0.8)
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
  VM_AGENT_PROTOCOL?: string; // "https" (default) or "http"
  VM_AGENT_PORT?: string; // "8443" (default) or custom port
  // Devcontainer image caching
  DEVCONTAINER_CACHE_ENABLED?: string; // "true" to enable managed registry caching (default: disabled)
  DEVCONTAINER_CACHE_CLOUDFLARE_ACCOUNT_ID?: string; // Cloudflare account for managed registry credentials
  DEVCONTAINER_CACHE_CLOUDFLARE_API_TOKEN?: string; // Token allowed to mint managed registry credentials
  DEVCONTAINER_CACHE_REGISTRY_HOST?: string; // Registry host (default: registry.cloudflare.com)
  DEVCONTAINER_CACHE_REPOSITORY_PREFIX?: string; // Optional cache repository name prefix
  DEVCONTAINER_CACHE_CREDENTIAL_EXPIRATION_MINUTES?: string; // Temporary registry credential TTL
  // Deployment registry credentials (pivot option 1: server-minted short-lived credentials)
  REGISTRY_CREDENTIAL_EXPIRATION_MINUTES?: string; // TTL for minted registry credentials (default: 60)
  REGISTRY_HOST?: string; // Registry host override (default: registry.cloudflare.com)
  REGISTRY_CREDENTIAL_RATE_LIMIT?: string; // Max credential mints per project per window (default: 10)
  REGISTRY_CREDENTIAL_RATE_WINDOW_SECONDS?: string; // Rate limit window in seconds (default: 300)
  // Workspace tool proxy configuration (unified from workspace-mcp)
  WORKSPACE_TOOL_TIMEOUT_MS?: string; // Timeout for VM agent proxy calls (default: 15000)
  BUILD_PUBLISH_TOOL_TIMEOUT_MS?: string; // Legacy timeout for synchronous build_and_publish VM agent proxy (default: 1260000)
  BUILD_PUBLISH_START_TIMEOUT_MS?: string; // Timeout for async build_and_publish VM job acceptance (default: 30000)
  WORKSPACE_TOOL_GITHUB_TIMEOUT_MS?: string; // Timeout for GitHub API calls (default: 10000)
  WORKSPACE_TOOL_DNS_TIMEOUT_MS?: string; // Timeout for DNS check calls (default: 10000)
  WORKSPACE_TOOL_COST_PRICING_JSON?: string; // VM hourly pricing JSON (default: built-in pricing table)
  WORKSPACE_TOOL_CI_RUNS_LIMIT?: string; // Max CI runs to return (default: 10)
  WORKSPACE_TOOL_DEPLOY_RUNS_LIMIT?: string; // Max deployment runs to return (default: 5)
  WORKSPACE_TOOL_DIAGNOSTIC_MAX_BYTES?: string; // Max diagnostic data size in bytes (default: 4096)
  // Origin CA certificate issuance for VM-agent TLS
  ORIGIN_CA_CERT_VALIDITY_DAYS?: string; // Cloudflare-supported validity: 7, 30, 90, 365, 730, 1095, 5475 (default: 7)
  // Legacy Origin CA certificate/key retained only as manual rotation inputs for already-provisioned nodes.
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
  CODEX_REFRESH_PROXY_ENABLED?: string; // Kill switch: "false" to disable (default: enabled)
  CODEX_REFRESH_LOCK_TIMEOUT_MS?: string; // Per-user lock timeout (default: 30000)
  CODEX_REFRESH_UPSTREAM_URL?: string; // OpenAI token endpoint (default: https://auth.openai.com/oauth/token)
  CODEX_REFRESH_UPSTREAM_TIMEOUT_MS?: string; // Upstream request timeout (default: 10000)
  CODEX_CLIENT_ID?: string; // OpenAI OAuth client_id (default: app_EMoamEEZ73f0CkXaXp7hrann)
  CODEX_EXPECTED_SCOPES?: string; // Comma-separated scope allowlist; unset = default allowlist enforced (openid,profile,email,offline_access); empty string disables validation
  // Google OAuth for GCP/infra authorization flows (cloud-platform scope,
  // redirect /auth/google/callback + /api/deployment/gcp/callback).
  // NOT the login client — see GOOGLE_LOGIN_* below.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Google OAuth for user login (BetterAuth "Sign in with Google" social
  // provider; redirect /api/auth/callback/google, openid/email/profile scopes).
  // Kept separate from the infra client above so configuring sign-in never
  // rewires GCP access. Optional; also configurable via the first-run setup wizard.
  GOOGLE_LOGIN_CLIENT_ID?: string;
  GOOGLE_LOGIN_CLIENT_SECRET?: string;
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
  GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES?: string;
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
  ANALYTICS_ENABLED?: string; // "true" (default) or "false"
  ANALYTICS_SKIP_ROUTES?: string; // Comma-separated route patterns to skip
  ANALYTICS_SQL_API_URL?: string; // Override Analytics Engine SQL API URL
  ANALYTICS_DEFAULT_PERIOD_DAYS?: string; // Default query period (default: 30)
  ANALYTICS_DATASET?: string; // Dataset name (set by deployment from resource prefix)
  ANALYTICS_TOP_EVENTS_LIMIT?: string; // Max events in top events query (default: 50)
  ANALYTICS_GEO_LIMIT?: string; // Max countries in geo distribution (default: 50)
  ANALYTICS_RETENTION_WEEKS?: string; // Retention cohort lookback weeks (default: 12)
  ANALYTICS_WEBSITE_TRAFFIC_TOP_PAGES_LIMIT?: string; // Max top pages per section in website traffic (default: 20)
  // Analytics ingest endpoint (Phase 2 — client-side events)
  ANALYTICS_INGEST_ENABLED?: string; // "true" (default) or "false"
  RATE_LIMIT_ANALYTICS_INGEST?: string; // Rate limit per IP per hour (default: 500)
  MAX_ANALYTICS_INGEST_BATCH_SIZE?: string; // Max events per batch (default: 25)
  MAX_ANALYTICS_INGEST_BODY_BYTES?: string; // Max request body bytes (default: 65536)
  // Analytics forwarding (Phase 4 — external event export)
  ANALYTICS_FORWARD_ENABLED?: string; // "true" to enable forwarding (default: "false")
  ANALYTICS_FORWARD_EVENTS?: string; // Comma-separated event names to forward (default: key conversions)
  ANALYTICS_FORWARD_LOOKBACK_HOURS?: string; // Hours of data to query per run (default: 25)
  ANALYTICS_FORWARD_CURSOR_KEY?: string; // KV key for last-forwarded timestamp (default: "analytics-forward-cursor")
  SEGMENT_WRITE_KEY?: string; // Segment write key (enables Segment forwarding)
  SEGMENT_API_URL?: string; // Segment batch endpoint (default: https://api.segment.io/v1/batch)
  SEGMENT_MAX_BATCH_SIZE?: string; // Max events per Segment batch (default: 100)
  GA4_MEASUREMENT_ID?: string; // GA4 measurement ID (enables GA4 forwarding)
  GA4_API_SECRET?: string; // GA4 API secret
  GA4_API_URL?: string; // GA4 Measurement Protocol endpoint (default: https://www.google-analytics.com/mp/collect)
  GA4_MAX_BATCH_SIZE?: string; // Max events per GA4 request (default: 25)
  ANALYTICS_FORWARD_SQL_LIMIT?: string; // Max rows per forwarding query (default: 10000)
  ANALYTICS_SQL_FETCH_TIMEOUT_MS?: string; // Timeout for Analytics Engine SQL API fetch (default: 30000)
  SEGMENT_FETCH_TIMEOUT_MS?: string; // Timeout for Segment API fetch (default: 30000)
  GA4_FETCH_TIMEOUT_MS?: string; // Timeout for GA4 API fetch (default: 30000)
  // File proxy configuration (chat file browser)
  FILE_PROXY_TIMEOUT_MS?: string; // Timeout for VM agent file proxy requests (default: 15000)
  FILE_PROXY_MAX_RESPONSE_BYTES?: string; // Max response body size from VM agent file proxy (default: 2097152 = 2MB)
  FILE_RAW_PROXY_MAX_BYTES?: string; // Max response size for raw binary file proxy (default: 52428800 = 50MB)
  // File upload/download configuration
  // Note: Per-file size enforcement (FILE_UPLOAD_MAX_BYTES) is delegated to the VM agent.
  // The API layer only enforces batch size via Content-Length pre-check.
  FILE_UPLOAD_BATCH_MAX_BYTES?: string; // Max total batch upload size forwarded to VM agent (default: 262144000 = 250MB)
  FILE_UPLOAD_TIMEOUT_MS?: string; // Timeout for upload proxy requests in ms (default: 120000)
  FILE_DOWNLOAD_TIMEOUT_MS?: string; // Timeout for download proxy requests in ms (default: 60000)
  FILE_DOWNLOAD_MAX_BYTES?: string; // Max file download size forwarded from VM agent (default: 52428800 = 50MB)
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
  LIBRARY_ENCRYPTION_KEY?: string; // Purpose-specific KEK for file library (falls back to ENCRYPTION_KEY)
  LIBRARY_UPLOAD_MAX_BYTES?: string; // Max file size per upload (default: 50MB)
  FILE_PREVIEW_MAX_BYTES?: string; // Max file size for inline preview (default: 50MB)
  LIBRARY_MAX_FILES_PER_PROJECT?: string; // Max files per project (default: 500)
  LIBRARY_MAX_TAGS_PER_FILE?: string; // Max tags per file (default: 20)
  LIBRARY_MAX_TAG_LENGTH?: string; // Max tag length in chars (default: 50)
  LIBRARY_MAX_FILENAME_LENGTH?: string; // Max filename length in chars (default: 255)
  LIBRARY_DOWNLOAD_TIMEOUT_MS?: string; // Download timeout (default: 60000)
  LIBRARY_LIST_DEFAULT_PAGE_SIZE?: string; // Default page size for list (default: 50)
  LIBRARY_LIST_MAX_PAGE_SIZE?: string; // Max page size for list (default: 200)
  LIBRARY_TAG_QUERY_BATCH_SIZE?: string; // File IDs per tag lookup query (default: 80, capped at D1 bind limit)
  LIBRARY_KEY_VERSION?: string; // KEK version stamped on new encryptions (default: 1)
  LIBRARY_MCP_DOWNLOAD_DIR?: string; // Workspace directory for library downloads (default: .library)
  LIBRARY_MCP_TRANSFER_TIMEOUT_MS?: string; // Timeout for VM agent file transfers (default: 60000)
  LIBRARY_MCP_CAPTION_MAX_LENGTH?: string; // Max caption length for display_from_library cards (default: 500)
  LIBRARY_MAX_DIRECTORY_DEPTH?: string; // Max directory nesting depth (default: 10)
  LIBRARY_MAX_DIRECTORY_PATH_LENGTH?: string; // Max directory path length in chars (default: 500)
  LIBRARY_MAX_DIRECTORIES_PER_PROJECT?: string; // Max directories per project (default: 500)
  LIBRARY_MAX_SEARCH_LENGTH?: string; // Max search query length in chars (default: 200)
  // Compute usage metering
  COMPUTE_USAGE_RECENT_RECORDS_LIMIT?: string; // Max recent records in admin user detail (default: 50)
  // Compute quota enforcement
  COMPUTE_QUOTA_ENFORCEMENT_ENABLED?: string; // Kill switch for quota checks (default: true)
  // VM size fallback on transient capacity exhaustion
  CAPACITY_SIZE_FALLBACK_ENABLED?: string; // Kill switch: "false" disables size descent on capacity exhaustion (default: true)
  // Event-driven triggers (cron) configuration
  MAX_TRIGGERS_PER_PROJECT?: string; // Max triggers per project (default: 10)
  CRON_MIN_INTERVAL_MINUTES?: string; // Min cron interval in minutes (default: 15)
  CRON_MAX_FIRE_PER_SWEEP?: string; // Max triggers to fire per 5-min sweep (default: 5)
  CRON_TEMPLATE_MAX_LENGTH?: string; // Max prompt template length (default: 8000)
  CRON_TEMPLATE_MAX_FIELD_LENGTH?: string; // Max per-field interpolated value length (default: 2000)
  TRIGGER_AUTO_PAUSE_AFTER_FAILURES?: string; // Auto-pause after N consecutive failures (default: 3)
  CRON_SWEEP_ENABLED?: string; // Kill switch: "false" to disable cron sweep (default: enabled)
  GITHUB_TRIGGERS_ENABLED?: string; // Optional override: "false" disables, "true" enables; GH webhook secret enables by default
  TRIGGER_NAME_MAX_LENGTH?: string; // Max trigger name length (default: 100)
  TRIGGER_MAX_CONCURRENT_LIMIT?: string; // Upper bound for maxConcurrent per trigger (default: 10)
  // Trigger execution cleanup
  TRIGGER_STALE_EXECUTION_TIMEOUT_MS?: string; // Timeout before running executions are considered stale (default: 1800000 = 30 min)
  TRIGGER_STALE_QUEUED_TIMEOUT_MS?: string; // Timeout before queued executions are considered stale (default: 300000 = 5 min)
  TRIGGER_EXECUTION_LOG_RETENTION_DAYS?: string; // Days to retain completed/failed/skipped execution logs (default: 90)
  TRIGGER_EXECUTION_CLEANUP_ENABLED?: string; // Kill switch: "false" to disable cleanup sweep (default: enabled)
  TRIGGER_STALE_RECOVERY_BATCH_SIZE?: string; // Max stale executions to recover per sweep (default: 100)
  SESSION_TASK_REPAIR_BATCH_SIZE?: string; // Max legacy taskless sessions repaired per sweep (default: 25, max: 200)
  // AI Inference Proxy (Cloudflare AI Gateway — Workers AI + Anthropic)
  AI_PROXY_ENABLED?: string; // Kill switch: "false" to disable (default: enabled)
  AI_PROXY_DEFAULT_MODEL?: string; // Default model for OpenCode (default: claude-haiku-4-5-20251001)
  AI_PROXY_DEFAULT_ANTHROPIC_MODEL?: string; // Default model for Claude Code proxy (default: claude-sonnet-4-6)
  AI_PROXY_DEFAULT_OPENAI_MODEL?: string; // Default model for Codex proxy (default: gpt-4.1)
  AI_PROXY_ALLOWED_MODELS?: string; // Comma-separated allowed models
  MODEL_CATALOG_SOURCE_URL?: string; // OpenCode model catalog source URL (default: https://models.dev/api.json)
  MODEL_CATALOG_CACHE_TTL_SECONDS?: string; // KV cache TTL for dynamic model catalogs (default: 3600)
  MODEL_CATALOG_FETCH_TIMEOUT_MS?: string; // Upstream model catalog fetch timeout (default: 5000)
  AI_PROXY_DAILY_INPUT_TOKEN_LIMIT?: string; // Per-user daily input token cap (default: 500000)
  AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT?: string; // Per-user daily output token cap (default: 200000)
  AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST?: string; // Max input tokens per request (default: 32000)
  AI_PROXY_RATE_LIMIT_RPM?: string; // Requests per minute per user (default: 30)
  AI_PROXY_STREAM_TIMEOUT_MS?: string; // Max streaming duration in ms (default: 120000)
  AI_PROXY_RATE_LIMIT_WINDOW_SECONDS?: string; // Rate limit window in seconds (default: 60)
  AI_PROXY_BILLING_MODE?: string; // Billing mode: "unified" | "platform-key" | "auto" (default: auto)
  AI_MONTHLY_COST_CACHE_TTL_SECONDS?: string; // TTL for monthly cost KV cache entries in seconds (default: 7200, min: 60, max: 86400, invalid values fall back)
  AI_MONTHLY_COST_AGGREGATION_MAX_PAGES?: string; // Max AI Gateway log pages for monthly cost cron (default: 200, hard cap: 500, invalid values fall back)
  AI_GATEWAY_ID?: string; // Cloudflare AI Gateway ID (set by deployment from resource prefix)
  CF_AIG_TOKEN?: string; // Cloudflare AI Gateway Unified Billing token (optional — enables all providers without separate keys)
  AI_USAGE_PAGE_SIZE?: string; // AI Gateway logs page size for usage aggregation (1-50, default: 50, invalid values fall back)
  AI_USAGE_MAX_PAGES?: string; // Max pages to iterate for AI usage aggregation (default: 20, hard cap: 20, invalid values fall back)
  AI_USAGE_MAX_DAILY_TOKEN_LIMIT?: string; // Max daily token limit a user can set (default: 10000000)
  AI_USAGE_MIN_DAILY_TOKEN_LIMIT?: string; // Min daily token limit a user can set (default: 1000)
  AI_USAGE_MAX_MONTHLY_COST_CAP_USD?: string; // Max monthly cost cap (USD) a user can set (default: 10000)
  AI_USAGE_MIN_MONTHLY_COST_CAP_USD?: string; // Min monthly cost cap (USD) a user can set (default: 0.01)
  AI_USAGE_BUDGET_TTL_SECONDS?: string; // KV TTL for daily budget entries (default: 90000)
  // Cost Monitoring
  COST_MONITORING_ENABLED?: string; // Enable/disable cost monitoring endpoint (default: true)
  COMPUTE_VCPU_HOUR_COST_USD?: string; // Estimated cost per vCPU-hour in USD (default: 0.003)
  // Trial Onboarding (zero-friction URL-to-workspace)
  TRIAL_CLAIM_TOKEN_SECRET?: string; // Secret: HMAC key for sam_trial_claim / sam_trial_fingerprint cookies
  TRIAL_MONTHLY_CAP?: string; // Global cap per calendar month (default: 1500)
  TRIAL_WORKSPACE_TTL_MS?: string; // Trial workspace lifetime in ms (default: 1200000 = 20 min)
  TRIAL_DATA_RETENTION_HOURS?: string; // Hours to retain trial project data post-expiry (default: 168 = 7d)
  TRIAL_ANONYMOUS_USER_ID?: string; // Sentinel user id (default: system_anonymous_trials)
  TRIAL_AGENT_TYPE_STAGING?: string; // Agent used for trials in staging (default: opencode)
  TRIAL_AGENT_TYPE_PRODUCTION?: string; // Agent used for trials in production (default: claude-code)
  TRIAL_DEFAULT_WORKSPACE_PROFILE?: string; // Workspace profile (default: lightweight)
  TRIALS_ENABLED_KV_KEY?: string; // KV key read by kill-switch (default: trials:enabled)
  TRIAL_KILL_SWITCH_CACHE_MS?: string; // Kill-switch cache TTL in ms (default: 30000)
  TRIAL_REPO_MAX_KB?: string; // Max GitHub repo size in KB (default: 512000 = 500 MB)
  TRIAL_GITHUB_TIMEOUT_MS?: string; // Timeout for GitHub repo metadata probe (default: 5000)
  TRIAL_EXPIRE_BATCH_SIZE?: string; // Max trial rows to expire per cron sweep (default: 1000)
  TRIAL_CLEANUP_BATCH_SIZE?: string; // Max expired trial projects to inspect per cleanup sweep (default: 25)
  TRIAL_CLEANUP_DEADLINE_MS?: string; // Soft wall-clock cleanup budget per sweep (default: 45000)
  TRIAL_NODE_DELETION_LOCK_STALE_MS?: string; // Age before retrying a stuck trial node deletion lock (default: 600000)
  TRIAL_COUNTER_KEEP_MONTHS?: string; // Months of counter rows to retain in DO (default: 3)
  TRIAL_WAITLIST_PURGE_DAYS?: string; // Days after reset_date before notified waitlist rows are purged (default: 30)
  TRIAL_CRON_ROLLOVER_CRON?: string; // Cron expression used by the monthly rollover audit (default: 0 5 1 * *)
  TRIAL_CRON_WAITLIST_CLEANUP?: string; // Cron expression used by the daily waitlist cleanup (default: 0 4 * * *)
  TRIAL_SSE_HEARTBEAT_MS?: string; // SSE comment heartbeat cadence (default: 15000)
  TRIAL_SSE_POLL_TIMEOUT_MS?: string; // Long-poll timeout per DO fetch (default: 15000)
  TRIAL_SSE_MAX_DURATION_MS?: string; // Hard cap on a single SSE connection (default: 1800000 = 30 min)
  /** Deployment mode — "staging" | "production". Chooses trial agent + model. */
  ENVIRONMENT?: string;
  /** Override for default trial model (production mode default: claude-sonnet-4-6). */
  TRIAL_MODEL?: string;
  /** Override for default trial LLM provider ("anthropic" | "workers-ai"). */
  TRIAL_LLM_PROVIDER?: string;
  // TrialOrchestrator DO (alarm-driven trial provisioning)
  TRIAL_ORCHESTRATOR_OVERALL_TIMEOUT_MS?: string;
  TRIAL_ORCHESTRATOR_STEP_MAX_RETRIES?: string;
  TRIAL_ORCHESTRATOR_RETRY_BASE_DELAY_MS?: string;
  TRIAL_ORCHESTRATOR_RETRY_MAX_DELAY_MS?: string;
  TRIAL_ORCHESTRATOR_WORKSPACE_READY_TIMEOUT_MS?: string;
  TRIAL_ORCHESTRATOR_WORKSPACE_READY_POLL_INTERVAL_MS?: string;
  TRIAL_ORCHESTRATOR_AGENT_READY_TIMEOUT_MS?: string;
  TRIAL_ORCHESTRATOR_NODE_READY_TIMEOUT_MS?: string;
  TRIAL_ORCHESTRATOR_HEARTBEAT_SKEW_MS?: string;
  // Fast-path GitHub knowledge probes (fired from POST /api/trial/create)
  TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS?: string;
  TRIAL_KNOWLEDGE_MAX_EVENTS?: string;
  /** Sentinel GitHub installation id used for anonymous trial projects. */
  TRIAL_ANONYMOUS_INSTALLATION_ID?: string;
  /** Trial VM size override (default: DEFAULT_VM_SIZE from shared). */
  TRIAL_VM_SIZE?: string;
  /** Trial VM location override (default: DEFAULT_VM_LOCATION from shared). */
  TRIAL_VM_LOCATION?: string;
  // Cloudflare Artifacts (GitHub-optional project creation)
  /** Kill switch — set to 'true' to enable Artifacts as a repo provider. */
  ARTIFACTS_ENABLED?: string;
  /** Default branch for new Artifacts repos (default: 'main'). */
  ARTIFACTS_DEFAULT_BRANCH?: string;
  /** TTL in seconds for Artifacts tokens (default: 3600). */
  ARTIFACTS_TOKEN_TTL_SECONDS?: string;
  /** Max Artifacts repos per user (default: 50). */
  ARTIFACTS_MAX_REPOS_PER_USER?: string;
  // Repo Browse (Files tab — remote-branch git browser + diff)
  /** Max bytes to inline as text in the file viewer; larger files stream via rawUrl (default: 1000000). */
  REPO_BROWSE_MAX_INLINE_BYTES?: string;
  /** Max changed files returned by an Artifacts compare before truncating (default: 300). */
  REPO_BROWSE_MAX_COMPARE_FILES?: string;
  // SAM Agent (Top-Level Agent) configuration
  SAM_MODEL?: string; // LLM model (default: claude-sonnet-4-20250514)
  SAM_MAX_TOKENS?: string; // Max output tokens per turn (default: 4096)
  SAM_MAX_TURNS?: string; // Max tool-use loop iterations (default: 20)
  SAM_SYSTEM_PROMPT_APPEND?: string; // Additional system prompt text
  SAM_RATE_LIMIT_RPM?: string; // Max messages per minute per user (default: 30)
  SAM_RATE_LIMIT_WINDOW_SECONDS?: string; // Rate limit window in seconds (default: 60)
  SAM_MAX_CONVERSATIONS?: string; // Max conversations per user (default: 100)
  SAM_MAX_MESSAGES_PER_CONVERSATION?: string; // Max messages per conversation (default: 500)
  SAM_CONVERSATION_CONTEXT_WINDOW?: string; // Messages sent to LLM per turn (default: 50)
  SAM_AIG_SOURCE?: string; // AI Gateway metadata source tag (default: sam)
  SAM_FTS_ENABLED?: string; // Kill switch for FTS5 search (default: true)
  SAM_SEARCH_LIMIT?: string; // Default search results (default: 10)
  SAM_SEARCH_MAX_LIMIT?: string; // Max allowed search results (default: 50)
  SAM_HISTORY_LOAD_LIMIT?: string; // Max messages loaded on page mount (default: 200)
  CHAT_SESSION_MESSAGE_LIMIT?: string; // Default page size when no explicit limit is requested — poll & load-more (default: 500)
  CHAT_SESSION_MESSAGE_MAX?: string; // Ceiling (max clamp) for a chat session REST response — the initial full-conversation load requests up to this (default: 50000)
  CHAT_COMPACT_MODE_DEFAULT?: string; // Whether compact mode strips tool content by default (default: true)
  SAM_MAX_REQUEST_BODY_BYTES?: string; // Override max request body bytes for LLM trimming
  SAM_LLM_TIMEOUT_MS?: string; // LLM call timeout in ms (default: 120000)
  SAM_DISPATCH_MAX_DESCRIPTION_LENGTH?: string; // Max task description length for SAM dispatch (default: 32000)
  SAM_MESSAGE_MAX_LENGTH?: string; // Max message length for send_message_to_subtask (default: 32000)
  SAM_IDEA_TITLE_MAX_LENGTH?: string; // Max length for SAM-created idea title (default: 200)
  SAM_IDEA_DESCRIPTION_MAX_LENGTH?: string; // Max length for SAM-created idea description (default: 5000)
  SAM_MAX_IDEAS_PER_PROJECT?: string; // Max draft ideas per project via SAM (default: 500)
  SAM_IDEA_LIST_MAX_LIMIT?: string; // Max ideas returned by list_ideas (default: 50)
  SAM_IDEA_SNIPPET_LENGTH?: string; // Description snippet length in idea lists (default: 200)
  SAM_IDEA_SEARCH_MAX_LIMIT?: string; // Max results from find_related_ideas (default: 50)
  SAM_CI_RUNS_LIMIT?: string; // Max GitHub Actions runs to fetch (default: 5)
  SAM_GITHUB_TIMEOUT_MS?: string; // GitHub API timeout in ms (default: 10000)
  SAM_SESSION_MESSAGES_LIMIT?: string; // Default messages per get_session_messages (default: 50)
  SAM_SESSION_MESSAGES_MAX_LIMIT?: string; // Max messages per get_session_messages (default: 200)
  SAM_SESSION_LIST_LIMIT?: string; // Default sessions per list_sessions (default: 20)
  SAM_SESSION_LIST_MAX_LIMIT?: string; // Max sessions per list_sessions (default: 100)
  SAM_TASK_MESSAGE_SEARCH_LIMIT?: string; // Default results per search_task_messages (default: 10)
  SAM_TASK_MESSAGE_SEARCH_MAX_LIMIT?: string; // Max results per search_task_messages (default: 50)
  SAM_CODE_SEARCH_LIMIT?: string; // Default results per search_code (default: 10)
  SAM_CODE_SEARCH_MAX_LIMIT?: string; // Max results per search_code (default: 30)
  SAM_FILE_CONTENT_MAX_BYTES?: string; // Max file size for get_file_content (default: 1048576)

  // Raw Cloudflare Container instant-session runtime
  CF_CONTAINER_ENABLED?: string; // Kill switch for raw Cloudflare Container instant sessions (generated deploy default: true)
  CF_CONTAINER_SLEEP_AFTER?: string; // Container sleep-after duration (default: 1h)
  CF_CONTAINER_ACTIVE_WORK_MAX_MS?: string; // Max active-work keepalive duration before defensive expiry (default: 7200000)
  CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS?: string; // Active-work renewActivityTimeout interval (default: 300000)
  CF_CONTAINER_VM_AGENT_PORT?: string; // vm-agent standalone HTTP port inside the raw container (default: 8080)
  CF_CONTAINER_PORT_READY_TIMEOUT_MS?: string; // Max time to wait for vm-agent port readiness (default: 30000)
  CF_CONTAINER_WAKE_TIMEOUT_MS?: string; // Max time for launch + restore before forwarding a wake request (default: 120000)
  CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS?: string; // Max time for the synchronous standalone create-workspace request incl. clone (default: 120000)
  CF_CONTAINER_CLONE_FILTER?: string; // Git partial-clone filter passed to the container as STANDALONE_CLONE_FILTER (vm-agent default: blob:none; "off" disables)
  CF_CONTAINER_WORKSPACE_BASE_DIR?: string; // Base checkout dir inside raw container (default: /workspaces)
  // Legacy Sandbox SDK prototype (admin-only)
  SANDBOX_ENABLED?: string; // Legacy/fallback kill switch for sandbox routes and older staging config (default: false)
  SANDBOX_EXEC_TIMEOUT_MS?: string; // Default exec timeout in ms (default: 30000)
  SANDBOX_GIT_TIMEOUT_MS?: string; // Git checkout timeout in ms (default: 120000)
  SANDBOX_SLEEP_AFTER?: string; // Container sleep-after duration (default: 10m)
  SANDBOX_VM_AGENT_PORT?: string; // vm-agent standalone HTTP port inside Sandbox container (default: 8080)
  SANDBOX_WORKSPACE_BASE_DIR?: string; // Base checkout dir inside Sandbox container (default: /workspaces)
}
