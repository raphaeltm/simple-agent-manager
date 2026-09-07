---
name: env-reference
description: Full environment variable reference for SAM. Use when adding, modifying, or documenting environment variables, configuring deployment, or working with Worker secrets.
user-invocable: false
---

# SAM Environment Variable Reference

## GitHub Environment Secrets (GitHub Settings -> Environments -> production)

Uses `GH_*` prefix because GitHub Actions secret names cannot start with `GITHUB_*`.

| Type     | Name                                               | Required                                                           |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| Variable | `BASE_DOMAIN`                                      | Yes                                                                |
| Variable | `RESOURCE_PREFIX`                                  | No (default: `sam`)                                                |
| Variable | `PULUMI_STATE_BUCKET`                              | No (default: `sam-pulumi-state`)                                   |
| Variable | `CF_CONTAINER_ENABLED`                             | No (default: `true`; set `false` to force VM runtime)              |
| Variable | `D1_MIGRATION_CHURNING_TABLES`                     | No (may narrow the reviewed built-in retention/expiry table list)  |
| Variable | `D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT` | No (default: `50`; range: 0–100)                                   |
| Secret   | `CF_API_TOKEN`                                     | Yes (requires Account → SSL and Certificates → Edit for Origin CA) |
| Secret   | `CF_ACCOUNT_ID`                                    | Yes                                                                |
| Secret   | `CF_ZONE_ID`                                       | Yes                                                                |
| Secret   | `DEVCONTAINER_CACHE_CLOUDFLARE_API_TOKEN`          | No (falls back to `CF_API_TOKEN`)                                  |
| Secret   | `DEVCONTAINER_CACHE_CLOUDFLARE_ACCOUNT_ID`         | No (falls back to `CF_ACCOUNT_ID`)                                 |
| Secret   | `R2_ACCESS_KEY_ID`                                 | Yes                                                                |
| Secret   | `R2_SECRET_ACCESS_KEY`                             | Yes                                                                |
| Secret   | `PULUMI_CONFIG_PASSPHRASE`                         | Yes                                                                |
| Secret   | `GH_CLIENT_ID`                                     | Yes                                                                |
| Secret   | `GH_CLIENT_SECRET`                                 | Yes                                                                |
| Secret   | `GH_APP_ID`                                        | Yes                                                                |
| Secret   | `GH_APP_PRIVATE_KEY`                               | Yes                                                                |
| Secret   | `GH_APP_SLUG`                                      | Yes                                                                |
| Secret   | `GH_WEBHOOK_SECRET`                                | Yes when GitHub App webhooks are active                            |
| Secret   | `ENCRYPTION_KEY`                                   | No (auto-generated)                                                |
| Secret   | `JWT_PRIVATE_KEY`                                  | No (auto-generated)                                                |
| Secret   | `JWT_PUBLIC_KEY`                                   | No (auto-generated)                                                |
| Secret   | `DEPLOY_SIGNING_PRIVATE_KEY`                       | No (auto-generated; override only)                                 |
| Secret   | `DEPLOY_SIGNING_PUBLIC_KEY`                        | No (derived during deploy; override only)                          |
| Secret   | `VAPID_PRIVATE_KEY`                                | No (auto-generated; override only)                                 |
| Secret   | `VAPID_PUBLIC_KEY`                                 | No (derived during deploy; override only)                          |
| Secret   | `VAPID_SUBJECT`                                    | No (generated contact URI; override only)                          |
| Secret   | `TRIAL_CLAIM_TOKEN_SECRET`                         | No (auto-generated)                                                |
| Variable | `ORIGIN_CA_CERT_VALIDITY_DAYS`                     | No (default: 7)                                                    |

`D1_MIGRATION_CHURNING_TABLES` is a comma-separated `<binding>.<table>` subset of the reviewed defaults: `DATABASE.deployment_releases`, `DATABASE.github_webhook_deliveries`, `DATABASE.project_files`, `DATABASE.registry_credential_rate_limits`, `DATABASE.session_snapshots`, `DATABASE.sessions`, `DATABASE.trial_waitlist`, `DATABASE.trigger_executions`, `DATABASE.verifications`, `DATABASE.webhook_deliveries`, and `OBSERVABILITY_DATABASE.platform_errors`. It may narrow but cannot expand this list; unset uses all reviewed defaults. `D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT` accepts `0`–`100`; a decrease exactly at the configured limit is accepted and a larger decrease blocks.

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
- `SAM_INSTALLATION_ID` — Pulumi-generated, non-secret exact installation identity injected by generated deployment config. Missing or malformed values disable destructive provider-side orphan reconciliation; operators do not set this manually.
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
- `SESSION_SNAPSHOT_TTL_DAYS` — Retention from actual sleep; the scheduled Worker terminalizes the chat and deletes R2 state (default: `7`)
- `SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES` — Maximum combined bytes accepted for snapshot artifacts (default: `268435456`)
- `SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES` — Per-file threshold before snapshot content is visibly skipped (default: `268435456`)
- `SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS` — Progress-idle timeout for snapshot upload/download (default: `30000`)
- `SESSION_SNAPSHOT_UPLOAD_URL_TTL_SECONDS` — Lifetime of direct R2 snapshot upload URLs (default: `900`)
- `SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS` — Budget for vm-agent acceptance of the final checkpoint request (default: `300000`)
- `SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS` — No-progress watchdog after a final checkpoint is accepted (default: `120000`)
- `SESSION_SNAPSHOT_POLL_INTERVAL_MS` — D1 poll interval while waiting for final checkpoint progress/completion (default: `1000`)
- `SESSION_SNAPSHOT_OPERATION_TIMEOUT` — VM-agent checkpoint operation deadline, passed to new VM nodes and Instant containers as a Go duration (default: `15m`)
- `SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL` — VM-agent snapshot progress callback throttle, passed to new VM nodes and Instant containers as a Go duration (default: `15s`)
- `SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT` — VM-agent snapshot progress callback timeout, passed to new VM nodes and Instant containers as a Go duration (default: `5s`)
- `SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES` — Maximum snapshot coordination JSON body (default: `262144`)
- `SESSION_SNAPSHOT_R2_PREFIX` — Private R2 object prefix for session snapshots (default: `session-snapshots`)
- `SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS` — Maximum replacement-VM wake attempts before the sleeping session becomes unavailable (default: `3`)
- `SESSION_SLEEP_AFTER_MS` — Runtime-neutral idle time before automatic VM-session sleep (default: `900000`)
- `SESSION_SLEEP_SWEEP_BATCH_SIZE` — Maximum due VM sleeps atomically claimed by one scheduled sweep (default: `10`)
- `SESSION_SLEEP_RETRY_DELAY_MS` — Delay after a fail-closed automatic sleep attempt (default: `300000`)
- `SESSION_SLEEP_MAX_ATTEMPTS` — Maximum automatic sleep attempts; exhaustion preserves compute and records the error (default: `9`)
- `SESSION_SLEEP_CLAIM_LEASE_MS` — Reclaim timeout for an interrupted automatic-sleep claim (default: `600000`)
- `HARNESS_BACKGROUND_WORK_LEASE_MS` — Finite sleep-protection lease renewed by normalized harness background-work lifecycle signals (default: `300000`)
- `HARNESS_BACKGROUND_WORK_MAX_DURATION_MS` — Absolute ceiling, measured from the last harness lifecycle progress edge, on how long background work may defer sleep (default: `1800000`)
- `ACP_ACTIVITY_ADMISSION_ENABLED` — Enables Worker-side admission control/coalescing for redundant intermediate ACP activity callbacks (default: `true`)
- `ACP_ACTIVITY_COALESCE_WINDOW_MS` — Minimum interval between redundant intermediate ProjectData activity writes; transitions and terminal/error reports bypass it (default: `2000`)
- `ACP_ACTIVITY_COALESCE_TTL_MS` — Maximum lifetime for a coalesced activity report before eviction leaves convergence to probe-backed reconciliation (default: `60000`)
- `ACP_ACTIVITY_COALESCE_MAX_PENDING` — Maximum pending coalesced activity reports retained by one Worker isolate (default: `512`)
- `ACP_ACTIVITY_BINDING_CACHE_TTL_MS` — Short-lived authorized ACP session binding cache used to avoid ProjectData reads during callback storms (default: `30000`)
- `ACP_ACTIVITY_BINDING_CACHE_MAX_ENTRIES` — Maximum cached ACP activity bindings retained by one Worker isolate (default: `2048`)

