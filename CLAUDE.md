# Simple Agent Manager (SAM)

> Agent instruction file only. This is not user-facing documentation or a getting-started guide. Canonical public documentation lives in `apps/www/src/content/docs/docs/`.

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

1. **Prototype and test locally first** — unit tests, Miniflare integration tests, local Vite dev server, Playwright visual audits. Hybrid loops (local UI against staging API, or local API against staging VM agent) are encouraged. See `.claude/rules/29-local-first-debugging.md`. Prototype artifacts are not production deliverables by default; do not ship throwaway prototype pages, demo routes, fixture-backed UI, or scaffolded experiments unless the user explicitly asks to ship the prototype itself.
2. **Deploy to staging only when local verification is exhausted** — when the remaining work genuinely needs real OAuth, DNS, or VMs. Partial-feature staging deploys are fine for end-to-end plumbing while the rest is still developed locally. Staging deploys take ~7 minutes via `gh workflow run deploy-staging.yml`.
3. **Query staging directly via Cloudflare API** — use `$CF_TOKEN` to query D1 (SQL), read/write KV, check DNS records, and inspect Workers. This is the fastest way to verify deploys, debug issues, and understand staging state. **Always check infrastructure state via CF API before guessing at fixes.** See `.claude/rules/32-cf-api-debugging.md` for the full cheat sheet.
4. **When something fails on staging, QUERY THEN READ LOGS before changing any code** — first query D1/KV/DNS via CF API to understand the data state, then use `wrangler tail`, `/admin/logs`, `/admin/errors`, the Node detail page's log stream, `journalctl -u vm-agent` via SSH, `docker logs` for containers. Never guess-and-redeploy. See `.claude/rules/29-local-first-debugging.md` for the log location matrix.
5. Merge to main — in this canonical repository, successful `main` CI triggers production deployment. Self-host forks update by manually running Deploy Production on `main`.

Full local-development guide: `apps/www/src/content/docs/docs/guides/local-development.md`.

## Deployment

Merging to `main` in the canonical repository automatically deploys to production after CI succeeds. Self-host forks do not update from a push alone; operators manually run **Deploy Production** on their fork's `main` branch when they want to deploy.

- **CI** (`ci.yml`): lint, typecheck, test, build on pull requests and canonical `main` pushes; fork `main` pushes are intentionally skipped
- **Deploy Staging** (`deploy-staging.yml`): manual trigger only (`workflow_dispatch`) — agents trigger this explicitly during `/do` Phase 6
- **Deploy Production** (`deploy.yml`): full Pulumi + Wrangler deployment after successful canonical `main` CI, or manual `workflow_dispatch` for self-host forks
- **Teardown** (`teardown.yml`): manual only — destroys all resources
- **Generated platform secrets**: deployment-owned signing/encryption keys are generated and persisted by Pulumi when practical, then copied to Worker secrets. Do not add manual GitHub Environment prerequisites for values SAM can safely create itself; GitHub secrets for generated keys are override/rotation paths only.

### Staging Deployment is a Merge Gate

Staging deployment is manual — triggered via `gh workflow run deploy-staging.yml --ref <branch>`. Agents executing the `/do` workflow MUST deploy to staging and verify the live app before merging. A failed staging deploy blocks merge just like a failed test. Before triggering a deployment, check for existing active runs and wait at least 5 minutes if one is in progress. If the deploy fails due to missing secrets or configuration (not code), **alert the user immediately** — do not skip verification. See `.claude/rules/13-staging-verification.md`.

### HARD GATE: Features Must Work End-to-End on Staging (NEVER SHIP BROKEN FEATURES)

Staging verification means the feature WORKS — not that pages load, not that config endpoints respond, not that the UI renders. The actual feature, exercised as an end user would, must complete successfully with ZERO errors. If the feature errors on staging for ANY reason (missing binding, wrong toolchain version, unconfigured service), **do NOT merge — alert the user immediately.** Never rationalize a staging error as "expected." See `.claude/rules/30-never-ship-broken-features.md`.

### Post-Merge Production Deploy Monitoring (MANDATORY)

After merging ANY PR to main in this canonical repository, agents MUST monitor the Deploy Production workflow to completion. If the deploy fails, **alert the user immediately** with the failure reason and whether it requires human intervention. Do NOT silently finish the task when the deploy fails — a merged PR is not shipped until the deploy succeeds. See the `/do` workflow Phase 7b for the full procedure.

### Data Integrity Safeguards (CRITICAL)

Production data loss is catastrophic and irreversible. Multiple deterministic gates prevent it:

