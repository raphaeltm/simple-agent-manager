# Simple Agent Manager (SAM)

A serverless monorepo platform for ephemeral AI coding agent environments on Cloudflare Workers + Hetzner Cloud VMs.

## Repository Structure

```
apps/
├── api/          # Cloudflare Worker API (Hono)
├── web/          # Control plane UI (React + Vite)
├── www/          # Marketing website, blog & docs (Astro + Starlight) — simple-agent-manager.org
└── tail-worker/  # Cloudflare Tail Worker (observability)
packages/
├── shared/       # Shared types and utilities
├── providers/    # Cloud provider abstraction (Hetzner, Scaleway)
├── terminal/     # Shared terminal component
├── cloud-init/   # Cloud-init template generator
├── acp-client/   # Shared ACP React components (MessageBubble, MessageActions, AudioPlayer)
├── ui/           # Design system tokens and shared UI components
├── workspace-mcp/ # Workspace MCP server
└── vm-agent/     # Go VM agent (PTY, WebSocket, ACP)
tasks/            # Task tracking (backlog -> active -> archive)
specs/            # Feature specifications
docs/             # Documentation
strategy/         # Strategic planning (competitive, business, marketing, engineering, content)
```

## Common Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm test             # Run tests
pnpm typecheck        # Type check
pnpm lint             # Lint
pnpm format           # Format
```

## Build Order

Build packages in dependency order: `shared` -> `providers` -> `cloud-init` -> `api` / `web`

```bash
pnpm --filter @simple-agent-manager/shared build
pnpm --filter @simple-agent-manager/providers build
pnpm --filter @simple-agent-manager/api build
```

## Website vs App (IMPORTANT)

This monorepo has TWO separate web surfaces. Do NOT confuse them:

| Surface | Directory | Domain | Stack | What it is |
|---------|-----------|--------|-------|------------|
| **Marketing website** | `apps/www/` | `simple-agent-manager.org` | Astro + Starlight | Public website, landing pages, blog, docs |
| **App (control plane)** | `apps/web/` | `app.simple-agent-manager.org` | React + Vite | Authenticated SaaS UI (dashboard, projects, settings) |

When the user mentions **website, marketing, landing page, blog, docs site, or public pages** → look in `apps/www/`.
When the user mentions **app, dashboard, projects, settings, or UI** → look in `apps/web/`.

## Development Approach

**Cloudflare-first.** Local dev (`pnpm dev`) has significant limitations — no real OAuth, DNS, or VMs. For meaningful testing, deploy to staging. See `docs/guides/local-development.md`.

1. Make changes locally — lint, typecheck
2. Deploy to staging via GitHub Actions or `pnpm deploy:setup --environment staging`
3. Test on Cloudflare — real D1, KV, Workers
4. Merge to main — triggers production deployment

## Deployment

Merge to `main` automatically deploys to production via GitHub Actions.

- **CI** (`ci.yml`): lint, typecheck, test, build on all pushes/PRs
- **Deploy Staging** (`deploy-staging.yml`): manual trigger only (`workflow_dispatch`) — agents trigger this explicitly during `/do` Phase 6
- **Deploy Production** (`deploy.yml`): full Pulumi + Wrangler deployment on push to main
- **Teardown** (`teardown.yml`): manual only — destroys all resources

### Staging Deployment is a Merge Gate

Staging deployment is manual — triggered via `gh workflow run deploy-staging.yml --ref <branch>`. Agents executing the `/do` workflow MUST deploy to staging and verify the live app before merging. A failed staging deploy blocks merge just like a failed test. Before triggering a deployment, check for existing active runs and wait at least 5 minutes if one is in progress. See `.claude/rules/13-staging-verification.md`.

## Key Concepts

- **Workspace**: AI coding environment (VM + devcontainer + Claude Code)
- **Node**: VM host that runs multiple workspaces
- **Provider**: Cloud infrastructure abstraction (currently Hetzner only)
- **Project**: Primary organizational unit linking a GitHub repo to workspaces, chat sessions, tasks, and activity
- **ProjectData DO**: Per-project Durable Object with embedded SQLite for chat sessions, messages, activity events, and ACP sessions (spec 027). Accessed via `env.PROJECT_DATA.idFromName(projectId)`
- **NodeLifecycle DO**: Per-node Durable Object managing warm pool state machine (active → warm → destroying). Accessed via `env.NODE_LIFECYCLE.idFromName(nodeId)`. Handles idle timeout alarms; actual infrastructure teardown delegated to cron sweep.
- **Warm Node Pooling**: After task completion, auto-provisioned nodes enter "warm" state for 30 min (configurable via `NODE_WARM_TIMEOUT_MS`) for fast reuse. Three-layer defense against orphans: DO alarm + cron sweep + max lifetime.
- **Task Runner**: Autonomous task execution — selects/provisions nodes, creates workspaces, runs agents, cleans up. VM size precedence: explicit override > project default > platform default.
- **Lifecycle Control**: Workspaces/nodes stopped, restarted, or deleted explicitly via API/UI

## URL Construction Rules

The root domain does NOT serve any application. Always use subdomains:

| Destination        | URL Pattern                                |
| ------------------ | ------------------------------------------ |
| **Web UI**         | `https://app.${BASE_DOMAIN}/...`           |
| **API**            | `https://api.${BASE_DOMAIN}/...`           |
| **Workspace**      | `https://ws-${id}.${BASE_DOMAIN}`          |
| **Workspace Port** | `https://ws-${id}--${port}.${BASE_DOMAIN}` |