Activity coalescing and binding caches are per Worker isolate. Delayed flushes carry their original observed event time, and ProjectData rejects stale writes so a delayed intermediate report cannot overwrite a newer idle/error state from another isolate.

- `SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS` — Reclaim timeout for an interrupted replacement-runtime wake claim (default: `600000`)
- `SESSION_LIFECYCLE_ERROR_MAX_LENGTH` — Maximum stored session lifecycle and agent activity failure diagnostic length (default: `2048`)
- `SESSION_SNAPSHOT_PURGE_ENABLED` — Kill switch for expired snapshot cleanup in D1 and R2 (default: enabled)
- `SESSION_SNAPSHOT_PURGE_BATCH_SIZE` — Maximum expired snapshot rows deleted per run (default: `250`)

### Deployment Storage Retention

- `DEPLOYMENT_RELEASE_RETENTION_ENABLED` — Kill switch for superseded terminal release pruning (default: enabled)
- `DEPLOYMENT_RELEASE_RETENTION_COUNT` — Newest releases protected per deployment environment, in addition to observed-applied and non-terminal releases (default: `3`)
- `DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE` — Maximum terminal release rows deleted per run (default: `250`)
- `DEPLOYMENT_RELEASE_RETENTION_INTERVAL_HOURS` — Minimum interval between release retention runs (default: `24`)
- `DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY` — KV interval marker (default: `cleanup:deployment-releases:last-run`)
- `DEPLOYMENT_RELEASE_RECONCILIATION_ENABLED` — Kill switch for stale nonterminal compose release reconciliation (default: enabled)
- `DEPLOYMENT_RELEASE_RECONCILIATION_BATCH_SIZE` — Maximum stale nonterminal releases terminalized before retention pruning in one run (default: `50`)
- `DEPLOYMENT_RELEASE_RECONCILIATION_STALE_HOURS` — Minimum release status age before reconciliation can mark a nonterminal release failed (default: `168`)
- `DEPLOYMENT_RELEASE_RECONCILIATION_ACTIVITY_GRACE_HOURS` — Recent release-event protection window for active fetch/apply work (default: `6`)
- `COMPOSE_IMAGE_ARTIFACT_CLEANUP_BATCH_SIZE` — Maximum abandoned compose archives deleted per daily run (default: `250`)

### Guided Agent Credential Setup

- `MAX_CONCURRENT_SETUP_SESSIONS` — Concurrent Cloudflare Sandbox setup-session cap (default: `2`)
- `SETUP_SESSION_TTL_MS` — Setup-session lifetime before teardown (default: `900000`)
- `SETUP_SESSION_CAPTURE_POLL_MS` — Device-login and credential-capture poll interval (default: `3000`)
- `CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS` — Codex app-server JSON-RPC request timeout (default: `30000`)
- `CLAUDE_SETUP_ENTER_DELAY_MS` — Delay before sending Enter as a separate stdin write after Claude's browser-displayed code is pasted into the CLI (default: `1000`)
- `CLAUDE_SETUP_EXCHANGE_TIMEOUT_MS` — Maximum wait for Claude's CLI exchange to finish after code submission (default: `120000`)
- `CLAUDE_SETUP_REJECTION_SETTLE_MS` — Wait for Ink redraws to settle before classifying the Claude CLI OAuth error line (default: `400`)
- `CLAUDE_SETUP_VERIFICATION_POLL_MS` — Poll interval for the browser-code handoff file inside the Claude setup sandbox (default: `500`)
- `CLAUDE_SETUP_TTY_COLUMNS` — PTY width used for `claude setup-token` to reduce opaque-token wrapping (default: `512`)
- `CLAUDE_SETUP_OUTPUT_BUFFER_BYTES` — Maximum in-memory Claude PTY output retained for parsing (default: `32768`)
- `CLAUDE_VERIFICATION_CODE_MAX_LENGTH` — Maximum accepted browser-displayed `code#state` length (default: `1024`)
- `CLAUDE_SETUP_ERROR_DETAIL_MAX_LENGTH` — Maximum sanitized Claude CLI diagnostic surfaced to the user (default: `160`)
- `CLAUDE_OAUTH_TOKEN_MAX_LENGTH` — Maximum captured Claude OAuth token length (default: `8192`)
- `SETUP_SESSION_SWEEP_MAX_CANDIDATES` — Maximum expired setup sessions torn down per sweep (default: `50`)
- `POOL_LEASE_BUFFER_MS` — Grace after the session TTL before a leaked setup-pool lease self-prunes (default: `300000`)

### Operational Control Loops