| Gate                                  | Runs in         | What it catches                                                                                                                      |
| ------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm quality:migration-safety`       | CI (every PR)   | DROP TABLE on CASCADE parents, DELETE without WHERE, PRAGMA foreign_keys=OFF, UPDATE without WHERE, any DROP TABLE in new migrations |
| `pnpm quality:do-migration-safety`    | CI (every PR)   | DROP TABLE, DELETE without WHERE, UPDATE without WHERE in Durable Object SQLite migrations (no recovery mechanism)                   |
| Pre-migration D1 backup               | Deploy pipeline | Creates time-travel bookmark + explicit backup before every migration run                                                            |
| Post-migration row count verification | Deploy pipeline | Compares row counts before/after migrations; **blocks deploy** if >50% data loss detected in any table                               |
| D1 Time Travel Restore                | Manual workflow | Point-in-time recovery for D1 databases (30-day window). See `d1-restore.yml`                                                        |

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

1. **BYOC (Bring-Your-Own-Cloud)**: Self-hosters and users may bring their own Hetzner tokens, encrypted per-user. This is the model for self-hosted deployments and BYO-key users. **However, SAM's own deployment (staging, and the platform-hosted / zero-config mode) DOES have an enabled platform-level cloud credential** (`platform_credentials`, `provider=hetzner`, `credential_type=cloud-provider`, `is_enabled=1`). Provider resolution falls back **user credential → platform credential**, so **a user does NOT need their own cloud credential for SAM to provision workspaces or deployment nodes.** NEVER treat a missing user cloud credential — e.g. a smoke/test user stuck at the cloud-onboarding wizard, or zero active workspaces — as a provisioning or staging-verification blocker. The platform Hetzner credential provisions VMs regardless. Verify before ever reporting such a blocker: D1 `SELECT id FROM platform_credentials WHERE credential_type='cloud-provider' AND is_enabled=1`.
2. **User credentials encrypted per-user** in the database — NOT stored as env vars or Worker secrets. Public security architecture documentation lives in `apps/www/src/content/docs/docs/architecture/security.md`.
3. **Platform secrets** (ENCRYPTION_KEY and purpose-specific overrides, JWT keys, deploy signing keys, CF_API_TOKEN) are Cloudflare Worker secrets set during deployment. SAM-owned generated keys should be Pulumi-managed by default, with GitHub secret overrides only when manual rotation is explicitly needed.
4. **Canonical IDs for identity** — use `workspaceId`, `nodeId`, `sessionId` for all machine-critical operations (storage, routing, lifecycle). Human-readable labels are for UX/logging only and MUST be treated as mutable and non-unique.
5. **Hybrid D1 + Durable Object storage** — D1 for cross-project queries (dashboard, tasks, users); per-project DOs for write-heavy data (chat sessions, messages, activity events). See `apps/www/src/content/docs/docs/architecture/overview.md`.

## Git Workflow

- **Always use worktrees and PRs** — never commit directly to main. Create a feature branch in a git worktree and open a PR.
- **No late direct-to-main fixes** — review fixes, CI fixes, staging fixes, and post-merge deploy fixes still go through a branch and PR. The only `/do` direct-to-main exception is the initial task file.
- **Push early and often** — environments are ephemeral. Unpushed work can be lost at any time.
- **Pull and rebase frequently** — before starting work and before pushing, run `git fetch origin && git rebase origin/main` to stay current and avoid conflicts.
- After pushing, check CI and fix any failures before moving on.

## Development Guidelines

- **Fix all build/lint errors** before pushing — even pre-existing ones
- **No dead code** — if code is no longer referenced, remove it in the same change
- **Capability tests required** — every multi-component feature needs at least one test that exercises the complete happy path across system boundaries. Component tests alone are not sufficient. See `.claude/rules/10-e2e-verification.md`.
- **Verify assumptions, don't trust documentation** — when specs or docs say "existing X works," verify with a test or manual check before building on it.
- **Cite code paths in behavioral docs** — when documenting what the system does, cite specific functions. Never write "X happens" without a code reference. Mark unimplemented behavior as "intended" not present tense.
- **Diagrams in markdown** — use Mermaid (`\`\`\`mermaid`) for all diagrams in `.md` files. The markdown renderer supports Mermaid natively.
- **Subagents** live in `.claude/agents/`; Codex skills in `.agents/skills/`
- **Playwright screenshots** go in `.codex/tmp/playwright-screenshots/` (gitignored)
- **Ephemeral scratch files go in `.tmp/`** — debug dumps, downloaded logs, scratch notes, generated fixtures, anything that must NOT be committed. The directory is gitignored (see `.tmp/README.md`). Never drop temporary artifacts in the repo root or package directories.
- **No strategy docs in this repo** — this is a public repository; business/marketing/competitive strategy documents are intentionally kept out of it. Do not create a `strategy/` directory.
- **Playwright visual audit required for UI changes** — any PR touching `apps/web/`, `packages/ui/`, or `packages/terminal/` must run Playwright visual tests with diverse mock data on mobile (375px) and desktop (1280px) viewports. See `.claude/rules/17-ui-visual-testing.md`.
- **No duplicate UI controls** — before adding any new settings control or form field, search for existing controls managing the same API field. Consolidate into one canonical location. See `.claude/rules/24-no-duplicate-ui-controls.md`.
- **Stale-while-revalidate UI** — context provider values must be memoized (ESLint-enforced), loading spinners may only gate rendering when there is no data yet, refetches must never unmount visible content, and new fetch surfaces in `apps/web/` use TanStack Query. See `.claude/rules/48-stale-while-revalidate-ui.md`.

