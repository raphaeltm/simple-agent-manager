# Simple Agent Manager (SAM) — Agent Instructions

> **SYNC DIRECTIVE**: `CLAUDE.md` and `AGENTS.md` MUST be kept identical. Any edit to one file MUST be applied to the other in the same commit. No exceptions.

---

## CRITICAL: Code Is The Source Of Truth (NON-NEGOTIABLE)

**When code and documentation conflict, the CODE is always correct. Documentation drifts; code does not lie.**

However, this does NOT excuse stale documentation. The following rule exists to prevent drift:

### Mandatory Documentation Sync (ENFORCED ON EVERY CHANGE)

**After writing or modifying ANY code, you MUST update ALL documentation that references the changed behavior IN THE SAME COMMIT.** There are NO exceptions and NO deferrals.

This includes but is not limited to:
- `docs/guides/self-hosting.md` — setup instructions, permissions, configuration
- `docs/architecture/` — architecture decisions, credential models
- `specs/` — feature specifications, data models
- `AGENTS.md` — development guidelines, API endpoints, environment variables
- `CLAUDE.md` — active technologies, recent changes
- `README.md` — if user-facing behavior changed

### How To Comply

1. **Before committing**: Search all docs for references to what you changed (`Grep` for function names, endpoint paths, permission names, env vars, etc.)
2. **Update every match**: If a doc says "Read-only" but the code now does "Read and write", fix the doc
3. **Include doc changes in the same commit**: Do NOT create separate "docs update" commits after the fact
4. **If unsure whether a doc is affected**: Read it. It takes seconds. The cost of stale docs is much higher.

### CRITICAL: Spec Documentation Edit Scope (NON-NEGOTIABLE)

Spec files are historical records tied to a specific feature context. Apply these scope rules on every task:

1. **Working within a specific spec**: You MAY update docs under that active spec directory (for example, `specs/014-multi-workspace-nodes/*`) when needed.
2. **Working within a specific spec**: You MUST NOT edit docs under any other spec directory.
3. **Working outside spec context**: You MUST NOT edit `specs/` documentation at all.

### Why This Matters

Stale documentation causes real user-facing failures. Users follow setup guides that reference incorrect permissions, wrong URLs, or outdated configuration — and then things break in ways that are hard to debug. Every code change without a corresponding doc update is technical debt that compounds.

---

## CRITICAL: Request Validation (NON-NEGOTIABLE)

**After completing ANY task, you MUST re-read the user's original request and verify your work fully addresses it.**

1. **MUST** scroll back to the user's last message that initiated the task
2. **MUST** compare what was requested vs. what was delivered
3. **MUST** explicitly confirm each requested item was addressed
4. **MUST** acknowledge any items that were deferred or handled differently than requested
5. **MUST NOT** mark work as complete until this validation passes

This prevents scope drift and ensures the user gets exactly what they asked for.

---

## CRITICAL: Feature Testing Requirements (NON-NEGOTIABLE)

**If you build or modify a feature, you MUST add tests that prove it works before calling the task complete.**

1. **MUST** add unit tests for new and changed logic/components
2. **MUST** add integration tests when multiple layers interact (API routes/services/DB, UI + API data loading, auth flows)
3. **SHOULD** add end-to-end tests for user-critical flows (login, workspace lifecycle, settings, primary CTAs), when applicable
4. **MUST** run relevant test suites and confirm they pass before completion
5. **MUST NOT** treat manual QA alone as sufficient coverage for feature delivery

### Quick Testing Gate

Before marking feature work complete:
- [ ] Unit tests added/updated for all changed behavior
- [ ] Integration tests added where cross-layer behavior exists
- [ ] E2E coverage added or explicitly justified as not applicable
- [ ] Local test run passes for impacted packages
- [ ] CI test checks are expected to pass with the changes

---

## CRITICAL: Constitution Validation (NON-NEGOTIABLE)

**ALL changes MUST be validated against the project constitution (`.specify/memory/constitution.md`) before completion.**

1. **MUST** read and understand all constitution principles before making changes
2. **MUST** validate EVERY change against Principle XI (No Hardcoded Values):
   - NO hardcoded URLs - derive from environment variables (e.g., `BASE_DOMAIN`)
   - NO hardcoded timeouts - use configurable env vars with defaults
   - NO hardcoded limits - all limits must be configurable
   - NO hardcoded identifiers - issuers, audiences, key IDs must be dynamic
