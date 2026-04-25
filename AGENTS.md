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
2. **Deploy to staging only when local verification is exhausted** — when the remaining work genuinely needs real OAuth, DNS, or VMs. Partial-feature staging deploys are fine for end-to-end plumbing while the rest is still developed locally.
3. **Test on Cloudflare** — real D1, KV, Workers, VMs.
4. **When something fails on staging, READ THE LOGS before changing any code** — `wrangler tail`, `/admin/logs`, `/admin/errors`, the Node detail page's log stream, `journalctl -u vm-agent` via SSH, `docker logs` for containers. Never guess-and-redeploy. See `.claude/rules/29-local-first-debugging.md` for the log location matrix.
5. Merge to main — triggers production deployment.

Full local-development guide: `docs/guides/local-development.md`.

## Deployment

Merge to `main` automatically deploys to production via GitHub Actions.

- **CI** (`ci.yml`): lint, typecheck, test, build on all pushes/PRs
- **Deploy Staging** (`deploy-staging.yml`): manual trigger only (`workflow_dispatch`) — agents trigger this explicitly during `/do` Phase 6
- **Deploy Production** (`deploy.yml`): full Pulumi + Wrangler deployment on push to main
- **Teardown** (`teardown.yml`): manual only — destroys all resources

### Staging Deployment is a Merge Gate

Staging deployment is manual — triggered via `gh workflow run deploy-staging.yml --ref <branch>`. Agents executing the `/do` workflow MUST deploy to staging and verify the live app before merging. A failed staging deploy blocks merge just like a failed test. Before triggering a deployment, check for existing active runs and wait at least 5 minutes if one is in progress. See `.claude/rules/13-staging-verification.md`.

## Key Concepts

- **Workspace**: AI coding environment (VM + devcontainer + coding agent)
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

Full env var reference: use the `$env-reference` skill or see `apps/api/.env.example`.

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
- **Verify environment assumptions before declaring blockers** — if you think a tool, credential, build artifact, dependency, or permission is missing, check the real environment first (`gh auth status`, `git remote -v`, package build order, file presence, env vars, command availability, etc.). If you still cannot proceed, report the exact checks you ran and why they failed. Do not give up based on an untested assumption.
- **Cite code paths in behavioral docs** — when documenting what the system does, cite specific functions. Never write "X happens" without a code reference. Mark unimplemented behavior as "intended" not present tense.
- **Diagrams in markdown** — use Mermaid for all diagrams in `.md` files. The markdown renderer supports Mermaid natively.
- **Playwright screenshots** go in `.codex/tmp/playwright-screenshots/` (gitignored)
- **Playwright visual audit required for UI changes** — any PR touching `apps/web/`, `packages/ui/`, or `packages/terminal/` must run Playwright visual tests with diverse mock data on mobile (375px) and desktop (1280px) viewports. See `.claude/rules/17-ui-visual-testing.md`.
- **No duplicate UI controls** — before adding any new settings control or form field, search for existing controls managing the same API field. Consolidate into one canonical location. See `.claude/rules/24-no-duplicate-ui-controls.md`.

## Agent Authentication

The platform supports multiple coding agents with different auth models:

- **Claude Code**: API keys (from Anthropic Console) or OAuth tokens (from Claude Max/Pro via `claude setup-token`). The system injects `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` based on active credential type.
- **OpenAI Codex**: OAuth tokens stored in `.codex/auth.json`. Centralized refresh proxy (`CodexRefreshLock` DO) prevents rotating-token race conditions. Post-session credential sync-back via `POST /api/workspaces/:id/agent-credential-sync`.

Users toggle between agents and credential types in Settings.

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

## Task Tracking

Tasks tracked as markdown in `tasks/` (backlog -> active -> archive). See `tasks/README.md` for conventions.

**Dispatching tasks**: When dispatching tasks to other agents, always instruct them to use the `$do` skill. This ensures the receiving agent follows the full end-to-end workflow (research, implement, review, staging verify, PR). See `.claude/rules/09-task-tracking.md`.

## Strategy Planning

Strategic planning artifacts live in `strategy/` — see `strategy/README.md` for full structure.

| Domain               | Directory               | Skill                        | Key Artifacts                                                    |
| -------------------- | ----------------------- | ---------------------------- | ---------------------------------------------------------------- |
| Competitive Research | `strategy/competitive/` | `$competitive-research`      | Competitor profiles, feature matrix, positioning map, SWOT       |
| Marketing            | `strategy/marketing/`   | `$marketing-strategy`        | Positioning doc, messaging guide, content calendar, gap analysis |
| Business             | `strategy/business/`    | `$business-strategy`         | Market sizing (TAM/SAM/SOM), pricing, business model, GTM plan   |
| Engineering          | `strategy/engineering/` | `$engineering-strategy`      | Roadmap (Now/Next/Later), tech radar, tech debt register         |
| Content              | `strategy/content/`     | `$content-create`            | Social posts, blog drafts, changelogs, launch copy               |

