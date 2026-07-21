---
name: env-reference
description: Full environment variable reference for SAM. Use when adding, modifying, or documenting environment variables, configuring deployment, or working with Worker secrets.
user-invocable: false
---

# SAM Environment Variable Reference

## GitHub Environment Secrets (GitHub Settings -> Environments -> production)

Uses `GH_*` prefix because GitHub Actions secret names cannot start with `GITHUB_*`.

| Type     | Name                                       | Required                                                           |
| -------- | ------------------------------------------ | ------------------------------------------------------------------ |
| Variable | `BASE_DOMAIN`                              | Yes                                                                |
| Variable | `RESOURCE_PREFIX`                          | No (default: `sam`)                                                |
| Variable | `PULUMI_STATE_BUCKET`                      | No (default: `sam-pulumi-state`)                                   |
| Variable | `CF_CONTAINER_ENABLED`                     | No (default: `true`; set `false` to force VM runtime)              |
| Secret   | `CF_API_TOKEN`                             | Yes (requires Account → SSL and Certificates → Edit for Origin CA) |
| Secret   | `CF_ACCOUNT_ID`                            | Yes                                                                |
| Secret   | `CF_ZONE_ID`                               | Yes                                                                |
| Secret   | `DEVCONTAINER_CACHE_CLOUDFLARE_API_TOKEN`  | No (falls back to `CF_API_TOKEN`)                                  |
| Secret   | `DEVCONTAINER_CACHE_CLOUDFLARE_ACCOUNT_ID` | No (falls back to `CF_ACCOUNT_ID`)                                 |
| Secret   | `R2_ACCESS_KEY_ID`                         | Yes                                                                |
| Secret   | `R2_SECRET_ACCESS_KEY`                     | Yes                                                                |
| Secret   | `PULUMI_CONFIG_PASSPHRASE`                 | Yes                                                                |
| Secret   | `GH_CLIENT_ID`                             | Yes                                                                |
| Secret   | `GH_CLIENT_SECRET`                         | Yes                                                                |
| Secret   | `GH_APP_ID`                                | Yes                                                                |
| Secret   | `GH_APP_PRIVATE_KEY`                       | Yes                                                                |
| Secret   | `GH_APP_SLUG`                              | Yes                                                                |
| Secret   | `GH_WEBHOOK_SECRET`                        | Yes when GitHub App webhooks are active                            |
| Secret   | `ENCRYPTION_KEY`                           | No (auto-generated)                                                |
| Secret   | `JWT_PRIVATE_KEY`                          | No (auto-generated)                                                |
| Secret   | `JWT_PUBLIC_KEY`                           | No (auto-generated)                                                |
| Secret   | `DEPLOY_SIGNING_PRIVATE_KEY`               | No (auto-generated; override only)                                 |
| Secret   | `DEPLOY_SIGNING_PUBLIC_KEY`                | No (derived during deploy; override only)                          |
| Secret   | `TRIAL_CLAIM_TOKEN_SECRET`                 | No (auto-generated)                                                |
| Variable | `ORIGIN_CA_CERT_VALIDITY_DAYS`             | No (default: 7)                                                    |

`ORIGIN_CA_CERT` and `ORIGIN_CA_KEY` are legacy rotation inputs for nodes provisioned before per-node Origin CA CSR signing. They are not required for new node provisioning.

## GH* to GITHUB* Mapping (done by `configure-secrets.sh`)

```
GitHub Secret          ->  Cloudflare Worker Secret
GH_CLIENT_ID           ->  GITHUB_CLIENT_ID
GH_CLIENT_SECRET       ->  GITHUB_CLIENT_SECRET
GH_APP_ID              ->  GITHUB_APP_ID
GH_APP_PRIVATE_KEY     ->  GITHUB_APP_PRIVATE_KEY
GH_APP_SLUG            ->  GITHUB_APP_SLUG
GH_WEBHOOK_SECRET      ->  GITHUB_WEBHOOK_SECRET
```

Use `GH_WEBHOOK_SECRET` in GitHub Actions because secret names cannot start with `GITHUB_`. The Worker/runtime secret remains `GITHUB_WEBHOOK_SECRET`, and it must match the GitHub App webhook secret exactly.

## API Worker Runtime Environment Variables

See `apps/api/.env.example` for the full list. Key variables:

### Core

