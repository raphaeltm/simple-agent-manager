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
└── vm-agent/     # Go VM agent (PTY, WebSocket, ACP, MCP tool endpoints)
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

| Surface                 | Directory   | Domain                         | Stack             | What it is                                            |
| ----------------------- | ----------- | ------------------------------ | ----------------- | ----------------------------------------------------- |
| **Marketing website**   | `apps/www/` | `simple-agent-manager.org`     | Astro + Starlight | Public website, landing pages, blog, docs             |
| **App (control plane)** | `apps/web/` | `app.simple-agent-manager.org` | React + Vite      | Authenticated SaaS UI (dashboard, projects, settings) |

When the user mentions **website, marketing, landing page, blog, docs site, or public pages** → look in `apps/www/`.
When the user mentions **app, dashboard, projects, settings, or UI** → look in `apps/web/`.

## Development Approach

**Local-first, Cloudflare-integrated.** Prove as much of a feature as you can locally before touching staging. Local iteration takes seconds; staging iteration takes minutes and burns VM quota. Staging is for things that genuinely require real infrastructure (OAuth callbacks, DNS, VM provisioning, edge TLS) — not for discovering whether your code compiles.

1. **Prototype and test locally first** — unit tests, Miniflare integration tests, local Vite dev server, Playwright visual audits. Hybrid loops (local UI against staging API, or local API against staging VM agent) are encouraged. See `.claude/rules/29-local-first-debugging.md`.
2. **Deploy to staging only when local verification is exhausted** — when the remaining work genuinely needs real OAuth, DNS, or VMs. Partial-feature staging deploys are fine for end-to-end plumbing while the rest is still developed locally. Staging deploys take ~7 minutes via `gh workflow run deploy-staging.yml`.
3. **Query staging directly via Cloudflare API** — use `$CF_TOKEN` to query D1 (SQL), read/write KV, check DNS records, and inspect Workers. This is the fastest way to verify deploys, debug issues, and understand staging state. **Always check infrastructure state via CF API before guessing at fixes.** See `.claude/rules/32-cf-api-debugging.md` for the full cheat sheet.
4. **When something fails on staging, QUERY THEN READ LOGS before changing any code** — first query D1/KV/DNS via CF API to understand the data state, then use `wrangler tail`, `/admin/logs`, `/admin/errors`, the Node detail page's log stream, `journalctl -u vm-agent` via SSH, `docker logs` for containers. Never guess-and-redeploy. See `.claude/rules/29-local-first-debugging.md` for the log location matrix.
5. Merge to main — triggers production deployment.

Full local-development guide: `docs/guides/local-development.md`.

## Deployment

Merge to `main` automatically deploys to production via GitHub Actions.

- **CI** (`ci.yml`): lint, typecheck, test, build on all pushes/PRs
- **Deploy Staging** (`deploy-staging.yml`): manual trigger only (`workflow_dispatch`) — agents trigger this explicitly during `/do` Phase 6
- **Deploy Production** (`deploy.yml`): full Pulumi + Wrangler deployment on push to main
- **Teardown** (`teardown.yml`): manual only — destroys all resources

### Staging Deployment is a Merge Gate

Staging deployment is manual — triggered via `gh workflow run deploy-staging.yml --ref <branch>`. Agents executing the `/do` workflow MUST deploy to staging and verify the live app before merging. A failed staging deploy blocks merge just like a failed test. Before triggering a deployment, check for existing active runs and wait at least 5 minutes if one is in progress. If the deploy fails due to missing secrets or configuration (not code), **alert the user immediately** — do not skip verification. See `.claude/rules/13-staging-verification.md`.

### HARD GATE: Features Must Work End-to-End on Staging (NEVER SHIP BROKEN FEATURES)

Staging verification means the feature WORKS — not that pages load, not that config endpoints respond, not that the UI renders. The actual feature, exercised as an end user would, must complete successfully with ZERO errors. If the feature errors on staging for ANY reason (missing binding, wrong toolchain version, unconfigured service), **do NOT merge — alert the user immediately.** Never rationalize a staging error as "expected." See `.claude/rules/30-never-ship-broken-features.md`.

### Post-Merge Production Deploy Monitoring (MANDATORY)

After merging ANY PR to main, agents MUST monitor the Deploy Production workflow to completion. If the deploy fails, **alert the user immediately** with the failure reason and whether it requires human intervention. Do NOT silently finish the task when the deploy fails — a merged PR is not shipped until the deploy succeeds. See the `/do` workflow Phase 7b for the full procedure.

### Data Integrity Safeguards (CRITICAL)

Production data loss is catastrophic and irreversible. Multiple deterministic gates prevent it:

| Gate | Runs in | What it catches |
|------|---------|----------------|
| `pnpm quality:migration-safety` | CI (every PR) | DROP TABLE on CASCADE parents, DELETE without WHERE, PRAGMA foreign_keys=OFF, UPDATE without WHERE, any DROP TABLE in new migrations |
| `pnpm quality:do-migration-safety` | CI (every PR) | DROP TABLE, DELETE without WHERE, UPDATE without WHERE in Durable Object SQLite migrations (no recovery mechanism) |
| Pre-migration D1 backup | Deploy pipeline | Creates time-travel bookmark + explicit backup before every migration run |
| Post-migration row count verification | Deploy pipeline | Compares row counts before/after migrations; **blocks deploy** if >50% data loss detected in any table |
| D1 Time Travel Restore | Manual workflow | Point-in-time recovery for D1 databases (30-day window). See `d1-restore.yml` |

**Migration rules:** See `.claude/rules/31-migration-safety.md`. NEVER use `DROP TABLE` on any table with CASCADE children. Use `ALTER TABLE ADD COLUMN` instead of table recreation.

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

## Env Var Naming: GH* vs GITHUB*

GitHub Actions secret names cannot start with `GITHUB_*`, so GitHub App secrets use `GH_*` prefix. The deployment script (`configure-secrets.sh`) maps them to `GITHUB_*` Worker secrets.

