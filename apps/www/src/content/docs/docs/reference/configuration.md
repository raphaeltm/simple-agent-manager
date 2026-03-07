---
title: Configuration Reference
description: All environment variables, secrets, and configurable settings for SAM.
---

SAM uses environment variables for platform configuration. User-specific settings (Hetzner tokens, agent keys) are stored encrypted in the database, not as environment variables.

:::note
This reference covers the most important configuration variables. For the complete list including advanced tuning options, see [`apps/api/src/index.ts`](https://github.com/raphaeltm/simple-agent-manager/blob/main/apps/api/src/index.ts) in the source code.
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

## AI Task Title Generation

| Variable | Default | Description |
|----------|---------|-------------|
| `TASK_TITLE_MODEL` | `@cf/meta/llama-3.1-8b-instruct` | Workers AI model |
| `TASK_TITLE_MAX_LENGTH` | `100` | Max characters in generated title |
| `TASK_TITLE_TIMEOUT_MS` | `5000` | Timeout before falling back to truncation |
| `TASK_TITLE_GENERATION_ENABLED` | `true` | Set `false` to disable AI generation |
| `TASK_TITLE_SHORT_MESSAGE_THRESHOLD` | `100` | Messages at or below this length bypass AI |
| `TASK_TITLE_MAX_RETRIES` | `2` | Max retry attempts on failure |
| `TASK_TITLE_RETRY_DELAY_MS` | `1000` | Base delay between retries |
| `TASK_TITLE_RETRY_MAX_DELAY_MS` | `4000` | Max delay cap for backoff |

## Warm Node Pooling

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_WARM_TIMEOUT_MS` | `1800000` (30 min) | Time a node stays warm after task completion |
| `DEFAULT_TASK_AGENT_TYPE` | `claude-code` | Agent used for autonomous task execution |

## Journald Configuration (VM)

Applied via cloud-init on each node:

| Setting | Default | Description |
|---------|---------|-------------|
| `SystemMaxUse` | `500M` | Max disk space for journal |
| `SystemKeepFree` | `1G` | Minimum free disk to maintain |
| `MaxRetentionSec` | `7day` | Max log retention period |
| `Storage` | `persistent` | Persist logs across reboots |
| `Compress` | `yes` | Compress stored entries |