- User-facing redirects -> `app.${BASE_DOMAIN}` (NEVER bare `${BASE_DOMAIN}`)
- API-to-API references -> `api.${BASE_DOMAIN}`
- Relative redirects in API worker are WRONG — they resolve to the API subdomain

## Env Var Naming: GH_ vs GITHUB_

GitHub Actions reserves `GITHUB_*`, so GitHub secrets use `GH_*` prefix. The deployment script (`configure-secrets.sh`) maps them to `GITHUB_*` Worker secrets.

| Context              | Prefix     | Example             |
| -------------------- | ---------- | ------------------- |
| GitHub Environment   | `GH_`     | `GH_CLIENT_ID`      |
| Worker runtime / .env | `GITHUB_` | `GITHUB_CLIENT_ID`  |

Full env var reference: use the `env-reference` skill or see `apps/api/.env.example`.

## Wrangler Binding Rule (CRITICAL)

Environment-specific `[env.*]` sections are NOT checked into the repository. They are generated at deploy time by `scripts/deploy/sync-wrangler-config.ts` from Pulumi outputs + the top-level config. When adding ANY new binding to `wrangler.toml`, add it to the **top-level section only**. The sync script copies static bindings (Durable Objects, AI, migrations) and generates dynamic bindings (D1, KV, R2, worker name, routes, tail_consumers) automatically. The CI quality check (`pnpm quality:wrangler-bindings`) verifies that no env sections are committed and that required binding types are present at the top level. See `.claude/rules/07-env-and-urls.md` for details.

## Architecture Principles

1. **BYOC (Bring-Your-Own-Cloud)**: Users provide their own Hetzner tokens. The platform does NOT have cloud provider credentials.
2. **User credentials encrypted per-user** in the database — NOT stored as env vars or Worker secrets. See `docs/architecture/credential-security.md`.
3. **Platform secrets** (ENCRYPTION_KEY and purpose-specific overrides, JWT keys, CF_API_TOKEN) are Cloudflare Worker secrets set during deployment. See `docs/architecture/secrets-taxonomy.md`.
4. **Canonical IDs for identity** — use `workspaceId`, `nodeId`, `sessionId` for all machine-critical operations (storage, routing, lifecycle). Human-readable labels are for UX/logging only and MUST be treated as mutable and non-unique.
5. **Hybrid D1 + Durable Object storage** — D1 for cross-project queries (dashboard, tasks, users); per-project DOs for write-heavy data (chat sessions, messages, activity events). See `docs/adr/004-hybrid-d1-do-storage.md`.

## Git Workflow

- **Always use worktrees and PRs** — never commit directly to main. Create a feature branch in a git worktree and open a PR.
- **Push early and often** — environments are ephemeral. Unpushed work can be lost at any time.
- **Pull and rebase frequently** — before starting work and before pushing, run `git fetch origin && git rebase origin/main` to stay current and avoid conflicts.
- After pushing, check CI and fix any failures before moving on.

