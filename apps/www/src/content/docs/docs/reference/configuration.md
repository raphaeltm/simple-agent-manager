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

| Secret | Description |
|--------|-------------|
| `ENCRYPTION_KEY` | AES-256-GCM key for credential encryption (auto-generated) |
| `JWT_PRIVATE_KEY` | RSA-2048 private key for signing tokens (auto-generated) |
| `JWT_PUBLIC_KEY` | RSA-2048 public key for token verification (auto-generated) |
| `CF_API_TOKEN` | Cloudflare API token for DNS and infrastructure |
| `CF_ZONE_ID` | Cloudflare zone ID for DNS record management |
| `CF_ACCOUNT_ID` | Cloudflare account ID |
| `GITHUB_CLIENT_ID` | GitHub App client ID for OAuth |
| `GITHUB_CLIENT_SECRET` | GitHub App client secret for OAuth |
| `GITHUB_APP_ID` | GitHub App ID for installation tokens |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM or base64) |
| `GITHUB_APP_SLUG` | GitHub App URL slug |

## Worker Variables

Set as `[vars]` in `wrangler.toml` or as environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_DOMAIN` | — | Root domain for the deployment (e.g., `example.com`) |
| `VERSION` | — | Deployment version string |

## GitHub Environment Variables

Set in GitHub Settings → Environments → production:

| Variable | Description | Example |
|----------|-------------|---------|
| `BASE_DOMAIN` | Deployment domain | `example.com` |
| `RESOURCE_PREFIX` | Cloudflare resource name prefix | `sam` |
| `PULUMI_STATE_BUCKET` | R2 bucket for Pulumi state | `sam-pulumi-state` |

:::note[Naming convention]
GitHub secrets use `GH_*` prefix (e.g., `GH_CLIENT_ID`) because GitHub reserves `GITHUB_*`. The deploy workflow maps `GH_*` → `GITHUB_*` for Worker secrets.
:::

## Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `REQUIRE_APPROVAL` | _(unset)_ | Require admin approval for new users. First user becomes superadmin. |

## AI Task Title Generation

| Variable | Default | Description |
|----------|---------|-------------|
| `TASK_TITLE_MODEL` | `@cf/google/gemma-3-12b-it` | Workers AI model for title generation |
| `TASK_TITLE_MAX_LENGTH` | `100` | Max characters in generated title |
| `TASK_TITLE_TIMEOUT_MS` | `5000` | Timeout before falling back to truncation |
| `TASK_TITLE_GENERATION_ENABLED` | `true` | Set `false` to disable AI generation |
| `TASK_TITLE_SHORT_MESSAGE_THRESHOLD` | `100` | Messages at or below this length bypass AI |
| `TASK_TITLE_MAX_RETRIES` | `2` | Max retry attempts on failure |
| `TASK_TITLE_RETRY_DELAY_MS` | `1000` | Base delay between retries (exponential backoff) |
| `TASK_TITLE_RETRY_MAX_DELAY_MS` | `4000` | Max delay cap for backoff |

## Warm Node Pooling

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_WARM_TIMEOUT_MS` | `1800000` (30 min) | Time a node stays warm after task completion |
| `MAX_AUTO_NODE_LIFETIME_MS` | `14400000` (4 hr) | Absolute max lifetime for auto-provisioned nodes |
| `NODE_WARM_GRACE_PERIOD_MS` | `2100000` (35 min) | Cron sweep grace period (must be > warm timeout) |
| `NODE_LIFECYCLE_ALARM_RETRY_MS` | `60000` (1 min) | Retry delay for DO alarm failures |
| `DEFAULT_TASK_AGENT_TYPE` | `claude-code` | Default agent for autonomous task execution |