## Agent Authentication

Agents support three **provider modes** (stored as `providerMode` in `agent_settings`):

- **`user-api-key`** (default): User's own API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) injected at workspace boot. No platform proxy involved.
- **`oauth`**: OAuth token from the provider's subscription plan (e.g., Claude Max/Pro via `claude setup-token`). Injected as `CLAUDE_CODE_OAUTH_TOKEN`.
- **`sam`**: Platform-managed AI proxy. The workspace receives a `__platform_proxy__` sentinel as its API key and routes all LLM traffic through the SAM AI proxy (`/ai/v1/*`), which handles billing, usage tracking, rate limiting, and budget enforcement via Cloudflare AI Gateway.

Users select their provider mode per-agent in Settings → Agent Settings. The `sam` mode requires explicit opt-in — it is never auto-selected.

## Testing

- **Staging authentication**: Use Playwright browser auth with the staging smoke/API token in `SAM_PLAYWRIGHT_PRIMARY_USER`. In the Playwright browser context, POST to `https://api.sammy.party/api/auth/token-login` with body `{ "token": "<value>" }`, verify a 200 response, then navigate to `https://app.sammy.party`. Do not rely on `SAM_API_URL`; it may point at production, where staging tokens correctly fail with `401 Invalid token`. See `.claude/rules/13-staging-verification.md` for full procedure.
- **Production authentication**: Use GitHub OAuth credentials at `/workspaces/.tmp/secure/demo-credentials.md` (outside repo)
- **Live test cleanup required**: delete test workspaces/nodes after verification
- **Staging verification required for every code PR** — see `.claude/rules/13-staging-verification.md`
- See `.claude/rules/02-quality-gates.md` for full testing requirements

## Bug Discovery During Testing

When you discover bugs or errors during testing — even if unrelated to your current task — file them as backlog tasks immediately so they don't get lost:

1. Create `tasks/backlog/YYYY-MM-DD-descriptive-name.md`
2. Include: Problem description, Context (where/when discovered), Acceptance Criteria checklist
3. Continue with your current work

If the bug is blocking the current task or is a small adjacent fix, fix it in the current branch with evidence. Otherwise file it and keep the assigned work moving.

## Troubleshooting

- **Build errors**: Run builds in dependency order (see Build Order above)
- **Test failures**: Check Miniflare bindings are configured in `vitest.config.ts`
- **Type errors**: Run `pnpm typecheck` from root to see all issues
- **Staging issues**: Query staging state directly via `$CF_TOKEN` and the Cloudflare API — D1 SQL queries, KV reads, DNS checks. See `.claude/rules/32-cf-api-debugging.md` for copy-paste commands. **Always query before guessing.**

## Task Tracking

Tasks tracked as markdown in `tasks/` (backlog -> active -> archive). See `tasks/README.md` for conventions.

**Dispatching tasks**: When dispatching tasks to other agents, always instruct them to use the `/do` skill in prose, for example `Execute this task using the /do skill.` Never start a dispatched task description with `/do` or any slash command; Codex treats that as CLI slash-command syntax and can reject the prompt before SAM bootstrap instructions are processed. Verify the task actually started with the requested profile and title. Do not wait on failed, queued, missing, or wrong-profile sessions. See `.claude/rules/09-task-tracking.md`.

**Read-only investigations**: PR status, PR history, task status, and diagnostic questions are read-only by default. Use SAM MCP, GitHub, logs, and local evidence in the current session. Do not create task files, branches, commits, or PRs unless the user asks for code/config changes or durable artifacts.

**Failed task retries**: Before retrying or redispatching a failed SAM task, inspect the failed task/session and check for active duplicate work with the same prompt, output branch, branch, or title. Do not blindly resubmit the same prompt after no-workspace/startup failures or transient provider failures. See `.claude/rules/09-task-tracking.md` for profile, skill, and task-mode validation details.

**Agent profile defaults**: When changing profile setup or onboarding, fresh installs should not seed multiple provider-specific built-in profiles. Prefer a setup wizard, templates, or at most one conversational default so users learn profiles intentionally instead of inheriting clutter.

