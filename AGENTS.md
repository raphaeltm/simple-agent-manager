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

## Key Concepts

- **Workspace**: AI coding environment (VM + devcontainer + Claude Code)
- **Node**: VM host that runs multiple workspaces
- **Provider**: Cloud infrastructure abstraction (currently Hetzner only)
- **Project**: Primary organizational unit linking a GitHub repo to workspaces, chat sessions, tasks, and activity
- **ProjectData DO**: Per-project Durable Object with embedded SQLite for chat sessions, messages, activity events. Accessed via `env.PROJECT_DATA.idFromName(projectId)`
- **NodeLifecycle DO**: Per-node Durable Object managing warm pool state machine (active → warm → destroying). Accessed via `env.NODE_LIFECYCLE.idFromName(nodeId)`
- **Warm Node Pooling**: After task completion, auto-provisioned nodes enter "warm" state for 30 min (configurable via `NODE_WARM_TIMEOUT_MS`) for fast reuse
- **Task Runner**: Autonomous task execution — selects/provisions nodes, creates workspaces, runs agents, cleans up

## Architecture Principles

1. **BYOC (Bring-Your-Own-Cloud)**: Users provide their own Hetzner tokens. The platform does NOT have cloud provider credentials.
2. **User credentials encrypted per-user** in the database — NOT stored as env vars or Worker secrets. See `docs/architecture/credential-security.md`.
3. **Platform secrets** (ENCRYPTION_KEY, JWT keys, CF_API_TOKEN) are Cloudflare Worker secrets set during deployment.
4. **Canonical IDs for identity** — use `workspaceId`, `nodeId`, `sessionId` for all machine-critical operations.
5. **Hybrid D1 + Durable Object storage** — D1 for cross-project queries; per-project DOs for write-heavy data. See `docs/adr/004-hybrid-d1-do-storage.md`.

## Development Approach

**Cloudflare-first.** Local dev (`pnpm dev`) has significant limitations — no real OAuth, DNS, or VMs. For meaningful testing, deploy to staging. See `docs/guides/local-development.md`.

1. Make changes locally — lint, typecheck
2. Deploy to staging via GitHub Actions or `pnpm deploy:setup --environment staging`
3. Test on Cloudflare — real D1, KV, Workers
4. Merge to main — triggers production deployment

## Git Workflow

- **Always use worktrees and PRs** — never commit directly to main
- **Push early and often** — environments are ephemeral
- **Pull and rebase frequently** — `git fetch origin && git rebase origin/main`

## URL Construction Rules

The root domain does NOT serve any application. Always use subdomains:

| Destination   | URL Pattern                       |
| ------------- | --------------------------------- |
| **Web UI**    | `https://app.${BASE_DOMAIN}/...`  |
| **API**       | `https://api.${BASE_DOMAIN}/...`  |
| **Workspace** | `https://ws-${id}.${BASE_DOMAIN}` |

## Env Var Naming: GH_ vs GITHUB_

GitHub Actions reserves `GITHUB_*`, so GitHub secrets use `GH_*` prefix. The deployment script (`configure-secrets.sh`) maps them to `GITHUB_*` Worker secrets.

| Context              | Prefix     | Example             |
| -------------------- | ---------- | ------------------- |
| GitHub Environment   | `GH_`     | `GH_CLIENT_ID`      |
| Worker runtime / .env | `GITHUB_` | `GITHUB_CLIENT_ID`  |

## Wrangler Binding Rule

Environment-specific `[env.*]` sections are NOT checked into the repository. They are generated at deploy time by `scripts/deploy/sync-wrangler-config.ts`. When adding ANY new binding to `wrangler.toml`, add it to the **top-level section only**.

---

## Rules (Essential)

The full rules live in `.claude/rules/*.md`. Below is the essential content. When working on a task, read the full rule file for detailed requirements.

### Documentation Sync (full: `.claude/rules/01-doc-sync.md`)

After writing or modifying ANY code, update ALL documentation that references the changed behavior IN THE SAME COMMIT. Search docs for function names, endpoint paths, env vars. Include doc changes in the same commit.

- Code is the source of truth — but stale docs are not acceptable
- Spec files (`specs/`) are historical records: only edit within the active spec directory
- Behavioral claims must cite specific code paths (file:function)

### Quality Gates (full: `.claude/rules/02-quality-gates.md`)

- After every task: re-read the original request, verify your work fully addresses it
- Feature testing: unit tests + integration tests + capability tests (cross-boundary happy path)
- Bug fixes require: regression tests + post-mortem in `docs/notes/` + process fix in `.claude/rules/`
- Pre-merge: dispatch review subagents in parallel based on what the PR touches
- Post-push: check CI, fix failures immediately
- **Prohibited**: Source-contract tests (`readFileSync` + `toContain()`) are NOT valid behavioral tests

### Constitution (full: `.claude/rules/03-constitution.md`)

Validate every change against `.specify/memory/constitution.md`, especially Principle XI:
- NO hardcoded URLs — derive from environment variables
- NO hardcoded timeouts — use configurable env vars with defaults
- NO hardcoded limits — all limits must be configurable
- NO hardcoded identifiers

### Preflight (full: `.claude/rules/05-preflight.md`)

Before writing ANY code: classify the change, gather context, record assumptions, plan doc updates, run constitution checks. Required for all AI-authored PRs.