Domains chain together: competitive research feeds marketing and business strategy, which feed engineering priorities and content creation.

---

## Rules (Full Reference)

The full rules live in `.claude/rules/*.md`. These rules apply to ALL agents working in this codebase. Below is a summary — read the full rule files for detailed requirements.

### Documentation Sync (`.claude/rules/01-doc-sync.md`)

After writing or modifying ANY code, update ALL documentation that references the changed behavior IN THE SAME COMMIT. Code is the source of truth — but stale docs are not acceptable. Behavioral claims must cite specific code paths.

### Quality Gates (`.claude/rules/02-quality-gates.md`)

- After every task: re-read the original request, verify your work fully addresses it
- Feature testing: unit tests + integration tests + capability tests (cross-boundary happy path)
- Bug fixes require: regression tests + post-mortem in `docs/notes/` + process fix in `.claude/rules/`
- Pre-merge: dispatch review agents in parallel based on what the PR touches
- **Prohibited**: Source-contract tests (`readFileSync` + `toContain()`) are NOT valid behavioral tests

### Constitution (`.claude/rules/03-constitution.md`)

Validate every change against `.specify/memory/constitution.md`, especially Principle XI:
- NO hardcoded URLs — derive from environment variables
- NO hardcoded timeouts — use configurable env vars with defaults
- NO hardcoded limits — all limits must be configurable

### Preflight (`.claude/rules/05-preflight.md`)

Before writing ANY code: classify the change, gather context, record assumptions, plan doc updates.

### Technical Patterns (`.claude/rules/06-technical-patterns.md`)

- When adding click handlers in components with `useEffect`, trace forward through every effect that could fire
- Adding features: check `packages/shared` for types, `packages/providers` for provider logic, `apps/api/src/routes/` for endpoints, `apps/web/src/components/` for UI

### Env & URLs (`.claude/rules/07-env-and-urls.md`)

- `GH_*` in GitHub → `GITHUB_*` in Worker (mapped by `configure-secrets.sh`)
- Wrangler env sections generated at deploy time — never check them in
- All URLs use subdomains — NEVER bare root domain

### Architecture (`.claude/rules/08-architecture.md`)

Before changing architecture, secrets, credentials, data models, or security: research `docs/architecture/`, `docs/adr/`, `specs/`, `.specify/memory/constitution.md`.

### Task Tracking (`.claude/rules/09-task-tracking.md`)

Tasks tracked as markdown in `tasks/` (backlog → active → archive). Check items off as you complete them. Record failures and dead ends. Run `$task-completion-validator` before archiving.

### E2E Verification (`.claude/rules/10-e2e-verification.md`)

Every feature needs at least one capability test across system boundaries. Multi-component features need a data flow trace citing specific code paths. Last task in any decomposition must be integration verification on staging.

### Fail-Fast Patterns (`.claude/rules/11-fail-fast-patterns.md`)

Identity validation at system boundaries. All identity fields validated at function entry. Mismatched IDs cause rejection, not silent acceptance.

### Staging Verification (`.claude/rules/13-staging-verification.md`)

Hard merge gate. Every code PR must deploy to staging and verify on live app. No exceptions.

### Workflow State Persistence (`.claude/rules/14-do-workflow-persistence.md`)

Maintain `.do-state.md` as external memory for long workflows. Re-read at every phase boundary.

### No Page Reload on Mutation (`.claude/rules/16-no-page-reload-on-mutation.md`)

Never use `window.location.reload()` after API mutations. Update via React state.

### UI Visual Testing (`.claude/rules/17-ui-visual-testing.md`)

Playwright visual audit for all UI changes — mobile (375px) + desktop (1280px).

### File Size Limits (`.claude/rules/18-file-size-limits.md`)

No source file >500 lines (800 hard limit). Split strategy by file type.

### External Service Integration (`.claude/rules/19-external-service-integration.md`)

OAuth URIs must be static. IAM bindings scoped per-entity. Self-hoster setup documented.

### Cross-Origin CORS (`.claude/rules/20-cross-origin-cors.md`)

Browser-to-external-service requests require automated CORS configuration in deployment pipeline.

### Timeout Merge Guard (`.claude/rules/21-timeout-merge-guard.md`)

Do not merge under time pressure. Past 75% of max execution time, push branch and stop.

### Infrastructure Merge Gate (`.claude/rules/22-infrastructure-merge-gate.md`)

Infrastructure phases cannot be deferred. Every item must be complete before PR.

### Cross-Boundary Contract Tests (`.claude/rules/23-cross-boundary-contract-tests.md`)

Inter-service HTTP calls require contract verification (URL path, auth mechanism, request/response shape).

### No Duplicate UI Controls (`.claude/rules/24-no-duplicate-ui-controls.md`)

Each API field has exactly one UI control. Search before adding new form fields.

### Review Merge Gate (`.claude/rules/25-review-merge-gate.md`)

All dispatched review agents must complete before merge. CRITICAL/HIGH findings block merge.

