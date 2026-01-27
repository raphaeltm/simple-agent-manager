<!--
SYNC IMPACT REPORT
==================
Version Change: 1.2.0 → 1.3.0
Bump Rationale: MINOR - Added Self-Contained Deployment section, updated Distribution Strategy

Modified Principles: None
Modified Sections:
  - VM Agent Guidelines > Distribution Strategy: Changed from GitHub Releases to control plane serving

Added Sections:
  - Self-Contained Deployment (new)
    - Rationale for self-hostability
    - Rules for artifacts we build vs allowed external dependencies
    - Version consistency requirements

Templates Status:
  - plan-template.md: ✅ Compatible (Constitution Check section references this file)
  - spec-template.md: ✅ Compatible (no direct dependency)
  - tasks-template.md: ✅ Compatible (test-first aligns with Principle II)
  - checklist-template.md: ✅ Compatible (no direct dependency)

Follow-up TODOs: None
-->

# Cloud AI Coding Workspaces Constitution

## Core Principles

### I. Open Source Sustainability

The project is open source first. All core functionality MUST be available under an OSI-approved license
(MIT or Apache 2.0). Monetization pathways (hosted services, enterprise features, support contracts) are
encouraged but MUST NOT compromise the open source core.

**Rules:**
- Core platform functionality remains fully open source
- Enterprise/premium features, if any, MUST be clearly separated (e.g., `enterprise/` directory)
- Sustainability mechanisms (sponsorships, hosted offerings) are documented in ROADMAP.md
- No open-core bait-and-switch: features announced as OSS stay OSS

**Rationale:** Sustainable open source projects balance community contribution with maintainer viability.
Transparency about monetization builds trust.

### II. Infrastructure Stability (NON-NEGOTIABLE)

This is infrastructure software. Users depend on it for their AI coding environments. Reliability is
paramount. Bugs in this codebase can cause data loss, unexpected costs, or security vulnerabilities.

**Rules:**
- Test coverage MUST exceed 90% for critical paths (VM provisioning, DNS management, idle detection)
- Test coverage SHOULD exceed 80% overall
- TDD is REQUIRED for all critical paths: tests written → tests fail → implementation → tests pass
- All cloud provider API interactions MUST have integration tests against mock or sandbox environments
- Breaking changes require migration guides and deprecation warnings one minor version in advance
- No PR merges with failing tests or coverage regressions

**Rationale:** Infrastructure failures cascade. High test coverage is insurance against regression.

### III. Documentation Excellence

Every feature, API, and architectural decision MUST be documented. Documentation is a first-class
deliverable, not an afterthought.

**Rules:**
- Public APIs MUST have complete reference documentation with examples
- Every user journey has a corresponding guide in `/docs/guides/`
- Architecture decisions are recorded in `/docs/adr/` (Architecture Decision Records)
- All code comments reference relevant documentation: `// See docs/guides/idle-detection.md`
- README.md provides <5 minute quickstart for new users
- CHANGELOG.md follows Keep a Changelog format

**Rationale:** Good documentation reduces support burden, accelerates contributor onboarding, and
demonstrates project maturity.

### IV. Approachable Code & UX

Usability applies to both end users AND developers. The "happy path" should be delightful and obvious.
Code should read like well-written prose.

**Rules:**
- Default configuration works out-of-the-box for common use cases
- Error messages are actionable: explain what went wrong AND how to fix it
- Code follows single responsibility principle: one function/class does one thing
- Functions under 50 lines; files under 400 lines (excluding tests)
- Variable/function names are self-documenting; avoid abbreviations
- Complex logic MUST have inline comments explaining "why", not "what"
- UI interactions provide immediate feedback (loading states, confirmations)

**Rationale:** Approachable code invites contribution. Clear UX reduces friction and support requests.

### V. Transparent Roadmap

Project direction is visible in the repository. Contributors should understand what's planned, what's
in progress, and what's completed.

**Rules:**
- ROADMAP.md outlines phases, priorities, and target milestones
- GitHub Projects or Issues track work in progress
- Milestones group related issues for release planning
- Major features have corresponding spec documents in `/specs/`
- Completed features link to their implementing PRs

**Rationale:** Transparency enables community alignment and prevents duplicate effort.

### VI. Automated Quality Gates

Contributors MUST be guided toward success automatically. Humans shouldn't have to remember style rules
or run tests manually.

