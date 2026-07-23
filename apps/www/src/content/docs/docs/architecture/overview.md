---
title: Architecture Overview
description: How SAM's components fit together — from the browser to the VM terminal.
---

SAM is a serverless platform for ephemeral AI coding environments. The architecture splits into three layers: **edge** (Cloudflare), **compute** (cloud VMs — Hetzner, Scaleway, Vultr, or GCP), and **external services** (GitHub, DNS).

For instant sessions, SAM can also run one standalone vm-agent in a raw Cloudflare Container. The deployment workflow builds the Linux vm-agent from the deployment commit, records its version and SHA-256 digest, and bakes it into the container image before Wrangler deploys the Worker. Cloudflare Worker deployment versions therefore provide the matching image/Worker rollback boundary. The image contains only SAM runtime tooling: project, profile, and skill files, environment variables, and secrets remain outside the image and are fetched and applied when the ACP session starts.

## High-Level Architecture

```mermaid
graph TD
    subgraph Browser
        SPA["React SPA<br/>(app.domain)"]
        XTERM["xterm.js"]
        CHAT["Agent Chat"]
        NOTIF["Notifications"]
        CMDK["Command Palette"]
    end

    subgraph CF["Cloudflare Edge"]
        subgraph Worker["API Worker (Hono)"]
            PROXY["Reverse Proxy"]
            AUTH["Auth"]
            AI["Workers AI"]
        end
        D1["D1 (SQLite)"]
        KV["KV"]
        R2["R2"]
        PAGES["Cloudflare Pages<br/>(React SPA)"]
        subgraph DOs["Durable Objects"]
            PD["ProjectData<br/>(per-project SQLite)"]
            NL["NodeLifecycle<br/>(warm pool state)"]
            TR["TaskRunner<br/>(task orchestration)"]
            AL["AdminLogs<br/>(real-time log stream)"]
            NO["Notification<br/>(delivery management)"]
        end
        Worker --- D1
        Worker --- KV
        Worker --- R2
        Worker --- DOs
    end

    subgraph VM["Cloud VM (Hetzner / Scaleway / Vultr / GCP)"]
        subgraph AGENT["VM Agent (Go, :8443)"]
            PTY["PTY Manager"]
            CM["Container Manager"]
            ACP["ACP Gateway"]
            PS["Port Scanner"]
            JWT["JWT Validator"]
        end
        subgraph DOCKER["Docker Engine"]
            WS1["Workspace Container 1"]
            WSN["Workspace Container N"]
        end
        AGENT --> DOCKER
    end

    Browser -- "HTTPS" --> CF
    Browser -- "WSS" --> CF
    CF -- "HTTP/WSS<br/>(proxied via DNS)" --> VM
```

## Request Routing

Every request to `*.domain` passes through the same Cloudflare Worker. The `Host` header determines routing:

| Pattern                                     | Destination             | How                                                                              |
| ------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `app.{domain}`                              | Cloudflare Pages        | Worker proxies to `{project}.pages.dev`                                          |
| `api.{domain}`                              | Worker API routes       | Direct handling by Hono router                                                   |
| `ws-{id}.{domain}`                          | VM Agent on port 8443   | Worker proxies via `{nodeId}.vm.{domain}` backend hostname                       |
| `ws-{id}--{port}.{domain}`                  | Workspace port proxy    | Worker proxies to dev server running on `{port}`                                 |
| `r{N}-{service}-{port}-{env}.apps.{domain}` | Deployment public route | DNS-only A record points at the deployment node; node-local Caddy terminates TLS |
| `*.{domain}` (other)                        | 404                     | No matching route                                                                |

:::note[Why backend hostnames?]
Cloudflare Workers can't fetch IP addresses directly (Error 1003). Node backend DNS records (`{nodeId}.vm.{domain}` → VM IP) are created so the Worker can proxy through hostnames, with `*.vm.{domain}` excluded from the Worker route.
:::

Deployment public routes do not pass through the Worker proxy. The API derives a
stable hostname and loopback host port for each public route in a release,
creates the SAM-owned DNS-only A record, and sends those route targets inside
the signed deployment apply payload. The deployment node's Caddy instance then
terminates TLS and reverse-proxies to `127.0.0.1:{hostPort}`. User-owned custom
subdomains reuse the same signed route-target path after DNS verification, but
SAM does not create those user DNS records.