3. **MUST** fix any violations before marking work as complete
4. **MUST** use sequential thinking to verify compliance

### Quick Compliance Check

Before committing any business logic changes, verify:
- [ ] All URLs derived from `BASE_DOMAIN` or similar env vars
- [ ] All timeouts have `DEFAULT_*` constants and env var overrides
- [ ] All limits are configurable via environment
- [ ] No magic strings that should be configuration

---

## CRITICAL: Mobile-First UI Requirements (NON-NEGOTIABLE)

**ALL UI changes MUST be tested for mobile usability before deployment.**

1. **MUST** ensure login/primary CTAs are prominent and have min 56px touch targets
2. **MUST** use responsive text sizes (mobile -> tablet -> desktop)
3. **MUST** start with single-column layouts on mobile
4. **MUST** test on mobile viewport before deploying
5. **MUST** follow `docs/guides/mobile-ux-guidelines.md`

### Quick Mobile Check

Before deploying any UI changes:
- [ ] Login button visible and large (min 56px height)
- [ ] Text readable without zooming (responsive sizing)
- [ ] Grid layouts collapse to single column on mobile
- [ ] Tested in Chrome DevTools mobile view

---

## CRITICAL: Environment Variable Naming (NON-NEGOTIABLE)

**GitHub secrets and Cloudflare Worker secrets use DIFFERENT naming conventions. Confusing them causes deployment failures.**

### The Two Naming Conventions

| Context | Prefix | Example | Where Used |
|---------|--------|---------|------------|
| **GitHub Environment** | `GH_` | `GH_CLIENT_ID` | GitHub Settings -> Environments -> production |
| **Cloudflare Worker** | `GITHUB_` | `GITHUB_CLIENT_ID` | Worker runtime, local `.env` files |

### Why Different Names?

GitHub Actions reserves `GITHUB_*` environment variables for its own use. Using `GITHUB_CLIENT_ID` as a GitHub secret would conflict. So we use `GH_*` in GitHub, and the deployment script maps them to `GITHUB_*` Worker secrets.

### The Mapping (done by `configure-secrets.sh`)

```
GitHub Secret          ->  Cloudflare Worker Secret
GH_CLIENT_ID           ->  GITHUB_CLIENT_ID
GH_CLIENT_SECRET       ->  GITHUB_CLIENT_SECRET
GH_APP_ID              ->  GITHUB_APP_ID
GH_APP_PRIVATE_KEY     ->  GITHUB_APP_PRIVATE_KEY
GH_APP_SLUG            ->  GITHUB_APP_SLUG
```

### Documentation Rules

When documenting environment variables:
1. **GitHub Environment config** -> Use `GH_*` prefix
2. **Cloudflare Worker secrets** -> Use `GITHUB_*` prefix
3. **Local `.env` files** -> Use `GITHUB_*` prefix (same as Worker)
4. **ALWAYS** specify which context you're documenting
5. **NEVER** mix prefixes in the same table without explanation

### Quick Reference

- **User configuring GitHub**: Tell them to use `GH_CLIENT_ID`
- **Code reading from env**: Use `env.GITHUB_CLIENT_ID`
- **Local development**: Use `GITHUB_CLIENT_ID` in `.env`

---

## CRITICAL: URL Construction Rules (NON-NEGOTIABLE)

**When constructing URLs using `BASE_DOMAIN`, you MUST use the correct subdomain prefix.** The root domain does NOT serve any application.

| Destination | URL Pattern | Example |
|-------------|-------------|---------|
| **Web UI** | `https://app.${BASE_DOMAIN}/...` | `https://app.simple-agent-manager.org/settings` |
| **API** | `https://api.${BASE_DOMAIN}/...` | `https://api.simple-agent-manager.org/health` |
| **Workspace** | `https://ws-${id}.${BASE_DOMAIN}` | `https://ws-abc123.simple-agent-manager.org` |

**NEVER** use `https://${BASE_DOMAIN}/...` (bare root domain) for redirects or links. This is always a bug.

### Redirect Rules

- All user-facing redirects (e.g., after GitHub App installation, after login) MUST go to `app.${BASE_DOMAIN}`
- All API-to-API references MUST use `api.${BASE_DOMAIN}`
- Relative redirects (e.g., `c.redirect('/settings')`) are WRONG in the API worker — they resolve to the API subdomain, not the app subdomain

---

## CRITICAL: Architecture Research Requirements