| Context               | Prefix    | Example            |
| --------------------- | --------- | ------------------ |
| GitHub Environment    | `GH_`     | `GH_CLIENT_ID`     |
| Worker runtime / .env | `GITHUB_` | `GITHUB_CLIENT_ID` |

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
- **No duplicate UI controls** — before adding any new settings control or form field, search for existing controls managing the same API field. Consolidate into one canonical location. See `.claude/rules/24-no-duplicate-ui-controls.md`.

## Agent Authentication

Claude Code supports dual authentication: **API keys** (pay-per-use from Anthropic Console) and **OAuth tokens** (from Claude Max/Pro subscriptions via `claude setup-token`). Users toggle between them in Settings. The system injects `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` based on active credential type.

## Testing

- **Staging authentication**: Use the smoke test token in `SAM_PLAYWRIGHT_PRIMARY_USER` env var. POST it to `https://api.sammy.party/api/auth/token-login` with body `{ "token": "<value>" }` to get a session cookie, then navigate to `https://app.sammy.party`. See `.claude/rules/13-staging-verification.md` for full procedure.
- **Production authentication**: Use GitHub OAuth credentials at `/workspaces/.tmp/secure/demo-credentials.md` (outside repo)
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
- **Staging issues**: Query staging state directly via `$CF_TOKEN` and the Cloudflare API — D1 SQL queries, KV reads, DNS checks. See `.claude/rules/32-cf-api-debugging.md` for copy-paste commands. **Always query before guessing.**

## Task Tracking

Tasks tracked as markdown in `tasks/` (backlog -> active -> archive). See `tasks/README.md` for conventions.

**Dispatching tasks**: When dispatching tasks to other agents, always instruct them to use the `/do` skill. This ensures the receiving agent follows the full end-to-end workflow (research, implement, review, staging verify, PR). See `.claude/rules/09-task-tracking.md`.

## Strategy Planning

Strategic planning artifacts live in `strategy/` — see `strategy/README.md` for full structure.

| Domain               | Directory               | Skill                   | Key Artifacts                                                    |
| -------------------- | ----------------------- | ----------------------- | ---------------------------------------------------------------- |
| Competitive Research | `strategy/competitive/` | `/competitive-research` | Competitor profiles, feature matrix, positioning map, SWOT       |
| Marketing            | `strategy/marketing/`   | `/marketing-strategy`   | Positioning doc, messaging guide, content calendar, gap analysis |
| Business             | `strategy/business/`    | `/business-strategy`    | Market sizing (TAM/SAM/SOM), pricing, business model, GTM plan   |
| Engineering          | `strategy/engineering/` | `/engineering-strategy` | Roadmap (Now/Next/Later), tech radar, tech debt register         |
| Content              | `strategy/content/`     | `/content-create`       | Social posts, blog drafts, changelogs, launch copy               |

Domains chain together: competitive research feeds marketing and business strategy, which feed engineering priorities and content creation.

## Active Technologies

- TypeScript 5.x (API Worker) + @mastra/core (AI agent orchestration), workers-ai-provider (Vercel AI SDK bridge to Workers AI), Cloudflare Workers AI binding (llm-task-title-generation)
- TypeScript 5.x (Worker/Web), Go 1.24+ (VM Agent) + Hono (API framework), Drizzle ORM (D1), React + Vite (Web), Cloudflare Workers SDK (Durable Objects) (018-project-first-architecture)
- Cloudflare D1 (platform metadata) + Durable Objects with SQLite (per-project high-throughput data) + KV (ephemeral tokens) + R2 (agent binaries) (018-project-first-architecture)
- TypeScript 5.x (React 19 + Vite for web UI) + React 19, React Router 7, Vite, existing `@simple-agent-manager/ui` design system (019-ui-overhaul)
- N/A (frontend-only changes; backend APIs already exist from spec 018) (019-ui-overhaul)
- Go 1.24 (VM Agent) with log/slog structured logging, TypeScript 5.x (API Worker + Web UI) (020-node-observability)
- journald (systemd journal) on VM for log aggregation; Docker journald log driver; no new database storage (020-node-observability)
- TypeScript 5.x (API Worker, Web UI), Go 1.24+ (VM Agent) + Hono (API), React 19 + Vite (Web), Drizzle ORM (D1), Cloudflare Workers SDK (DOs), ACP Go SDK, cenkalti/backoff/v5 (new, Go retry) (021-task-chat-architecture)
- Cloudflare D1 (relational metadata), Durable Objects with SQLite (per-project chat data), VM-local SQLite (message outbox) (021-task-chat-architecture)
- TypeScript 5.x (API Worker + Web UI), Go 1.24+ (VM Agent) + Hono (API framework), Drizzle ORM (D1), React 19 + Vite (Web), Cloudflare Workers SDK (Durable Objects), `creack/pty` + `gorilla/websocket` (VM Agent) (022-simplified-chat-ux)
- TypeScript 5.x (API Worker + Web UI) + Hono (API), React 19 + Vite (Web), Drizzle ORM (D1), Cloudflare Workers SDK (Durable Objects, Tail Workers) (023-admin-observability)
- Cloudflare D1 (new `OBSERVABILITY_DATABASE` for errors) + existing D1 (`DATABASE` for health queries) + Cloudflare Workers Observability API (historical logs, 7-day retention) (023-admin-observability)
- TypeScript 5.x (React 19 + Vite 5) + Tailwind CSS v4, `@tailwindcss/vite` plugin, React 19, Vite 5, Lucide React (024-tailwind-adoption)
- N/A (no backend changes) (024-tailwind-adoption)
- TypeScript 5.x (React 19 + Vite) + React 19, `@simple-agent-manager/acp-client` (shared components), Tailwind CSS v4 (026-chat-message-parity)
- N/A (frontend-only changes; no database or API changes) (026-chat-message-parity)
- TypeScript 5.x (API Worker + Web UI), Go 1.24+ (VM Agent) + Hono (API), Drizzle ORM (D1), React 19 + Vite (Web), Cloudflare Workers SDK (Durable Objects), `creack/pty` + `gorilla/websocket` (VM Agent), ACP Go SDK (027-do-session-ownership)
- Cloudflare D1 (cross-project queries), Durable Objects with SQLite (per-project session data), VM-local SQLite (message outbox) (027-do-session-ownership)
- TypeScript 5.x (Cloudflare Workers runtime) + Hono (API framework), Drizzle ORM (D1), `@simple-agent-manager/shared`, `@simple-agent-manager/cloud-init` (028-provider-infrastructure)
- Cloudflare D1 (credentials table with AES-GCM encrypted tokens) (028-provider-infrastructure)