- `WRANGLER_PORT` — Local dev port (default: 8787)
- `BASE_DOMAIN` — Set automatically by sync scripts
- `CF_CONTAINER_ENABLED` — Enables Cloudflare Container instant-session runtime in generated deployment envs (default: `true`; set `false` to force VM runtime)
- `CF_CONTAINER_SLEEP_AFTER` — Container idle sleep duration for instant-session runtime (default: `1h`)
- `CF_CONTAINER_ACTIVE_WORK_MAX_MS` — Defensive maximum active-work keepalive duration (default: `7200000`)
- `CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS` — Active-work keepalive renewal interval (default: `300000`)
- `CF_CONTAINER_VM_AGENT_PORT` — vm-agent standalone HTTP port inside the raw container (default: `8080`)
- `CF_CONTAINER_PORT_READY_TIMEOUT_MS` — Max wait for vm-agent port readiness (default: `30000`)
- `CF_CONTAINER_WAKE_TIMEOUT_MS` — Max wait for launch, snapshot restore, and request readiness (default: `120000`)
- `CF_CONTAINER_RECOVERY_MAX_ATTEMPTS` — Max restore attempts before terminal status reconciliation (default: `2`)
- `INSTANT_STALE_CALLBACK_MARGIN_MS` — Freshness margin for rejecting destructive callbacks from superseded Instant containers (default: `60000`)
- `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` — Synchronous workspace creation and clone budget (default: `120000`)
- `CF_CONTAINER_CLONE_FILTER` — Git partial-clone filter (default: `blob:none`; `off` disables partial clone)
- `SESSION_SNAPSHOT_TTL_DAYS` — Retention for hibernated session snapshots; deployment also provisions matching R2 prefix expiration (default: `7`)
- `SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES` — Maximum bytes accepted for one snapshot artifact (default: `104857600`)
- `SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES` — Per-file threshold before snapshot content is visibly skipped (default: `52428800`)
- `SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS` — Progress-idle timeout for snapshot upload/download (default: `30000`)
- `SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES` — Maximum snapshot coordination JSON body (default: `262144`)
- `SESSION_SNAPSHOT_R2_PREFIX` — Private R2 object prefix for session snapshots (default: `session-snapshots`)

### Devcontainer Cache

- `DEVCONTAINER_CACHE_ENABLED` — Enables opportunistic devcontainer image caching
- `DEVCONTAINER_CACHE_REGISTRY_HOST` — Managed registry host (default: `registry.cloudflare.com`)
- `DEVCONTAINER_CACHE_REPOSITORY_PREFIX` — Prefix for generated cache repository names
- `DEVCONTAINER_CACHE_CREDENTIAL_EXPIRATION_MINUTES` — TTL for short-lived registry credentials minted by the API

### Google OAuth and GCP

- `GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET` — Optional Google user-login OAuth fallback. Runtime `/setup` or superadmin config takes precedence. Callback: `/api/auth/callback/google`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Optional, independent infrastructure OAuth fallback used only for keyless GCP/WIF setup. Runtime superadmin config takes precedence. Callbacks: `/auth/google/callback` and `/api/deployment/gcp/callback`.
- `GCP_WIF_POOL_ID`, `GCP_WIF_PROVIDER_ID`, `GCP_SERVICE_ACCOUNT_ID` — Default identifiers used by WIF setup.
- `GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES` — Maximum UTF-8 service-account JSON upload/paste size (default: `65536`).
- `GCP_DEFAULT_ZONE` — Default Compute zone (default: `us-central1-a`).
- `GCP_IMAGE_FAMILY`, `GCP_IMAGE_PROJECT`, `GCP_DISK_SIZE_GB` — Compute VM image and disk defaults.
- `GCP_TOKEN_CACHE_TTL_SECONDS` — Maximum short-lived access-token cache TTL (default: `3300`; capped by the provider-returned expiry).
- `GCP_IDENTITY_TOKEN_EXPIRY_SECONDS` — WIF SAM identity-token lifetime (default: `600`).
- `GCP_OPERATION_POLL_TIMEOUT_MS` — GCP asynchronous operation timeout (default: `300000`).
- `GCP_API_TIMEOUT_MS` — Timeout for Google OAuth, IAM, and Compute verification requests (default: `30000`).
- `GCP_STS_SCOPE` — WIF STS scope (default: `https://www.googleapis.com/auth/cloud-platform`).
- `GCP_SA_IMPERSONATION_SCOPES` — Comma-separated WIF service-account impersonation scopes (default: Compute).
- `GCP_SA_TOKEN_LIFETIME_SECONDS` — WIF impersonated-token lifetime (default: `3600`).
- `GCP_STS_TOKEN_URL`, `GCP_IAM_CREDENTIALS_BASE_URL` — WIF endpoint overrides for controlled environments. They do not affect service-account JWT exchange, which always uses Google's fixed OAuth token endpoint.
- `GCP_DEPLOY_WIF_POOL_ID`, `GCP_DEPLOY_WIF_PROVIDER_ID`, `GCP_DEPLOY_SERVICE_ACCOUNT_ID` — Default identifiers for deployment WIF.
- `GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS`, `GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS`, `GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS` — Deployment authorization lifetimes.