**Before making ANY changes related to architecture, secrets, credentials, data models, or security:**

1. **MUST** research relevant architecture documentation:
   - `docs/architecture/` - Core architecture decisions
   - `docs/adr/` - Architecture Decision Records
   - `specs/` - Feature specifications with data models
   - `.specify/memory/constitution.md` - Project principles (especially Principle XI)

2. **MUST** use sequential thinking to:
   - Understand the existing architecture
   - Identify how your change fits (or conflicts)
   - Consider security implications
   - **Validate against constitution principles**
   - Document your reasoning

3. **MUST** provide explicit justification for any architecture-related changes

### Key Architecture Documents

| Document | Contents |
|----------|----------|
| `docs/architecture/credential-security.md` | BYOC model, encryption, user credentials |
| `docs/architecture/secrets-taxonomy.md` | Platform secrets vs user credentials |
| `docs/adr/002-stateless-architecture.md` | Stateless design principles |
| `.specify/memory/constitution.md` | Core principles and rules |

### Architecture Principles (Quick Reference)

1. **Bring-Your-Own-Cloud (BYOC)**: Users provide their own Hetzner tokens. The platform does NOT have cloud provider credentials.
2. **User credentials are encrypted per-user** in the database, NOT stored as environment variables or Worker secrets.
3. **Platform secrets** (ENCRYPTION_KEY, JWT keys, CF_API_TOKEN) are Cloudflare Worker secrets set during deployment.

---

## CRITICAL: Business Logic Research Requirements

**Before making ANY changes related to features, workflows, state machines, validation rules, or user-facing behavior:**

1. **MUST** research relevant feature specifications:
   - `specs/` - Feature specs with user stories, requirements, acceptance criteria
   - `specs/*/data-model.md` - State machines, entity relationships, constraints
   - `apps/api/src/db/schema.ts` - Current database schema and constraints
   - `apps/api/src/routes/` - Existing API behavior and validation

2. **MUST** use sequential thinking to:
   - Understand existing business rules and why they exist
   - Identify edge cases and error scenarios
   - Consider impact on existing features
   - Document your reasoning

3. **MUST** provide explicit justification for any business logic changes

### Key Business Logic Documents

| Document | Contents |
|----------|----------|
| `specs/003-browser-terminal-saas/spec.md` | Core SaaS features, user stories |
| `specs/003-browser-terminal-saas/data-model.md` | Entity relationships, state machines |
| `specs/004-mvp-hardening/spec.md` | Security hardening, access control |
| `specs/004-mvp-hardening/data-model.md` | Bootstrap tokens, ownership validation |

### Business Logic Principles (Quick Reference)

1. **Workspace Lifecycle**: pending -> creating -> running -> stopping -> stopped (see data-model.md for state machine)
2. **Idle Detection Telemetry**: Idle/activity heartbeats are still recorded (`IDLE_TIMEOUT_SECONDS` remains configurable), but lifecycle transitions are explicit (no automatic idle-triggered stop/delete)
3. **Ownership Validation**: All workspace operations MUST verify `user_id` matches authenticated user
4. **Bootstrap Tokens**: One-time use, 5-minute expiry, cryptographically random

---

## CRITICAL: Agent Preflight Behavior (NON-NEGOTIABLE)

**Before writing ANY code, agents MUST complete preflight behavior checks.**

This policy is defined in `docs/guides/agent-preflight-behavior.md` and enforced through PR evidence checks in CI.

### Mandatory Preflight Steps (Before Code Edits)

1. **MUST** classify the change using one or more classes:
   - `external-api-change`, `cross-component-change`, `business-logic-change`, `public-surface-change`
   - `docs-sync-change`, `security-sensitive-change`, `ui-change`, `infra-change`
2. **MUST** gather class-required context before editing files
3. **MUST** record assumptions and impact analysis before implementation
4. **MUST** plan documentation/spec updates when interfaces or behavior change
5. **MUST** run constitution alignment checks relevant to the change

### Required Behavioral Rules

- **Up-to-date docs first**: For `external-api-change`, use Context7 when available. If unavailable, use official primary documentation and record what was used.
- **Cross-component impact first**: For `cross-component-change`, map dependencies and affected components before edits.
- **Code usage analysis first**: For business logic/contract changes, inspect existing usage and edge cases before implementation.
- **Docs sync by default**: If behavior or interfaces change, update docs/specs in the same PR or explicitly justify deferral.

