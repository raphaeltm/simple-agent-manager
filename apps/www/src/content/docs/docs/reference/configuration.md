---
title: Configuration Reference
description: All environment variables, secrets, and configurable settings for SAM.
---

SAM uses environment variables for platform configuration. User-specific settings (cloud provider tokens, agent API keys) are stored encrypted in the database, not as environment variables.

:::note
This reference covers the most important configuration variables. For the complete list including advanced tuning options, see [`apps/api/.env.example`](https://github.com/raphaeltm/simple-agent-manager/blob/main/apps/api/.env.example) in the source code.
:::

## Platform Secrets

These are Cloudflare Worker secrets, set during deployment. Pulumi auto-generates security keys on first deploy.

| Secret                                     | Description                                                                                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`                           | AES-256-GCM master key. Used for BetterAuth session cookies and user credential encryption unless a purpose-specific override below is set (auto-generated)                                                                  |
| `BETTER_AUTH_SECRET`                       | Optional purpose-specific override for BetterAuth session cookie signing/encryption. Falls back to `ENCRYPTION_KEY` when unset (`apps/api/src/lib/secrets.ts`)                                                               |
| `CREDENTIAL_ENCRYPTION_KEY`                | Optional purpose-specific override for AES-GCM encryption of user cloud/agent credentials. Falls back to `ENCRYPTION_KEY` when unset (`apps/api/src/lib/secrets.ts`)                                                         |
| `JWT_PRIVATE_KEY`                          | RSA-2048 private key for signing tokens (auto-generated)                                                                                                                                                                     |
| `JWT_PUBLIC_KEY`                           | RSA-2048 public key for token verification (exposed via JWKS)                                                                                                                                                                |
| `DEPLOY_SIGNING_PRIVATE_KEY`               | Ed25519 private key for signing deployment apply payloads (auto-generated)                                                                                                                                                   |
| `DEPLOY_SIGNING_PUBLIC_KEY`                | Ed25519 public key derived during deployment for deployment node verification (auto-generated)                                                                                                                               |
| `CF_API_TOKEN`                             | Cloudflare API token for infrastructure, DNS, Origin CA certificate issuance, observability, AI Gateway, Containers, and admin logs. Requires **Account → Containers → Edit** and **Account → SSL and Certificates → Edit**. |
| `CF_AIG_TOKEN`                             | Optional narrower Cloudflare AI Gateway Unified Billing token                                                                                                                                                                |
| `CF_ZONE_ID`                               | Cloudflare zone ID for DNS record management                                                                                                                                                                                 |
| `CF_ACCOUNT_ID`                            | Cloudflare account ID                                                                                                                                                                                                        |
| `DEVCONTAINER_CACHE_CLOUDFLARE_API_TOKEN`  | Optional narrower Cloudflare token for managed devcontainer registry credentials                                                                                                                                             |
| `DEVCONTAINER_CACHE_CLOUDFLARE_ACCOUNT_ID` | Optional Cloudflare account override for managed devcontainer registry credentials                                                                                                                                           |
| `GITHUB_CLIENT_ID`                         | Optional fallback GitHub App client ID for OAuth; runtime admin config takes precedence                                                                                                                                      |
| `GITHUB_CLIENT_SECRET`                     | Optional fallback GitHub App client secret for OAuth; runtime admin config takes precedence                                                                                                                                  |
| `GITHUB_APP_ID`                            | Optional fallback GitHub App ID for installation tokens; runtime admin config takes precedence                                                                                                                               |
| `GITHUB_APP_PRIVATE_KEY`                   | Optional fallback GitHub App private key (PEM or base64); runtime admin config takes precedence                                                                                                                              |
| `GITHUB_APP_SLUG`                          | Optional fallback GitHub App URL slug; runtime admin config takes precedence                                                                                                                                                 |
| `GITHUB_WEBHOOK_SECRET`                    | Optional fallback GitHub App webhook HMAC secret; runtime admin config takes precedence                                                                                                                                      |
| `GITLAB_HOST`                              | Optional fallback GitLab OAuth host, such as `https://gitlab.com`; runtime admin config takes precedence                                                                                                                     |
| `GITLAB_CLIENT_ID`                         | Optional fallback GitLab OAuth application ID; runtime admin config takes precedence                                                                                                                                         |
| `GITLAB_CLIENT_SECRET`                     | Optional fallback GitLab OAuth secret; runtime admin config takes precedence                                                                                                                                                 |
| `TRIAL_CLAIM_TOKEN_SECRET`                 | Trial onboarding HMAC secret (auto-generated)                                                                                                                                                                                |

## Worker Variables

Set as `[vars]` in `wrangler.toml` or as environment variables:

| Variable                          | Default   | Description                                                                                                                |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `BASE_DOMAIN`                     | —         | Root domain for the deployment (e.g., `example.com`)                                                                       |
| `VERSION`                         | —         | Deployment version string                                                                                                  |
| `SETUP_TOKEN`                     | —         | Plaintext first-run setup token generated during deploy and readable in the Cloudflare dashboard while setup is incomplete |
| `SETUP_FORCE`                     | _(unset)_ | Set to `true` to reopen `/setup` for lockout recovery                                                                      |
| `SETUP_RATE_LIMIT_MAX_ATTEMPTS`   | `10`      | Max setup-token attempts per identifier/window                                                                             |
| `SETUP_RATE_LIMIT_WINDOW_SECONDS` | `900`     | Setup-token attempt window in seconds                                                                                      |

## GitHub Environment Variables

Set in GitHub Settings → Environments → production:

| Variable               | Description                                                                                                    | Example                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `BASE_DOMAIN`          | Deployment domain                                                                                              | `example.com`          |
| `RESOURCE_PREFIX`      | Domain-derived Cloudflare resource name prefix                                                                 | `sa379a6`              |
| `PULUMI_STATE_BUCKET`  | R2 bucket for Pulumi state                                                                                     | `sa379a6-pulumi-state` |
| `CF_CONTAINER_ENABLED` | Optional instant-session runtime toggle. Generated deploys default to `true`; set `false` to force VM runtime. | `false`                |

`RESOURCE_PREFIX` is generated from `BASE_DOMAIN` as `s` plus the first six hex
characters of the domain's SHA-256 hash. The self-host onboarding flow fills it
in for you.

Required GitHub Actions secrets include `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `PULUMI_CONFIG_PASSPHRASE`. GitHub App/OAuth secrets (`GH_CLIENT_ID`, `GH_CLIENT_SECRET`, `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_SLUG`, `GH_WEBHOOK_SECRET`) and Google **login** OAuth secrets (`GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET`) are optional environment fallbacks; fresh deployments can set them through `/setup` instead. The separate Google **infra/GCP** OAuth pair (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) is used only for WIF and can be configured by a superadmin at `/admin/integrations`; runtime values override the environment fallback. Service-account JSON users need no infrastructure OAuth client. Deploy signing keys are generated and persisted by Pulumi during deployment; GitHub Environment values are only needed for explicit key overrides.

:::note[Naming convention]
GitHub App secrets use `GH_*` prefix (e.g., `GH_CLIENT_ID`, `GH_WEBHOOK_SECRET`) because GitHub Actions secret names cannot start with `GITHUB_*`. When present, the deploy workflow maps those `GH_*` secrets to `GITHUB_*` Worker secrets. Runtime admin config in D1 is resolved first, then these environment fallbacks, then unset.
:::

## CLI Environment Variables

These variables affect the local `sam` CLI process only. They are not Worker runtime variables or GitHub Actions secrets.

| Variable                         | Default   | Description                                                               |
| -------------------------------- | --------- | ------------------------------------------------------------------------- |
| `SAM_CLI_MAX_API_RESPONSE_BYTES` | `1048576` | Maximum API response body bytes the CLI reads before truncating/aborting. |

## Feature Flags

| Variable                                   | Default                   | Description                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CF_CONTAINER_ENABLED`                     | `true`                    | Enables Cloudflare Container instant sessions for matching profiles and zero-config runtime selection. Set `false` to force cloud VM runtime.                                                                                                                                                                                |
| `CF_CONTAINER_SLEEP_AFTER`                 | `1h`                      | Normal inactivity window before an Instant container sleeps. Sleep remains recoverable through the runtime-neutral session snapshot.                                                                                                                                                                                         |
| `CF_CONTAINER_ACTIVE_WORK_MAX_MS`          | `7200000`                 | Defensive maximum lifetime for an active-work keepalive lease.                                                                                                                                                                                                                                                               |
| `CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS` | `300000`                  | Interval used to renew the container activity timeout while prompt work is active.                                                                                                                                                                                                                                           |
| `CF_CONTAINER_WAKE_TIMEOUT_MS`             | `120000`                  | Maximum time for a sleeping container to launch, restore its snapshot, and accept the triggering request.                                                                                                                                                                                                                    |
| `CF_CONTAINER_RECOVERY_MAX_ATTEMPTS`       | `2`                       | Maximum snapshot restore attempts before SAM reconciles the runtime, workspace, agent session, and active task to a visible terminal recovery failure.                                                                                                                                                                       |
| `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` | `120000`                  | Budget for the synchronous instant-session create-workspace request, which includes the repository clone inside the container.                                                                                                                                                                                               |
| `CF_CONTAINER_CLONE_FILTER`                | `blob:none`               | Git partial-clone filter forwarded to instant containers as `STANDALONE_CLONE_FILTER`. Set `off` to force full clones.                                                                                                                                                                                                       |
| `REQUIRE_APPROVAL`                         | _(unset)_                 | Default signup approval gate. Superadmins can override it at runtime in Admin → Users without redeploying; when no runtime override exists, this value is used. The first genuine human becomes superadmin regardless of this flag — see [First Login & Admin Access](/docs/guides/self-hosting/#first-login--admin-access). |
| `TRIAL_ANONYMOUS_USER_ID`                  | `system_anonymous_trials` | Id of the internal anonymous-trial sentinel user, excluded from first-user superadmin checks. Override only if your deployment uses a different sentinel id.                                                                                                                                                                 |
| `CAPACITY_SIZE_FALLBACK_ENABLED`           | `true`                    | When a new node's VM size is exhausted on transient capacity, descend the size chain (large→medium→small). Only applies to default-derived sizes (project/platform default), never user-requested sizes. Set `false` to disable.                                                                                             |
| `ORIGIN_CA_CERT_VALIDITY_DAYS`             | `7`                       | Validity for per-node Cloudflare Origin CA certificates issued from node-generated CSRs. Must be one of Cloudflare's supported values: 7, 30, 90, 365, 730, 1095, or 5475.                                                                                                                                                   |

## Google OAuth and GCP provisioning

Google login and Google infrastructure authorization are independent credential families:

| Variables                                              | Purpose                    | Runtime precedence                                     | Redirect URIs                                              |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET` | BetterAuth user login      | `/setup` or superadmin runtime D1 → Worker env → unset | `/api/auth/callback/google`                                |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`             | Keyless GCP/WIF setup only | Superadmin runtime D1 → Worker env → unset             | `/auth/google/callback` and `/api/deployment/gcp/callback` |

Configuring one family never enables or modifies the other. Users who choose service-account JSON do not need either infrastructure OAuth variable.

| Variable                             | Default                                          | Description                                                                                 |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES` | `65536`                                          | Maximum UTF-8 byte size accepted by `PUT /api/gcp/service-account`                          |
| `GCP_DEFAULT_ZONE`                   | `us-central1-a`                                  | Default Compute zone                                                                        |
| `GCP_IMAGE_FAMILY`                   | `ubuntu-2404-lts-amd64`                          | Compute image family                                                                        |
| `GCP_IMAGE_PROJECT`                  | `ubuntu-os-cloud`                                | Compute image project                                                                       |
| `GCP_DISK_SIZE_GB`                   | `50`                                             | Boot disk size                                                                              |
| `GCP_TOKEN_CACHE_TTL_SECONDS`        | `3300`                                           | Maximum derivative access-token cache TTL; actual TTL is capped by Google's returned expiry |
| `GCP_IDENTITY_TOKEN_EXPIRY_SECONDS`  | `600`                                            | SAM identity-token lifetime for WIF                                                         |
| `GCP_OPERATION_POLL_TIMEOUT_MS`      | `300000`                                         | Maximum wait for GCP asynchronous operations                                                |
| `GCP_API_TIMEOUT_MS`                 | `30000`                                          | GCP OAuth, IAM, and Compute request timeout                                                 |
| `GCP_STS_SCOPE`                      | `https://www.googleapis.com/auth/cloud-platform` | WIF STS exchange scope                                                                      |
| `GCP_SA_IMPERSONATION_SCOPES`        | `https://www.googleapis.com/auth/compute`        | Comma-separated scopes for WIF service-account impersonation                                |
| `GCP_SA_TOKEN_LIFETIME_SECONDS`      | `3600`                                           | WIF impersonated access-token lifetime                                                      |
| `GCP_STS_TOKEN_URL`                  | `https://sts.googleapis.com/v1/token`            | WIF STS endpoint override for controlled environments                                       |
| `GCP_IAM_CREDENTIALS_BASE_URL`       | Google IAM Credentials API                       | WIF impersonation base URL override                                                         |

The service-account JWT bearer flow always uses `https://oauth2.googleapis.com/token`; it has no endpoint override, and uploaded `token_uri` values are ignored. Source credentials are encrypted in D1. Only derivative short-lived tokens are cached.

## AI Idea Title Generation

| Variable                                 | Default               | Description                                      |
| ---------------------------------------- | --------------------- | ------------------------------------------------ |
| `TASK_TITLE_MODEL`                       | `@cf/zai-org/glm-5.2` | Workers AI model for title generation            |
| `TASK_TITLE_MAX_LENGTH`                  | `100`                 | Max characters in generated title                |
| `TASK_TITLE_TIMEOUT_MS`                  | `5000`                | Timeout before falling back to truncation        |
| `TASK_TITLE_GENERATION_ENABLED`          | `true`                | Set `false` to disable AI generation             |
| `TASK_TITLE_SHORT_MESSAGE_THRESHOLD`     | `100`                 | Messages at or below this length bypass AI       |
| `TASK_TITLE_MAX_RETRIES`                 | `2`                   | Max retry attempts on failure                    |
| `TASK_TITLE_RETRY_DELAY_MS`              | `1000`                | Base delay between retries (exponential backoff) |
| `TASK_TITLE_RETRY_MAX_DELAY_MS`          | `4000`                | Max delay cap for backoff                        |
| `TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH` | `512`                 | Max sanitized provider-error diagnostic length   |

## Agent Model Catalog

SAM loads OpenCode Zen and OpenCode Go model choices through the authenticated model-catalog API, backed by Models.dev and cached in KV. If the upstream catalog or cache is unavailable, SAM falls back to the static catalog shipped with the app.

| Variable                          | Default                       | Description                                                   |
| --------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `MODEL_CATALOG_SOURCE_URL`        | `https://models.dev/api.json` | Source URL for the dynamic model catalog                      |
| `MODEL_CATALOG_CACHE_TTL_SECONDS` | `3600`                        | KV cache TTL for normalized dynamic model catalog payloads    |
| `MODEL_CATALOG_FETCH_TIMEOUT_MS`  | `5000`                        | Timeout for the upstream catalog fetch before static fallback |

## Warm Node Pooling

| Variable                        | Default            | Description                                           |
| ------------------------------- | ------------------ | ----------------------------------------------------- |
| `NODE_WARM_TIMEOUT_MS`          | `1800000` (30 min) | Time a node stays warm after idea execution completes |
| `MAX_AUTO_NODE_LIFETIME_MS`     | `14400000` (4 hr)  | Absolute max lifetime for auto-provisioned nodes      |
| `NODE_WARM_GRACE_PERIOD_MS`     | `2100000` (35 min) | Cron sweep grace period (must be > warm timeout)      |
| `NODE_LIFECYCLE_ALARM_RETRY_MS` | `60000` (1 min)    | Retry delay for DO alarm failures                     |
| `DEFAULT_TASK_AGENT_TYPE`       | `opencode`         | Default agent for autonomous idea execution           |

## Project Invites

| Variable                               | Default | Description                                                                |
| -------------------------------------- | ------- | -------------------------------------------------------------------------- |
| `PROJECT_INVITE_TOKEN_BYTES`           | `32`    | Random bytes used for generated project invite link tokens                 |
| `PROJECT_INVITE_DEFAULT_EXPIRY_DAYS`   | `7`     | Default lifetime for invite links created without an explicit expiry       |
| `PROJECT_INVITE_MAX_EXPIRY_DAYS`       | `30`    | Maximum allowed invite link lifetime, including explicit expiry-date input |
| `PROJECT_OFFBOARDING_PLAN_TTL_SECONDS` | `900`   | Lifetime for project member offboarding preview plans before recomputation |

## Notification System

| Variable                                | Default                | Description                                          |
| --------------------------------------- | ---------------------- | ---------------------------------------------------- |
| `NOTIFICATION_PROGRESS_BATCH_WINDOW_MS` | `300000` (5 min)       | Min interval between progress notifications per idea |
| `NOTIFICATION_DEDUP_WINDOW_MS`          | `60000` (60s)          | Dedup window for task_complete notifications         |
| `NOTIFICATION_AUTO_DELETE_AGE_MS`       | `7776000000` (90 days) | Auto-delete old notifications                        |
| `MAX_NOTIFICATIONS_PER_USER`            | `500`                  | Max stored notifications per user                    |
| `NOTIFICATION_PAGE_SIZE`                | `50`                   | Default page size for notification list              |
| `MAX_NOTIFICATION_PAGE_SIZE`            | `100`                  | Max allowed page size                                |

## Generic Webhook Triggers

| Variable                                      | Default | Description                                                 |
| --------------------------------------------- | ------- | ----------------------------------------------------------- |
| `WEBHOOK_TRIGGERS_ENABLED`                    | `true`  | Public generic webhook ingress kill switch                  |
| `WEBHOOK_TRIGGER_MAX_BODY_BYTES`              | `65536` | Maximum JSON request body size                              |
| `WEBHOOK_TRIGGER_MAX_FILTERS`                 | `10`    | Maximum deterministic filters per trigger                   |
| `WEBHOOK_TRIGGER_MAX_FILTER_PATH_LENGTH`      | `200`   | Maximum configured filter dot-path length                   |
| `WEBHOOK_TRIGGER_MAX_FILTER_PATH_DEPTH`       | `8`     | Maximum filter nesting depth at evaluation time             |
| `WEBHOOK_TRIGGER_MAX_INCLUDED_HEADERS`        | `10`    | Maximum safe request headers copied into template context   |
| `WEBHOOK_TRIGGER_MAX_HEADER_NAME_LENGTH`      | `100`   | Maximum configured included-header name length              |
| `WEBHOOK_TRIGGER_MAX_SOURCE_LABEL_LENGTH`     | `100`   | Maximum optional source label length                        |
| `WEBHOOK_TRIGGER_MAX_IDEMPOTENCY_KEY_LENGTH`  | `200`   | Maximum accepted `Idempotency-Key` length                   |
| `WEBHOOK_INGRESS_RATE_LIMIT_PER_MINUTE`       | `120`   | Best-effort pre-auth request damping per client IP/window   |
| `WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE`       | `60`    | Best-effort request damping per trigger/window              |
| `WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE` | `30`    | Best-effort invalid-token damping per client IP/window      |
| `WEBHOOK_RATE_LIMIT_WINDOW_SECONDS`           | `60`    | Fixed rate-limit window length                              |
| `WEBHOOK_DELIVERY_RETENTION_DAYS`             | `7`     | Retention for redacted delivery audit metadata              |
| `WEBHOOK_DELIVERY_CLEANUP_BATCH_SIZE`         | `500`   | Maximum expired audit rows deleted per cleanup pass         |
| `WEBHOOK_DELIVERY_DEFAULT_PAGE_SIZE`          | `25`    | Default delivery-history page size                          |
| `WEBHOOK_DELIVERY_MAX_PAGE_SIZE`              | `100`   | Maximum delivery-history page size                          |
| `WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS`   | `300`   | Lease before an unsubmitted processing delivery can recover |

Webhook tokens use the existing `ENCRYPTION_KEY` as keyed-hash material and do not require a separate deployment secret. See [Webhook Triggers](/docs/guides/webhook-triggers/) for request, credential, filtering, and audit behavior.

Webhook damping uses Cloudflare KV's eventually consistent read-update-write behavior. It reduces accidental bursts and abuse but is not a strict distributed quota.

## ACP Session Lifecycle

| Variable                                | Default          | Description                                          |
| --------------------------------------- | ---------------- | ---------------------------------------------------- |
| `ACP_SESSION_DETECTION_WINDOW_MS`       | `300000` (5 min) | Heartbeat timeout before marking session interrupted |
| `ACP_SESSION_HEARTBEAT_INTERVAL_MS`     | `60000` (60s)    | How often VM agent sends heartbeats                  |
| `ACP_SESSION_RECONCILIATION_TIMEOUT_MS` | `30000` (30s)    | VM agent startup reconciliation timeout              |
| `ACP_SESSION_MAX_FORK_DEPTH`            | `10`             | Maximum session fork chain depth                     |
| `ACP_SESSION_FORK_CONTEXT_MESSAGES`     | `20`             | Context messages included when forking               |

## ACP Protocol (VM Agent)

| Variable                            | Default | Description                                                      |
| ----------------------------------- | ------- | ---------------------------------------------------------------- |
| `ACP_MESSAGE_BUFFER_SIZE`           | `5000`  | Buffer size for ACP messages                                     |
| `ACP_STDERR_BUFFER_BYTES`           | `4096`  | Agent stderr bytes retained for crash reports                    |
| `ACP_PING_INTERVAL`                 | `30s`   | WebSocket keepalive ping interval                                |
| `ACP_PONG_TIMEOUT`                  | `10s`   | Pong response timeout                                            |
| `ACP_TASK_PROMPT_TIMEOUT`           | `6h`    | Task execution prompt timeout                                    |
| `ACP_PROMPT_RETRY_MAX_RETRIES`      | `2`     | Max transient provider prompt retries after the initial attempt  |
| `ACP_PROMPT_RETRY_INITIAL_BACKOFF`  | `15s`   | Initial backoff before retrying transient provider prompt errors |
| `ACP_PROMPT_RETRY_MAX_BACKOFF`      | `2m`    | Max exponential backoff for transient provider prompt retries    |
| `ACTIVITY_REREPORT_INTERVAL`        | `60s`   | Re-send prompting activity while a prompt is active              |
| `ACTIVITY_TERMINAL_REPORT_ATTEMPTS` | `5`     | Retry attempts for terminal activity reports                     |
| `ACTIVITY_TERMINAL_REPORT_BACKOFF`  | `1s`    | Backoff between terminal activity report retries                 |
| `ACP_IDLE_SUSPEND_TIMEOUT`          | `30m`   | Idle session auto-suspend timeout                                |
| `ACP_NOTIF_SERIALIZE_TIMEOUT`       | `5s`    | Notification serialization timeout                               |

## MCP (Agent Tools)

| Variable                              | Default           | Description                                     |
| ------------------------------------- | ----------------- | ----------------------------------------------- |
| `MCP_TOKEN_TTL_SECONDS`               | `28800` (8 hours) | Sliding inactivity timeout for agent MCP access |
| `MCP_RATE_LIMIT`                      | `120`             | Max MCP requests per window                     |
| `MCP_RATE_LIMIT_WINDOW_SECONDS`       | `60`              | Rate limit window                               |
| `MCP_DISPATCH_MAX_DEPTH`              | `3`               | Max recursion depth for dispatch_task           |
| `MCP_DISPATCH_MAX_PER_TASK`           | `5`               | Max dispatched tasks per parent task            |
| `MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT` | `10`              | Max active dispatched tasks per project         |

## Voice & Text-to-Speech

| Variable                     | Default                             | Description                      |
| ---------------------------- | ----------------------------------- | -------------------------------- |
| `WHISPER_MODEL_ID`           | `@cf/openai/whisper-large-v3-turbo` | Transcription model              |
| `MAX_AUDIO_SIZE_BYTES`       | `10485760` (10 MB)                  | Max upload audio size            |
| `MAX_AUDIO_DURATION_SECONDS` | `60`                                | Max recording duration           |
| `RATE_LIMIT_TRANSCRIBE`      | `30`                                | Max transcriptions per minute    |
| `TTS_ENABLED`                | `true`                              | Enable/disable text-to-speech    |
| `TTS_MODEL`                  | `@cf/deepgram/aura-2-en`            | TTS model                        |
| `TTS_SPEAKER`                | `luna`                              | TTS voice selection              |
| `TTS_ENCODING`               | `mp3`                               | Audio output format              |
| `TTS_MAX_TEXT_LENGTH`        | `100000`                            | Max characters per TTS synthesis |
| `TTS_TIMEOUT_MS`             | `60000`                             | TTS synthesis timeout            |

## Context Summarization (Forking)

| Variable                          | Default                         | Description                                  |
| --------------------------------- | ------------------------------- | -------------------------------------------- |
| `CONTEXT_SUMMARY_MODEL`           | `@cf/google/gemma-4-26b-a4b-it` | Model for conversation context summarization |
| `CONTEXT_SUMMARY_MAX_LENGTH`      | `4000`                          | Max summary length in characters             |
| `CONTEXT_SUMMARY_TIMEOUT_MS`      | `10000`                         | Summarization timeout                        |
| `CONTEXT_SUMMARY_MAX_MESSAGES`    | `50`                            | Max messages to include in summary           |
| `CONTEXT_SUMMARY_SHORT_THRESHOLD` | `5`                             | Skip AI for conversations this short         |

## Idea Execution Timeouts

| Variable                                           | Default                                | Description                                                                                      |
| -------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `TASK_RUN_MAX_EXECUTION_MS`                        | `14400000` (4 hr)                      | Max task execution time                                                                          |
| `TASK_STUCK_QUEUED_TIMEOUT_MS`                     | `1200000` (20 min)                     | Timeout for tasks stuck in queued state                                                          |
| `TASK_STUCK_DELEGATED_TIMEOUT_MS`                  | `1860000` (31 min)                     | Timeout for tasks stuck in delegated state                                                       |
| `TASK_DO_MISMATCH_GRACE_MS`                        | `300000` (5 min)                       | Minimum age before reconciling completed TaskRunner state with task-scoped liveness              |
| `STUCK_TASK_MAX_CANDIDATES_PER_SWEEP`              | `100`                                  | Maximum active tasks inspected by each recovery sweep                                            |
| `STUCK_TASK_SCAN_CURSOR_KV_KEY`                    | `scheduled:stuck-tasks:scan-cursor:v1` | KV key used to resume bounded recovery scans fairly across active tasks                          |
| `TASK_LIVENESS_MAX_ACP_SESSIONS`                   | `5`                                    | Maximum task-scoped ACP sessions inspected per liveness probe                                    |
| `TASK_LIVENESS_PROBE_TIMEOUT_MS`                   | `5000` (5 sec)                         | Per-candidate timeout for the ACP liveness probe; a timeout is inconclusive (never fails a task) |
| `TASK_RUN_ABSOLUTE_CEILING_MS`                     | `86400000` (24 hr)                     | Absolute runaway-cost ceiling; fails even a task with a demonstrably live runtime                |
| `CLAUDE_CODE_COMPACTION_LOOP_DETECTOR_ENABLED`     | `true`                                 | Enable Claude Code compaction-loop shutdown from recent message evidence                         |
| `CLAUDE_CODE_COMPACTION_LOOP_RECENT_MESSAGE_LIMIT` | `40`                                   | Recent task-session messages to inspect for compaction-loop evidence                             |
| `CLAUDE_CODE_COMPACTION_LOOP_WINDOW_MESSAGES`      | `20`                                   | Rolling recent-message window used for compaction-loop detection                                 |
| `CLAUDE_CODE_COMPACTION_LOOP_MIN_PAIRS`            | `3`                                    | Minimum `Compacting...` / `Compacting completed` marker pairs before failing a task              |
| `TASK_CALLBACK_TIMEOUT_MS`                         | `10000`                                | Callback response timeout                                                                        |
| `TASK_CALLBACK_RETRY_MAX_ATTEMPTS`                 | `3`                                    | Max callback retry attempts                                                                      |
| `TASK_RUN_CLEANUP_DELAY_MS`                        | `5000`                                 | Delay before task cleanup                                                                        |
| `TASK_RECONCILIATION_IDLE_MS`                      | `300000` (5 min)                       | Idle threshold before SAM sends a visible task check-in                                          |
| `TASK_RECONCILIATION_RESPONSE_DEADLINE_MS`         | `60000` (1 min)                        | Response deadline after a visible task check-in                                                  |
| `TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS`         | `1800000` (30 min)                     | In-flight prompt observation threshold before a non-interrupting reconciliation event            |
| `TASK_RECONCILIATION_PROMPT_HARD_STALL_MS`         | `7200000` (2 hr)                       | In-flight prompt hard-stall threshold before SAM requests prompt cancellation                    |
| `TASK_RECONCILIATION_MIN_ALARM_DELAY_MS`           | `10000` (10 sec)                       | Minimum delay before the next reconciliation alarm can fire                                      |

> **Liveness-gated recovery.** Stuck-task recovery for `in_progress` tasks (including task-mode work paused at the `awaiting_followup` execution step) is gated on **task-scoped** liveness — a live workspace, a healthy node with a recent heartbeat, **and** an active task-scoped ACP session. A shared-node heartbeat alone is never sufficient. Consequently, `TASK_RUN_HARD_TIMEOUT_MS` and `TASK_RUN_MAX_EXECUTION_MS` bound the point at which a task with **no** proven live runtime is failed; a task with a demonstrably live runtime is preserved past those thresholds, but remains bounded by `TASK_RUN_ABSOLUTE_CEILING_MS` (24 hours by default) as a runaway-cost backstop. When liveness cannot be determined (probe timeout or error), the task is left untouched (fail-safe) until it reaches that absolute ceiling.

## Node & Workspace Readiness

| Variable                                 | Default            | Description                                                   |
| ---------------------------------------- | ------------------ | ------------------------------------------------------------- |
| `NODE_AGENT_READY_TIMEOUT_MS`            | `600000` (10 min)  | Wait for VM agent to report ready                             |
| `NODE_AGENT_READY_POLL_INTERVAL_MS`      | `5000`             | Poll interval for agent readiness                             |
| `TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS` | `1800000` (30 min) | Max wait for workspace-ready callback                         |
| `PROVISIONING_TIMEOUT_MS`                | `1800000` (30 min) | Cron marks stuck workspaces as error                          |
| `NODE_HEARTBEAT_STALE_SECONDS`           | `180`              | Seconds without a heartbeat before a node is treated as stale |

## App Deployment Routing

| Variable                                      | Default                                | Description                                                           |
| --------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `DEPLOY_PAYLOAD_EXPIRY_SECONDS`               | `3600`                                 | Signed deployment apply payload lifetime                              |
| `DEPLOYMENT_ROUTE_PORT_BASE`                  | `35000`                                | First node-local loopback port reserved for app routes                |
| `DEPLOYMENT_ROUTE_PORT_SPAN`                  | `100`                                  | Number of loopback ports reserved per deployment environment          |
| `AGENT_DEPLOYMENT_RESERVED_ENVIRONMENT_NAMES` | `prod,production`                      | Comma-separated environment names agents cannot create through MCP    |
| `MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE`        | `5`                                    | Maximum deployment environments to place on one deployment node       |
| `DEPLOYMENT_DEFAULT_VM_SIZE`                  | `small`                                | Default VM size for deployment nodes                                  |
| `DEPLOYMENT_MODEL_RUNNER_VM_SIZE`             | `medium`                               | VM size for deployment nodes that need Docker Model Runner            |
| `DEPLOYMENT_DEFAULT_MEMORY_LIMIT_MB`          | `256`                                  | Default per-service memory limit for compose-publish releases         |
| `DEPLOYMENT_LOG_MAX_SIZE`                     | `10m`                                  | Default json-file log max-size for compose-publish releases           |
| `DEPLOYMENT_LOG_MAX_FILE`                     | `3`                                    | Default json-file log max-file for compose-publish releases           |
| `MCP_DEPLOYMENT_COMPOSE_PREVIEW_MAX_BYTES`    | `128000`                               | Max Compose YAML size accepted by deployment route preview MCP tool   |
| `BUILD_PUBLISH_TOOL_TIMEOUT_MS`               | `1260000`                              | Worker-to-VM proxy timeout for `build_and_publish`                    |
| `DEPLOY_ACME_EMAIL`                           | _(unset)_                              | Optional ACME contact email emitted into deployment-node Caddy config |
| `DEPLOY_ACME_CA`                              | _(unset)_                              | Optional ACME CA directory override, useful for Let's Encrypt staging |
| `DOH_RESOLVER_URL`                            | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS resolver used to verify deployment custom domains      |
| `DOH_TIMEOUT_MS`                              | `10000`                                | Timeout for deployment custom-domain DNS verification lookups         |
| `DEPLOY_COMPOSE_CMD`                          | `docker compose`                       | Docker Compose command used by the deployment engine                  |
| `DEPLOY_HEALTH_TIMEOUT`                       | `5m`                                   | Deployment health-check timeout used by the VM agent                  |
| `DEPLOY_RUNTIME_TIMEOUT`                      | `15m`                                  | VM-agent max time for deployment-node host dependency setup           |
| `DEPLOY_TEARDOWN_TIMEOUT`                     | `2m`                                   | VM-agent max time for deployment environment teardown (stop/start)    |
| `DEPLOY_APPLY_IDLE_TIMEOUT`                   | `15m`                                  | VM-agent idle watchdog for deployment apply (no-progress only)        |
| `DEPLOY_BUILD_PUBLISH_TIMEOUT`                | `20m`                                  | VM-agent max time for host build + push + release publish             |
| `DEPLOY_ARTIFACT_DIAL_TIMEOUT`                | `30s`                                  | VM-agent TCP dial timeout for artifact downloads                      |
| `DEPLOY_ARTIFACT_TLS_HANDSHAKE_TIMEOUT`       | `15s`                                  | VM-agent TLS handshake timeout for artifact downloads                 |
| `DEPLOY_ARTIFACT_RESPONSE_HEADER_TIMEOUT`     | `60s`                                  | VM-agent first-response-header timeout for artifact downloads         |
| `DEPLOY_ARTIFACT_IDLE_TIMEOUT`                | `2m`                                   | VM-agent idle watchdog for artifact body-read progress                |

## Platform Limits

| Variable                           | Default | Description                         |
| ---------------------------------- | ------- | ----------------------------------- |
| `MAX_NODES_PER_USER`               | `10`    | Max nodes per user                  |
| `MAX_WORKSPACES_PER_NODE`          | `3`     | Max workspaces packed onto one node |
| `MAX_AGENT_SESSIONS_PER_WORKSPACE` | `10`    | Max concurrent agent sessions       |
| `MAX_PROJECTS_PER_USER`            | `100`   | Max projects per user               |
| `MAX_TASKS_PER_PROJECT`            | `10000` | Max ideas per project               |
| `MAX_TASK_MESSAGE_LENGTH`          | `16000` | Max idea description length         |

## Durable Object Limits

| Variable                              | Default          | Description                                                            |
| ------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `MAX_SESSIONS_PER_PROJECT`            | `10000`          | Max chat sessions per project                                          |
| `MAX_MESSAGES_PER_SESSION`            | `100000`         | Max messages per chat session                                          |
| `DOCUMENT_CARD_RAW_OUTPUT_MAX_BYTES`  | `16384`          | Max compact metadata bytes preserved for library document cards        |
| `MESSAGE_SIZE_THRESHOLD`              | `102400`         | Max message size in bytes                                              |
| `ACTIVITY_RETENTION_DAYS`             | `90`             | Days to retain activity events                                         |
| `SESSION_IDLE_TIMEOUT_MINUTES`        | `60`             | Idle session timeout                                                   |
| `SESSION_ACTIVITY_STALE_THRESHOLD_MS` | `300000` (5 min) | Evidence threshold before stale working activity can be healed to idle |
| `DO_SUMMARY_SYNC_DEBOUNCE_MS`         | `5000`           | Debounce for DO-to-D1 summary sync                                     |

## Durable Object Retry

| Variable                 | Default | Description                                                                |
| ------------------------ | ------- | -------------------------------------------------------------------------- |
| `DO_RETRY_MAX_ATTEMPTS`  | `8`     | Max attempts for transient Durable Object RPC reset/overload errors        |
| `DO_RETRY_BASE_DELAY_MS` | `100`   | Base retry delay in milliseconds for transient Durable Object RPC failures |
| `DO_RETRY_MAX_DELAY_MS`  | `250`   | Max per-attempt retry delay for transient Durable Object RPC failures      |

## Runtime Config Limits

| Variable                                   | Default  | Description                                |
| ------------------------------------------ | -------- | ------------------------------------------ |
| `MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT` | `150`    | Max env vars per project                   |
| `MAX_PROJECT_RUNTIME_FILES_PER_PROJECT`    | `50`     | Max files per project                      |
| `MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES`      | `8192`   | Max bytes per env var value                |
| `MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES`   | `131072` | Max bytes per file content                 |
| `MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH`     | `256`    | Max file path length                       |
| `MAX_DEPLOYMENT_ENV_VARS_PER_ENVIRONMENT`  | `100`    | Max deployment config vars per environment |
| `MAX_DEPLOYMENT_ENV_VALUE_BYTES`           | `65536`  | Max bytes per deployment config value      |
| `MAX_DEPLOYMENT_ENV_TOTAL_BYTES`           | `262144` | Max aggregate deployment config env size   |

## External API Timeouts

| Variable                                   | Default  | Description                                                           |
| ------------------------------------------ | -------- | --------------------------------------------------------------------- |
| `HETZNER_API_TIMEOUT_MS`                   | `30000`  | Hetzner API request timeout                                           |
| `CF_API_TIMEOUT_MS`                        | `30000`  | Cloudflare API request timeout                                        |
| `GCP_API_TIMEOUT_MS`                       | `30000`  | GCP OAuth, IAM, and Compute request timeout                           |
| `NODE_AGENT_REQUEST_TIMEOUT_MS`            | `30000`  | VM Agent request timeout                                              |
| `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` | `120000` | Instant-session create-workspace budget (includes in-container clone) |

## Admin Observability

| Variable                             | Default  | Description                      |
| ------------------------------------ | -------- | -------------------------------- |
| `OBSERVABILITY_ERROR_RETENTION_DAYS` | `30`     | Error log retention              |
| `OBSERVABILITY_ERROR_MAX_ROWS`       | `100000` | Max stored error rows            |
| `OBSERVABILITY_ERROR_BATCH_SIZE`     | `25`     | Error ingestion batch size       |
| `OBSERVABILITY_LOG_QUERY_RATE_LIMIT` | `30`     | Log queries per minute per admin |

## VM TLS

| Variable                       | Default | Description                                                           |
| ------------------------------ | ------- | --------------------------------------------------------------------- |
| `VM_AGENT_PROTOCOL`            | `https` | Protocol for VM agent communication                                   |
| `VM_AGENT_PORT`                | `8443`  | VM agent listening port                                               |
| `ORIGIN_CA_CERT_VALIDITY_DAYS` | `7`     | Validity for per-node Origin CA certificates signed by the API Worker |

New nodes generate `/etc/sam/tls/origin-ca-key.pem` locally in cloud-init and fetch only the signed certificate from `POST /api/nodes/:id/origin-ca-certificate` (`packages/cloud-init/src/template.ts`, `apps/api/src/routes/node-lifecycle.ts`). Legacy `ORIGIN_CA_CERT` and `ORIGIN_CA_KEY` Worker secrets are not required for new node provisioning.

## Journald Configuration (VM)

Applied via cloud-init on each node:

| Setting           | Default      | Description                   |
| ----------------- | ------------ | ----------------------------- |
| `SystemMaxUse`    | `500M`       | Max disk space for journal    |
| `SystemKeepFree`  | `1G`         | Minimum free disk to maintain |
| `MaxRetentionSec` | `7day`       | Max log retention period      |
| `Storage`         | `persistent` | Persist logs across reboots   |
| `Compress`        | `yes`        | Compress stored entries       |

## File Upload & Download

| Variable                      | Default              | Description                     |
| ----------------------------- | -------------------- | ------------------------------- |
| `FILE_UPLOAD_MAX_BYTES`       | `52428800` (50 MB)   | Max size per uploaded file      |
| `FILE_UPLOAD_BATCH_MAX_BYTES` | `262144000` (250 MB) | Max total size per upload batch |
| `FILE_UPLOAD_TIMEOUT`         | `120s`               | Upload timeout (VM agent)       |
| `FILE_UPLOAD_TIMEOUT_MS`      | `120000` (120s)      | Upload proxy timeout (Worker)   |
| `FILE_DOWNLOAD_TIMEOUT_MS`    | `60000` (60s)        | Download proxy timeout          |
| `FILE_DOWNLOAD_MAX_BYTES`     | `52428800` (50 MB)   | Max download file size          |

## File Browsing & Raw Proxy

| Variable                        | Default            | Description                           |
| ------------------------------- | ------------------ | ------------------------------------- |
| `FILE_PROXY_TIMEOUT_MS`         | `15000`            | File proxy request timeout            |
| `FILE_PROXY_MAX_RESPONSE_BYTES` | `2097152` (2 MB)   | Max file proxy response size          |
| `FILE_RAW_MAX_SIZE`             | `52428800` (50 MB) | Max raw binary file size (VM agent)   |
| `FILE_RAW_TIMEOUT`              | `60s`              | Raw file streaming timeout (VM agent) |
| `FILE_RAW_PROXY_MAX_BYTES`      | `52428800` (50 MB) | Max raw file proxy size (Worker)      |

## Project Files (Remote-Branch Git Browser)

| Variable                        | Default          | Description                                                       |
| ------------------------------- | ---------------- | ----------------------------------------------------------------- |
| `REPO_BROWSE_MAX_INLINE_BYTES`  | `1000000` (1 MB) | Max bytes to inline as text in the file viewer; larger stream raw |
| `REPO_BROWSE_MAX_COMPARE_FILES` | `300`            | Max changed files in an Artifacts diff before truncation          |

## MCP Idea Tools

| Variable                      | Default | Description                                     |
| ----------------------------- | ------- | ----------------------------------------------- |
| `MCP_IDEA_CONTEXT_MAX_LENGTH` | `500`   | Max characters of idea context shown to agents  |
| `MCP_IDEA_LIST_LIMIT`         | `20`    | Default page size for `list_ideas`              |
| `MCP_IDEA_LIST_MAX`           | `100`   | Max page size for `list_ideas`                  |
| `MCP_IDEA_SEARCH_MAX`         | `20`    | Max results from `search_ideas`                 |
| `MCP_MESSAGE_SEARCH_MAX`      | `20`    | Max results from `search_messages`              |
| `MCP_MESSAGE_LIST_LIMIT`      | `50`    | Default page size for `get_session_messages`    |
| `MCP_MESSAGE_LIST_MAX`        | `200`   | Max messages per `get_session_messages` request |

## Web UI (Build-Time)

| Variable                             | Default            | Description                                                          |
| ------------------------------------ | ------------------ | -------------------------------------------------------------------- |
| `VITE_FILE_PREVIEW_INLINE_MAX_BYTES` | `10485760` (10 MB) | Images below this size render inline automatically                   |
| `VITE_FILE_PREVIEW_LOAD_MAX_BYTES`   | `52428800` (50 MB) | Images below this size show click-to-load; above shows download link |

## Admin Analytics

| Variable                    | Default | Description                                   |
| --------------------------- | ------- | --------------------------------------------- |
| `ANALYTICS_GEO_LIMIT`       | `50`    | Max countries in geographic distribution view |
| `ANALYTICS_RETENTION_WEEKS` | `12`    | Number of weeks for retention cohort analysis |

## Analytics Forwarding

| Variable                           | Default                                       | Description                                |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------ |
| `ANALYTICS_FORWARD_ENABLED`        | `false`                                       | Enable external analytics event forwarding |
| `ANALYTICS_FORWARD_EVENTS`         | _(all)_                                       | Comma-separated list of events to forward  |
| `ANALYTICS_FORWARD_LOOKBACK_HOURS` | `25`                                          | Hours to look back for events              |
| `SEGMENT_WRITE_KEY`                | _(unset)_                                     | Segment Write Key for event forwarding     |
| `SEGMENT_API_URL`                  | `https://api.segment.io/v1/batch`             | Segment API endpoint                       |
| `SEGMENT_MAX_BATCH_SIZE`           | `100`                                         | Max events per Segment batch request       |
| `GA4_MEASUREMENT_ID`               | _(unset)_                                     | Google Analytics 4 Measurement ID          |
| `GA4_API_SECRET`                   | _(unset)_                                     | Google Analytics 4 API secret              |
| `GA4_API_URL`                      | `https://www.google-analytics.com/mp/collect` | GA4 Measurement Protocol endpoint          |
| `GA4_MAX_BATCH_SIZE`               | `25`                                          | Max events per GA4 batch request           |