## Recent Changes

- sam-agent-phase-a-tools: SAM Phase A orchestration tools — 4 new tools in `apps/api/src/durable-objects/sam-session/tools/` transform SAM from read-only to functional orchestrator: `dispatch_task` (provisions workspace, runs agent, resolves config via explicit→profile→project→platform chain, reuses `startTaskRunnerDO`, `generateBranchName`, `generateTaskTitle`, `resolveAgentProfile`, `resolveCredentialSource`, `projectDataService.createSession/persistMessage`), `get_task_details` (full task details with output/PR/error via D1 tasks+projects join), `create_mission` (D1 insert + ProjectOrchestrator DO registration, per-project limit enforcement), `get_mission` (mission status with task summary counts and individual task list via projects join for ownership); all tools registered in `tools/index.ts` SAM_TOOLS array and toolHandlers map; SAM_SYSTEM_PROMPT updated with Observation and Action tool categories; `dispatch_task` accepts optional `missionId` for mission-task association; configurable via SAM_DISPATCH_MAX_DESCRIPTION_LENGTH (default: 32000)
- sam-conversation-persistence-phase1: SAM conversation persistence and FTS5 search — SamSession DO migration 003 adds `type`, `linked_session_id`, `linked_project_id` columns to conversations table (ALTER TABLE ADD COLUMN, no DROP TABLE) and `messages_fts` FTS5 virtual table (external content, unicode61 tokenizer) with backfill; `searchMessages()` two-tier strategy (FTS5 MATCH first, LIKE fallback with de-duplication); `search_conversation_history` tool for SAM agent to query past conversations; frontend (`SamPrototype.tsx`) loads persisted human conversation on mount with message mapping (assistant→sam, tool_result attachment); `GET /search` endpoint on SamSession DO; `GET /conversations` accepts `type` query filter; `GET /conversations/:id/messages` accepts `limit` param with `SAM_HISTORY_LOAD_LIMIT` default; FTS5 sync in `persistMessage()` (non-fatal try/catch) and cleanup on conversation eviction; configurable via SAM_FTS_ENABLED (default: true), SAM_SEARCH_LIMIT (default: 10), SAM_SEARCH_MAX_LIMIT (default: 50), SAM_HISTORY_LOAD_LIMIT (default: 200)
- policy-propagation-phase4: Policy Propagation system (Phase 4 orchestration) — `project_policies` table in ProjectData DO SQLite (migration 019) with category (rule/constraint/delegation/preference), title, content, source (explicit/inferred), sourceSessionId, confidence, active fields; 5 MCP tools (`add_policy`, `list_policies`, `get_policy`, `update_policy`, `remove_policy`) in `apps/api/src/routes/mcp/policy-tools.ts` with tool definitions in `tool-definitions-policy-tools.ts`; policy injection into `get_instructions` MCP response via `formatPolicyDirectives()` (readable text grouped by category with "PROJECT POLICY" headers) and `buildPolicyInstructions()` (agent instructions for policy usage); policy propagation via `dispatch_task` — when dispatching within a mission, active policies are appended to child task descriptions as "## Project Policies (inherited)" section; REST API at `/api/projects/:projectId/policies` (GET list with category filter and pagination, GET /:id, POST create, PATCH /:id update, DELETE /:id soft-delete) guarded by `requireOwnedProject`; service layer in `apps/api/src/services/project-data.ts` (createPolicy, getPolicy, listPolicies, updatePolicy, removePolicy, getActivePolicies); shared types in `packages/shared/src/types/policy.ts` (`ProjectPolicy`, `CreatePolicyRequest`, `UpdatePolicyRequest`, `ListPoliciesResponse`, `isPolicyCategory`, `isPolicySource`); configurable limits in `packages/shared/src/constants/policies.ts` via `resolvePolicyLimits(env)`: POLICY_MAX_PER_PROJECT (default: 100), POLICY_TITLE_MAX_LENGTH (default: 200), POLICY_CONTENT_MAX_LENGTH (default: 2000), POLICY_LIST_PAGE_SIZE (default: 50), POLICY_LIST_MAX_PAGE_SIZE (default: 200), POLICY_DEFAULT_CONFIDENCE (default: 0.8)
- project-orchestrator-phase3: Per-project ProjectOrchestrator Durable Object (Phase 3 orchestration) — alarm-driven scheduling loop (default 30s) watches active missions, routes handoff packets from completed tasks to dependents via `enqueueMailboxMessage()` with `deliver` class, detects stalled tasks (configurable timeout, default 20min) and sends `interrupt` messages, manages mission lifecycle (pause/resume/cancel); internal SQLite tables (`orchestrator_missions`, `scheduling_queue`, `decision_log`) with idempotent migration; 6 MCP tools (`get_orchestrator_status`, `get_scheduling_queue`, `pause_mission`, `resume_mission`, `cancel_mission`, `override_task_state`) in `apps/api/src/routes/mcp/orchestrator-lifecycle-tools.ts`; REST API at `/api/projects/:projectId/orchestrator/*` (status, queue, mission pause/resume/cancel, task state override); service layer in `apps/api/src/services/project-orchestrator.ts`; integration hooks: `create_mission` auto-registers with orchestrator, `complete_task` triggers immediate scheduling cycle via `notifyTaskEvent()`; wrangler binding `PROJECT_ORCHESTRATOR` with migration v10; configurable via ORCHESTRATOR_SCHEDULING_INTERVAL_MS (default: 30000), ORCHESTRATOR_STALL_TIMEOUT_MS (default: 1200000), ORCHESTRATOR_MAX_DISPATCHES_PER_CYCLE (default: 5), ORCHESTRATOR_MAX_ACTIVE_TASKS_PER_MISSION (default: 5), ORCHESTRATOR_DECISION_LOG_MAX_ENTRIES (default: 500), ORCHESTRATOR_RECENT_DECISIONS_LIMIT (default: 20), ORCHESTRATOR_QUEUE_MAX_ENTRIES (default: 100)
- durable-interrupts-phase1: Durable messaging layer for orchestration — 5 message classes (notify, deliver, interrupt, preempt_and_replan, shutdown_with_final_prompt) with urgency-based priority ordering; delivery state machine (queued → delivered → acked → expired) with DELIVERY_STATE_TRANSITIONS map enforcing valid transitions; DO alarm-based delivery sweep for retry/re-delivery integrated into recalculateAlarm(); 3 MCP tools (send_durable_message, get_pending_messages, ack_message) in `apps/api/src/routes/mcp/mailbox-tools.ts`; REST API at `/api/projects/:projectId/mailbox` for message inspection (list with filters, stats, get, cancel); backwards-compatible upgrade of send_message_to_subtask to queue notify-class messages on agent_busy; migration 017-agent-mailbox extends session_inbox via ALTER TABLE ADD COLUMN (no DROP TABLE); configurable via MAILBOX_ACK_TIMEOUT_MS (default: 300000), MAILBOX_REDELIVERY_MAX_ATTEMPTS (default: 5), MAILBOX_TTL_MS (default: 3600000), MAILBOX_DELIVERY_POLL_INTERVAL_MS (default: 30000), MAILBOX_MAX_MESSAGES_PER_PROJECT (default: 1000), MAILBOX_MESSAGE_MAX_LENGTH (default: 32768)
- mission-state-handoff-packets: Phase 2 orchestration primitives — `missions` D1 table (migration 0048) with project/user FKs, status, budget_config; `mission_id` and `scheduler_state` nullable columns on tasks (ALTER TABLE ADD COLUMN); ProjectData DO migration 018 adds `mission_state_entries` and `handoff_packets` tables for per-project high-write storage; 8 MCP tools (`create_mission`, `get_mission`, `add_mission_state`, `get_mission_state`, `update_mission_state`, `delete_mission_state`, `create_handoff`, `get_handoffs`); `dispatch_task` upgraded with `missionId` parameter and parent inheritance; REST API at `/api/projects/:projectId/missions/*` (list, detail, state entries, handoff packets); `computeSchedulerStates()` pure function derives scheduler state from dependency graph (11 states: schedulable, blocked_dependency, blocked_budget, blocked_resource, blocked_human, waiting_delivery, stalled, running, completed, failed, cancelled); shared types in `packages/shared/src/types/mission.ts` and constants in `packages/shared/src/constants/missions.ts`; configurable via MISSION_MAX_PER_PROJECT (default: 50), MISSION_MAX_STATE_ENTRIES (default: 200), MISSION_MAX_HANDOFFS (default: 100), MISSION_TITLE_MAX_LENGTH (default: 200), MISSION_DESCRIPTION_MAX_LENGTH (default: 5000), MISSION_STATE_TITLE_MAX_LENGTH (default: 200), MISSION_STATE_CONTENT_MAX_LENGTH (default: 2000), HANDOFF_SUMMARY_MAX_LENGTH (default: 5000), HANDOFF_MAX_FACTS (default: 50), HANDOFF_MAX_OPEN_QUESTIONS (default: 20), HANDOFF_MAX_ARTIFACT_REFS (default: 30), HANDOFF_MAX_SUGGESTED_ACTIONS (default: 20), MISSION_LIST_PAGE_SIZE (default: 20), MISSION_LIST_MAX_PAGE_SIZE (default: 100)
- ai-proxy-gateway: AI inference proxy routes LLM requests through Cloudflare AI Gateway — `POST /ai/v1/chat/completions` accepts OpenAI-format requests, transparently routes to Workers AI (@cf/_ models) or Anthropic (claude-_ models) with format translation (`ai-anthropic-translate.ts`); per-user RPM rate limiting + daily token budget via KV; admin model picker at `/admin/ai-proxy`; AI usage analytics dashboard at `/admin/analytics/ai-usage` aggregates AI Gateway logs by model, day, cost; configurable via AI_PROXY_ENABLED, AI_PROXY_DEFAULT_MODEL, AI_GATEWAY_ID, AI_PROXY_ALLOWED_MODELS, AI_PROXY_RATE_LIMIT_RPM, AI_PROXY_RATE_LIMIT_WINDOW_SECONDS, AI_PROXY_MAX_INPUT_TOKENS_PER_REQUEST, AI_USAGE_PAGE_SIZE, AI_USAGE_MAX_PAGES
- trial-agent-boot: TrialOrchestrator `discovery_agent_start` step now runs the full 5-step idempotent VM boot (registers agent session via `createAgentSessionOnNode`, mints MCP token with trialId as synthetic taskId, `startAgentSessionOnNode` with discovery prompt + MCP server URL, drives ACP session `pending → assigned → running`; idempotency flags `mcpToken`, `agentSessionCreatedOnVm`, `agentStartedOnVm`, `acpAssignedOnVm`, `acpRunningOnVm` on DO state let crash/retry resume without double-booking); new `fetchDefaultBranch()` probes GitHub `/repos/:owner/:repo` with AbortController-bounded fetch and threads the real default branch through `projects.defaultBranch` + workspace `git clone --branch` (master-default repos like `octocat/Hello-World` now work); configurable via TRIAL_GITHUB_TIMEOUT_MS (default: 5000); new capability test `apps/api/tests/unit/durable-objects/trial-orchestrator-agent-boot.test.ts` asserts every cross-boundary call fires with correct payload; rule 10 updated with port-of-pattern coverage requirement. See `docs/notes/2026-04-19-trial-orchestrator-agent-boot-postmortem.md`.
- trial-sse-events-fix: Fixed "zero trial.\* events on staging" — `formatSse()` in `apps/api/src/routes/trial/events.ts` previously emitted named SSE frames (`event: trial.knowledge\ndata: {...}`), but the frontend subscribes via `source.onmessage` which only fires for the default (unnamed) event; frames arrived on the wire (curl saw them) but browser EventSource silently dropped them. Now emits unnamed `data: {JSON}\n\n` frames; the `TrialEvent` payload's own `type` discriminator preserves dispatch info. Also fixed `eventsUrl` in `apps/api/src/routes/trial/create.ts` response shape mismatch (`/api/trial/events?trialId=X` → `/api/trial/:trialId/events`). New capability test `apps/api/tests/workers/trial-event-bus-sse.test.ts` asserts no `event:` line + JSON round-trip across the TrialEventBus DO → SSE endpoint boundary; unit tests updated to assert new unnamed-frame contract and exact `eventsUrl` shape (no substring matches on URL contracts). Rule 13 updated to ban curl-only verification of browser-consumed SSE/WebSocket streams — curl confirms bytes, browsers confirm dispatch. See `docs/notes/2026-04-19-trial-sse-named-events-postmortem.md`.
- trial-orchestrator-wire-up: TrialOrchestrator Durable Object + GitHub-API knowledge fast-path — `POST /api/trial/create` now fire-and-forget dispatches two concurrent `c.executionCtx.waitUntil` tasks: (1) `env.TRIAL_ORCHESTRATOR.idFromName(trialId)` DO state machine (alarm-driven, steps: project_creation → node_provisioning → workspace_creation → workspace_ready → agent_session → completed; idempotent `start()`; terminal guard on completed/failed; overall-timeout emits `trial.error`); (2) `emitGithubKnowledgeEvents()` probe hits unauthenticated `/repos/:o/:n`, `/repos/:o/:n/languages`, `/repos/:o/:n/readme` in parallel with AbortController-bounded fetches, emits up to `TRIAL_KNOWLEDGE_MAX_EVENTS` `trial.knowledge` events (description, primary language, stars, topics, license, language breakdown by bytes, README first paragraph), swallows all errors; `apps/api/src/services/trial/bridge.ts` bridges ACP session transitions (`running` → `trial.ready`, `failed` → `trial.error`) and MCP tool calls (`add_knowledge` → `trial.knowledge`, `create_idea` → `trial.idea`) into the SSE stream via `readTrialByProject()` KV lookup (no-op on non-trial projects); new sentinel `TRIAL_ANONYMOUS_INSTALLATION_ID` row in `github_installations` so trial projects satisfy the FK; configurable via TRIAL_ORCHESTRATOR_OVERALL_TIMEOUT_MS (default: 300000), TRIAL_ORCHESTRATOR_STEP_MAX_RETRIES (default: 5), TRIAL_ORCHESTRATOR_RETRY_BASE_DELAY_MS (default: 1000), TRIAL_ORCHESTRATOR_RETRY_MAX_DELAY_MS (default: 60000), TRIAL_ORCHESTRATOR_NODE_READY_TIMEOUT_MS (default: 180000), TRIAL_ORCHESTRATOR_AGENT_READY_TIMEOUT_MS (default: 60000), TRIAL_ORCHESTRATOR_WORKSPACE_READY_TIMEOUT_MS (default: 180000), TRIAL_ORCHESTRATOR_WORKSPACE_READY_POLL_INTERVAL_MS (default: 5000), TRIAL_VM_SIZE (default: DEFAULT_VM_SIZE), TRIAL_VM_LOCATION (default: DEFAULT_VM_LOCATION), TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS (default: 5000), TRIAL_KNOWLEDGE_MAX_EVENTS (default: 10)
- project-credential-overrides: Per-project agent credential overrides — `credentials.project_id` column (migration 0042, nullable FK to `projects.id ON DELETE CASCADE`) with two partial unique indexes (`WHERE project_id IS NULL` for user-scoped, `WHERE project_id IS NOT NULL` for project-scoped); `getDecryptedAgentKey(db, userId, agentType, key, projectId?)` resolves project → user → platform in order; workspace runtime callback forwards `workspace.projectId`; `CodexRefreshLock` DO preserves scope on OAuth token rotation; new `/api/projects/:id/credentials` routes (GET/PUT/DELETE) guarded by `requireOwnedProject` (404 on cross-user); `ProjectAgentsSection` on Project Settings combines credential override and model/permission override per agent using `AgentKeyCard` (scope='project') with inheritance hints; cross-user writes rejected at query layer AND ownership check; `autoActivate` only affects project-scoped rows (user-scoped untouched)
- project-knowledge-graph: Per-project knowledge graph for persistent agent memory — `knowledge_entities`, `knowledge_observations`, `knowledge_relations` tables + FTS5 virtual table in ProjectData DO SQLite (migration 016); entity-observation-relation model with confidence scoring and recency weighting; 11 MCP tools (`add_knowledge`, `update_knowledge`, `remove_knowledge`, `get_knowledge`, `search_knowledge`, `get_project_knowledge`, `get_relevant_knowledge`, `relate_knowledge`, `get_related`, `confirm_knowledge`, `flag_contradiction`) in `apps/api/src/routes/mcp/knowledge-tools.ts`; auto-retrieval of relevant knowledge in `get_instructions` MCP tool; REST API at `/api/projects/:projectId/knowledge/*` for UI CRUD; Knowledge Browser page at `/projects/:id/knowledge` with entity list, search, type filters, detail panel; configurable via KNOWLEDGE_AUTO_RETRIEVE_LIMIT (default: 20), KNOWLEDGE_MAX_ENTITIES_PER_PROJECT (default: 500), KNOWLEDGE_MAX_OBSERVATIONS_PER_ENTITY (default: 100), KNOWLEDGE_SEARCH_LIMIT (default: 20), KNOWLEDGE_SEARCH_MAX_LIMIT (default: 100), KNOWLEDGE_LIST_PAGE_SIZE (default: 50), KNOWLEDGE_LIST_MAX_PAGE_SIZE (default: 200), KNOWLEDGE_OBSERVATION_MAX_LENGTH (default: 1000)
- dispatch-task-config-parity: Full task execution config parity for `dispatch_task` MCP tool — extended schema accepts optional `agentProfileId`, `taskMode` (task/conversation), `agentType`, `workspaceProfile` (default/lightweight), `provider` (hetzner/scaleway/gcp), `vmLocation`; config precedence matches normal submit path: explicit field → agent profile → project default → platform default; `resolveAgentProfile()` from `agent-profiles.ts` resolves profiles by ID or name with built-in seeding; profile-derived values (`model`, `permissionMode`, `systemPromptAppend`) passed through to `startTaskRunnerDO()`; `agentProfileHint` and `taskMode` persisted in task INSERT for observability; location validated against resolved provider; `maxTurns`/`timeoutMinutes` excluded — not enforced by runtime (documented in task file)
- project-file-library-mcp-tools: 4 MCP tools for project file library — `list_library_files` (browse with tag/type/source filters, configurable sort and limit), `download_library_file` (decrypt from R2 and transfer to workspace via VM agent, configurable target directory), `upload_to_library` (read from workspace via VM agent, encrypt and store with agent source/tags, returns FILE_EXISTS with metadata on duplicate filename), `replace_library_file` (download new content from workspace, replace via service, additive tag merge, returns FILE_NOT_FOUND for invalid fileId); handlers in `apps/api/src/routes/mcp/library-tools.ts`; path traversal validation on targetPath; error message sanitization; Authorization Bearer header for server-to-server VM agent calls; configurable via LIBRARY_MCP_DOWNLOAD_DIR (default: .library), LIBRARY_MCP_TRANSFER_TIMEOUT_MS (default: 60000), LIBRARY_UPLOAD_MAX_BYTES (default: 50MB)
- strengthen-eslint-configuration: Strengthened ESLint with `eslint-plugin-jsx-a11y` (accessibility warnings for `.tsx`), `eslint-plugin-simple-import-sort` (import ordering as errors — CI-breaking), `@typescript-eslint/consistent-type-imports` (enforces `import type` syntax as errors — auto-fixable), `@typescript-eslint/no-non-null-assertion` (warning); 645 files auto-fixed for import ordering and type imports; a11y rules start as warnings for incremental adoption; `no-console` enforcement for API code (from PR #581) remains in place
- neko-browser-streaming-sidecar: Neko remote browser sidecar for workspaces — VM agent `internal/browser/` package manages Neko container lifecycle (start/stop/status) per workspace, Docker network attachment, and socat port forwarders syncing DevContainer ports via `/proc/net/tcp` polling; 4 HTTP endpoints (`POST/GET/DELETE /workspaces/{id}/browser`, `GET /workspaces/{id}/browser/ports`); API Worker proxy routes at both project-session level (`/projects/:id/sessions/:sessionId/browser`) and workspace level (`/workspaces/:id/browser`); cloud-init optional Neko image pre-pull (`nekoImage`, `nekoPrePull` variables); `BrowserSidecar` React component with workspace/session dual-mode, mobile viewport detection, Neko iframe embed; `useBrowserSidecar` hook with auto-polling; integrated into `WorkspaceSidebar` collapsible section; configurable via NEKO_IMAGE (default: ghcr.io/m1k1o/neko/google-chrome:latest), NEKO_SCREEN_RESOLUTION (default: 1920x1080), NEKO_MAX_FPS (default: 30), NEKO_WEBRTC_PORT (default: 6080), NEKO_SOCAT_POLL_INTERVAL (default: 5s), NEKO_MIN_RAM_MB (default: 2048), NEKO_ENABLE_AUDIO (default: true), NEKO_TCP_FALLBACK (default: true), NEKO_MUX_PORT (default: 59000), NEKO_NAT1TO1 (default: auto-detect public IP), BROWSER_PROXY_TIMEOUT_MS (default: 30000)
- per-project-scaling-provider-locations: Per-project scaling parameters and provider-aware location validation — `PROVIDER_LOCATIONS` registry in shared constants maps each provider (hetzner, scaleway, gcp) to valid locations; `isValidLocationForProvider()`, `getLocationsForProvider()`, `getDefaultLocationForProvider()` validation functions; 9 new nullable columns on projects table (defaultLocation + 8 scaling params: taskExecutionTimeoutMs, maxConcurrentTasks, maxDispatchDepth, maxSubTasksPerTask, warmNodeTimeoutMs, maxWorkspacesPerNode, nodeCpuThresholdPercent, nodeMemoryThresholdPercent); `resolveProjectScalingConfig()` helper for project→env→default fallback chain; `SCALING_PARAMS` registry with ScalingParamMeta for UI generation; API validation on PATCH projects, POST nodes, POST tasks (submit + run); TaskRunner DO uses projectScaling for node capacity thresholds and warm timeout; MCP dispatch tools use project overrides for depth/concurrency/sub-task limits; NodeLifecycle DO accepts warmTimeoutOverrideMs; ScalingSettings UI component with provider/location dropdowns, task limit fields, node scheduling fields, platform defaults as placeholders, per-field reset; location resolution: explicit override → project defaultLocation → provider default → platform default
- task-submission-file-attachments: Task submission file attachments via R2 presigned uploads — `POST /api/projects/:id/tasks/request-upload` generates presigned PUT URL for direct browser→R2 upload; `uploadAttachmentToR2()` client function with XHR progress events; `TaskSubmitForm` and `ProjectChat` attachment UI (paperclip button, progress chips, file validation); `validateAttachments()` R2 HEAD checks at submit time; `attachment_transfer` execution step in TaskRunner DO (between `workspace_ready` and `agent_session`) downloads from R2 and uploads to workspace `.private/` via VM agent; augmented initial prompt lists attached files; `cleanupAttachments()` eager R2 delete after transfer; shared types `TaskAttachment`, `RequestAttachmentUploadRequest/Response`, `ATTACHMENT_DEFAULTS`, `SAFE_FILENAME_REGEX`; configurable via R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, CF_ACCOUNT_ID, ATTACHMENT_UPLOAD_MAX_BYTES (default: 50MB), ATTACHMENT_UPLOAD_BATCH_MAX_BYTES (default: 200MB), ATTACHMENT_MAX_FILES (default: 20), ATTACHMENT_PRESIGN_EXPIRY_SECONDS (default: 900)
- workspace-file-upload-download: File upload/download for workspace sessions — VM agent `POST /workspaces/{id}/files/upload` (multipart, `docker exec tee`, no shell interpolation) with configurable per-file max (FILE_UPLOAD_MAX_BYTES, default: 50MB) and batch max (FILE_UPLOAD_BATCH_MAX_BYTES, default: 250MB); `GET /workspaces/{id}/files/download?path=...` with `docker exec cat` and CRLF-stripped Content-Disposition; API proxy routes `POST/GET /api/projects/:id/sessions/:sessionId/files/upload|download` with size-limited streaming; `uploadSessionFiles`/`downloadSessionFile` client functions; Paperclip attach button in `FollowUpInput`; download button in `ChatFilePanel` view mode; `.private` upload destination created during bootstrap (`ensureVolumeWritable`); safe filename regex rejects shell metacharacters; configurable via FILE_UPLOAD_MAX_BYTES, FILE_UPLOAD_BATCH_MAX_BYTES, FILE_UPLOAD_TIMEOUT (VM agent), FILE_UPLOAD_TIMEOUT_MS, FILE_DOWNLOAD_TIMEOUT_MS, FILE_DOWNLOAD_MAX_BYTES (Worker)
- file-browser-image-rendering: Image rendering in file browser — new `GET /workspaces/{id}/files/raw` endpoint on VM agent streams binary files with MIME detection (`mime.TypeByExtension`), ETag/304 support, and SVG Content-Security-Policy; API proxy route `GET /api/projects/:id/sessions/:sessionId/files/raw` with separate 50MB limit (FILE_RAW_PROXY_MAX_BYTES); `ImageViewer` component in `apps/web/src/components/shared-file-viewer/` with fit-to-panel/1:1 toggle, size guardrails (inline < 10MB, click-to-load < 50MB, download-only > 50MB); image detection via `isImageFile()` in `apps/web/src/lib/file-utils.ts`; integrated into both `FileViewerPanel` (workspace view) and `ChatFilePanel` (project chat); image icon in file browser listing; configurable via FILE_RAW_MAX_SIZE (default: 50MB), FILE_RAW_TIMEOUT (default: 60s), FILE_RAW_PROXY_MAX_BYTES (default: 50MB), VITE_FILE_PREVIEW_INLINE_MAX_BYTES (default: 10MB), VITE_FILE_PREVIEW_LOAD_MAX_BYTES (default: 50MB)
- file-browsing-diff-views-in-chat: Inline file viewer in project chat — four API proxy routes (`GET /api/projects/:id/sessions/:sessionId/files/list`, `files/view`, `git/status`, `git/diff`) resolve the session's workspace via D1 workspaces table, generate a terminal token, and proxy to VM agent; path sanitization via `normalizeProjectFilePath`; configurable via FILE_PROXY_TIMEOUT_MS (default: 15000), FILE_PROXY_MAX_RESPONSE_BYTES (default: 2097152); new `ChatFilePanel` slide-over component (browse/view/diff/git-status modes) accessed from session header "Files"/"Git" buttons and clickable file refs in `ToolCallCard`; shared `DiffRenderer` extracted to `apps/web/src/components/shared-file-viewer/` and reused by both `GitDiffView` (workspace view) and `ChatFilePanel` (chat view)
- global-persistent-audio-player: Global persistent TTS audio player — `GlobalAudioProvider` wraps the app above the router (`App.tsx`); `GlobalAudioPlayer` bar renders in `AppShell` (mobile: below main via flexbox, desktop: spanning full width via CSS Grid row 2); audio survives page navigation; three callers migrated from per-component `useAudioPlayback` to `useGlobalAudio` (`ProjectMessageView`, `TruncatedSummary`, `TaskDetail`); `MessageActions` and `MessageBubble` in `acp-client` accept new `onPlayAudio` callback prop to delegate to external player; new `--sam-z-player: 15` token added to design system; slide-in animation with `prefers-reduced-motion` support
- analytics-engine-phase4-forwarding: Analytics Engine Phase 4 — external event forwarding; daily cron job (`0 3 * * *`) queries Analytics Engine for key conversion events (signup, login, project_created, workspace_created, task_submitted) and batch-forwards them to Segment (Track API with Basic auth) and/or GA4 (Measurement Protocol); cursor-based deduplication via KV; new service `analytics-forward.ts` with `runAnalyticsForward()` orchestrator; admin dashboard `ForwardingStatus` card showing enabled state, last-forwarded timestamp, and destination configuration; `GET /api/admin/analytics/forward-status` endpoint; configurable via ANALYTICS_FORWARD_ENABLED (default: false), ANALYTICS_FORWARD_EVENTS, ANALYTICS_FORWARD_LOOKBACK_HOURS (default: 25), SEGMENT_WRITE_KEY, SEGMENT_API_URL, SEGMENT_MAX_BATCH_SIZE (default: 100), GA4_MEASUREMENT_ID, GA4_API_SECRET, GA4_API_URL, GA4_MAX_BATCH_SIZE (default: 25)
- analytics-engine-phase3-dashboards: Analytics Engine Phase 3 — dashboard visualizations for feature adoption (horizontal bars + sparklines for feature-event trends), geographic distribution (country-level user breakdown from CF headers), and weekly retention cohorts (heat-map cohort table with server-computed retention matrix); three new API endpoints (`/api/admin/analytics/feature-adoption`, `/geo`, `/retention`) using Cloudflare Analytics Engine SQL API; `AdminAnalytics.tsx` refactored from monolithic file to `admin-analytics/` directory with individual chart components; configurable via ANALYTICS_GEO_LIMIT (default: 50), ANALYTICS_RETENTION_WEEKS (default: 12)
- chat-idea-association: Many-to-many chat session ↔ idea (task) linking — `chat_session_ideas` junction table in ProjectData DO SQLite (migration 012); 4 MCP tools (`link_idea`, `unlink_idea`, `list_linked_ideas`, `find_related_ideas`) for agents to manage associations mid-conversation; REST endpoints `GET/POST /sessions/:id/ideas`, `DELETE /sessions/:id/ideas/:taskId`, `GET /tasks/:id/sessions` for UI; batch D1 enrichment with `inArray()`; shared `SessionIdeaLink` type; configurable via MCP_IDEA_CONTEXT_MAX_LENGTH (default: 500)
- message-materialization-fts5: Post-session message materialization + FTS5 full-text search — when a session stops, `materializeSession()` groups raw streaming tokens into `chat_messages_grouped` and populates `chat_messages_grouped_fts` FTS5 virtual table; `searchMessages()` uses FTS5 MATCH for materialized sessions with LIKE fallback for active sessions; `materializeAllStopped()` backfills existing data; migration 011 adds tables + `materialized_at` column; configurable via MCP_MESSAGE_SEARCH_MAX (default: 20)
- token-message-concatenation: MCP `get_session_messages` now groups consecutive streaming tokens (assistant, tool, thinking roles) into logical messages via `groupTokensIntoMessages()` before returning to agents; configurable via MCP_MESSAGE_LIST_LIMIT (default: 50), MCP_MESSAGE_LIST_MAX (default: 200)
- notification-system-phase2: Agent-initiated notifications — `request_human_input` MCP tool for agents to signal when blocked/need decisions (high-urgency needs_input notification); progress notification emission from `update_task_status` with batching (one per task per 5 min window); session_ended notification on conversation-mode `complete_task` remap; task_complete deduplication (60s window); notification grouping by project in NotificationCenter UI; configurable via NOTIFICATION_PROGRESS_BATCH_WINDOW_MS, NOTIFICATION_MIN_SESSION_DURATION_MS, NOTIFICATION_DEDUP_WINDOW_MS
- 027-do-session-ownership: DO-owned ACP session lifecycle — shifts session state machine (pending→assigned→running→completed/failed/interrupted) from VM agent in-memory maps to ProjectData DO SQLite; heartbeat-based VM failure detection via DO alarm; session forking with lineage tracking; workspace-project binding enforcement; configurable via ACP_SESSION_DETECTION_WINDOW_MS, ACP_SESSION_MAX_FORK_DEPTH
- codex-token-refresh-proxy: Centralized Codex OAuth token refresh proxy — `POST /api/auth/codex-refresh` receives refresh requests from Codex instances in workspaces, serializes them per user via `CodexRefreshLock` Durable Object (keyed by userId), and proxies to OpenAI; prevents rotating refresh token race condition where concurrent refreshes permanently invalidate tokens; auth via workspace callback token in `?token=` query param; compares request's refresh_token with stored credential: match → forward to OpenAI and store new tokens, stale → return latest from DB, missing → 401; VM agent injects `CODEX_REFRESH_TOKEN_URL_OVERRIDE` env var for openai-codex oauth-token sessions; configurable via CODEX_REFRESH_PROXY_ENABLED (kill switch, default: enabled), CODEX_REFRESH_LOCK_TIMEOUT_MS (default: 30000), CODEX_REFRESH_UPSTREAM_URL (default: https://auth.openai.com/oauth/token), CODEX_REFRESH_UPSTREAM_TIMEOUT_MS (default: 10000), CODEX_CLIENT_ID (default: app_EMoamEEZ73f0CkXaXp7hrann)
- codex-oauth-token-sync: Post-session credential sync-back for file-based agent credentials (e.g., codex-acp auth.json); reads updated auth file from container after session ends via `syncCredentialOnStop()`, sends to API via `POST /api/workspaces/:id/agent-credential-sync` with callbackretry; re-encrypts with fresh AES-GCM IV on change; guards: injectionMode=auth-file + CredentialSyncer configured; best-effort (errors logged, teardown not blocked)
- llm-task-title-generation: AI-powered task title generation via Cloudflare Workers AI (Mastra + workers-ai-provider + @cf/google/gemma-3-12b-it by default); generates concise titles (≤100 chars) from full message text at task submit time; falls back to truncation on failure or timeout; short messages (≤100 chars) bypass AI; configurable via TASK_TITLE_MODEL, TASK_TITLE_MAX_LENGTH, TASK_TITLE_TIMEOUT_MS, TASK_TITLE_GENERATION_ENABLED, TASK_TITLE_SHORT_MESSAGE_THRESHOLD
- fix-streaming-token-ordering: ACP notification serialization via orderedPipe in VM agent; wraps agent stdout with a serializing pipe that waits for each session/update handler to complete before delivering the next, preventing the ACP SDK's concurrent goroutine dispatch from reordering streaming tokens; configurable via `ACP_NOTIF_SERIALIZE_TIMEOUT` (default: 5s)
- 023-admin-observability: Admin observability dashboard — error storage in D1, health overview, error list with filtering, historical log viewer via CF API proxy, real-time log stream via AdminLogs DO + Tail Worker, error trends visualization
- 022-simplified-chat-ux: Chat-first UX — project page is now a chat interface (no tabs), dashboard shows project cards, descriptive branch naming (sam/...), idle auto-push safety net (15 min DO alarm), settings drawer, agent completion git push + PR creation, gh CLI injection + token refresh wrapper, finalization guard for idempotent git push results
- 021-task-chat-architecture: Task-driven chat with autonomous workspace execution, warm node pooling, project chat view, kanban board, task submit form, project default VM size
- 018-project-first-architecture: Added TypeScript 5.x (Worker/Web), Go 1.24+ (VM Agent) + Hono (API framework), Drizzle ORM (D1), React + Vite (Web), Cloudflare Workers SDK (Durable Objects)