## Control Plane — API Worker

The API Worker (`apps/api/`) is a Hono application handling:

- **Authentication** — GitHub, Google, and GitLab OAuth via BetterAuth
- **Resource management** — CRUD for nodes, workspaces, projects, ideas
- **Reverse proxy** — workspace subdomain, port traffic, and file proxy to VMs
- **Durable Objects** — per-project data, node lifecycle, idea orchestration, notifications
- **Workers AI** — idea title generation, voice transcription, text-to-speech, context summarization
- **MCP server** — project-aware tools for running agents
- **Cron triggers** — provisioning timeout checks, warm node cleanup, orphan detection

### Key Route Groups

| Route                   | Purpose                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `/api/auth/*`           | GitHub OAuth sign-in/out, sessions                                             |
| `/api/nodes/*`          | Node CRUD, lifecycle, health callbacks                                         |
| `/api/workspaces/*`     | Workspace CRUD, lifecycle, boot logs, agent sessions                           |
| `/api/projects/*`       | Project CRUD, runtime config, ideas, chat sessions, file proxy                 |
| `/api/credentials/*`    | Cloud provider + agent API key management                                      |
| `/api/notifications/*`  | Notification list, read/dismiss, preferences, WebSocket                        |
| `/api/tasks/*`          | Idea submission, lifecycle, status updates                                     |
| `/api/github/*`         | GitHub App installations, repos                                                |
| `/api/terminal/token`   | Workspace JWT for WebSocket auth                                               |
| `/api/agent/*`          | VM Agent binary download (VM/cloud-init path; container image has it baked in) |
| `/api/bootstrap/:token` | One-time credential injection                                                  |
| `/api/admin/*`          | Admin dashboard, error logs, real-time log stream                              |
| `/api/tts/*`            | Text-to-speech synthesis                                                       |
| `/api/transcribe`       | Voice-to-text transcription                                                    |

## Data Layer — Hybrid D1 + Durable Objects

SAM uses a hybrid storage model: **D1** for cross-project queries and **Durable Objects** for write-heavy, project-scoped data.

### D1 (Cross-Project Queries)

| Binding                  | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `DATABASE`               | Users, projects, nodes, workspaces, ideas, credentials |
| `OBSERVABILITY_DATABASE` | Error storage for admin dashboard                      |

D1 stores platform-level data that needs to be queried across projects (e.g., "show all my ideas" on the dashboard).

### Durable Objects (Per-Project Data)

| Binding                         | Scope       | Purpose                                                     |
| ------------------------------- | ----------- | ----------------------------------------------------------- |
| `PROJECT_DATA`                  | Per project | Chat sessions, messages, activity events, ACP sessions (embedded SQLite) |
| `NODE_LIFECYCLE`                | Per node    | Warm pool state machine (active → warm → destroying)        |
| `TASK_RUNNER`                   | Per task    | Multi-step task execution orchestration via alarm callbacks |
| `ADMIN_LOGS`                    | Singleton   | Real-time log broadcast to admin WebSocket clients          |
| `NOTIFICATION`                  | Per user    | Notification delivery and state management                  |
| `PROJECT_ORCHESTRATOR`          | Per project | Project-scoped agent orchestration                          |
| `PROJECT_AGENT`                 | Per project | AI technical-lead session for a project                     |
| `SAM_SESSION`                   | Per user    | SAM agent conversation session state                        |
| `CODEX_REFRESH_LOCK`            | Per user    | Serializes Codex OAuth token refresh (prevents 429 rotation races) |
| `GITHUB_USER_ACCESS_TOKEN_LOCK` | Per user    | Serializes GitHub OAuth user-token refresh                  |
| `GITLAB_USER_ACCESS_TOKEN_LOCK` | Per user    | Serializes GitLab OAuth user-token refresh                  |
| `AI_TOKEN_BUDGET_COUNTER`       | Per user    | Atomic AI token budget accounting                           |
| `TRIAL_COUNTER`                 | Singleton   | Monthly trial-onboarding cap counter (keyed by `YYYY-MM`)   |
| `TRIAL_EVENT_BUS`               | Per trial   | SSE event buffering for trial provisioning                  |
| `TRIAL_ORCHESTRATOR`            | Per trial   | Alarm-driven trial provisioning                             |