## Development Guidelines

- **Fix all build/lint errors** before pushing — even pre-existing ones
- **No dead code** — if code is no longer referenced, remove it in the same change
- **Capability tests required** — every multi-component feature needs at least one test that exercises the complete happy path across system boundaries. Component tests alone are not sufficient. See `.claude/rules/10-e2e-verification.md`.
- **Verify assumptions, don't trust documentation** — when specs or docs say "existing X works," verify with a test or manual check before building on it. See post-mortem: `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`.
- **Cite code paths in behavioral docs** — when documenting what the system does, cite specific functions. Never write "X happens" without a code reference. Mark unimplemented behavior as "intended" not present tense.
- **Diagrams in markdown** — use Mermaid (`\`\`\`mermaid`) for all diagrams in `.md` files. The markdown renderer supports Mermaid natively.
- **Subagents** live in `.claude/agents/`; Codex skills in `.agents/skills/`
- **Playwright screenshots** go in `.codex/tmp/playwright-screenshots/` (gitignored)
- **Playwright visual audit required for UI changes** — any PR touching `apps/web/`, `packages/ui/`, or `packages/terminal/` must run Playwright visual tests with diverse mock data on mobile (375px) and desktop (1280px) viewports. See `.claude/rules/17-ui-visual-testing.md`.

## Agent Authentication

Claude Code supports dual authentication: **API keys** (pay-per-use from Anthropic Console) and **OAuth tokens** (from Claude Max/Pro subscriptions via `claude setup-token`). Users toggle between them in Settings. The system injects `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` based on active credential type.

## Testing

- **Test credentials** for the live app are at `/workspaces/.tmp/secure/demo-credentials.md` (outside repo)
- **Live test cleanup required**: delete test workspaces/nodes after verification
- **Staging verification required for every code PR** — see `.claude/rules/13-staging-verification.md`
- See `.claude/rules/02-quality-gates.md` for full testing requirements

## Bug Discovery During Testing

When you discover bugs or errors during testing — even if unrelated to your current task — file them as backlog tasks immediately so they don't get lost:

1. Create `tasks/backlog/YYYY-MM-DD-descriptive-name.md`
2. Include: Problem description, Context (where/when discovered), Acceptance Criteria checklist
3. Continue with your current work

## Troubleshooting

- **Build errors**: Run builds in dependency order (see Build Order above)
- **Test failures**: Check Miniflare bindings are configured in `vitest.config.ts`
- **Type errors**: Run `pnpm typecheck` from root to see all issues

## Task Tracking

Tasks tracked as markdown in `tasks/` (backlog -> active -> archive). See `tasks/README.md` for conventions.

**Dispatching tasks**: When dispatching tasks to other agents, always instruct them to use the `/do` skill. This ensures the receiving agent follows the full end-to-end workflow (research, implement, review, staging verify, PR). See `.claude/rules/09-task-tracking.md`.

## Strategy Planning

Strategic planning artifacts live in `strategy/` — see `strategy/README.md` for full structure.

| Domain | Directory | Skill | Key Artifacts |
|--------|-----------|-------|--------------|
| Competitive Research | `strategy/competitive/` | `/competitive-research` | Competitor profiles, feature matrix, positioning map, SWOT |
| Marketing | `strategy/marketing/` | `/marketing-strategy` | Positioning doc, messaging guide, content calendar, gap analysis |
| Business | `strategy/business/` | `/business-strategy` | Market sizing (TAM/SAM/SOM), pricing, business model, GTM plan |
| Engineering | `strategy/engineering/` | `/engineering-strategy` | Roadmap (Now/Next/Later), tech radar, tech debt register |
| Content | `strategy/content/` | `/content-create` | Social posts, blog drafts, changelogs, launch copy |

Domains chain together: competitive research feeds marketing and business strategy, which feed engineering priorities and content creation.