### Technical Patterns (full: `.claude/rules/06-technical-patterns.md`)

- When adding click handlers/state setters in components with `useEffect`, trace forward through every effect that could fire
- Check for conflicts where effects undo handler intent
- Adding features: check `packages/shared` for types, `packages/providers` for provider logic, `apps/api/src/routes/` for endpoints, `apps/web/src/components/` for UI

### Env & URLs (full: `.claude/rules/07-env-and-urls.md`)

- `GH_*` in GitHub → `GITHUB_*` in Worker (mapped by `configure-secrets.sh`)
- Wrangler env sections generated at deploy time — never check them in
- All URLs use subdomains — NEVER bare root domain

### Architecture (full: `.claude/rules/08-architecture.md`)

Before changing architecture, secrets, credentials, data models, or security: research `docs/architecture/`, `docs/adr/`, `specs/`, `.specify/memory/constitution.md`.

### Task Tracking (full: `.claude/rules/09-task-tracking.md`)

Tasks tracked as markdown in `tasks/` (backlog → active → archive). Check items off as you complete them. Record failures and dead ends.

### E2E Verification (full: `.claude/rules/10-e2e-verification.md`)

- Every feature needs at least one capability test across system boundaries
- Multi-component features need a data flow trace citing specific code paths
- When a spec says "existing X works," verify it — "I read the code" is NOT verification
- Task decomposition: last task MUST be integration verification on staging

## Development Guidelines

- **Fix all build/lint errors** before pushing
- **No dead code** — remove unused code in the same change
- **Capability tests required** — component tests alone are insufficient
- **Cite code paths in behavioral docs** — never write "X happens" without a code reference
- **Diagrams in markdown** — use Mermaid for all diagrams

---

## Agent Configuration Cross-Reference

| What | Claude Code Location | Codex Location |
|------|---------------------|----------------|
| Project instructions | `CLAUDE.md` | `AGENTS.md` (this file) |
| Modular rules | `.claude/rules/*.md` | Condensed above + path-scoped `AGENTS.md` files |
| Subagents / skills | `.claude/agents/*/` | `.agents/skills/*/SKILL.md` (symlinked) |
| Reference skills | `.claude/skills/*/SKILL.md` | `.agents/skills/*/SKILL.md` |
| Slash commands | `.claude/commands/*.md` | `.codex/prompts/*.md` |
| Project config | `.claude/settings.json` | `.codex/config.toml` |
| Constitution | `.specify/memory/constitution.md` | Same file |
| Feature specs | `specs/` | Same directory |

## Codex Skills

Invoke skills with `$skill-name`. Available skills in `.agents/skills/`:

### Review / Specialist Skills
- `$cloudflare-specialist` — D1, KV, R2, wrangler config review
- `$constitution-validator` — No hardcoded values compliance
- `$doc-sync-validator` — Documentation matches code
- `$env-validator` — GH_ vs GITHUB_ consistency
- `$go-specialist` — Go code review (PTY, WebSocket, JWT)
- `$security-auditor` — Credential safety, OWASP, JWT
- `$test-engineer` — Test generation and TDD compliance
- `$ui-ux-specialist` — Mobile-first UI, Playwright verification

### Reference Skills
- `$api-reference` — Full API endpoint reference
- `$changelog` — Recent feature changes and history
- `$env-reference` — Full environment variable reference

### Task Execution
- `$do` — End-to-end task executor: research → plan → implement → review → PR

## Codex Prompts

Speckit workflow prompts in `.codex/prompts/`:
- `/prompts:speckit.specify` — Create/update feature spec
- `/prompts:speckit.clarify` — Identify underspecified areas
- `/prompts:speckit.plan` — Create implementation plan
- `/prompts:speckit.tasks` — Generate task list from plan
- `/prompts:speckit.taskstoissues` — Convert tasks to GitHub issues
- `/prompts:speckit.implement` — Execute implementation plan
- `/prompts:speckit.analyze` — Cross-artifact consistency analysis
- `/prompts:speckit.checklist` — Generate custom checklist
- `/prompts:speckit.constitution` — Constitution management
- `/prompts:do` — End-to-end task execution

## Durable Object Patterns

Per-project data (chat sessions, messages, activity events) is stored in a `ProjectData` Durable Object with embedded SQLite. Key patterns:

- **Access**: `env.PROJECT_DATA.idFromName(projectId)` → deterministic DO stub
- **Service layer**: `apps/api/src/services/project-data.ts` — typed wrapper for all DO RPC calls
- **DO class**: `apps/api/src/durable-objects/project-data.ts` — extends `DurableObject`, constructor runs migrations
- **Migrations**: `apps/api/src/durable-objects/migrations.ts` — append-only, tracked in `migrations` table
- **WebSocket**: Hibernatable WebSockets for real-time event streaming
- **D1 sync**: `scheduleSummarySync()` debounces summary updates to D1
- **ADR**: `docs/adr/004-hybrid-d1-do-storage.md`

## Active Technologies

- TypeScript 5.x (Worker/Web), Go 1.24+ (VM Agent)
- Hono (API framework), Drizzle ORM (D1), React 18 + Vite (Web)
- Cloudflare Workers SDK (Durable Objects, D1, KV, R2)
- Tailwind CSS v4 (Web)