**Rules:**
- Pre-commit hooks enforce formatting and linting (Husky + lint-staged)
- CI runs on every PR: lint, typecheck, test, coverage check
- Branch protection requires passing CI and code review
- Commit messages follow Conventional Commits (enforced by commitlint)
- Dependabot or Renovate keeps dependencies current
- Security scanning (Trivy, npm audit) runs in CI

**Rationale:** Automation catches issues early and consistently, reducing review burden.

### VII. Inclusive Contribution

All contributions are welcome: code, documentation, bug reports, feature requests, translations,
design feedback. The project actively lowers barriers to entry.

**Rules:**
- CONTRIBUTING.md provides clear getting-started instructions
- Issues labeled `good-first-issue` exist for newcomers
- Code review feedback is constructive and educational
- No contribution is too small (typo fixes are valid contributions)
- Discussions and decisions happen in public (GitHub Issues/Discussions)
- Code of Conduct (Contributor Covenant) is enforced

**Rationale:** Diverse contributors strengthen the project. Inclusive practices expand the contributor pool.

### VIII. AI-Friendly Repository

AI coding agents (Claude Code, GitHub Copilot, Cursor) are first-class development tools. The repository
structure MUST help agents understand and contribute effectively.

**Rules:**
- CLAUDE.md at repository root provides agent-specific context (concise, universally applicable)
- AGENTS.md provides detailed build/test/convention instructions
- Each package MAY have its own AGENTS.md with package-specific context
- File and directory names are descriptive and predictable
- Code follows consistent patterns that agents can learn from existing code
- Comments reference documentation paths agents can follow
- Complex business logic is co-located, not scattered across files

**Rationale:** AI agents amplify developer productivity when given proper context. Investing in agent
ergonomics pays dividends.

### IX. Clean Code Architecture

Code is organized by domain responsibility. Domain logic, reusable utilities, and use-case specific
code are clearly separated.

**Rules:**
- Monorepo structure with pnpm workspaces + Turborepo:
  - `apps/` - Deployable applications (UI, API, workers)
  - `packages/` - Shared, reusable libraries (providers, cloud-init, shared types)
  - `scripts/` - VM-side scripts and tooling
  - `docs/` - Documentation
  - `specs/` - Feature specifications
- Dependencies flow inward: apps → packages, never packages → apps
- No circular dependencies between packages
- Each package has a clear, single purpose (documented in its README)
- Shared code is extracted only when used by 2+ consumers (no premature abstraction)

**Rationale:** Clear boundaries reduce cognitive load and enable independent testing and deployment.

### X. Simplicity & Clarity

Complexity is the enemy. Every abstraction, pattern, and dependency MUST justify its existence.

**Rules:**
- YAGNI: Don't build features until needed
- KISS: Prefer simple solutions; clever code is hard to debug
- New dependencies require justification in PR description
- Abstractions require 2+ concrete use cases before extraction
- Configuration has sensible defaults; advanced options are optional
- Architecture can be explained in a single diagram
- If something takes >30 minutes to understand, it needs refactoring or documentation

**Rationale:** Simple systems are easier to operate, debug, and extend. Complexity compounds over time.

## Code Organization Guidelines

### Repository Structure

```
cloud-ai-workspaces/
├── apps/
│   ├── web/                 # Control plane UI (Cloudflare Pages)
│   └── api/                 # Worker API (Cloudflare Workers + Hono)
├── packages/
│   ├── providers/           # Cloud provider abstraction (Hetzner, future: Scaleway)
│   ├── cloud-init/          # Cloud-init template generation
│   ├── dns/                 # DNS management utilities
│   ├── shared/              # Shared types and utilities
│   └── vm-agent/            # VM Agent (Go binary with embedded React UI)
│       ├── main.go          # Entry point
│       ├── embed.go         # //go:embed ui/dist/*
│       ├── internal/        # Go packages (auth, pty, server)
│       ├── ui/              # React app (compiled into binary)
│       └── Makefile         # Build commands
├── scripts/
│   └── vm/                  # VM-side scripts (idle-check, setup)
├── docs/
│   ├── guides/              # User guides
│   ├── adr/                 # Architecture Decision Records
│   └── api/                 # API reference
├── specs/                   # Feature specifications
├── .github/
│   ├── workflows/           # CI/CD pipelines
│   └── ISSUE_TEMPLATE/      # Issue templates
├── CLAUDE.md                # AI agent context
├── AGENTS.md                # Detailed agent instructions
├── CONTRIBUTING.md          # Contribution guide
├── ROADMAP.md               # Project roadmap
└── README.md                # Project overview and quickstart
```