## Notification System

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFICATION_PROGRESS_BATCH_WINDOW_MS` | `300000` (5 min) | Min interval between progress notifications per task |
| `NOTIFICATION_DEDUP_WINDOW_MS` | `60000` (60s) | Dedup window for task_complete notifications |
| `NOTIFICATION_AUTO_DELETE_AGE_MS` | `7776000000` (90 days) | Auto-delete old notifications |
| `MAX_NOTIFICATIONS_PER_USER` | `500` | Max stored notifications per user |
| `NOTIFICATION_PAGE_SIZE` | `50` | Default page size for notification list |
| `MAX_NOTIFICATION_PAGE_SIZE` | `100` | Max allowed page size |

## ACP Session Lifecycle

| Variable | Default | Description |
|----------|---------|-------------|
| `ACP_SESSION_DETECTION_WINDOW_MS` | `300000` (5 min) | Heartbeat timeout before marking session interrupted |
| `ACP_SESSION_HEARTBEAT_INTERVAL_MS` | `60000` (60s) | How often VM agent sends heartbeats |
| `ACP_SESSION_RECONCILIATION_TIMEOUT_MS` | `30000` (30s) | VM agent startup reconciliation timeout |
| `ACP_SESSION_MAX_FORK_DEPTH` | `10` | Maximum session fork chain depth |
| `ACP_SESSION_FORK_CONTEXT_MESSAGES` | `20` | Context messages included when forking |

## ACP Protocol (VM Agent)

| Variable | Default | Description |
|----------|---------|-------------|
| `ACP_MESSAGE_BUFFER_SIZE` | `5000` | Buffer size for ACP messages |
| `ACP_PING_INTERVAL` | `30s` | WebSocket keepalive ping interval |
| `ACP_PONG_TIMEOUT` | `10s` | Pong response timeout |
| `ACP_TASK_PROMPT_TIMEOUT` | `6h` | Task execution prompt timeout |
| `ACP_IDLE_SUSPEND_TIMEOUT` | `30m` | Idle session auto-suspend timeout |
| `ACP_NOTIF_SERIALIZE_TIMEOUT` | `5s` | Notification serialization timeout |

## MCP (Agent Tools)

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TOKEN_TTL_SECONDS` | `14400` (4 hours) | Token lifetime for agent MCP access (must be >= task max execution time) |
| `MCP_RATE_LIMIT` | `120` | Max MCP requests per window |
| `MCP_RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate limit window |
| `MCP_DISPATCH_MAX_DEPTH` | `3` | Max recursion depth for dispatch_task |
| `MCP_DISPATCH_MAX_PER_TASK` | `5` | Max dispatched tasks per parent task |
| `MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT` | `10` | Max active dispatched tasks per project |

## Voice & Text-to-Speech

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_MODEL_ID` | `@cf/openai/whisper-large-v3-turbo` | Transcription model |
| `MAX_AUDIO_SIZE_BYTES` | `10485760` (10 MB) | Max upload audio size |
| `MAX_AUDIO_DURATION_SECONDS` | `60` | Max recording duration |
| `RATE_LIMIT_TRANSCRIBE` | `30` | Max transcriptions per minute |
| `TTS_ENABLED` | `true` | Enable/disable text-to-speech |
| `TTS_MODEL` | `@cf/deepgram/aura-2-en` | TTS model |
| `TTS_SPEAKER` | `luna` | TTS voice selection |
| `TTS_ENCODING` | `mp3` | Audio output format |
| `TTS_MAX_TEXT_LENGTH` | `10000` | Max characters per TTS synthesis |
| `TTS_TIMEOUT_MS` | `60000` | TTS synthesis timeout |