### Speckit and Non-Speckit Enforcement

- **Non-Speckit tasks**: Complete full preflight at task start before any code edits.
- **Speckit tasks**: Complete preflight before `/speckit.plan`, and re-run preflight before `/speckit.implement`.

### PR Evidence Requirement

All AI-authored PRs MUST include preflight evidence using the block in `.github/pull_request_template.md`.
CI validates this evidence on pull requests.

---

# Simple Agent Manager (SAM)

A serverless platform to spin up AI coding agent environments on-demand with zero ongoing cost.

## Project Overview

This is a monorepo containing a Cloudflare-based platform for managing ephemeral Claude Code workspaces. Users can create cloud VMs with Claude Code pre-installed from any git repository, access them via a web-based interface, and have them automatically terminate when idle.

## Tech Stack

- **Runtime**: Cloudflare Workers (API), Cloudflare Pages (UI)
- **Language**: TypeScript 5.x
- **Framework**: Hono (API), React + Vite (UI)
- **Cloud Provider**: Hetzner Cloud (VMs)
- **DNS**: Cloudflare DNS API
- **Testing**: Vitest + Miniflare
- **Monorepo**: pnpm workspaces + Turborepo

## Repository Structure

```
apps/
├── api/          # Cloudflare Worker API (Hono)
└── web/          # Control plane UI (React + Vite)

packages/
├── shared/       # Shared types and utilities
├── providers/    # Cloud provider abstraction (Hetzner)
├── terminal/     # Shared terminal component (@simple-agent-manager/terminal)
├── cloud-init/   # Cloud-init template generator
└── vm-agent/     # Go VM agent (PTY, WebSocket, idle detection)

scripts/
└── vm/           # VM-side scripts (cloud-init, idle detection)

tasks/            # Task tracking (backlog -> active -> archive)
specs/            # Feature specifications
docs/             # Documentation
```

## Task Tracking

Tasks are tracked as markdown files in `tasks/`. See `tasks/README.md` for the full system.

- **`tasks/backlog/`** — Tasks waiting to be worked on
- **`tasks/active/`** — Tasks currently in progress (with checklists, implementation notes)
- **`tasks/archive/`** — Completed tasks (moved here when both human and agent agree work is done)

Task files use the naming convention: `YYYY-MM-DD-descriptive-name.md`

Task file template and conventions are defined in `tasks/README.md`.

## Development Approach

**This project uses a Cloudflare-first development approach.** Per the constitution:

> "No complex local testing setups. Iterate directly on Cloudflare infrastructure."

### Recommended Workflow

1. **Make changes locally** — Use your IDE, run lint/typecheck
2. **Deploy to staging** — Via GitHub Actions or `pnpm deploy:setup --environment staging`
3. **Test on Cloudflare** — Real D1, real KV, real Workers
4. **Merge to main** — Triggers production deployment

### Local Dev Limitations (NOT Recommended for Testing)