### Naming Conventions

- **Files**: kebab-case (`idle-check.ts`, `hetzner-provider.ts`)
- **Directories**: kebab-case (`cloud-init/`, `dns-manager/`)
- **Classes/Types**: PascalCase (`HetznerProvider`, `WorkspaceConfig`)
- **Functions/Variables**: camelCase (`createWorkspace`, `idleThreshold`)
- **Constants**: SCREAMING_SNAKE_CASE (`DEFAULT_IDLE_MINUTES`, `API_VERSION`)
- **Test files**: `*.test.ts` co-located with source or in `__tests__/`

## Infrastructure as Code Guidelines

This project manages cloud infrastructure (Cloudflare Workers, Pages, R2, KV, DNS) and VM provisioning
(Hetzner Cloud). All infrastructure MUST be declarative, version-controlled, and reproducible.

### IaC Tooling Strategy

**Primary Tool: Wrangler**
- All Cloudflare resources (Workers, Pages, R2, KV, D1) are managed via `wrangler.toml`
- `wrangler.toml` is version-controlled and the source of truth for deployments
- Use Wrangler's auto-provisioning for R2/KV/D1 (no manual resource creation)
- Deployments happen via `wrangler deploy` in CI/CD

**Secondary Tool: Pulumi/Terraform (Optional)**
- Use only when Wrangler cannot manage a resource (e.g., complex DNS rules, external services)
- Infrastructure code lives in `infra/` directory if needed
- Prefer Wrangler simplicity over Pulumi/Terraform complexity when possible

**Rules:**
- All infrastructure changes go through PR review (no manual console changes)
- Infrastructure drift is checked quarterly (compare deployed state vs config)
- Never use `--force` or bypass flags without documented justification

### Environment Management

Three environments with clear separation:

| Environment | Wrangler Command | Purpose |
|-------------|-----------------|---------|
| Development | `wrangler dev` | Local development with hot reload |
| Staging | `wrangler deploy --env staging` | Pre-production testing |
| Production | `wrangler deploy` | Live user-facing deployment |

**Rules:**
- Environment-specific config uses `[env.staging]` sections in `wrangler.toml`
- Environment variables differ by environment (documented in README)
- Never deploy directly to production without staging verification
- Database migrations tested in staging before production

### Secrets Management

Secrets are sensitive values (API keys, tokens, passwords) that MUST NOT be exposed.

**Rules:**
- NEVER hardcode secrets in source code, config files, or commit history
- Use Cloudflare Workers secrets: `wrangler secret put SECRET_NAME`
- Local development uses `.dev.vars` file (gitignored)
- Document all required secrets in README with descriptions (not values)
- Secrets follow principle of least privilege (minimal required permissions)
- Rotate secrets on suspected compromise; schedule rotation for long-lived secrets

**Secret Files (gitignored):**
```
.dev.vars          # Local Cloudflare Workers secrets
.env               # General environment variables
.env.local         # Local overrides
*.pem              # Private keys
*credentials*      # Any credential files
```

**Required Secrets Documentation (in README):**
```markdown
## Required Secrets

| Secret Name | Description | Where to Get |
|-------------|-------------|--------------|
| HETZNER_TOKEN | Hetzner Cloud API token | Hetzner console → API tokens |
| CF_API_TOKEN | Cloudflare API token | Cloudflare dashboard → API tokens |
| ANTHROPIC_API_KEY | User-provided per workspace | User provides |
```

### Resource Naming Conventions

Consistent naming enables identification and automation:

| Resource Type | Pattern | Example |
|---------------|---------|---------|
| Workers | `{project}-{env}` | `cloud-ai-workspaces-staging` |
| KV Namespaces | `{project}-{env}-{purpose}` | `cloud-ai-workspaces-prod-sessions` |
| R2 Buckets | `{project}-{env}-{purpose}` | `cloud-ai-workspaces-prod-backups` |
| D1 Databases | `{project}-{env}` | `cloud-ai-workspaces-staging` |
| DNS Records | `*.{vm-id}.vm.{domain}` | `*.abc123.vm.example.com` |
| Hetzner VMs | `ws-{workspace-id}` | `ws-abc123` |

**Rules:**
- All names lowercase with hyphens (no underscores or camelCase)
- Include environment in name for clarity
- VM labels include `managed-by: cloud-ai-workspaces` for filtering

### Cloud-Init Scripts