**Memory and ideas**: Keep SAM knowledge, ideas, and policies current when human feedback or shipped work changes what future agents should believe. Do not mark ideas complete unless they are merged or otherwise verifiably shipped. See `.claude/rules/38-agent-feedback-and-memory.md`.

## Active Technologies

- TypeScript 5.x (Worker/Web), Go 1.24+ (VM Agent)
- Hono (API framework), Drizzle ORM (D1), React 19 + Vite (Web)
- Cloudflare Workers SDK (Durable Objects, D1, KV, R2, Workers AI)
- Tailwind CSS v4 (Web), Astro + Starlight (Marketing site)
- @mastra/core (AI agent orchestration), workers-ai-provider (Workers AI bridge)
- ACP Go SDK, `creack/pty` + `gorilla/websocket` (VM Agent)

## Recent Changes

Use the `/changelog` skill for structured queries.

- dispatch-task-runtime-routing: MCP `dispatch_task` now honors explicit and skill/profile `runtime` selection. Explicit `cf-container` decisions launch task-mode Instant sessions asynchronously without VM credential/quota gates or duplicate chat persistence; VM-only arguments conflict with container runtime instead of silently downgrading; responses expose the effective runtime and decision reason.
- origin-tag-injected-messages: SAM-injected prompt text (e.g. the `get_instructions` reminder) is no longer concatenated into the visible user prompt. It is passed separately as `injectedInstructions` on the vm-agent create-session HTTP body (`startAgentSessionOnNode` → `buildInitialPromptParams`), emitted as a second ACP prompt block tagged `_meta["sam.origin"]="system"`. The vm-agent honors that marker ONLY from a trusted control-plane prompt (`HandlePrompt(..., trustedSource)`) — browser viewer prompts have it stripped so a user cannot hide their own content. Origin propagates through the messagereport outbox (new `origin` column), the ProjectData DO `chat_messages` table (additive migration `024-chat-message-origin`, NULL/absent = `user`), `ChatMessageResponse`, and the live `session/update` broadcast. The web collapses `origin=system` user messages behind a `<details>` "Show system context" disclosure (`AcpConversationItemView`). `origin=system` content is excluded from user-content dedup, LIKE/FTS search (materialization filters it out of `chat_messages_grouped`), topic auto-capture, and attention resolution.
- chat-full-load-timeline-jump: Project chat loads the FULL conversation on open (`getSessionMessageLimit` split into a small default page size `CHAT_SESSION_MESSAGE_LIMIT` for the 3s poll/load-more and a large `CHAT_SESSION_MESSAGE_MAX` ceiling the initial load requests; new `DEFAULT_CHAT_SESSION_MESSAGE_MAX`). The 30 MiB RPC size guard + `hasMore` "Load earlier" remain the fallback for oversized sessions. Timeline jump-to-message now anchors by messageId+timestamp with a `loadUntil` fallback (no more dead clicks), every entry kind (user message, status update, activity) is clickable, and the jumped-to message flashes (`.sam-message-highlight`). Removed the now-dead `messageIndex`/`messageIndexMap` from the timeline.
- skills-profile-override-layer: Skills as a first-class profile-override layer (skill → profile → project → platform); additive migration `0063_skills.sql` adds `skills`, `skill_runtime_env_vars`, `skill_runtime_files` and `tasks.skill_id`/`tasks.skill_hint`/`triggers.skill_id`; shared mappers in `profile-fields.ts`/`profile-runtime-assets.ts`; CRUD + runtime routes under `/api/projects/:projectId/skills`; resolution wired through task/trigger/MCP/dispatch + workspace runtime asset injection; Skills UI + chat/task skill selectors in `apps/web`
- explicit-sam-provider-selection: Require explicit opt-in to SAM as AI provider via `providerMode: 'sam'`; three-mode agent auth (user-api-key, oauth, sam); AI proxy auth gate on all endpoints including /models
- compact-mode-lazy-load-tool-content: Chat compact mode strips tool content from RPC payload (80-90% reduction); lazy-loads on expand
- harness-track-d-integration-design: SAM-native harness architecture doc; Gemma 4 26B as default Workers AI model
- ai-proxy-universal-tracking: URL-path-based passthrough proxy for usage tracking without consuming auth headers
- user-ai-budget-controls: User-facing daily token budgets + monthly cost cap with 3-tier resolution
- anthropic-proxy-endpoint: Native Anthropic Messages API proxy through AI Gateway with Unified Billing
- user-ai-usage-dashboard: Per-user LLM usage dashboard from AI Gateway logs (by model, by day)
- cost-monitoring-dashboard: Admin cost dashboard aggregating LLM + compute costs with projections
- sam-observability-context-tools: SAM tools for searching task messages and browsing project codebases
- sam-agent-phase-a-tools: SAM orchestration tools (dispatch_task, create_mission, get_task_details)
- policy-propagation-phase4: Project policies with MCP tools + propagation to child tasks