## Active Technologies
- TypeScript 5.x (API Worker) + @mastra/core (AI agent orchestration), workers-ai-provider (Vercel AI SDK bridge to Workers AI), Cloudflare Workers AI binding (llm-task-title-generation)
- TypeScript 5.x (Worker/Web), Go 1.24+ (VM Agent) + Hono (API framework), Drizzle ORM (D1), React + Vite (Web), Cloudflare Workers SDK (Durable Objects) (018-project-first-architecture)
- Cloudflare D1 (platform metadata) + Durable Objects with SQLite (per-project high-throughput data) + KV (ephemeral tokens) + R2 (agent binaries) (018-project-first-architecture)
- TypeScript 5.x (React 18 + Vite for web UI) + React 18, React Router 6, Vite, existing `@simple-agent-manager/ui` design system (019-ui-overhaul)
- N/A (frontend-only changes; backend APIs already exist from spec 018) (019-ui-overhaul)
- Go 1.24 (VM Agent) with log/slog structured logging, TypeScript 5.x (API Worker + Web UI) (020-node-observability)
- journald (systemd journal) on VM for log aggregation; Docker journald log driver; no new database storage (020-node-observability)
- TypeScript 5.x (API Worker, Web UI), Go 1.24+ (VM Agent) + Hono (API), React 18 + Vite (Web), Drizzle ORM (D1), Cloudflare Workers SDK (DOs), ACP Go SDK, cenkalti/backoff/v5 (new, Go retry) (021-task-chat-architecture)
- Cloudflare D1 (relational metadata), Durable Objects with SQLite (per-project chat data), VM-local SQLite (message outbox) (021-task-chat-architecture)
- TypeScript 5.x (API Worker + Web UI), Go 1.24+ (VM Agent) + Hono (API framework), Drizzle ORM (D1), React 18 + Vite (Web), Cloudflare Workers SDK (Durable Objects), `creack/pty` + `gorilla/websocket` (VM Agent) (022-simplified-chat-ux)
- TypeScript 5.x (API Worker + Web UI) + Hono (API), React 18 + Vite (Web), Drizzle ORM (D1), Cloudflare Workers SDK (Durable Objects, Tail Workers) (023-admin-observability)
- Cloudflare D1 (new `OBSERVABILITY_DATABASE` for errors) + existing D1 (`DATABASE` for health queries) + Cloudflare Workers Observability API (historical logs, 7-day retention) (023-admin-observability)
- TypeScript 5.x (React 18 + Vite 5) + Tailwind CSS v4, `@tailwindcss/vite` plugin, React 18, Vite 5, Lucide React (024-tailwind-adoption)
- N/A (no backend changes) (024-tailwind-adoption)
- TypeScript 5.x (React 18 + Vite) + React 18, `@simple-agent-manager/acp-client` (shared components), Tailwind CSS v4 (026-chat-message-parity)
- N/A (frontend-only changes; no database or API changes) (026-chat-message-parity)
- TypeScript 5.x (API Worker + Web UI), Go 1.24+ (VM Agent) + Hono (API), Drizzle ORM (D1), React 18 + Vite (Web), Cloudflare Workers SDK (Durable Objects), `creack/pty` + `gorilla/websocket` (VM Agent), ACP Go SDK (027-do-session-ownership)
- Cloudflare D1 (cross-project queries), Durable Objects with SQLite (per-project session data), VM-local SQLite (message outbox) (027-do-session-ownership)
- TypeScript 5.x (Cloudflare Workers runtime) + Hono (API framework), Drizzle ORM (D1), `@simple-agent-manager/shared`, `@simple-agent-manager/cloud-init` (028-provider-infrastructure)
- Cloudflare D1 (credentials table with AES-GCM encrypted tokens) (028-provider-infrastructure)