## Context Summarization (Forking)

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_SUMMARY_MODEL` | `@cf/google/gemma-3-12b-it` | Model for conversation context summarization |
| `CONTEXT_SUMMARY_MAX_LENGTH` | `4000` | Max summary length in characters |
| `CONTEXT_SUMMARY_TIMEOUT_MS` | `10000` | Summarization timeout |
| `CONTEXT_SUMMARY_MAX_MESSAGES` | `50` | Max messages to include in summary |
| `CONTEXT_SUMMARY_SHORT_THRESHOLD` | `5` | Skip AI for conversations this short |

## Task Execution Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `TASK_RUN_MAX_EXECUTION_MS` | `14400000` (4 hr) | Max task execution time |
| `TASK_STUCK_QUEUED_TIMEOUT_MS` | `600000` (10 min) | Timeout for tasks stuck in queued state |
| `TASK_STUCK_DELEGATED_TIMEOUT_MS` | `1860000` (31 min) | Timeout for tasks stuck in delegated state |
| `TASK_CALLBACK_TIMEOUT_MS` | `10000` | Callback response timeout |
| `TASK_CALLBACK_RETRY_MAX_ATTEMPTS` | `3` | Max callback retry attempts |
| `TASK_RUN_CLEANUP_DELAY_MS` | `5000` | Delay before task cleanup |

## Node & Workspace Readiness

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_AGENT_READY_TIMEOUT_MS` | `600000` (10 min) | Wait for VM agent to report ready |
| `NODE_AGENT_READY_POLL_INTERVAL_MS` | `5000` | Poll interval for agent readiness |
| `TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS` | `1800000` (30 min) | Max wait for workspace-ready callback |
| `PROVISIONING_TIMEOUT_MS` | `1800000` (30 min) | Cron marks stuck workspaces as error |

## Platform Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_NODES_PER_USER` | `10` | Max nodes per user |
| `MAX_AGENT_SESSIONS_PER_WORKSPACE` | `10` | Max concurrent agent sessions |
| `MAX_PROJECTS_PER_USER` | `100` | Max projects per user |
| `MAX_TASKS_PER_PROJECT` | `500` | Max tasks per project |
| `MAX_TASK_MESSAGE_LENGTH` | `16000` | Max task description length |

## Durable Object Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_SESSIONS_PER_PROJECT` | `1000` | Max chat sessions per project |
| `MAX_MESSAGES_PER_SESSION` | `10000` | Max messages per chat session |
| `MESSAGE_SIZE_THRESHOLD` | `102400` | Max message size in bytes |
| `ACTIVITY_RETENTION_DAYS` | `90` | Days to retain activity events |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `60` | Idle session timeout |
| `DO_SUMMARY_SYNC_DEBOUNCE_MS` | `5000` | Debounce for DO-to-D1 summary sync |

## Runtime Config Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT` | `150` | Max env vars per project |
| `MAX_PROJECT_RUNTIME_FILES_PER_PROJECT` | `50` | Max files per project |
| `MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES` | `8192` | Max bytes per env var value |
| `MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES` | `131072` | Max bytes per file content |
| `MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH` | `256` | Max file path length |

## External API Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `HETZNER_API_TIMEOUT_MS` | `30000` | Hetzner API request timeout |
| `CF_API_TIMEOUT_MS` | `30000` | Cloudflare API request timeout |
| `NODE_AGENT_REQUEST_TIMEOUT_MS` | `30000` | VM Agent request timeout |

## Admin Observability

| Variable | Default | Description |
|----------|---------|-------------|
| `OBSERVABILITY_ERROR_RETENTION_DAYS` | `30` | Error log retention |
| `OBSERVABILITY_ERROR_MAX_ROWS` | `100000` | Max stored error rows |
| `OBSERVABILITY_ERROR_BATCH_SIZE` | `25` | Error ingestion batch size |
| `OBSERVABILITY_LOG_QUERY_RATE_LIMIT` | `30` | Log queries per minute per admin |

## VM TLS

| Variable | Default | Description |
|----------|---------|-------------|
| `VM_AGENT_PROTOCOL` | `https` | Protocol for VM agent communication |
| `VM_AGENT_PORT` | `8443` | VM agent listening port |
| `ORIGIN_CA_CERT` | _(auto)_ | TLS certificate (auto-generated by Pulumi) |
| `ORIGIN_CA_KEY` | _(auto)_ | TLS private key (auto-generated by Pulumi) |

## Journald Configuration (VM)

Applied via cloud-init on each node:

| Setting | Default | Description |
|---------|---------|-------------|
| `SystemMaxUse` | `500M` | Max disk space for journal |
| `SystemKeepFree` | `1G` | Minimum free disk to maintain |
| `MaxRetentionSec` | `7day` | Max log retention period |
| `Storage` | `persistent` | Persist logs across reboots |
| `Compress` | `yes` | Compress stored entries |