### Project Chat First (`.claude/rules/26-project-chat-first.md`)

Project chat is the primary UX surface. Design for chat integration first, workspace view second.

### VM Agent Staging Refresh (`.claude/rules/27-vm-agent-staging-refresh.md`)

Delete all nodes before testing VM agent changes on staging to get new binary.

### Credential Resolution Tests (`.claude/rules/28-credential-resolution-fallback-tests.md`)

Credential resolution requires behavioral tests for every fallback branch.

### Local-First Debugging (`.claude/rules/29-local-first-debugging.md`)

Prototype locally first. When staging fails, read logs before changing code. Never guess-and-redeploy.

---

## Agent Configuration Cross-Reference

| What                 | Claude Code Location              | Codex Location                                  |
| -------------------- | --------------------------------- | ----------------------------------------------- |
| Project instructions | `CLAUDE.md`                       | `AGENTS.md` (this file)                         |
| Modular rules        | `.claude/rules/*.md`              | Same files (shared)                             |
| Subagents / skills   | `.claude/agents/*/`               | `.agents/skills/*/SKILL.md` + `agents/openai.yaml` |
| Reference skills     | `.claude/skills/*/SKILL.md`       | `.agents/skills/*/SKILL.md`                     |
| Slash commands       | `.claude/commands/*.md`           | `.codex/prompts/*.md`                           |
| Project config       | `.claude/settings.json`           | `.codex/config.toml`                            |
| Constitution         | `.specify/memory/constitution.md` | Same file                                       |
| Feature specs        | `specs/`                          | Same directory                                  |

## Skills

Skills are invoked with `$skill-name` (Codex) or dispatched as subagents (Claude Code). Available in `.agents/skills/`:

### Review / Specialist Skills

- `$cloudflare-specialist` — D1, KV, R2, wrangler config review
- `$constitution-validator` — No hardcoded values compliance
- `$doc-sync-validator` — Documentation matches code
- `$env-validator` — GH_ vs GITHUB_ consistency
- `$go-specialist` — Go code review (PTY, WebSocket, JWT)
- `$security-auditor` — Credential safety, OWASP, JWT
- `$task-completion-validator` — Planned vs actual work validation (mandatory before archive)
- `$test-engineer` — Test generation and TDD compliance
- `$ui-ux-specialist` — Mobile-first UI, Playwright verification

### Reference Skills

- `$api-reference` — Full API endpoint reference
- `$changelog` — Recent feature changes and history
- `$env-reference` — Full environment variable reference

### Strategy Skills

- `$business-strategy` — Market sizing, pricing, business model, GTM
- `$competitive-research` — Competitor profiles, feature matrices, SWOT
- `$content-create` — Social posts, blog outlines, changelogs, launch copy
- `$engineering-strategy` — Roadmap, tech radar, tech debt, build-vs-buy
- `$marketing-strategy` — Positioning, messaging, gap analysis, channel strategy

### Task Execution

- `$do` — End-to-end task executor: research → plan → implement → review → staging → PR
- `$workflow` — Multi-step workflow orchestration with foreground polling

## Prompts

Workflow prompts in `.codex/prompts/` (Codex) and `.claude/commands/` (Claude Code):

- `do` — End-to-end task execution (7-phase workflow)
- `workflow` — Multi-step workflow orchestration
- `speckit.specify` — Create/update feature spec
- `speckit.clarify` — Identify underspecified areas
- `speckit.plan` — Create implementation plan
- `speckit.tasks` — Generate task list from plan
- `speckit.taskstoissues` — Convert tasks to GitHub issues
- `speckit.implement` — Execute implementation plan
- `speckit.analyze` — Cross-artifact consistency analysis
- `speckit.checklist` — Generate custom checklist
- `speckit.constitution` — Constitution management

## Durable Object Patterns

Per-project data (chat sessions, messages, activity events) is stored in a `ProjectData` Durable Object with embedded SQLite:

- **Access**: `env.PROJECT_DATA.idFromName(projectId)` → deterministic DO stub
- **Service layer**: `apps/api/src/services/project-data.ts` — typed wrapper for all DO RPC calls
- **DO class**: `apps/api/src/durable-objects/project-data.ts` — extends `DurableObject`, constructor runs migrations
- **Migrations**: `apps/api/src/durable-objects/migrations.ts` — append-only, tracked in `migrations` table
- **WebSocket**: Hibernatable WebSockets for real-time event streaming
- **D1 sync**: `scheduleSummarySync()` debounces summary updates to D1
- **ADR**: `docs/adr/004-hybrid-d1-do-storage.md`

## Active Technologies

- TypeScript 5.x (Worker/Web), Go 1.24+ (VM Agent)
- Hono (API framework), Drizzle ORM (D1), React 19 + Vite (Web)
- Cloudflare Workers SDK (Durable Objects, D1, KV, R2)
- Tailwind CSS v4 (Web), Astro + Starlight (Marketing site)
- @mastra/core (AI agent orchestration), workers-ai-provider (Workers AI bridge)