## Recent Changes
- file-browser-image-rendering: Image rendering in file browser — new `GET /workspaces/{id}/files/raw` endpoint on VM agent streams binary files with MIME detection (`mime.TypeByExtension`), ETag/304 support, and SVG Content-Security-Policy; API proxy route `GET /api/projects/:id/sessions/:sessionId/files/raw` with separate 25MB limit (FILE_RAW_PROXY_MAX_BYTES); `ImageViewer` component in `apps/web/src/components/shared-file-viewer/` with fit-to-panel/1:1 toggle, size guardrails (inline < 10MB, click-to-load < 25MB, download-only > 25MB); image detection via `isImageFile()` in `apps/web/src/lib/file-utils.ts`; integrated into both `FileViewerPanel` (workspace view) and `ChatFilePanel` (project chat); image icon in file browser listing; configurable via FILE_RAW_MAX_SIZE (default: 25MB), FILE_RAW_TIMEOUT (default: 30s), FILE_RAW_PROXY_MAX_BYTES (default: 25MB)
- file-browsing-diff-views-in-chat: Inline file viewer in project chat — four API proxy routes (`GET /api/projects/:id/sessions/:sessionId/files/list`, `files/view`, `git/status`, `git/diff`) resolve the session's workspace via D1 workspaces table, generate a terminal token, and proxy to VM agent; path sanitization via `normalizeProjectFilePath`; configurable via FILE_PROXY_TIMEOUT_MS (default: 15000), FILE_PROXY_MAX_RESPONSE_BYTES (default: 2097152); new `ChatFilePanel` slide-over component (browse/view/diff/git-status modes) accessed from session header "Files"/"Git" buttons and clickable file refs in `ToolCallCard`; shared `DiffRenderer` extracted to `apps/web/src/components/shared-file-viewer/` and reused by both `GitDiffView` (workspace view) and `ChatFilePanel` (chat view)
- global-persistent-audio-player: Global persistent TTS audio player — `GlobalAudioProvider` wraps the app above the router (`App.tsx`); `GlobalAudioPlayer` bar renders in `AppShell` (mobile: below main via flexbox, desktop: spanning full width via CSS Grid row 2); audio survives page navigation; three callers migrated from per-component `useAudioPlayback` to `useGlobalAudio` (`ProjectMessageView`, `TruncatedSummary`, `TaskDetail`); `MessageActions` and `MessageBubble` in `acp-client` accept new `onPlayAudio` callback prop to delegate to external player; new `--sam-z-player: 15` token added to design system; slide-in animation with `prefers-reduced-motion` support
- analytics-engine-phase4-forwarding: Analytics Engine Phase 4 — external event forwarding; daily cron job (`0 3 * * *`) queries Analytics Engine for key conversion events (signup, login, project_created, workspace_created, task_submitted) and batch-forwards them to Segment (Track API with Basic auth) and/or GA4 (Measurement Protocol); cursor-based deduplication via KV; new service `analytics-forward.ts` with `runAnalyticsForward()` orchestrator; admin dashboard `ForwardingStatus` card showing enabled state, last-forwarded timestamp, and destination configuration; `GET /api/admin/analytics/forward-status` endpoint; configurable via ANALYTICS_FORWARD_ENABLED (default: false), ANALYTICS_FORWARD_EVENTS, ANALYTICS_FORWARD_LOOKBACK_HOURS (default: 25), SEGMENT_WRITE_KEY, SEGMENT_API_URL, SEGMENT_MAX_BATCH_SIZE (default: 100), GA4_MEASUREMENT_ID, GA4_API_SECRET, GA4_API_URL, GA4_MAX_BATCH_SIZE (default: 25)
- analytics-engine-phase3-dashboards: Analytics Engine Phase 3 — dashboard visualizations for feature adoption (horizontal bars + sparklines for feature-event trends), geographic distribution (country-level user breakdown from CF headers), and weekly retention cohorts (heat-map cohort table with server-computed retention matrix); three new API endpoints (`/api/admin/analytics/feature-adoption`, `/geo`, `/retention`) using Cloudflare Analytics Engine SQL API; `AdminAnalytics.tsx` refactored from monolithic file to `admin-analytics/` directory with individual chart components; configurable via ANALYTICS_GEO_LIMIT (default: 50), ANALYTICS_RETENTION_WEEKS (default: 12)
- chat-idea-association: Many-to-many chat session ↔ idea (task) linking — `chat_session_ideas` junction table in ProjectData DO SQLite (migration 012); 4 MCP tools (`link_idea`, `unlink_idea`, `list_linked_ideas`, `find_related_ideas`) for agents to manage associations mid-conversation; REST endpoints `GET/POST /sessions/:id/ideas`, `DELETE /sessions/:id/ideas/:taskId`, `GET /tasks/:id/sessions` for UI; batch D1 enrichment with `inArray()`; shared `SessionIdeaLink` type; configurable via MCP_IDEA_CONTEXT_MAX_LENGTH (default: 500)
- message-materialization-fts5: Post-session message materialization + FTS5 full-text search — when a session stops, `materializeSession()` groups raw streaming tokens into `chat_messages_grouped` and populates `chat_messages_grouped_fts` FTS5 virtual table; `searchMessages()` uses FTS5 MATCH for materialized sessions with LIKE fallback for active sessions; `materializeAllStopped()` backfills existing data; migration 011 adds tables + `materialized_at` column; configurable via MCP_MESSAGE_SEARCH_MAX (default: 20)
- token-message-concatenation: MCP `get_session_messages` now groups consecutive streaming tokens (assistant, tool, thinking roles) into logical messages via `groupTokensIntoMessages()` before returning to agents; configurable via MCP_MESSAGE_LIST_LIMIT (default: 50), MCP_MESSAGE_LIST_MAX (default: 200)
- notification-system-phase2: Agent-initiated notifications — `request_human_input` MCP tool for agents to signal when blocked/need decisions (high-urgency needs_input notification); progress notification emission from `update_task_status` with batching (one per task per 5 min window); session_ended notification on conversation-mode `complete_task` remap; task_complete deduplication (60s window); notification grouping by project in NotificationCenter UI; configurable via NOTIFICATION_PROGRESS_BATCH_WINDOW_MS, NOTIFICATION_MIN_SESSION_DURATION_MS, NOTIFICATION_DEDUP_WINDOW_MS
- 027-do-session-ownership: DO-owned ACP session lifecycle — shifts session state machine (pending→assigned→running→completed/failed/interrupted) from VM agent in-memory maps to ProjectData DO SQLite; heartbeat-based VM failure detection via DO alarm; session forking with lineage tracking; workspace-project binding enforcement; configurable via ACP_SESSION_DETECTION_WINDOW_MS, ACP_SESSION_MAX_FORK_DEPTH
- codex-oauth-token-sync: Post-session credential sync-back for file-based agent credentials (e.g., codex-acp auth.json); reads updated auth file from container after session ends via `syncCredentialOnStop()`, sends to API via `POST /api/workspaces/:id/agent-credential-sync` with callbackretry; re-encrypts with fresh AES-GCM IV on change; guards: injectionMode=auth-file + CredentialSyncer configured; best-effort (errors logged, teardown not blocked)
- llm-task-title-generation: AI-powered task title generation via Cloudflare Workers AI (Mastra + workers-ai-provider + @cf/meta/llama-3.1-8b-instruct); generates concise titles (≤100 chars) from full message text at task submit time; falls back to truncation on failure or timeout; short messages (≤100 chars) bypass AI; configurable via TASK_TITLE_MODEL, TASK_TITLE_MAX_LENGTH, TASK_TITLE_TIMEOUT_MS, TASK_TITLE_GENERATION_ENABLED, TASK_TITLE_SHORT_MESSAGE_THRESHOLD
- fix-streaming-token-ordering: ACP notification serialization via orderedPipe in VM agent; wraps agent stdout with a serializing pipe that waits for each session/update handler to complete before delivering the next, preventing the ACP SDK's concurrent goroutine dispatch from reordering streaming tokens; configurable via `ACP_NOTIF_SERIALIZE_TIMEOUT` (default: 5s)
- 023-admin-observability: Admin observability dashboard — error storage in D1, health overview, error list with filtering, historical log viewer via CF API proxy, real-time log stream via AdminLogs DO + Tail Worker, error trends visualization
- 022-simplified-chat-ux: Chat-first UX — project page is now a chat interface (no tabs), dashboard shows project cards, descriptive branch naming (sam/...), idle auto-push safety net (15 min DO alarm), settings drawer, agent completion git push + PR creation, gh CLI injection + token refresh wrapper, finalization guard for idempotent git push results
- 021-task-chat-architecture: Task-driven chat with autonomous workspace execution, warm node pooling, project chat view, kanban board, task submit form, project default VM size
- 018-project-first-architecture: Added TypeScript 5.x (Worker/Web), Go 1.24+ (VM Agent) + Hono (API framework), Drizzle ORM (D1), React + Vite (Web), Cloudflare Workers SDK (Durable Objects)