- `CRON_SWEEPS_ENABLED_KV_KEY` — Fail-open KV brake key for the five-minute operational sweep (default: `control-loops:cron-enabled`)
- `DO_ALARMS_ENABLED_KV_KEY` — Fail-open KV brake key shared by alarm-bearing DOs (default: `control-loops:alarms-enabled`)
- `CONTROL_LOOP_KILL_SWITCH_CACHE_MS` — In-memory brake cache, clamped to 30000ms (default: `30000`)
- `CONTROL_LOOP_DISABLED_ALARM_RETRY_MS` — Alarm recheck interval while disabled, clamped to at least 60000ms (default: `300000`)
- `CRON_FAILURE_NOTIFICATION_THROTTLE_MS` — Per-sweep failure-notification throttle backed by KV and an atomic per-user Notification DO claim (default: `3600000`)
- `CRON_FAILURE_NOTIFICATION_KV_PREFIX` — KV prefix for failure-notification throttle markers (default: `cron-failure-notification`)
- `NODE_LIFECYCLE_MAX_DESTROYING_AGE_MS` — Maximum destroying-state residence before DO self-cleanup (default: `86400000`)
- `NODE_WORKSPACE_IDLE_TIMEOUT_MS` — Last-workspace-activity window before an auto-provisioned workspace-role node with no active workspaces is destroy-eligible (default: `1800000`; parsed by `buildCleanupConfig()` and enforced by `claimNodeForCleanup()` in `apps/api/src/scheduled/node-cleanup/shared.ts`)
- `NODE_ORPHAN_IDLE_TIMEOUT_MS` — Legacy alias for `NODE_WORKSPACE_IDLE_TIMEOUT_MS` when the primary variable is unset (resolved by `buildCleanupConfig()` in `apps/api/src/scheduled/node-cleanup/shared.ts`)
- `NODE_CLEANUP_FAILURE_BACKOFF_MS` — Failed cleanup-candidate exclusion window (default: `3600000`)
- `IDLE_CLEANUP_MAX_RESIDENCE_MS` — Maximum ProjectData idle-cleanup schedule residence before preserved/error outcomes stop re-arming and surface attention (default: `7200000`)
- `DIAGNOSIS_COMPLETED_STEP_MIN_DELAY_MS` — Minimum re-arm delay for completed diagnosis steps (default: `1000`)
- `ORCHESTRATOR_ZERO_TASK_GRACE_MS` — Grace before a zero-task mission terminalizes (default: `600000`)
- `ORCHESTRATOR_MAX_MISSION_LIFETIME_MS` — Mission lifetime backstop (default: `86400000`)
- `ORCHESTRATOR_WAIT_RECONCILE_INTERVAL_MS` — ProjectData D1 reconciliation backstop interval for active parent waits (default: `30000`)
- `ORCHESTRATOR_WAIT_MAX_CHILDREN` — Maximum same-project task IDs selected by one durable wait (default: `20`, hard ceiling: `90`)
- `ORCHESTRATOR_WAIT_MAX_ACTIVE_PER_PROJECT` — Maximum active durable parent waits per project (default: `100`)
- `ORCHESTRATOR_WAIT_MAX_DURATION_MS` — Maximum finite durable wait deadline (default: `86400000`)
- `ORCHESTRATOR_WAIT_MAX_CANDIDATES_PER_ALARM` — Maximum wait subscriptions reconciled by one ProjectData alarm (default: `10`)
- `PROJECT_DATA_TOOL_METADATA_MAX_BYTES` — Maximum stored `tool_metadata` bytes per ProjectData message before oversized tool content is stripped into bounded metadata (default: `131072`)
- `PROJECT_DATA_STORAGE_TELEMETRY_ENABLED` — Enables ProjectData `databaseSize` alarm measurement and D1 telemetry writes (default: `true`)
- `PROJECT_DATA_STORAGE_LIMIT_BYTES` — Cloudflare SQLite-backed Durable Object storage limit used for ProjectData usage classification (default: `10000000000`)
- `PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS` — Minimum interval between per-object ProjectData storage measurements (default: `3600000`)
- `PROJECT_DATA_STORAGE_ALERT_INTERVAL_MS` — Minimum interval between repeated warning/critical/degraded ProjectData storage observability alerts and cleanup target-unreachable alerts (default: `21600000`)
- `PROJECT_DATA_STORAGE_NOTICE_RATIO` — ProjectData storage usage ratio classified as `notice` (default: `0.6`)
- `PROJECT_DATA_STORAGE_WARNING_RATIO` — ProjectData storage usage ratio classified as `warning` (default: `0.8`)
- `PROJECT_DATA_STORAGE_CRITICAL_RATIO` — ProjectData storage usage ratio classified as `critical` (default: `0.9`)
- `PROJECT_DATA_STORAGE_DEGRADED_RATIO` — ProjectData storage usage ratio classified as `degraded` (default: `0.95`)
- `PROJECT_DATA_STORAGE_EMERGENCY_TARGET_RATIO` — Target usage ratio for explicit superadmin ProjectData emergency purge calls (default: `0.9`)
- `PROJECT_DATA_STORAGE_EMERGENCY_BATCH_ROWS` — Oldest `activity_events` and `acp_session_events` rows deleted per table per emergency purge batch (default: `500`)
- `PROJECT_DATA_STORAGE_EMERGENCY_MAX_BATCHES` — Maximum emergency purge batches per explicit call (default: `4`)
- `PROJECT_DATA_STORAGE_GROWTH_LOOKBACK_DAYS` — Lookback window used to estimate ProjectData bytes/day growth and days to storage limit (default: `7`)
- `PROJECT_DATA_STORAGE_TELEMETRY_LIST_LIMIT_DEFAULT` — Default row count for admin ProjectData storage telemetry and history lists (default: `50`)
- `PROJECT_DATA_STORAGE_TELEMETRY_LIST_LIMIT_MAX` — Max accepted row count for admin ProjectData storage telemetry and history lists (default: `200`)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED` — Enables automatic ProjectData cleanup that archives expandable `tool_metadata.content` payloads to private R2 before stripping them from old ProjectData message rows (default: enabled)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PLAN_ID` — Immutable operator plan identifier; required with a fixed cleanup cutoff and persisted with continuation state so configuration drift fails closed (default: empty)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_KEY` / `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_SHA256` — Verified, immutable R2 target-manifest root required for a fixed cleanup plan (default: empty)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_MANIFEST_MAX_BYTES` / `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ROOT_MANIFEST_MAX_BYTES` — Verified approved-plan R2 manifest read/write ceilings, included in exact-plan fingerprints (defaults: `2000000` / `1000000`)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_ROWS` / `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES` / `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_R2_OPERATIONS` / `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_WALL_TIME_MS` — Hard cumulative approval ceilings required for a fixed cleanup plan; exact execution transactionally charges the full per-pass R2-operation and wall-time allowances before external work, without refunds (default: empty)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS` — Optional comma-separated project allowlist for automatic cleanup; empty preserves cleanup eligibility for every project, while an emergency rollout can scope elevated budgets to exact projects (default: empty)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT` — Optional fixed exclusive tool-message creation cutoff in epoch milliseconds; when set, an immutable plan ID and exactly one allowlisted project are required, and malformed/future values fail closed (default: empty, retention-derived cutoff)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO` — ProjectData storage usage ratio that starts automatic tool payload archival cleanup even before the retention cadence is due (default: `0.8`)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO` — ProjectData storage usage ratio below which automatic tool payload cleanup stops (default: `0.75`)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS` — Maximum eligible tool-message candidates processed by one automatic cleanup alarm batch; ordinary candidate selection may examine a larger physical row window bounded by `PROJECT_DATA_STORAGE_RELIEF_MEASURE_MAX_BATCH_ROWS` (default: `500`)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES` — Legacy `tool_metadata` read budget for one automatic cleanup pass; an ordinary retention pass may admit its first oversized candidate up to the archive metadata ceiling to advance the cursor, while a fixed exact plan fails closed unless its per-row ceiling fits this budget (default: `2097152`)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES` — Hard maximum single legacy `tool_metadata` row read by cleanup; an approved emergency plan must explicitly raise it to include larger manifest targets, without exceeding `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES` (default: `1048576`)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS` — Legacy terminal-session age guard retained for storage telemetry compatibility; tool payload archival uses `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS` (default: `7`)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS` — Delay before the next automatic cleanup alarm batch when more candidates remain (default: `86400000`, daily)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM` — Deprecated legacy terminal-session cleanup knob retained for env compatibility; archival cleanup scans tool-message rows directly and is bounded by rows, bytes, and wall time instead (default: `25`)
- `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS` — Absolute wall-clock deadline shared by candidate processing and every R2 write/read-back operation in one cleanup pass (default: `20000`)
- `PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_ROWS` — Hard row cap for one explicit superadmin manual ProjectData tool payload archival cleanup pass (default: `500`)
- `PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_BYTES` — Maximum configurable legacy `tool_metadata` read budget for one explicit manual pass; the ordinary-path first-row exception still applies unless a fixed exact plan binds the row ceiling within this budget (default: `2097152`)
- `PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_WALL_TIME_MS` — Hard wall-clock cap for one explicit manual cleanup pass (default: `20000`)
- `PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS` — Persisted project-scoped cooldown after an explicit manual cleanup pass (default: `86400000`, daily)
- `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS` — Message age before expandable tool payload JSON may be archived to private R2 and stripped from the ProjectData DO (default: `5`)
- `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS` — Cadence for the retention-driven ProjectData tool payload archival scan (default: `86400000`)
- `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX` — Private R2 prefix used for archived ProjectData tool payload JSON objects (default: `project-data/tool-payloads`)
- `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS` — Per-R2 write/read-back verification timeout for automatic archival cleanup; timeout leaves the original payload in ProjectData and defers retry (default: `5000`)
- `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS` — Maximum R2 PUT, GET, and body-read operations reserved by one cleanup pass (default: `1500`)
- `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS` — Row-level retry deferral after retryable archive/write failures (default: `300000`)
- `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES` — R2 chunk size used when archiving legacy tool payload metadata larger than one archive object slice (default: `524288`)
- `PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES` — Absolute bounded read cap for legacy oversized tool payload metadata; larger rows fail closed and remain in ProjectData (default: `1900000`)
- `PROJECT_DATA_STORAGE_RELIEF_MEASURE_BATCH_ROWS` — Default row budget for superadmin ProjectData relief measurement slices (default: `500`)
- `PROJECT_DATA_STORAGE_RELIEF_MEASURE_MAX_BATCH_ROWS` — Maximum physical row window accepted for superadmin/preflight relief measurements and examined by one ordinary cleanup candidate-selection slice (default: `5000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_ENABLED` — Enables the scheduled, read-only, fixed-cutoff ProjectData tool-payload relief preflight; requires the exact plan, project, and cutoff variables below (default: disabled)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PLAN_ID` — Immutable operator plan identifier used to resume one preflight without mixing evidence from another run (default: empty)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PROJECT_ID` — Exact ProjectData project targeted by the enabled preflight (default: empty)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_CUTOFF_CREATED_AT` — Fixed exclusive tool-message creation cutoff in epoch milliseconds; required while preflight is enabled (default: empty)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_BATCH_ROWS` — Maximum physical `chat_messages` rowid-window rows examined by one preflight slice before eligibility filtering (default: `5000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_INTERVAL_MS` — Persisted minimum interval between preflight slices (default: `300000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BATCHES` — Overall claimed-attempt ceiling; an incomplete successful scan becomes truncated at the ceiling, while the final failed attempt becomes failed (default: `100`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_ROWS` — Overall physical `chat_messages` rows-examined ceiling for one preflight plan before eligibility filtering (default: `500000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BYTES` — Overall projected net reclaimable-byte evidence ceiling for one preflight plan (default: `2000000000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_LEASE_MS` — D1 claim lease that prevents overlapping scheduled slices and must exceed the wall-time budget by the configured lease margin (default: `60000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_WALL_TIME_MS` — Absolute per-slice deadline shared by the bounded ProjectData measurement and verified R2 manifest writes/read-backs; failures retain the prior cursor and fail closed for retry (default: `20000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_SLICES_PER_RUN` — Maximum number of sequential, separately leased preflight slices in one scheduled invocation; later slices bypass only the persisted cadence for that invocation (default: `1`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_RUN_WALL_TIME_MS` — Aggregate invocation admission budget used to decide whether another full sequential slice can start; must exceed the per-slice wall-time budget by the return margin (default: `25000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_LEASE_MARGIN_MS` — Required lease headroom above the per-slice wall-time budget (default: `5000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_RETURN_MARGIN_MS` — Required return headroom inside measurement, slice, and aggregate run budgets (default: `500`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MEASUREMENT_WALL_TIME_MS` — Explicit ProjectData measurement budget within one slice; plus the return margin it must not exceed the slice wall budget (default: `10000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_STATE_BYTES` — Combined D1 JSON byte ceiling for accumulated session and target-batch proof state in one preflight row (default: `1750000`)
- `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_ERROR_MAX_LENGTH` — Character ceiling for a persisted preflight failure diagnostic (default: `1000`)

Implementation of the storage-safety, cleanup and preflight behavior documented above:
`resolveStorageSafetyConfig()` (`apps/api/src/durable-objects/project-data/storage-safety.ts`)
validates every value and fails closed on a malformed one;
`runProjectDataToolPayloadCleanup()` / `scanToolPayloadCleanupBatch()`
(`.../tool-payload-cleanup.ts`) apply the row/byte/wall-time and approved-plan budgets;
`runProjectDataManualToolPayloadCleanup()` (`.../tool-payload-manual-cleanup.ts`) owns the
manual slice, its fingerprint and its cooldown;
`measureProjectDataStorageReliefSlice()` (`.../storage-relief-measurement.ts`) owns the
read-only measurement, cursor and byte/deadline bounds; and
`runProjectDataStorageReliefPreflight()`
(`apps/api/src/scheduled/project-data-storage-relief-preflight.ts`) owns the lease, the
per-slice and per-run admission budgets, and the verified R2 manifest writes.

- `PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED` — Production-disabled switch for cleanup of old terminal-session grouped message rows and their external-content FTS entries (default: disabled)
- `PROJECT_DATA_GROUPED_FTS_CLEANUP_TRIGGER_RATIO` — ProjectData usage ratio that starts grouped/FTS derived-data cleanup when explicitly enabled (default: `0.9`)
- `PROJECT_DATA_GROUPED_FTS_CLEANUP_TARGET_RATIO` — ProjectData usage ratio below which grouped/FTS cleanup stops (default: `0.85`)
- `PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_SESSIONS` — Maximum terminal sessions cleaned by one grouped/FTS canary slice (default: `2`)
- `PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_ROWS` — Maximum grouped message rows deleted by one grouped/FTS canary slice (default: `1000`)
- `PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_BYTES` — Maximum grouped message content bytes deleted by one grouped/FTS canary slice (default: `4194304`)
- `PROJECT_DATA_GROUPED_FTS_CLEANUP_MIN_SESSION_AGE_DAYS` — Minimum terminal-session age before grouped/FTS derived rows may be cleaned (default: `7`)
- `PROJECT_DATA_GROUPED_FTS_CLEANUP_RECHECK_MS` — Delay before the next grouped/FTS cleanup slice when more candidates remain (default: `300000`)
- `PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_TIME_MS` — Soft wall-clock budget for one grouped/FTS cleanup slice (default: `5000`)
- `PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_UNSAFE_RATIO` — Refuses grouped/FTS cleanup writes when the object is too close to the configured storage limit (default: `0.98`)
- `PROJECT_DATA_GROUPED_FTS_CLEANUP_WEAK_RECLAIM_BYTES` — Stops grouped/FTS cleanup if a slice deletes rows but `databaseSize` does not drop by at least this many bytes (default: `1`)
- `PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED` — Enables automatic deletion of old low-value terminal-session `activity_events` and terminal ACP event history when storage remains above the cleanup target (default: enabled)
- `PROJECT_DATA_EVENT_LOG_CLEANUP_BATCH_ROWS` — Maximum terminal `activity_events` rows and terminal `acp_session_events` rows deleted per automatic cleanup alarm batch (default: `500`)
- `PROJECT_DATA_EVENT_LOG_CLEANUP_MIN_SESSION_AGE_DAYS` — Minimum terminal-session age before automatic event-log cleanup may delete its activity/ACP event history (default: `7`)
- `PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS` — Delay before the next terminal event-log cleanup alarm batch when more candidates remain (default: `86400000`, daily)
- `PROJECT_DATA_ARCHIVE_SHARDING_ENABLED` — Production-disabled switch for exact archive read routing (default: disabled)
- `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED` — Separate production-disabled switch for the unscoped scheduled archive-sharding sweep; enabling exact routing alone does not run global migration (default: disabled)
- `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS` — Persisted cadence gate between unscoped scheduled archive-sharding sweeps; the Worker scheduled handler wakes every five minutes and claims the cadence row only when it is due. The code fallback is daily; the checked-in `wrangler.toml` ships 15 minutes because one tick moves one non-trivial session (default: `86400000`, shipped: `900000`)
- `PROJECT_DATA_ARCHIVE_SHARD_COUNT` — Deterministic archive-shard fanout used when assigning terminal sessions to ProjectData archive Durable Objects (default: `128`)
- `PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS` — Maximum projects selected by one archive-sharding cron pass (default: `1`)
- `PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS` — Hard ceiling on sessions (in-flight plus new candidates) one archive-sharding pass may process (default: `10`)
- `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` — Cumulative `session_summaries.message_count` of NEW candidates one pass may journal; candidates are selected largest first and a single session above the budget is still selected alone (default: `20000`)
- `PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS` — Minimum terminal-session age before archive-sharding may consider a session (default: `604800000`)
- `PROJECT_DATA_ARCHIVE_PRECOPY_REFUSAL_RETRY_MS` — How long a session the root object refused at prepare (a pre-copy eligibility invariant such as `active_session_state`, recorded as a `frozen`/`precopy_refused` journal with the location returned to `root`) stays out of unscoped sweep selection; an operator canary that names the session bypasses it; values below `60000` fall back to the default so a stray value cannot disable the anti-thrash window (default: `604800000`)
- `PROJECT_DATA_ARCHIVE_FAILED_RETRY_DELAY_MS` — Minimum age of a `failed` archive journal before an unscoped sweep reclaims it, so `PROJECT_DATA_ARCHIVE_POISON_AFTER_ATTEMPTS` spans hours rather than consecutive cadence ticks; `0` disables the delay and a session-scoped canary bypasses it (default: `3600000`)
- `PROJECT_DATA_ARCHIVE_CHUNK_ROWS` — Maximum rows exported in one archive chunk (default: `500`)
- `PROJECT_DATA_ARCHIVE_CHUNK_BYTES` — Maximum bytes exported in one archive chunk, clamped below Cloudflare's 32MiB RPC ceiling (default: `16777216`)
- `PROJECT_DATA_ARCHIVE_HASH_PAGE_ROWS` — Rows read per statement while streaming a session's terminal-version hash and grouped-row loops inside the ProjectData DO; bounds object memory by page size instead of session size (default: `500`)
- `PROJECT_DATA_ARCHIVE_LEASE_MS` — D1 CAS journal lease duration for archive-sharding work (default: `300000`)
- `PROJECT_DATA_ARCHIVE_WALL_TIME_MS` — Soft wall-clock budget for one archive-sharding cron pass, checked between candidates (a single large session may run past it). Code fallback 5 s; the checked-in `wrangler.toml` ships 30 s (default: `5000`, shipped: `30000`)
- `PROJECT_DATA_ARCHIVE_ROLLOUT_LIST_LIMIT_DEFAULT` — Default row limit for superadmin archive-sharding rollout inspection and failed/poisoned/frozen migration list endpoints (default: `25`)
- `PROJECT_DATA_ARCHIVE_ROLLOUT_LIST_LIMIT_MAX` — Maximum accepted row limit for superadmin archive-sharding rollout inspection endpoints (default: `100`)
- `PROJECT_DATA_ARCHIVE_FROZEN_INTENT_INSPECTION_LIMIT_DEFAULT` — Default row limit for frozen-intent detail inspection; each row may perform source and target ProjectData DO RPCs (default: `5`)
- `PROJECT_DATA_ARCHIVE_FROZEN_INTENT_INSPECTION_LIMIT_MAX` — Maximum accepted frozen-intent detail inspection limit; configured values are hard-clamped to 10 to cap hot-DO fan-out (default: `10`)
- `PROJECT_DATA_ARCHIVE_MANUAL_CANARY_MAX_SESSIONS` — Maximum sessions selected by one scoped manual archive-sharding canary; dry-run remains flag-independent, non-dry requires exact archive routing enabled (default: `5`)
- `PROJECT_DATA_ARCHIVE_MANUAL_CANARY_MAX_WALL_TIME_MS` — Maximum wall-clock budget accepted by the scoped manual archive-sharding canary endpoint (default: `15000`)
- `PROJECT_DATA_ARCHIVE_ROLLOUT_WARNING_EXAMPLES_MAX` — Maximum malformed-row warning examples returned by archive rollout read/list endpoints (default: `5`)
- `PROJECT_DATA_ARCHIVE_ROLLOUT_WARNING_REASON_MAX_LENGTH` — Maximum characters per malformed-row warning reason returned by archive rollout read/list endpoints (default: `300`)
- `PROJECT_DATA_ARCHIVE_POISON_AFTER_ATTEMPTS` — Failed archive-sharding attempts before the migration is poisoned and the project circuit breaker opens (default: `3`)
- `PROJECT_DATA_ARCHIVE_R2_PREFIX` — Private R2 prefix for terminal-session archive recovery chunks and manifests (default: `project-data/session-archives`)
- `PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS` — Maximum archive-shard owners queried for one project-wide message search before results report explicit partial metadata (default: `4`)
- `PROJECT_EVENT_MAX_ACTIVE_SUBSCRIPTIONS_PER_PROJECT` — Maximum active durable event subscriptions in one ProjectData object (default: `200`)
- `PROJECT_EVENT_FILTER_MAX_VALUES_PER_FIELD` — Maximum exact/set values accepted for one v1 event filter field (default: `20`)
- `PROJECT_EVENT_FILTER_MAX_MATCH_KEYS` — Maximum deterministic match keys compiled for one event subscription (default: `100`)
- `PROJECT_EVENT_FILTER_MAX_STRING_BYTES` — Maximum bytes for event source/type/subject, filter values, delivery keys, fingerprints, and event idempotency strings (default: `160`)
- `PROJECT_EVENT_METADATA_MAX_BYTES` — Maximum normalized event metadata JSON bytes stored in ProjectData (default: `8192`)
- `PROJECT_EVENT_METADATA_MAX_DEPTH` — Maximum nesting depth for normalized event metadata (default: `4`)
- `PROJECT_EVENT_METADATA_MAX_KEYS` — Maximum total object keys in normalized event metadata (default: `64`)
- `PROJECT_EVENT_METADATA_MAX_ARRAY_ITEMS` — Maximum array items in normalized event metadata (default: `64`)
- `PROJECT_EVENT_DISPLAY_MAX_BYTES` — Maximum deterministic untrusted event display JSON bytes (default: `4096`)
- `PROJECT_EVENT_DISPLAY_MAX_LABELS` — Maximum labels accepted in event display data (default: `12`)
- `PROJECT_EVENT_RAW_PAYLOAD_REF_MAX_BYTES` — Maximum optional raw-payload reference JSON bytes; raw webhook bodies are not persisted in ProjectData (default: `512`)
- `PROJECT_EVENT_REASON_MAX_BYTES` — Maximum diagnostic reason bytes on subscriptions, batches, and attempts (default: `1024`)
- `PROJECT_EVENT_MAX_MATCHES_PER_EVENT` — Maximum durable subscription matches written for one admitted normalized event (default: `100`)
- `PROJECT_EVENT_DELIVERY_BATCH_MAX_EVENTS` — Maximum event matches in one durable delivery batch (default: `50`)
- `PROJECT_EVENT_DELIVERY_ATTEMPT_MAX_PER_BATCH` — Maximum recorded delivery attempts for one event delivery batch (default: `10`)
- `PROJECT_EVENT_LIST_LIMIT` — Default ProjectData event-subscription list/status page size (default: `50`)
- `PROJECT_EVENT_LIST_MAX` — Maximum ProjectData event-subscription list/status page size (default: `200`)
- `PROJECT_EVENT_SUBSCRIPTION_EVENT_CURSOR_MAX_LENGTH` — Maximum opaque `list_subscription_events` cursor length accepted by ProjectData pull delivery (default: `512`)
- `PROJECT_EVENT_RECENT_STATUS_LIMIT` — Maximum rows returned per section in recent event-subscription status inspection (default: `50`)
- `PROJECT_EVENT_RETENTION_DAYS` — Retention window for terminal ProjectData event-subscription records (default: `30`)
- `PROJECT_EVENT_RETENTION_BATCH_ROWS` — Maximum old rows pruned per event-subscription retention category per pass (default: `500`)

Absent operational brake keys and KV read errors mean enabled. This fail-open
behavior preserves availability and intentionally differs from the fail-closed
trials entitlement switch.

GitHub Environment variables for the scheduled Durable Object monitor:

- `DO_WALL_TIME_SCRIPT_NAMES` — Optional wall-time/rate service filter and fallback cron-liveness target
- `DO_INVOCATION_RATE_REGRESSION_RATIO` — Recent-versus-baseline invocation-rate threshold (default: `2`)
- `DO_CRON_LIVENESS_MAX_AGE_HOURS` — Maximum allowed age of `cron.completed` (default: `3`)
- `DO_CRON_LIVENESS_SCRIPT_NAMES` — Explicit API Worker service target for cron liveness; the GitHub workflow derives both script-name filters from `RESOURCE_PREFIX` and the selected stack when unset
- `DO_CRON_LIVENESS_ENDPOINT` — Optional Workers Observability query endpoint override passed by the monitor workflow

The monitor's `CF_API_TOKEN` GitHub Environment secret must include the
Cloudflare `Workers Observability Write` permission. Despite the permission
name, Cloudflare documents it for the supported telemetry query endpoint used
by the read-only cron-liveness check.

### Human Input and Web Push

- `HUMAN_INPUT_TIMEOUT_MS` — Initial needs-input response window (default: `7200000`)
- `HUMAN_INPUT_ESCALATION_FRACTIONS` — Comma-separated reminder points within the initial window (default: `0.25,0.75`)
- `HUMAN_INPUT_UNDELIVERED_GRACE_MS` — Extension when no push delivery was confirmed (default: `7200000`)
- `HUMAN_INPUT_MAX_WAIT_MS` — Hard maximum needs-input marker lifetime (default: `86400000`)
- `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` — Deployment-generated Worker secrets for Web Push authentication and browser subscription
- `WEB_PUSH_TTL_SECONDS` — Push-service message TTL (default: `86400`)
- `WEB_PUSH_VAPID_TTL_SECONDS` — VAPID authorization-token lifetime (default: `43200`)
- `WEB_PUSH_DELIVERY_TIMEOUT_MS` — Per-attempt delivery timeout (default: `10000`)
- `WEB_PUSH_DELIVERY_BUDGET_MS` — Total delivery/fan-out budget kept below the Worker `waitUntil()` lifetime (default: `25000`)
- `WEB_PUSH_FANOUT_CONCURRENCY` — Maximum endpoint deliveries processed concurrently (default: `8`)
- `WEB_PUSH_MAX_ATTEMPTS` — Bounded transient delivery attempts (default: `3`)
- `WEB_PUSH_MAX_RETRY_AFTER_SECONDS` — Maximum honored `Retry-After` delay (default: `30`)
- `WEB_PUSH_MAX_PAYLOAD_BYTES` — Maximum unencrypted payload size (default: `3500`)
- `WEB_PUSH_FAILURE_THRESHOLD` — Consecutive failures before disabling a subscription (default: `5`)
- `WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER` — Maximum retained browser endpoints per user (default: `8`)
- `WEB_PUSH_USER_AGENT_MAX_LENGTH` — Maximum stored browser description length (default: `512`)
- `RATE_LIMIT_PUSH_SUBSCRIPTION` — Subscription mutations allowed per user per hour (default: `30`)

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
- `VM_ADMISSION_CONTROL_MODE` — VM task/session admission mode for node-packing backpressure (`off`, `shadow`, `enforce`; default: `enforce`)
- `VM_ADMISSION_LEASE_TTL_MS` — Fenced VM provisioning claim lease duration (default: `1200000`)
- `VM_ADMISSION_RETRY_MIN_MS` / `VM_ADMISSION_RETRY_MAX_MS` — Bounds for retrying tasks waiting on VM capacity (defaults: `15000` / `60000`)
- `VM_ADMISSION_WAIT_TIMEOUT_MS` — Maximum visible wait for VM capacity before failing the task (default: `7200000`)
- `VM_ADMISSION_PROVIDER_COOLDOWN_MS` — Cooldown after provider/account capacity errors such as Hetzner server limits (default: `600000`)
- `VM_ADMISSION_WAKE_BATCH_SIZE` — Maximum waiting TaskRunner DOs nudged by one capacity event (default: `25`)
- `VM_ADMISSION_DIAGNOSTIC_MESSAGE_MAX_LENGTH` — Maximum provider diagnostic message persisted on admission/capacity rows (default: `500`)
- `MAX_PROJECTS_PER_USER` — Runtime project cap
- `MAX_TASKS_PER_PROJECT` — Runtime task cap per project
- `MAX_TASK_DEPENDENCIES_PER_TASK` — Runtime dependency-edge cap per task
- `PROJECT_INVITE_TOKEN_BYTES` — Random bytes used for generated project invite link tokens (default: 32)
- `PROJECT_INVITE_DEFAULT_EXPIRY_DAYS` — Default lifetime for project invite links created without an explicit expiry (default: 7)
- `PROJECT_INVITE_MAX_EXPIRY_DAYS` — Maximum allowed project invite link lifetime (default: 30)
- `AGENT_SETTINGS_VALIDATION_LIMITS` — Optional JSON object overriding
  agent-settings validation bounds for model IDs, tool lists, additional env
  entries, provider display names, and OpenCode base URLs. See
  `apps/api/.env.example` and `apps/www/src/content/docs/docs/guides/self-hosting.mdx` for supported keys
  and defaults.

### Platform Feedback and Report an Issue

- `PLATFORM_FEEDBACK_PROJECT_ID` — Bootstrap/environment fallback for the private project that receives Report-an-Issue submissions, automated platform triage records, and incident trigger agents. The Admin → Integrations runtime setting is preferred and overrides it; no effective project hides in-app reporting and disables incident trigger sweeps.
- `PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES`, `PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT`, `PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT`, `PLATFORM_FEEDBACK_TRIAGE_EVIDENCE_LIMIT`, `PLATFORM_FEEDBACK_TRIAGE_CLAIM_TTL_MS`, `PLATFORM_FEEDBACK_TRIAGE_MAX_FAILURES`, `PLATFORM_FEEDBACK_TRIAGE_FAILURE_REASON_MAX_LENGTH`, `PLATFORM_FEEDBACK_TRIAGE_BUDGET_DEFER_MS` — Hourly platform-error grouping, budget deferral, and draft-Idea triage bounds.
- `DEBUG_AGENT_MODEL`, `DEBUG_AGENT_MAX_TURNS`, `DEBUG_AGENT_RUN_TOKEN_LIMIT`, `DEBUG_AGENT_MODEL_OUTPUT_TOKENS`, `DEBUG_AGENT_DAILY_TOKEN_LIMIT`, `DEBUG_AGENT_TOOL_RESULT_LIMIT`, `DEBUG_AGENT_TOOL_RESULT_BYTES`, `DEBUG_AGENT_MAX_WINDOW_HOURS`, `DEBUG_AGENT_TIMEOUT_MS`, `DEBUG_AGENT_HARD_DEADLINE_MS`, `DEBUG_AGENT_STALE_HEARTBEAT_MS`, `DEBUG_AGENT_RETRY_BASE_DELAY_MS`, `DEBUG_AGENT_RETRY_MAX_DELAY_MS`, `DEBUG_AGENT_STEP_MAX_RETRIES` — Automated and manual diagnosis model, turn, retry, timeout, and token-budget controls.
- `PLATFORM_FEEDBACK_INCIDENT_DISPATCH_LEASE_TTL_MS`, `PLATFORM_FEEDBACK_INCIDENT_AGENT_LEASE_TTL_MS`, `PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCH_ATTEMPTS`, `PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS`, `PLATFORM_FEEDBACK_INCIDENT_RECLAIM_LIMIT`, `PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS`, `PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_MAX_AGE_MS`, `PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_EXPIRY_BATCH_SIZE`, `PLATFORM_FEEDBACK_INCIDENT_TRIGGER_LIMIT` — Durable private incident backlog dispatch/claim/reopen/reclaim/expiry state-machine and sweep bounds.
- `PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_SEVERITY`, `PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE`, `PLATFORM_FEEDBACK_INCIDENT_MIN_PENDING_AGE_MS`, `PLATFORM_FEEDBACK_INCIDENT_DISPATCH_RATE_WINDOW_MS`, `PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCHES_PER_TRIGGER_WINDOW` — Automatic incident dispatch eligibility, batch/age admission, and per-trigger rate-cap controls.
- `PLATFORM_FEEDBACK_INCIDENT_SUMMARY_LIMIT`, `PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_REF_LIMIT`, `PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_MAX_BYTES`, `PLATFORM_FEEDBACK_INCIDENT_RESOLUTION_NOTE_MAX_LENGTH` — Model-visible incident summary/evidence/resolution size limits.
- `PLATFORM_FEEDBACK_INCIDENT_AUTO_TRIGGER_ENABLED`, `PLATFORM_FEEDBACK_INCIDENT_TRIGGER_NAME`, `PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE` — Private incident trigger auto-creation and default prompt configuration.
- `REPORT_ISSUE_TITLE_MAX_LENGTH`, `REPORT_ISSUE_DESCRIPTION_MAX_LENGTH`, `REPORT_ISSUE_CONTENT_MAX_LENGTH`, `RATE_LIMIT_REPORT_ISSUE_POST` — In-app user report truncation and rate limits.

### Pagination

- `DASHBOARD_ACTIVE_TASK_LIMIT` — Maximum active tasks returned by `/api/dashboard/active-tasks` (default: `100`)
- `DASHBOARD_INACTIVE_THRESHOLD_MS` — Last-message freshness threshold for Active vs Idle on `/api/dashboard/active-tasks` (default: `900000`)
- `TASK_LIST_DEFAULT_PAGE_SIZE` — Default task/project list page size
- `TASK_LIST_MAX_PAGE_SIZE` — Maximum task/project list page size
- `CHAT_SESSION_MESSAGE_LIMIT` — Default page size for chat session message REST responses when no limit is requested — used by the 3s poll and load-more (default: 500)
- `CHAT_SESSION_MESSAGE_MAX` — Ceiling any chat session message request is clamped to; the initial full-conversation load requests up to this (default: 50000)
- `CHAT_SESSION_DELTA_MESSAGE_LIMIT` — Default page size for forward-cursor chat delta fetches after the newest cached browser message (default: 5000)
- `MCP_ARCHIVED_TOOL_PAYLOAD_LIST_LIMIT` — Default result count for the `get_archived_tool_payloads` MCP tool (default: 10)
- `MCP_ARCHIVED_TOOL_PAYLOAD_LIST_MAX` — Maximum result count accepted by the `get_archived_tool_payloads` MCP tool (default: 50)
- `MCP_TRIGGER_LIST_LIMIT` — Default result count for the `list_triggers` MCP tool (default: 20)
- `MCP_TRIGGER_LIST_MAX` — Maximum result count accepted by the `list_triggers` MCP tool (default: 100)
- `MCP_INCIDENT_LIST_LIMIT` — Default result count for the private `list_incident_queue` MCP tool (default: 10)
- `MCP_INCIDENT_LIST_MAX` — Maximum result count accepted by the private `list_incident_queue` MCP tool (default: 50)
- `HETZNER_MAX_LIST_PAGES` — Maximum pages per Hetzner list request (default: 100)

### Timeouts

- `ORCHESTRATOR_STOP_CAS_MAX_ATTEMPTS` — Maximum task-status compare-and-set attempts after a parent hard-stops a child runtime (default: 2)
- `TASK_CALLBACK_TIMEOUT_MS` — Timeout budget for delegated-task callback processing
- `TASK_CALLBACK_RETRY_MAX_ATTEMPTS` — Retry budget for delegated-task callback processing
- `TASK_RECONCILIATION_IDLE_MS` — Idle threshold before a visible task reconciliation check-in (default: 300000)
- `TASK_RECONCILIATION_RESPONSE_DEADLINE_MS` — Response deadline after a visible task reconciliation check-in (default: 60000)
- `TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS` — In-flight prompt observation threshold before SAM records a non-interrupting reconciliation event (default: 1800000)
- `TASK_RECONCILIATION_PROMPT_HARD_STALL_MS` — In-flight prompt hard-stall threshold before SAM requests prompt cancellation and retries check-in later (default: 7200000)
- `TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS` — Hard ceiling for deferring an expired check-in because prompt/tool work is still active (default: 7200000)
- `TASK_RECONCILIATION_MIN_ALARM_DELAY_MS` — Minimum delay before the next reconciliation alarm can fire (default: 10000)
- `TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP` — Maximum D1/runtime assessments per ProjectData alarm pass (default: 5)
- `TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS` — Bounded reconciliation check-in/cancel request timeout (default: 5000)
- `TASK_RECONCILIATION_CANDIDATE_LEASE_MS` — Durable claim floor preventing overlapping alarms from repeating reconciliation; the effective lease covers configured liveness-probe, node-call, and minimum-alarm-delay budgets (default: 30000)
- `TASK_RECONCILIATION_PROBE_MAX_ATTEMPTS` — Consecutive inconclusive task reconciliation attempts before quarantine (default: 3)
- `TASK_RECONCILIATION_QUARANTINE_MS` — Cooldown after task reconciliation exhausts its inconclusive-attempt budget (default: 300000)
- `SESSION_ACTIVITY_PROBE_TIMEOUT_MS` — Bounded authoritative SessionHost inventory request timeout (default: 5000)
- `SESSION_ACTIVITY_PROBE_MAX_ATTEMPTS` — Unreachable probes before the stale activity mirror is quarantined without terminalization (default: 3)
- `SESSION_ACTIVITY_PROBE_MAX_CANDIDATES` — Maximum SessionHost inventory probes per ProjectData alarm pass (default: 10)
- `SESSION_TASK_REPAIR_BATCH_SIZE` — Maximum legacy taskless chat sessions repaired per 5-minute sweep (default: 25; capped at 200)
- `TERMINAL_SESSION_RECONCILE_PROJECT_BATCH_SIZE` — Maximum projects inspected for stale active ProjectData session ledgers per 5-minute sweep (default: 25; capped at 200)
- `TERMINAL_SESSION_RECONCILE_BATCH_SIZE` — Maximum active ProjectData `chat_sessions` candidates reconciled per project per 5-minute sweep (default: 25; capped at 200)
- `TERMINAL_SESSION_SUMMARY_RECONCILE_BATCH_SIZE` — Maximum active D1 `session_summaries` candidates reconciled globally per 5-minute sweep (default: 25; capped at 200)
- `TERMINAL_SESSION_RECONCILE_DEFER_MS` — Retry delay for live-head, snapshot-protected, or temporarily ineligible terminal-session ledger candidates (default: 3600000; capped at 86400000)
- `TASK_RUN_ABSOLUTE_CEILING_MS` — Absolute runaway-cost ceiling that fails even a demonstrably live task (default: 86400000 / 24h)
- `SESSION_ACTIVITY_STALE_THRESHOLD_MS` — Threshold before stale working activity is checked against authoritative SessionHost inventory (default: 300000)
- `NODE_HEARTBEAT_STALE_SECONDS` — Staleness threshold for node health
- `TASK_LIVENESS_PROBE_TIMEOUT_MS` — Per-candidate timeout for ACP and Instant lifecycle probes used by ProjectData heartbeat deferral, idle cleanup, and stuck-task reconciliation; timeout is inconclusive (default: 5000)
- `TASK_LIVENESS_MAX_ACP_SESSIONS` — Maximum task-scoped ACP sessions inspected per liveness probe (default: 5)
- `TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS` — Timeout for stale-VM-node health probes used by ProjectData idle cleanup and stuck-task reconciliation; a timeout is inconclusive and preserves the task/workspace (default: 5000)
- `NODE_AGENT_READY_TIMEOUT_MS` — Max wait for freshly provisioned node-agent health
- `NODE_AGENT_READY_POLL_INTERVAL_MS` — Polling interval for fresh-node readiness checks
- `VM_AGENT_REQUIRED_VERSION` — Deployment-generated required vm-agent build for reusable VM nodes. Official deploys set this from the Git commit SHA after publishing matching binaries; unset disables rollout gating for local/manual or skip-agent deploys.
- `TASK_RUNNER_STEP_MAX_RETRIES` — Max retries per TaskRunner step before failing the task (default: 3)
- `TASK_RUNNER_RETRY_BASE_DELAY_MS` — Base delay for TaskRunner retry backoff (default: 5000)
- `TASK_RUNNER_RETRY_MAX_DELAY_MS` — Maximum delay for TaskRunner retry backoff (default: 60000)
- `TASK_RUNNER_AGENT_POLL_INTERVAL_MS` — TaskRunner D1 poll interval while waiting for a fresh provisioned VM agent (default: 5000)
- `TASK_RUNNER_AGENT_READY_TIMEOUT_MS` — TaskRunner max wait for a provisioned VM agent before failing the task (default: 900000)
- `TASK_RUNNER_AGENT_READY_FRESHNESS_SKEW_MS` — Timestamp skew tolerated between TaskRunner wait start, node heartbeat, and `/ready` signals (default: 30000)
- `TASK_RUNNER_WORKSPACE_DISPATCH_TIMEOUT_MS` — Max wait for VM-agent workspace dispatch acknowledgement (default: 600000)
- `TASK_RUNNER_WORKSPACE_DISPATCH_BASE_DELAY_MS` — Base delay for workspace dispatch retry backoff (default: 30000)
- `TASK_RUNNER_WORKSPACE_DISPATCH_MAX_DELAY_MS` — Maximum delay for workspace dispatch retry backoff (default: 120000)
- `TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS` — Max wait for workspace-ready callback (default: 1800000)
- `TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS` — D1 poll interval during the TaskRunner workspace-ready step (default: 30000)
- `TASK_RUNNER_PROVISION_POLL_INTERVAL_MS` — TaskRunner provision status poll interval (default: 10000)
- `TASK_RUNNER_PROVISION_TIMEOUT_MS` — Max time for TaskRunner node provisioning before permanent failure (default: 900000)
- `HETZNER_API_TIMEOUT_MS` — Timeout for Hetzner Cloud API calls (default: 30000)
- `HETZNER_CAPACITY_RETRY_INITIAL_DELAY_MS` — Initial delay for transient Hetzner capacity retry backoff (default: 15000)
- `HETZNER_CAPACITY_RETRY_MAX_DELAY_MS` — Maximum delay per transient Hetzner capacity retry wait (default: 120000)
- `HETZNER_CAPACITY_RETRY_MAX_ATTEMPTS` — Maximum transient Hetzner capacity retry attempts (default: 10)
- `HETZNER_CAPACITY_RETRY_BUDGET_MS` — Total transient Hetzner capacity retry budget (default: 300000)
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
- `MAX_VM_AGENT_ERROR_SOURCE_LENGTH` — Max redacted VM error source length (default: 256)
- `OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH` — Max persisted observability error message length (default: 2048)
- `OBSERVABILITY_ERROR_STACK_MAX_LENGTH` — Max persisted observability stack length (default: 4096)
- `OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH` — Max persisted observability user-agent length (default: 512)
- `VM_INCIDENT_R2_PREFIX` — Private R2 object-key prefix (default: `diagnostic-incidents`; generated deployments use the Pulumi output)
- `VM_INCIDENT_ARTIFACT_MAX_BYTES` — Max compressed artifact bytes (default: 2097152)
- `VM_INCIDENT_REGISTRATION_MAX_BYTES` — Max artifact registration body bytes (default: 262144)
- `VM_INCIDENT_MANIFEST_MAX_BYTES` — Max redacted manifest bytes (default: 131072)
- `VM_INCIDENT_PREVIEW_MAX_BYTES` — Max redacted preview bytes (default: 131072)
- `VM_INCIDENT_MAX_ARTIFACTS_PER_NODE` — Active artifact quota per node (default: 50)
- `VM_INCIDENT_MAX_BYTES_PER_NODE` — Active expected-byte quota per node (default: 104857600)
- `VM_INCIDENT_RETENTION_DAYS` — Private object and active metadata retention (default: 7; generated deployments use the Pulumi output)
- `VM_INCIDENT_METADATA_RETENTION_DAYS` — Expired metadata retention after object deletion (default: 30)
- `VM_INCIDENT_PENDING_TIMEOUT_MINUTES` — Incomplete upload timeout and upload-lease duration (default: 30)
- `VM_INCIDENT_RECONCILE_BATCH_SIZE` — Max rows repaired per scheduled pass (default: 50; minimum: 6)

### Project File Library

- `LIBRARY_LIST_DEFAULT_PAGE_SIZE` — Default file-list page size (default: 50)
- `LIBRARY_LIST_MAX_PAGE_SIZE` — Maximum file-list page size (default: 200)
- `LIBRARY_TAG_QUERY_BATCH_SIZE` — File IDs per tag metadata lookup query (default: 80, capped below D1 bind-variable limits)
- `LIBRARY_PROJECT_DELETE_CLEANUP_BATCH_SIZE` — Maximum project-owned R2 library objects listed and deleted per page after project deletion (default: `1000`, capped at R2's page maximum)
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

- `TRIGGER_STALE_EXECUTION_TIMEOUT_MS` — Age before running executions are checked against linked task liveness (default: `1800000`)
- `TRIGGER_STALE_QUEUED_TIMEOUT_MS` — Age before queued executions are checked against linked task liveness (default: `300000`)
- `TRIGGER_EXECUTION_HARD_MAX_RESIDENCE_HOURS` — Hard maximum execution residence backstop. The cleanup/admission/incident-dispatch paths still read linked task liveness so this backstop cannot free concurrency for a live task by itself (default: `48`)
- `TRIGGER_EXECUTION_LOG_RETENTION_DAYS` — Completed/failed/skipped execution log retention (default: `90`)
- `TRIGGER_EXECUTION_CLEANUP_ENABLED` — Trigger execution cleanup kill switch (default: enabled; set to `false` to disable)
- `TRIGGER_STALE_RECOVERY_BATCH_SIZE` — Maximum stale execution candidates processed per sweep (default: `100`)
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
- `MAX_TRIGGERS_PER_PROJECT` — Platform default trigger cap per project (default: `20`). Editable per project in the Settings → Scaling & Scheduling → Task Limits field; a `NULL` `projects.max_triggers` falls back to this env default.

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

### Session Snapshots

Generated deployments validate and pass these values through cloud-init to newly provisioned VM Agent systemd services. Instant containers receive the same values at launch.

- `SESSION_SNAPSHOT_OPERATION_TIMEOUT` — Deadline for one asynchronous checkpoint operation (default: `15m`)
- `SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL` — Minimum interval between progress callbacks while a checkpoint continues making progress (default: `15s`)
- `SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT` — Timeout for each best-effort progress callback to the control plane (default: `5s`)

### File Operations

- `FILE_LIST_TIMEOUT` — Timeout for file listing commands (default: 10s)
- `FILE_LIST_MAX_ENTRIES` — Max entries per directory listing (default: 1000)
- `FILE_FIND_TIMEOUT` — Timeout for recursive file index (default: 15s)
- `FILE_FIND_MAX_ENTRIES` — Max entries returned by file index (default: 5000)

### Error Reporting

Generated deployments validate and pass these values through cloud-init to newly provisioned VM Agent systemd services.

- `ERROR_REPORT_FLUSH_INTERVAL` — Background error flush interval (default: 30s)
- `ERROR_REPORT_MAX_BATCH_SIZE` — Immediate flush threshold (default: 10)
- `ERROR_REPORT_MAX_BATCH_BYTES` — Max serialized batch bytes, aligned with Worker ingestion (default: 32768)
- `ERROR_REPORT_MAX_QUEUE_SIZE` — Max durable SQLite outbox entries (default: 1000)
- `ERROR_REPORT_HTTP_TIMEOUT` — HTTP POST timeout for error reports (default: 10s)
- `ERROR_REPORT_RETRY_INITIAL` / `ERROR_REPORT_RETRY_MAX` — Exponential retry bounds (defaults: 1s / 5m)
- `ERROR_REPORT_MAX_ATTEMPTS` — Retry attempts before a report expires locally (default: 20)
- `ERROR_REPORT_DB_PATH` — Durable SQLite outbox path (default: next to the VM Agent persistence database)
- `ERROR_REPORT_DB_BUSY_TIMEOUT` — SQLite outbox contention timeout (default: 5s)
- `ERROR_REPORT_SPOOL_DIR` — Private evidence spool path (default: `diagnostic-incidents` beside the persistence database)
- `ERROR_REPORT_ARTIFACT_MAX_BYTES` — Max compressed artifact bytes (default: 2097152)
- `ERROR_REPORT_SPOOL_MAX_BYTES` — Max local evidence spool bytes (default: 20971520)
- `ERROR_REPORT_RETENTION` — Max local report/evidence retention (default: 24h)
- `ERROR_REPORT_COLLECTOR_TIMEOUT` — Shared allowlisted collector deadline (default: 10s)
- `ERROR_REPORT_MAX_COLLECTOR_DOCS` — Max structured collector documents (default: 8)
- `ERROR_REPORT_MAX_DOCUMENT_BYTES` — Cumulative redacted preview budget (default: 131072)
- `ERROR_REPORT_MAX_VALUE_DEPTH` / `ERROR_REPORT_MAX_VALUE_ITEMS` — Recursive sanitizer bounds (defaults: 8 / 256)
- `ERROR_REPORT_MAX_STRING_BYTES` — Per-string sanitizer limit (default: 4096)
- `ERROR_REPORT_EVENT_LIMIT` — Max structured event or workspace previews collected (default: 100)
- `ERROR_REPORT_RESPONSE_MAX_BYTES` — Max control-plane response bytes read into a diagnostic error (default: 4096)
- `ERROR_REPORT_STORED_ERROR_MAX_BYTES` — Max bytes persisted for a durable reporter error (default: 512)
- `ERROR_REPORT_COLLECTOR_CONCURRENCY` — Max automatic-evidence collectors running concurrently (default: 1)

### Message Reporting

- `MSG_MAX_MESSAGE_CONTENT_BYTES` — Max single persisted message content before truncation (default: 102400)

### ACP (Agent Communication Protocol)

- `ACP_MESSAGE_BUFFER_SIZE` — Max buffered messages per SessionHost for late-join replay (default: 5000)
- `ACP_VIEWER_SEND_BUFFER` — Per-viewer send channel buffer size (default: 256)
- `ACP_PING_INTERVAL` — WebSocket ping interval for stale connection detection (default: 30s)
- `ACP_PONG_TIMEOUT` — WebSocket pong deadline after ping (default: 10s)
- `ACP_PROMPT_TIMEOUT` — Max ACP prompt runtime for workspace sessions; 0 = no timeout (default: 0)
- `ACP_TASK_PROMPT_TIMEOUT` — Max ACP prompt runtime for task-driven sessions (default: 8h)
- `ACP_PROMPT_CANCEL_GRACE_PERIOD` — Grace wait after cancel before force-stop (default: 5s)
- `ACP_PROMPT_RETRY_MAX_RETRIES` — Max transient provider prompt retries after the initial attempt (default: 2)
- `ACP_PROMPT_RETRY_INITIAL_BACKOFF` — Initial backoff before retrying transient provider prompt errors (default: 15s)
- `ACP_PROMPT_RETRY_MAX_BACKOFF` — Max exponential backoff for transient provider prompt retries (default: 2m)
- `ACTIVITY_REREPORT_INTERVAL` — Re-send `prompting` activity while a prompt is active (default: 60s)
- `ACP_HARNESS_ACTIVITY_REPORT_DEBOUNCE` — Debounce window for coalescing high-frequency ACP harness/tool-call activity reports before POSTing to the control plane (default: 750ms)
- `ACP_CHECKPOINT_PREEMPT_GRACE` — Graceful ACP cancel/close wait before harness force-stop (default: 30s)
- `ACP_CHECKPOINT_PREEMPT_MAX_GRACE` — Maximum caller-selected checkpoint rollover grace (default: 2m)
- `ACP_CHECKPOINT_ROLLOVER_TIMEOUT` — Full checkpoint restart and strict LoadSession deadline (default: 2m)
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