### Resource Limits

- `MAX_NODES_PER_USER` — Runtime node cap
- `MAX_AGENT_SESSIONS_PER_WORKSPACE` — Runtime session cap
- `MAX_PROJECTS_PER_USER` — Runtime project cap
- `MAX_TASKS_PER_PROJECT` — Runtime task cap per project
- `MAX_TASK_DEPENDENCIES_PER_TASK` — Runtime dependency-edge cap per task
- `PROJECT_INVITE_TOKEN_BYTES` — Random bytes used for generated project invite link tokens (default: 32)
- `PROJECT_INVITE_DEFAULT_EXPIRY_DAYS` — Default lifetime for project invite links created without an explicit expiry (default: 7)
- `PROJECT_INVITE_MAX_EXPIRY_DAYS` — Maximum allowed project invite link lifetime (default: 30)
- `AGENT_SETTINGS_VALIDATION_LIMITS` — Optional JSON object overriding
  agent-settings validation bounds for model IDs, tool lists, additional env
  entries, provider display names, and OpenCode base URLs. See
  `apps/api/.env.example` and `apps/www/src/content/docs/docs/guides/self-hosting.md` for supported keys
  and defaults.

### Pagination

- `TASK_LIST_DEFAULT_PAGE_SIZE` — Default task/project list page size
- `TASK_LIST_MAX_PAGE_SIZE` — Maximum task/project list page size
- `CHAT_SESSION_MESSAGE_LIMIT` — Default page size for chat session message REST responses when no limit is requested — used by the 3s poll and load-more (default: 500)
- `CHAT_SESSION_MESSAGE_MAX` — Ceiling any chat session message request is clamped to; the initial full-conversation load requests up to this (default: 50000)

### Timeouts

- `TASK_CALLBACK_TIMEOUT_MS` — Timeout budget for delegated-task callback processing
- `TASK_CALLBACK_RETRY_MAX_ATTEMPTS` — Retry budget for delegated-task callback processing
- `TASK_RECONCILIATION_IDLE_MS` — Idle threshold before a visible task reconciliation check-in (default: 300000)
- `TASK_RECONCILIATION_RESPONSE_DEADLINE_MS` — Response deadline after a visible task reconciliation check-in (default: 60000)
- `TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS` — In-flight prompt observation threshold before SAM records a non-interrupting reconciliation event (default: 1800000)
- `TASK_RECONCILIATION_PROMPT_HARD_STALL_MS` — In-flight prompt hard-stall threshold before SAM requests prompt cancellation and retries check-in later (default: 7200000)
- `TASK_RECONCILIATION_MIN_ALARM_DELAY_MS` — Minimum delay before the next reconciliation alarm can fire (default: 10000)
- `SESSION_TASK_REPAIR_BATCH_SIZE` — Maximum legacy taskless chat sessions repaired per 5-minute sweep (default: 25; capped at 200)
- `TASK_RUN_ABSOLUTE_CEILING_MS` — Absolute runaway-cost ceiling that fails even a demonstrably live task (default: 86400000 / 24h)
- `SESSION_ACTIVITY_STALE_THRESHOLD_MS` — Evidence-based fallback threshold before stale working activity can be healed to idle (default: 300000)
- `NODE_HEARTBEAT_STALE_SECONDS` — Staleness threshold for node health
- `NODE_AGENT_READY_TIMEOUT_MS` — Max wait for freshly provisioned node-agent health
- `NODE_AGENT_READY_POLL_INTERVAL_MS` — Polling interval for fresh-node readiness checks
- `HETZNER_API_TIMEOUT_MS` — Timeout for Hetzner Cloud API calls (default: 30000)
- `CF_API_TIMEOUT_MS` — Timeout for Cloudflare DNS API calls (default: 30000)
- `NODE_AGENT_REQUEST_TIMEOUT_MS` — Timeout for Node Agent HTTP requests (default: 30000)