Running `pnpm dev` starts local emulators but has significant limitations:
- No real GitHub OAuth (callbacks won't work)
- No real DNS (workspace URLs won't resolve)
- No real VMs (workspaces can't be created)
- D1/KV emulation may differ from production

**For any meaningful testing, deploy to staging.** See `docs/guides/local-development.md`.

### Playwright Artifacts (Development)

Store all Playwright screenshots from development and verification runs in `.codex/tmp/playwright-screenshots/` (gitignored). Do not save screenshots in tracked directories.

### Live Test Resource Cleanup (Required)

When Playwright or manual live-app verification creates test workspaces or nodes:
- Use only newly created test resources for that verification run
- Do not mutate long-lived/legacy resources
- Delete test workspaces and test nodes after verification is complete

## Common Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Run development servers (LIMITED - see above)
pnpm test             # Run tests
pnpm build            # Build all packages
pnpm typecheck        # Type check
pnpm lint             # Lint
pnpm format           # Format
```

## Deployment

**Continuous Deployment:** Merge to `main` automatically deploys to production.

### Configuration (GitHub Environment)

All configuration lives in **GitHub Settings -> Environments -> production**:

| Type | Name | Required |
|------|------|----------|
| Variable | `BASE_DOMAIN` | Yes |
| Variable | `RESOURCE_PREFIX` | No (default: `sam`) |
| Variable | `PULUMI_STATE_BUCKET` | No (default: `sam-pulumi-state`) |
| Secret | `CF_API_TOKEN` | Yes |
| Secret | `CF_ACCOUNT_ID` | Yes |
| Secret | `CF_ZONE_ID` | Yes |
| Secret | `R2_ACCESS_KEY_ID` | Yes |
| Secret | `R2_SECRET_ACCESS_KEY` | Yes |
| Secret | `PULUMI_CONFIG_PASSPHRASE` | Yes |
| Secret | `GH_CLIENT_ID` | Yes |
| Secret | `GH_CLIENT_SECRET` | Yes |
| Secret | `GH_APP_ID` | Yes |
| Secret | `GH_APP_PRIVATE_KEY` | Yes |
| Secret | `GH_APP_SLUG` | Yes |
| Secret | `ENCRYPTION_KEY` | No (auto-generated) |
| Secret | `JWT_PRIVATE_KEY` | No (auto-generated) |
| Secret | `JWT_PUBLIC_KEY` | No (auto-generated) |

### GitHub Actions Workflows

- **CI** (`ci.yml`): Runs on all pushes/PRs — lint, typecheck, test, build
- **Deploy** (`deploy.yml`): Runs on push to main — full Pulumi + Wrangler deployment
- **Teardown** (`teardown.yml`): Manual only — destroys all resources (type "DELETE" to confirm)

## Key Concepts

- **Workspace**: An AI coding environment (VM + devcontainer + Claude Code)
- **Node**: A VM host that can run multiple workspaces
- **Provider**: Cloud infrastructure abstraction (currently Hetzner only)
- **CloudCLI**: Web-based Claude Code interface (file explorer + terminal)
- **Lifecycle Control**: Workspaces/nodes are stopped, restarted, or deleted explicitly via API/UI actions
- **OAuth Authentication**: Claude Code supports both API keys and OAuth tokens from Claude Max/Pro subscriptions

## API Endpoints

### Node Management
- `POST /api/nodes` — Create node
- `GET /api/nodes` — List user's nodes
- `GET /api/nodes/:id` — Get node details
- `POST /api/nodes/:id/stop` — Stop node
- `DELETE /api/nodes/:id` — Delete node
- `GET /api/nodes/:id/events` — List node events

### Workspace Management
- `POST /api/workspaces` — Create workspace
- `GET /api/workspaces` — List user's workspaces
- `GET /api/workspaces/:id` — Get workspace details
- `PATCH /api/workspaces/:id` — Rename workspace display name
- `POST /api/workspaces/:id/stop` — Stop a running workspace
- `POST /api/workspaces/:id/restart` — Restart a workspace
- `DELETE /api/workspaces/:id` — Delete a workspace
- `GET /api/workspaces/:id/events` — List workspace events

### Agent Sessions
- `GET /api/workspaces/:id/agent-sessions` — List workspace agent sessions
- `POST /api/workspaces/:id/agent-sessions` — Create agent session
- `POST /api/workspaces/:id/agent-sessions/:sessionId/stop` — Stop agent session

### VM Communication
- `POST /api/nodes/:id/ready` — Node Agent ready callback
- `POST /api/nodes/:id/heartbeat` — Node Agent heartbeat callback
- `POST /api/workspaces/:id/ready` — Workspace ready callback
- `POST /api/workspaces/:id/provisioning-failed` — Workspace provisioning failure callback (sets workspace to `error`)
- `POST /api/workspaces/:id/heartbeat` — Workspace activity heartbeat callback
- `GET /api/workspaces/:id/runtime` — Workspace runtime metadata callback (repository/branch for recovery)
- `POST /api/workspaces/:id/boot-log` — Workspace boot progress log callback
- `POST /api/bootstrap/:token` — Redeem one-time bootstrap token (credentials + git identity)
- `POST /api/agent/ready` — VM agent ready callback
- `POST /api/agent/activity` — VM agent activity report

### Terminal Access
- `POST /api/terminal/token` — Get terminal WebSocket token

### Authentication (BetterAuth)
- `POST /api/auth/sign-in/social` — GitHub OAuth login
- `GET /api/auth/session` — Get current session
- `POST /api/auth/sign-out` — Sign out

### Credentials
- `GET /api/credentials` — Get user's cloud provider credentials
- `POST /api/credentials` — Save cloud provider credentials
- `DELETE /api/credentials/:provider` — Delete stored cloud provider credential

### GitHub Integration
- `GET /api/github/installations` — List user's GitHub App installations
- `GET /api/github/repositories` — List accessible repositories

## Troubleshooting

### Build Errors
Run builds in dependency order:
```bash
pnpm --filter @simple-agent-manager/shared build
pnpm --filter @simple-agent-manager/providers build
pnpm --filter @simple-agent-manager/api build
```

### Test Failures
Check if Miniflare bindings are configured in `vitest.config.ts`.

### Type Errors
Run `pnpm typecheck` from root to see all issues.

## Agent Authentication

### Claude Code OAuth Support

Claude Code now supports dual authentication methods:

1. **API Keys**: Traditional pay-per-use API keys from Anthropic Console
2. **OAuth Tokens**: Tokens from Claude Max/Pro subscriptions via `claude setup-token`

#### Using OAuth Tokens

1. Generate a token on your local machine: `claude setup-token`
2. In SAM Settings, select "OAuth Token (Pro/Max)" for Claude Code
3. Paste the token and save
4. The system automatically injects `CLAUDE_CODE_OAUTH_TOKEN` instead of `ANTHROPIC_API_KEY`

#### Credential Switching

- Users can store both an API key and OAuth token
- Toggle between them in Settings
- New credentials auto-activate by default
- Delete specific credential types via the API

---

## Development Guidelines

### Claude Subagents and Codex Skills

- Claude Code subagents live in `.claude/agents/`.
- Codex discovers repo-local skills in `.agents/skills/<skill-name>/SKILL.md`.
- This repo exposes the Claude subagents to Codex via wrapper skills in `.agents/skills/`.
- `SKILL.md` contains Codex-valid frontmatter and brief usage instructions.
- `CLAUDE_AGENT.md` points to the source subagent definition in `.claude/agents/`.
- Keep `.claude/agents/*/*.md` as the source of truth. Do not add Claude-specific frontmatter keys (e.g. `tools`, `model`) to `SKILL.md` files.

### No Legacy / Dead Code

- This project is pre-production. Do not keep "legacy" code paths that are not used.
- If code, files, routes, scripts, or configs are no longer referenced by the active architecture, remove them in the same change.
- When replacing an implementation, update all related docs and instructions to point only to the current path.

### Adding New Features

1. Check if types need to be added to `packages/shared`
2. If provider-related, add to `packages/providers`
3. API endpoints go in `apps/api/src/routes/`
4. UI components go in `apps/web/src/components/`

### Post-Push CI Procedure (Required)

- After every push, check GitHub Actions runs for the pushed commit/branch.
- If any workflow fails, inspect the failing job logs immediately and implement fixes.
- Push follow-up commits and repeat until all required workflows are green.
- For pull requests, keep the PR template filled (including Agent Preflight block) so quality gates can pass.

### Post-Deployment Playwright Testing (Required)

**After ANY deployment to production (push to main or merged PR), you MUST verify the deployed feature works using Playwright against the live app.**

1. Wait for the Deploy workflow to complete successfully in GitHub Actions.
2. Use Playwright to navigate to `app.simple-agent-manager.org` and test the deployed feature end-to-end.
3. Use the test credentials stored at `/workspaces/.tmp/secure/demo-credentials.md` to authenticate. If the file is missing, ask the human for credentials and write them to that path before testing.
4. If the feature cannot be tested via Playwright (e.g., requires external service interaction), document why and what was verified manually.
5. Report results to the user — do not assume deployment success just because CI passed.
6. During development Playwright runs, store screenshots in `.codex/tmp/playwright-screenshots/` (gitignored). Do not write screenshots to tracked directories.
7. For Playwright verification that needs live resources, create fresh test workspaces/nodes and clean them up when testing is complete (delete test workspaces, then delete test nodes if empty).
8. Do not repurpose or modify old/long-lived workspaces or nodes for validation; only use newly created test resources for the current run.

### Error Handling

All API errors should follow this format:

```typescript
{
  error: "error_code",
  message: "Human-readable description"
}
```

**CRITICAL: Hono Error Handler Pattern**

Use `app.onError()` for error handling — **NEVER** use middleware try/catch. Hono's `app.route()` subrouter errors do NOT propagate to parent middleware try/catch blocks, causing unhandled errors to return plain text "Internal Server Error" from the Workers runtime instead of JSON.

```typescript
// CORRECT — catches errors from ALL routes including subrouters
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.statusCode);
  }
  return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
});

// WRONG — subrouter errors silently bypass this
app.use('*', async (c, next) => {
  try { await next(); } catch (err) { /* NEVER REACHED for subrouter errors */ }
});
```

Throw `AppError` (from `middleware/error.ts`) in route handlers — the global `app.onError()` handler catches them.

### Environment Variables

Workers secrets are set via:

```bash
wrangler secret put SECRET_NAME
```

Local development uses `.dev.vars`.

**Note**: Hetzner tokens are NOT platform secrets. Users provide their own tokens through the Settings UI, stored encrypted per-user in the database. See `docs/architecture/credential-security.md`.

### Development Environment Variables

See `apps/api/.env.example`:
- `WRANGLER_PORT` - Local dev port (default: 8787)
- `BASE_DOMAIN` - Set automatically by sync scripts
- `MAX_NODES_PER_USER` - Optional runtime node cap
- `MAX_WORKSPACES_PER_USER` - Optional runtime workspace cap
- `MAX_WORKSPACES_PER_NODE` - Optional runtime per-node workspace cap
- `MAX_AGENT_SESSIONS_PER_WORKSPACE` - Optional runtime session cap
- `NODE_HEARTBEAT_STALE_SECONDS` - Optional staleness threshold for node health
- `NODE_AGENT_READY_TIMEOUT_MS` - Optional max wait for freshly provisioned node-agent health before first workspace create
- `NODE_AGENT_READY_POLL_INTERVAL_MS` - Optional polling interval for fresh-node readiness checks

## Testing

**Test credentials** for the live app (`app.simple-agent-manager.org`) are stored at `/workspaces/.tmp/secure/demo-credentials.md` (outside this git repository). This path is intentionally outside the repo so credentials cannot be committed. If the file is missing or outdated, ask the human for the latest credentials, update that file, and then continue Playwright testing.

**Playwright screenshots (development):** Save all screenshots to `.codex/tmp/playwright-screenshots/` only. This path is gitignored via `.codex/tmp/`.

**Live test cleanup (required):** When automated/manual verification creates test nodes or workspaces, delete those test resources before marking the task complete. Do not alter pre-existing legacy resources during validation.

## UI Agent Rules

For UI changes in `apps/web`, `packages/vm-agent/ui`, or `packages/ui`:

1. Prefer shared components from `@simple-agent-manager/ui` when available.
2. Use semantic tokens from `packages/ui/src/tokens/semantic-tokens.ts` and CSS vars from `packages/ui/src/tokens/theme.css`.
3. Maintain mobile-first behavior:
   - single-column baseline at small widths
   - primary action target minimum 56px on mobile
   - no required horizontal scrolling at 320px for core flows
4. Preserve accessibility:
   - keyboard-accessible interactions
   - visible focus states
   - clear non-color-only status communication
5. If a shared component is missing, either:
   - add/extend it in `packages/ui`, or
   - document a temporary exception with rationale and expiration.

## Active Technologies
- **API**: TypeScript 5.x, Hono, Drizzle ORM, BetterAuth, jose, Cloudflare Workers
- **Web**: TypeScript 5.x, React 18, Vite 5, TailwindCSS, xterm.js 5.3, Radix UI, lucide-react
- **VM Agent**: Go 1.22+, creack/pty, gorilla/websocket, golang-jwt, modernc.org/sqlite
- **Storage**: Cloudflare D1 (SQLite), KV (sessions/tokens/boot logs), R2 (binaries/Pulumi state)
- **Infra**: Pulumi, Wrangler, @devcontainers/cli, pnpm 9.0+, Cloudflare Pages

## Recent Changes
- 014-multi-workspace-nodes: First-class Nodes with multi-workspace hosting, async provisioning (callback-driven `/ready` + `/provisioning-failed`), workspace recovery on attach, session tab UX with `+` dropdown, node-scoped routing/auth, explicit lifecycle control
- 014-multi-workspace-nodes: Default fallback devcontainer image changed to `mcr.microsoft.com/devcontainers/base:ubuntu`; bind-mount permission normalization before `devcontainer up`; fresh-node readiness probing with hard timeouts
- 014-auth-profile-sync: GitHub primary email resolved at login, propagated into workspace bootstrap for git commit identity
- 013-agent-oauth-support: Dual credential support for Claude Code (API key + OAuth token), credential switching, auto-activation
- 012-pty-session-persistence: PTY sessions survive page refresh with ring buffer replay and session reattach