Cloud-init scripts configure VMs on first boot. They live in `scripts/vm/`.

**Rules:**
- Scripts MUST be idempotent (safe to run multiple times)
- Use template variables for dynamic values: `${VARIABLE_NAME}`
- Test scripts in Docker before deploying to cloud
- Log all significant actions for debugging
- Include error handling with descriptive messages
- Scripts are versioned and tagged with releases

**Script Structure:**
```bash
#!/bin/bash
set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Logging function
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "Starting cloud-init script v${SCRIPT_VERSION}"

# ... script body ...

log "Cloud-init completed successfully"
```

### Infrastructure Testing

Infrastructure changes require testing before production deployment.

**Testing Levels:**
1. **Local**: `wrangler dev` for Worker logic testing
2. **Unit Tests**: Mock cloud provider APIs in `packages/providers/`
3. **Integration Tests**: Deploy to staging, verify end-to-end
4. **Cloud-Init Tests**: Run scripts in Docker container locally

**Rules:**
- All provider API interactions have mock-based unit tests
- Critical paths (VM creation, DNS management) have integration tests
- Cloud-init scripts tested in Docker before cloud deployment
- Staging deployment required before production for infrastructure changes

### Deployment & Rollback

**Deployment Process:**
1. Merge to `main` triggers CI/CD
2. CI runs tests, lint, typecheck
3. CI deploys to staging automatically
4. Manual promotion to production after staging verification
5. Production deployment creates immutable version in Cloudflare

**Rollback Procedures:**
- Cloudflare maintains version history; rollback via dashboard or API
- For critical issues: `wrangler rollback` to previous version
- Database rollbacks require migration scripts (test in staging first)
- Document rollback steps in runbooks for each component

**Rules:**
- Never delete previous versions immediately after deployment
- Gradual rollouts for high-risk changes (Cloudflare supports percentage-based)
- Incident response: rollback first, investigate second
- Post-incident: document root cause and prevention in ADR

## Multi-Tenant Architecture Guidelines

This platform operates as a multi-tenant SaaS where users bring their own cloud credentials. We manage
authentication, orchestration, and workspace metadata while users retain ownership of their infrastructure.

### Data Ownership Model

**What We Store (Cloudflare D1/KV):**
- User profiles (from GitHub OAuth)
- User's Hetzner API tokens (AES-GCM encrypted with per-user initialization vectors)
- Workspace metadata (name, repo, status, VM ID, DNS record ID)
- JWT signing keys
- Sessions and rate limiting data

