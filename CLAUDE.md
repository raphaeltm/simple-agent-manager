# Simple Agent Manager (SAM)

A serverless monorepo platform for ephemeral AI coding agent environments on Cloudflare Workers + Hetzner Cloud VMs.

## Repository Structure

```
apps/
├── api/          # Cloudflare Worker API (Hono)
└── web/          # Control plane UI (React + Vite)
packages/
├── shared/       # Shared types and utilities
├── providers/    # Cloud provider abstraction (Hetzner)
├── terminal/     # Shared terminal component
├── cloud-init/   # Cloud-init template generator
└── vm-agent/     # Go VM agent (PTY, WebSocket, ACP)
tasks/            # Task tracking (backlog -> active -> archive)
specs/            # Feature specifications
docs/             # Documentation
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

## Development Approach

**Cloudflare-first.** Local dev (`pnpm dev`) has significant limitations — no real OAuth, DNS, or VMs. For meaningful testing, deploy to staging. See `docs/guides/local-development.md`.

1. Make changes locally — lint, typecheck
2. Deploy to staging via GitHub Actions or `pnpm deploy:setup --environment staging`
3. Test on Cloudflare — real D1, KV, Workers
4. Merge to main — triggers production deployment

## Deployment

Merge to `main` automatically deploys to production via GitHub Actions.

- **CI** (`ci.yml`): lint, typecheck, test, build on all pushes/PRs
- **Deploy** (`deploy.yml`): full Pulumi + Wrangler deployment on push to main
- **Teardown** (`teardown.yml`): manual only — destroys all resources

## Key Concepts

- **Workspace**: AI coding environment (VM + devcontainer + Claude Code)
- **Node**: VM host that runs multiple workspaces
- **Provider**: Cloud infrastructure abstraction (currently Hetzner only)
- **Project**: Primary organizational unit linking a GitHub repo to workspaces, chat sessions, tasks, and activity
- **ProjectData DO**: Per-project Durable Object with embedded SQLite for chat sessions, messages, activity events. Accessed via `env.PROJECT_DATA.idFromName(projectId)`
- **NodeLifecycle DO**: Per-node Durable Object managing warm pool state machine (active → warm → destroying). Accessed via `env.NODE_LIFECYCLE.idFromName(nodeId)`. Handles idle timeout alarms; actual infrastructure teardown delegated to cron sweep.
- **Warm Node Pooling**: After task completion, auto-provisioned nodes enter "warm" state for 30 min (configurable via `NODE_WARM_TIMEOUT_MS`) for fast reuse. Three-layer defense against orphans: DO alarm + cron sweep + max lifetime.
- **Task Runner**: Autonomous task execution — selects/provisions nodes, creates workspaces, runs agents, cleans up. VM size precedence: explicit override > project default > platform default.
- **Lifecycle Control**: Workspaces/nodes stopped, restarted, or deleted explicitly via API/UI

## URL Construction Rules

The root domain does NOT serve any application. Always use subdomains:

| Destination   | URL Pattern                       |
| ------------- | --------------------------------- |
| **Web UI**    | `https://app.${BASE_DOMAIN}/...`  |
| **API**       | `https://api.${BASE_DOMAIN}/...`  |
| **Workspace** | `https://ws-${id}.${BASE_DOMAIN}` |

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

Wrangler does NOT inherit `durable_objects`, `d1_databases`, `kv_namespaces`, `r2_buckets`, `ai`, or `tail_consumers` from top-level config into `[env.*]` sections. When adding ANY new binding to `wrangler.toml`, add it to **all three places**: top-level, `[env.staging]`, and `[env.production]`. Miniflare tests won't catch this — they configure bindings independently. See `.claude/rules/07-env-and-urls.md` for details.

## Architecture Principles

1. **BYOC (Bring-Your-Own-Cloud)**: Users provide their own Hetzner tokens. The platform does NOT have cloud provider credentials.
2. **User credentials encrypted per-user** in the database — NOT stored as env vars or Worker secrets. See `docs/architecture/credential-security.md`.
3. **Platform secrets** (ENCRYPTION_KEY, JWT keys, CF_API_TOKEN) are Cloudflare Worker secrets set during deployment.
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

## Agent Authentication

Claude Code supports dual authentication: **API keys** (pay-per-use from Anthropic Console) and **OAuth tokens** (from Claude Max/Pro subscriptions via `claude setup-token`). Users toggle between them in Settings. The system injects `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` based on active credential type.

## Testing

- **Test credentials** for the live app are at `/workspaces/.tmp/secure/demo-credentials.md` (outside repo)
- **Live test cleanup required**: delete test workspaces/nodes after verification
- See `.claude/rules/02-quality-gates.md` for full testing requirements

## Troubleshooting

- **Build errors**: Run builds in dependency order (see Build Order above)
- **Test failures**: Check Miniflare bindings are configured in `vitest.config.ts`
- **Type errors**: Run `pnpm typecheck` from root to see all issues

## Task Tracking

Tasks tracked as markdown in `tasks/` (backlog -> active -> archive). See `tasks/README.md` for conventions.

## Active Technologies
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

## Recent Changes
- 023-admin-observability: Admin observability dashboard — error storage in D1, health overview, error list with filtering, historical log viewer via CF API proxy, real-time log stream via AdminLogs DO + Tail Worker, error trends visualization
- 022-simplified-chat-ux: Chat-first UX — project page is now a chat interface (no tabs), dashboard shows project cards, descriptive branch naming (sam/...), idle auto-push safety net (15 min DO alarm), settings drawer, agent completion git push + PR creation, gh CLI injection + token refresh wrapper, finalization guard for idempotent git push results
- 021-task-chat-architecture: Task-driven chat with autonomous workspace execution, warm node pooling, project chat view, kanban board, task submit form, project default VM size
- 018-project-first-architecture: Added TypeScript 5.x (Worker/Web), Go 1.24+ (VM Agent) + Hono (API framework), Drizzle ORM (D1), React + Vite (Web), Cloudflare Workers SDK (Durable Objects)