### Why Hybrid?

D1 handles reads well but has write contention under high concurrency. Chat messages and activity events generate high-frequency writes that would overwhelm D1. Durable Objects provide single-threaded SQLite access per project, eliminating contention while keeping data co-located.

Summary data flows back from DOs to D1 via debounced sync (e.g., `last_activity_at`, `active_session_count` on the projects table).

### Other Bindings

| Service        | Binding | Purpose                                                          |
| -------------- | ------- | ---------------------------------------------------------------- |
| **KV**         | `KV`    | Auth sessions, bootstrap tokens, boot logs, MCP tokens           |
| **R2**         | `R2`    | VM Agent binaries, TTS audio cache, Pulumi state                 |
| **Workers AI** | `AI`    | Idea title generation, transcription, TTS, context summarization |

## Agent Configuration Layers

Agent behavior is assembled from several override layers rather than a single global setting:

- **Composable credentials** — reusable credential rows (`cc_credentials`) and configuration/attachment rows (`cc_configurations`, `cc_attachments`) can be layered per project and per profile, resolved **skill → profile → project → platform**.
- **Agent profiles** — named, reusable agent configurations (agent type, model, runtime, env, files) selected per chat or per task/trigger.
- **Skills** — a first-class override layer that further specializes a profile for a specific task type.
- **Provider modes** — each agent runs in one of three auth modes: `user-api-key` (the user's own key), `oauth` (a subscription token such as Claude Max), or `sam` (the platform-managed AI proxy, opt-in). See [Agent Authentication](/docs/guides/agents/).

## Durable Objects Deep Dive

### ProjectData DO

Each project gets one `ProjectData` Durable Object instance, accessed via `env.PROJECT_DATA.idFromName(projectId)`.
nEvery user-visible chat session has exactly one backing D1 Task. `taskMode` controls autonomous task versus human-controlled conversation lifecycle semantics; it never controls whether the Task exists. D1 `tasks.chat_session_id` and ProjectData `chat_sessions.task_id` form a bidirectional soft link. Because the stores cannot share a transaction, creation and legacy repair are idempotent and retain compatibility readers while reconciliation is in progress.

**Embedded SQLite tables:**

- `chat_sessions` — session metadata, lifecycle status, message counts
- `chat_messages` — append-only streaming token log; each row is one streaming chunk from Claude Code, not a logical message. Consecutive same-role tokens (assistant, tool, thinking) are grouped into logical messages at the API and UI layers. The `origin` column tags SAM-injected content (e.g. the `get_instructions` reminder) as `system` (NULL/absent = normal `user` message); `origin=system` rows are excluded from grouping/materialization, full-text search, topic auto-capture, and attention resolution, and are rendered collapsed in the chat UI.
- `chat_messages_grouped` — materialized grouped messages, populated when a session stops by concatenating consecutive same-role tokens. Source for FTS5 full-text search.
- `chat_messages_grouped_fts` — FTS5 virtual table indexed on grouped message content for full-text search with stemming and phrase matching.
- `activity_events` — audit trail (workspace created, session stopped, etc.)
- `chat_session_ideas` — many-to-many links between sessions and ideas
- `task_status_events` — idea lifecycle transitions with actor tracking
- `acp_sessions` — ACP session state machine with fork lineage
- `acp_session_events` — ACP session state transition history

**Key features:**

- Hibernatable WebSockets for zero-idle-cost real-time chat
- Heartbeat-based VM failure detection via DO alarms
- Session forking with parent lineage tracking
- Debounced D1 summary sync for dashboard data

### NodeLifecycle DO

Each node gets one `NodeLifecycle` Durable Object, accessed via `env.NODE_LIFECYCLE.idFromName(nodeId)`.

**State machine:**

```mermaid
stateDiagram-v2
    [*] --> active
    active --> warm : Task complete / idle
    warm --> active : Claimed by new task
    warm --> destroying : Warm timeout elapsed
```

- `markIdle(nodeId, userId)` — transitions to warm, schedules cleanup alarm
- `tryClaim(taskId)` — atomically claims a warm node for reuse (single-threaded, no races)
- `alarm()` — fires after warm timeout, triggers node destruction

### TaskRunner DO

Each idea execution gets one `TaskRunner` Durable Object, accessed via `env.TASK_RUNNER.idFromName(taskId)`.

**Orchestration steps** (each idempotent, alarm-driven):

```mermaid
graph LR
    NS["node_selection"] --> NP["node_provisioning"]
    NP --> NAR["node_agent_ready"]
    NAR --> WC["workspace_creation"]
    WC --> WR["workspace_ready"]
    WR --> AS["agent_session"]
    AS --> R["running"]
```

Cross-DO coordination with NodeLifecycle (for warm node claims) and ProjectData (for session linkage). Exponential backoff on transient errors.

## ACP Session Lifecycle

Agent sessions are managed by the ProjectData DO with this state machine:

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> assigned : Node selected
    assigned --> running : Agent started on VM
    running --> completed : Agent finished
    running --> failed : Agent error
    running --> interrupted : Heartbeat lost
    assigned --> interrupted : Heartbeat lost
```

**Heartbeat detection**: VM agent sends heartbeats every 60 seconds. If no heartbeat within 5 minutes (`ACP_SESSION_DETECTION_WINDOW_MS`), the DO alarm marks the session as `interrupted`.

**Session forking**: Sessions track `parentSessionId` and `forkDepth` for lineage. Fork depth is limited to 10 (`ACP_SESSION_MAX_FORK_DEPTH`).

## VM Agent

The VM Agent (`packages/vm-agent/`) is a Go binary running on each node:

| Subsystem         | Package                   | Responsibility                                                  |
| ----------------- | ------------------------- | --------------------------------------------------------------- |
| PTY Manager       | `internal/pty/`           | Terminal multiplexing, ring buffer replay                       |
| Container Manager | `internal/container/`     | Docker exec, devcontainer CLI                                   |
| ACP Gateway       | `internal/acp/`           | Agent protocol, streaming responses, notification serialization |
| Port Scanner      | `internal/ports/`         | Auto-detect listening ports, build proxy URLs                   |
| JWT Validator     | `internal/auth/`          | Validates workspace JWTs via JWKS endpoint                      |
| Persistence       | `internal/persistence/`   | SQLite tab/session storage                                      |
| Boot Logger       | `internal/bootlog/`       | Reports provisioning progress                                   |
| Message Reporter  | `internal/messagereport/` | Outbox-based message relay to control plane                     |

## Deployment Pipeline

```mermaid
graph TD
    TRIGGER["Deploy Production workflow"] --> P1
    P1["Phase 1: Infrastructure<br/>(Pulumi)"] --> P2
    P1 -.- P1D["D1, KV, R2, DNS records"]
    P2["Phase 2: Configuration"] --> P3
    P2 -.- P2D["Sync wrangler.toml, read security keys"]
    P3["Phase 3: Application"] --> P4
    P3 -.- P3D["Build → Bake vm-agent into container image → Deploy Worker → Deploy Pages → Migrations → Secrets"]
    P4["Phase 4: VM Agent"] --> P5
    P4 -.- P4D["Build Go (multi-arch) → Upload to R2"]
    P5["Phase 5: Validation"]
    P5 -.- P5D["Health check polling"]
```

CI runs lint, typecheck, tests, and build on pull requests and on canonical-repository `main` pushes. In the canonical repository, Deploy Production runs after successful `main` CI. In self-host forks, `main` push CI is intentionally skipped, so operators update their instance by manually running **Deploy Production** on the fork's `main` branch.

## Key Design Decisions

| Decision                             | Rationale                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------- |
| Single Worker as API + reverse proxy | Simplifies infrastructure — one Worker handles everything                 |
| Hybrid D1 + Durable Objects          | D1 for cross-project reads, DOs for high-throughput project-scoped writes |
| BYOC + platform-credential fallback  | Users/self-hosters may bring their own cloud tokens; SAM's hosted platform also has an enabled platform credential so provisioning works with zero config (resolution: user → platform) |
| Callback-driven provisioning         | VMs POST `/ready` when bootstrapped — no polling                          |
| Dynamic DNS per workspace            | Instant subdomain resolution; cleaned up on stop                          |
| Alarm-driven execution orchestration | Idempotent steps with exponential backoff; no long-running processes      |
| No credentials in cloud-init         | Bootstrap tokens for secure credential injection                          |
| Multi-provider abstraction           | Unified VM size/lifecycle API across Hetzner, Scaleway, Vultr, and GCP           |