### Audio/Transcription

- `WHISPER_MODEL_ID` — Workers AI model for transcription (default: `@cf/openai/whisper-large-v3-turbo`)
- `MAX_AUDIO_SIZE_BYTES` — Maximum audio upload size (default: 10485760)
- `MAX_AUDIO_DURATION_SECONDS` — Maximum recording duration (default: 60)
- `RATE_LIMIT_TRANSCRIBE` — Rate limit for transcription requests

### Client Error Reporting

- `RATE_LIMIT_CLIENT_ERRORS` — Rate limit per hour per IP (default: 200)
- `MAX_CLIENT_ERROR_BATCH_SIZE` — Max errors per request (default: 25)
- `MAX_CLIENT_ERROR_BODY_BYTES` — Max request body size (default: 65536)
- `MAX_VM_AGENT_ERROR_BODY_BYTES` — Max VM agent error request body (default: 32768)
- `MAX_VM_AGENT_ERROR_BATCH_SIZE` — Max VM agent errors per request (default: 10)

### Project File Library

- `LIBRARY_LIST_DEFAULT_PAGE_SIZE` — Default file-list page size (default: 50)
- `LIBRARY_LIST_MAX_PAGE_SIZE` — Maximum file-list page size (default: 200)
- `LIBRARY_TAG_QUERY_BATCH_SIZE` — File IDs per tag metadata lookup query (default: 80, capped below D1 bind-variable limits)
- Other library upload, directory, search, preview, and encryption settings are listed in `apps/api/.env.example`.

### Codex OAuth Refresh Proxy (`CodexRefreshLock` DO + `/api/auth/codex-refresh`)

