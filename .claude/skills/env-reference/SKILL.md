---
name: env-reference
description: Full environment variable reference for SAM. Use when adding, modifying, or documenting environment variables, configuring deployment, or working with Worker secrets.
user-invocable: false
---

# SAM Environment Variable Reference

## GitHub Environment Secrets (GitHub Settings -> Environments -> production)

Uses `GH_*` prefix because GitHub Actions reserves `GITHUB_*` for its own use.

| Type     | Name                       | Required |
| -------- | -------------------------- | -------- |
| Variable | `BASE_DOMAIN`              | Yes |
| Variable | `RESOURCE_PREFIX`          | No (default: `sam`) |
| Variable | `PULUMI_STATE_BUCKET`      | No (default: `sam-pulumi-state`) |
| Secret   | `CF_API_TOKEN`             | Yes |
| Secret   | `CF_ACCOUNT_ID`            | Yes |
| Secret   | `CF_ZONE_ID`               | Yes |
| Secret   | `R2_ACCESS_KEY_ID`         | Yes |
| Secret   | `R2_SECRET_ACCESS_KEY`     | Yes |
| Secret   | `PULUMI_CONFIG_PASSPHRASE` | Yes |
| Secret   | `GH_CLIENT_ID`             | Yes |
| Secret   | `GH_CLIENT_SECRET`         | Yes |
| Secret   | `GH_APP_ID`                | Yes |
| Secret   | `GH_APP_PRIVATE_KEY`       | Yes |
| Secret   | `GH_APP_SLUG`              | Yes |
| Secret   | `ENCRYPTION_KEY`           | No (auto-generated) |
| Secret   | `JWT_PRIVATE_KEY`          | No (auto-generated) |
| Secret   | `JWT_PUBLIC_KEY`           | No (auto-generated) |

## GH_ to GITHUB_ Mapping (done by `configure-secrets.sh`)

```
GitHub Secret          ->  Cloudflare Worker Secret
GH_CLIENT_ID           ->  GITHUB_CLIENT_ID
GH_CLIENT_SECRET       ->  GITHUB_CLIENT_SECRET
GH_APP_ID              ->  GITHUB_APP_ID
GH_APP_PRIVATE_KEY     ->  GITHUB_APP_PRIVATE_KEY
GH_APP_SLUG            ->  GITHUB_APP_SLUG
```

## API Worker Runtime Environment Variables

See `apps/api/.env.example` for the full list. Key variables:

### Core
- `WRANGLER_PORT` — Local dev port (default: 8787)
- `BASE_DOMAIN` — Set automatically by sync scripts

### Resource Limits
- `MAX_NODES_PER_USER` — Runtime node cap
- `MAX_WORKSPACES_PER_USER` — Runtime workspace cap
- `MAX_WORKSPACES_PER_NODE` — Per-node workspace cap
- `MAX_AGENT_SESSIONS_PER_WORKSPACE` — Runtime session cap
- `MAX_PROJECTS_PER_USER` — Runtime project cap
- `MAX_TASKS_PER_PROJECT` — Runtime task cap per project
- `MAX_TASK_DEPENDENCIES_PER_TASK` — Runtime dependency-edge cap per task

### Pagination
- `TASK_LIST_DEFAULT_PAGE_SIZE` — Default task/project list page size
- `TASK_LIST_MAX_PAGE_SIZE` — Maximum task/project list page size

### Timeouts
- `TASK_CALLBACK_TIMEOUT_MS` — Timeout budget for delegated-task callback processing
- `TASK_CALLBACK_RETRY_MAX_ATTEMPTS` — Retry budget for delegated-task callback processing
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

## VM Agent Environment Variables

### Container/User
- `CONTAINER_USER` — Optional `docker exec -u` override; when unset, auto-detects effective devcontainer user

### Git Operations
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

### ACP (Agent Communication Protocol)
- `ACP_MESSAGE_BUFFER_SIZE` — Max buffered messages per SessionHost for late-join replay (default: 5000)
- `ACP_VIEWER_SEND_BUFFER` — Per-viewer send channel buffer size (default: 256)
- `ACP_PING_INTERVAL` — WebSocket ping interval for stale connection detection (default: 30s)
- `ACP_PONG_TIMEOUT` — WebSocket pong deadline after ping (default: 10s)
- `ACP_PROMPT_TIMEOUT` — Max ACP prompt runtime before timeout (default: 10m)
- `ACP_PROMPT_CANCEL_GRACE_PERIOD` — Grace wait after cancel before force-stop (default: 5s)

### Events
- `MAX_NODE_EVENTS` — Max node-level events retained in memory (default: 500)
- `MAX_WORKSPACE_EVENTS` — Max workspace-level events retained in memory (default: 500)

### System Info
- `SYSINFO_DOCKER_TIMEOUT` — Timeout for Docker CLI commands during system info collection (default: 10s)
- `SYSINFO_VERSION_TIMEOUT` — Timeout for version-check commands (default: 5s)
- `SYSINFO_CACHE_TTL` — Cache duration for system info results (default: 5s)