**What We DON'T Store:**
- VMs (created on user's Hetzner account, billed to them)
- Code (lives on Git provider and in user's VMs)

**Rules:**
- Users MUST be able to delete all their data via account deletion
- Encrypted credentials use AES-GCM with unique IVs per credential
- Workspace metadata is soft-deleted first, hard-deleted after 30 days
- Users can revoke their Hetzner token at any time (workspaces stop working)

### User Credential Security

**Rules:**
- NEVER log or expose decrypted credentials in error messages
- Credentials are decrypted only at point of use (just-in-time)
- Encryption key is a Worker secret, never in source code
- Failed decryption attempts are logged for security monitoring
- Credential rotation: users can update their Hetzner token without recreating workspaces

### Privacy Principles

**Rules:**
- User's code never passes through our control plane (direct GitHub ↔ VM)
- We cannot access running VMs (no SSH keys, no backdoors)
- Workspace URLs are unique per workspace, not guessable
- Idle detection and cleanup happens on the VM, not via our monitoring

## Authentication Architecture

Authentication is a first-class concern, not an afterthought. No "simple API key" shortcuts.

### Git Provider OAuth

We use [BetterAuth](https://better-auth.com) with [better-auth-cloudflare](https://github.com/zpg6/better-auth-cloudflare)
for Cloudflare-native authentication. OAuth with Git providers serves dual purposes: user authentication
AND repository access.

**Supported Providers:**
- GitHub (primary, implemented first)
- GitLab (future)
- Bitbucket (future)

**OAuth Scopes (GitHub example):**
- `read:user` - User profile information
- `user:email` - User email addresses
- `repo` - Full repository access (read/write, list repos)

**Rules:**
- Git provider OAuth is the ONLY authentication method (no email/password)
- OAuth tokens are stored encrypted in D1 (enables repo listing, cloning, pushing)
- Token refresh is handled automatically by BetterAuth
- BetterAuth manages sessions via Cloudflare KV
- BetterAuth auto-generates database tables (users, sessions, accounts)
- Rate limiting is enabled by default (100 requests/minute per IP)
- All auth routes are under `/api/auth/*`
- Design for multiple providers: abstract Git operations behind provider interface

**Configuration Pattern:**
```typescript
// apps/api/src/auth.ts
import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";

export function createAuth(env: CloudflareBindings, cf?: IncomingRequestCfProperties) {
    return betterAuth({
        ...withCloudflare({
            d1: { db: drizzle(env.DATABASE), options: { usePlural: true } },
            kv: env.KV,
        }, {
            socialProviders: {
                github: {
                    clientId: env.GITHUB_CLIENT_ID,
                    clientSecret: env.GITHUB_CLIENT_SECRET,
                    scope: ["read:user", "user:email", "repo"],
                },
                // Future: gitlab, bitbucket
            },
        }),
    });
}
```

**Git Token Flow:**
1. User authenticates via OAuth (e.g., GitHub)
2. We receive access token with `repo` scope
3. Token is encrypted and stored in D1 (linked to user account)
4. When creating workspace, token is decrypted and passed to VM via cloud-init
5. VM uses token for git clone/push (credential helper pattern)
6. Token can be refreshed via OAuth refresh flow

### JWT Terminal Authentication

Terminal access uses short-lived JWTs issued by the control plane and validated by VM Agents.

**Rules:**
- JWTs are RS256 signed (RSA 2048-bit minimum)
- Token lifetime: 1 hour maximum
- JWKS endpoint: `/.well-known/jwks.json` (cached, supports key rotation)
- JWT claims MUST include: `sub` (user ID), `workspace` (workspace ID), `exp`, `iss`, `aud`
- VM Agents fetch JWKS on startup and cache for 1 hour
- Token is passed via URL parameter on redirect, then exchanged for session cookie

**Terminal Access Flow:**
1. User clicks "Open Terminal" in control plane UI
2. Control plane validates session, verifies workspace ownership
3. Control plane issues JWT with workspace claim
4. Redirect to `https://ws-{id}.domain.com/?token=JWT`
5. VM Agent validates JWT against JWKS
6. VM Agent issues session cookie, proxies to terminal

### Session Management

**Rules:**
- Control plane sessions: managed by BetterAuth in Cloudflare KV
- VM Agent sessions: simple cookie with HMAC signature
- Session cookies are `HttpOnly`, `Secure`, `SameSite=Strict`
- VM Agent session lifetime: 8 hours (user must re-auth from control plane after)

## VM Agent Guidelines

The VM Agent is a single Go binary that runs on the VM host, serving the terminal UI and managing
PTY sessions. It does NOT run in Docker.

### Single Binary Architecture

**Why Go:**
- Single static binary, no runtime dependencies
- Cross-compiles to linux/amd64 and linux/arm64
- Fast startup (milliseconds)
- Excellent PTY and WebSocket support

**Rules:**
- The agent is ONE binary with embedded UI (no separate processes)
- No ttyd dependency (agent handles PTY directly)
- No Docker for the agent (runs on VM host)
- Binary size target: <20MB uncompressed, <8MB with UPX compression

### Embedded UI Pattern

The React UI is compiled into the Go binary using Go's `embed` package.

**Build Process:**
```makefile
build: ui
    go build -o bin/vm-agent .

ui:
    cd ui && pnpm install && pnpm build
```

**Rules:**
- UI source lives in `packages/vm-agent/ui/`
- UI is built before Go compilation
- `//go:embed ui/dist/*` embeds the built assets
- No external static file serving (everything in binary)

### PTY Management

**Rules:**
- Use `github.com/creack/pty` for PTY spawning
- Shell command: `devcontainer exec --workspace-folder /workspace bash`
- Support terminal resize (SIGWINCH handling)
- Multiple concurrent sessions per workspace
- Clean session teardown on disconnect

**WebSocket Protocol:**
- Use `github.com/gorilla/websocket`
- Binary frames for terminal I/O
- JSON frames for control messages (resize, heartbeat)
- Heartbeat every 30 seconds, timeout after 90 seconds

### Distribution Strategy

**Rules:**
- Build via goreleaser automation for multi-arch: `vm-agent-linux-amd64`, `vm-agent-linux-arm64`
- Binaries are embedded in or served by the control plane (NOT downloaded from GitHub at runtime)
- Download in cloud-init from control plane: `curl -Lo /usr/local/bin/vm-agent $API_URL/agent/download?arch=amd64`
- Run as systemd service with auto-restart
- Environment config via `/etc/workspace/agent.env`
- Version MUST match control plane version (enforced by serving from same deployment)

## Self-Contained Deployment

The platform MUST be deployable without external runtime dependencies beyond the user's cloud providers.
This enables self-hosting in air-gapped or restricted environments and ensures version consistency.

### Rationale

1. **Self-Hostability**: Users deploying their own instance should not depend on our GitHub releases
2. **Version Alignment**: Control plane and VM Agent versions MUST always match to prevent compatibility issues
3. **Reliability**: No third-party service (GitHub, CDNs) can cause runtime failures
4. **Security**: Air-gapped deployments can verify all artifacts come from their own infrastructure

### Rules

**Artifacts We Build:**
- VM Agent binary MUST be served from the control plane, not external sources
- Cloud-init scripts MUST be generated by or served from the control plane
- No hardcoded URLs to GitHub, npm, or CDNs for OUR artifacts

**Allowed External Dependencies:**
- User's Git provider (GitHub, GitLab, etc.) - required for repository access
- Container registries (Docker Hub, GHCR) - required for devcontainer images
- OS package repositories (apt, apk) - required for system packages
- User's cloud provider APIs (Hetzner, etc.) - required for VM provisioning

**Version Consistency:**
- Control plane MUST serve VM Agent binaries that match its deployed version
- Cloud-init MUST request the correct architecture binary from control plane
- VM Agent MUST report its version; control plane MAY reject outdated agents

## Development Workflow

### Cloudflare-First Development

**Philosophy:** No complex local testing setups. Iterate directly on Cloudflare infrastructure.

**Rationale:** This project has many moving pieces (Workers, D1, KV, DNS, VMs, VM Agent). Setting up
a realistic local environment is impractical. Instead, we deploy frequently to staging and test there.

**Rules:**
- `pnpm dev` starts local development servers (Workers miniflare, Vite)
- `pnpm deploy:staging` deploys everything to Cloudflare staging
- `pnpm deploy` deploys to production
- `pnpm teardown:staging` destroys staging environment completely
- First-time setup: `pnpm setup` (interactive, sets secrets)

**Deploy Script Requirements:**
- Idempotent (safe to run multiple times)
- Creates D1 database if missing
- Creates KV namespace if missing
- Runs database migrations
- Deploys Workers and Pages
- Reports URLs on completion

**Teardown Script Requirements:**
- Requires confirmation (destructive action)
- Deletes Workers, Pages, D1, KV
- Does NOT delete secrets (they're reset on next setup)

### Branch Strategy

- `main` - Production-ready code; protected branch
- `001-feature-name` - Feature branches (numbered for tracking)
- Release tags: `v1.0.0`, `v1.1.0`, etc.

### Pull Request Process

1. Create feature branch from `main`
2. Implement with tests (TDD for critical paths)
3. Ensure CI passes (lint, typecheck, test, coverage)
4. Request review from at least one maintainer
5. Address feedback; avoid force-push after review starts
6. Squash merge to `main` with Conventional Commit message

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`

Examples:
- `feat(api): add workspace creation endpoint`
- `fix(providers): handle Hetzner rate limiting`
- `docs(readme): add quickstart guide`

### Release Process

1. Create release branch or tag from `main`
2. Update CHANGELOG.md with release notes
3. Bump version in package.json files
4. Create GitHub Release with changelog excerpt
5. CI deploys to production on release tag

## Governance

### Constitution Authority

This Constitution is the authoritative source for project standards. In conflicts between this document
and other project documentation, this Constitution takes precedence.

### Amendment Process

1. Create issue proposing amendment with rationale
2. Allow 7 days for community discussion
3. Create PR with proposed changes
4. Require approval from 2+ maintainers
5. Increment version according to semantic versioning:
   - MAJOR: Principle removal or fundamental redefinition
   - MINOR: New principle or substantial expansion
   - PATCH: Clarifications, typo fixes, non-semantic changes

### Compliance Review

- All PRs SHOULD be checked against relevant principles
- Architectural changes MUST demonstrate Constitution compliance
- Quarterly review of Constitution relevance (add to ROADMAP.md)

### Enforcement

- Maintainers are responsible for enforcing Constitution compliance
- Violations should be addressed constructively with reference to specific principles
- Repeated violations may result in contribution restrictions per Code of Conduct

**Version**: 1.3.0 | **Ratified**: 2026-01-24 | **Last Amended**: 2026-01-26