- `CODEX_REFRESH_PROXY_ENABLED` — Kill switch; set to `'false'` to disable the proxy entirely (default: enabled)
- `CODEX_REFRESH_UPSTREAM_URL` — OpenAI OAuth token endpoint (default: `https://auth.openai.com/oauth/token`)
- `CODEX_REFRESH_UPSTREAM_TIMEOUT_MS` — Timeout for upstream fetch (default: 10000)
- `CODEX_REFRESH_LOCK_TIMEOUT_MS` — Max DO lock hold time per refresh (default: 30000)
- `CODEX_CLIENT_ID` — Public OAuth client_id for Codex (default: `app_EMoamEEZ73f0CkXaXp7hrann`)
- `CODEX_EXPECTED_SCOPES` — Comma-separated allowlist of scopes the upstream may return. **Unset uses the default allowlist** (`openid,profile,email,offline_access`). Set to empty string (`""`) to disable validation entirely (escape hatch for provider-driven scope additions). Unexpected scopes block the refresh with 502; the previous token remains valid. (MEDIUM #6 fix)
- `RATE_LIMIT_CODEX_REFRESH_PER_HOUR` — Per-user refresh request cap per window (default: 30). Enforced atomically via DO storage, not KV. (MEDIUM #5 fix)
- `RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS` — Rate-limit window length in seconds (default: 3600)

### Credential Routes Rate Limits

- `RATE_LIMIT_CREDENTIAL_UPDATE` — Credential mutation cap used by user/project agent-key writes and the atomic `PUT /api/gcp/service-account` and superadmin Google infrastructure OAuth rotation paths.

### Generic Webhook Triggers

- `WEBHOOK_TRIGGERS_ENABLED` — Public ingress kill switch (default: `true`)
- `WEBHOOK_TRIGGER_MAX_BODY_BYTES` — Maximum JSON request body (default: `65536`)
- `WEBHOOK_TRIGGER_MAX_FILTERS` — Maximum deterministic filters per trigger (default: `10`)
- `WEBHOOK_TRIGGER_MAX_FILTER_PATH_LENGTH` — Maximum filter dot-path length (default: `200`)
- `WEBHOOK_TRIGGER_MAX_FILTER_PATH_DEPTH` — Maximum filter nesting depth at evaluation time (default: `8`)
- `WEBHOOK_TRIGGER_MAX_INCLUDED_HEADERS` — Maximum safe request headers copied into template context (default: `10`)
- `WEBHOOK_TRIGGER_MAX_HEADER_NAME_LENGTH` — Maximum configured included-header name length (default: `100`)
- `WEBHOOK_TRIGGER_MAX_SOURCE_LABEL_LENGTH` — Maximum optional source label length (default: `100`)
- `WEBHOOK_TRIGGER_MAX_IDEMPOTENCY_KEY_LENGTH` — Maximum `Idempotency-Key` length (default: `200`)
- `WEBHOOK_INGRESS_RATE_LIMIT_PER_MINUTE` — Best-effort pre-auth request damping per IP/window (default: `120`)
- `WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE` — Best-effort request damping per trigger/window (default: `60`)
- `WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE` — Best-effort invalid-token request damping per IP/window (default: `30`)
- `WEBHOOK_RATE_LIMIT_WINDOW_SECONDS` — Fixed rate-limit window length (default: `60`)
- `WEBHOOK_DELIVERY_RETENTION_DAYS` — Retention for redacted delivery audit metadata (default: `7`)
- `WEBHOOK_DELIVERY_CLEANUP_BATCH_SIZE` — Maximum expired audit rows deleted per cleanup pass (default: `500`)
- `WEBHOOK_DELIVERY_DEFAULT_PAGE_SIZE` — Default delivery-history page size (default: `25`)
- `WEBHOOK_DELIVERY_MAX_PAGE_SIZE` — Maximum delivery-history page size (default: `100`)
- `WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS` — Recovery lease for processing deliveries without a submitted task (default: `300`)

### Trial Onboarding (`/try` flow)

Trial configuration is currently sourced from `apps/api/.env.example` and `apps/api/src/env.ts`. Summary:

- `TRIAL_CLAIM_TOKEN_SECRET` — Worker secret; HMAC key for trial cookies (auto-provisioned by Pulumi)
- `TRIAL_MONTHLY_CAP`, `TRIAL_WORKSPACE_TTL_MS`, `TRIAL_DATA_RETENTION_HOURS` — Global cap + lifetimes
- `TRIAL_ANONYMOUS_USER_ID`, `TRIAL_ANONYMOUS_INSTALLATION_ID` — Sentinel rows for pre-claim ownership
- `TRIAL_AGENT_TYPE_STAGING`, `TRIAL_AGENT_TYPE_PRODUCTION`, `TRIAL_DEFAULT_WORKSPACE_PROFILE` — Agent + profile selection
- `TRIALS_ENABLED_KV_KEY`, `TRIAL_KILL_SWITCH_CACHE_MS` — Kill switch
- `TRIAL_EXPIRE_BATCH_SIZE`, `TRIAL_CLEANUP_BATCH_SIZE`, `TRIAL_CLEANUP_DEADLINE_MS`, `TRIAL_NODE_DELETION_LOCK_STALE_MS` — Expired-trial cron cleanup bounds and stale deletion-lock retry
- `TRIAL_ORCHESTRATOR_OVERALL_TIMEOUT_MS`, `TRIAL_ORCHESTRATOR_STEP_MAX_RETRIES`, `TRIAL_ORCHESTRATOR_RETRY_BASE_DELAY_MS`, `TRIAL_ORCHESTRATOR_RETRY_MAX_DELAY_MS` — Orchestrator retry budget
- `TRIAL_ORCHESTRATOR_NODE_READY_TIMEOUT_MS`, `TRIAL_ORCHESTRATOR_AGENT_READY_TIMEOUT_MS`, `TRIAL_ORCHESTRATOR_WORKSPACE_READY_TIMEOUT_MS`, `TRIAL_ORCHESTRATOR_WORKSPACE_READY_POLL_INTERVAL_MS` — Step-level timeouts
- `TRIAL_VM_SIZE`, `TRIAL_VM_LOCATION` — VM overrides for trial workspaces
- `TRIAL_GITHUB_TIMEOUT_MS` — Per-request timeout for the default-branch probe (`fetchDefaultBranch`); falls back to `main` on timeout/404/error
- `TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS`, `TRIAL_KNOWLEDGE_MAX_EVENTS` — Fast-path knowledge probe tunables

## VM Agent Environment Variables

### Container/User

- `CONTAINER_USER` — Optional `docker exec -u` override; when unset, auto-detects effective devcontainer user

### Git Operations

- `GIT_CREDENTIAL_TIMEOUT` — Go duration for credential-helper callbacks to the local VM agent, such as `5s` or `1750ms` (default: `5s`)
- `GIT_EXEC_TIMEOUT` — Timeout for git commands via docker exec (default: 30s)
- `GIT_WORKTREE_TIMEOUT` — Timeout for git worktree create/remove (default: 30s)
- `WORKTREE_CACHE_TTL` — Cache duration for parsed `git worktree list` results (default: 5s)
- `MAX_WORKTREES_PER_WORKSPACE` — Max worktrees allowed per workspace (default: 5)
- `GIT_FILE_MAX_SIZE` — Max file size for git/file endpoint (default: 1048576)

### File Operations

- `FILE_LIST_TIMEOUT` — Timeout for file listing commands (default: 10s)
- `FILE_LIST_MAX_ENTRIES` — Max entries per directory listing (default: 1000)
- `FILE_FIND_TIMEOUT` — Timeout for recursive file index (default: 15s)
- `FILE_FIND_MAX_ENTRIES` — Max entries returned by file index (default: 5000)

### Error Reporting

- `ERROR_REPORT_FLUSH_INTERVAL` — Background error flush interval (default: 30s)
- `ERROR_REPORT_MAX_BATCH_SIZE` — Immediate flush threshold (default: 10)
- `ERROR_REPORT_MAX_QUEUE_SIZE` — Max queued error entries (default: 100)
- `ERROR_REPORT_HTTP_TIMEOUT` — HTTP POST timeout for error reports (default: 10s)

### Message Reporting

- `MSG_MAX_MESSAGE_CONTENT_BYTES` — Max single persisted message content before truncation (default: 102400)

### ACP (Agent Communication Protocol)

- `ACP_MESSAGE_BUFFER_SIZE` — Max buffered messages per SessionHost for late-join replay (default: 5000)
- `ACP_VIEWER_SEND_BUFFER` — Per-viewer send channel buffer size (default: 256)
- `ACP_PING_INTERVAL` — WebSocket ping interval for stale connection detection (default: 30s)
- `ACP_PONG_TIMEOUT` — WebSocket pong deadline after ping (default: 10s)
- `ACP_PROMPT_TIMEOUT` — Max ACP prompt runtime for workspace sessions; 0 = no timeout (default: 0)
- `ACP_TASK_PROMPT_TIMEOUT` — Max ACP prompt runtime for task-driven sessions (default: 6h)
- `ACP_PROMPT_CANCEL_GRACE_PERIOD` — Grace wait after cancel before force-stop (default: 5s)
- `ACP_PROMPT_RETRY_MAX_RETRIES` — Max transient provider prompt retries after the initial attempt (default: 2)
- `ACP_PROMPT_RETRY_INITIAL_BACKOFF` — Initial backoff before retrying transient provider prompt errors (default: 15s)
- `ACP_PROMPT_RETRY_MAX_BACKOFF` — Max exponential backoff for transient provider prompt retries (default: 2m)
- `ACTIVITY_REREPORT_INTERVAL` — Re-send `prompting` activity while a prompt is active (default: 60s)
- `ACTIVITY_TERMINAL_REPORT_ATTEMPTS` — Retry attempts for terminal activity reports (`idle`, `recovering`, `error`) (default: 5)
- `ACTIVITY_TERMINAL_REPORT_BACKOFF` — Backoff between terminal activity report retries (default: 1s)
- `ACP_IDLE_SUSPEND_TIMEOUT` — Idle timeout before auto-suspending agent session (default: 30m)
- `ACP_NOTIF_SERIALIZE_TIMEOUT` — Max wait for previous session/update processing before delivering next (default: 5s)

### Events

- `MAX_NODE_EVENTS` — Max node-level events retained in memory (default: 500)
- `MAX_WORKSPACE_EVENTS` — Max workspace-level events retained in memory (default: 500)

### System Info

- `SYSINFO_DOCKER_TIMEOUT` — Timeout for Docker CLI commands during system info collection (default: 10s)
- `SYSINFO_VERSION_TIMEOUT` — Timeout for version-check commands (default: 5s)
- `SYSINFO_CACHE_TTL` — Cache duration for system info results (default: 5s)
