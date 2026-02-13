# Factual Claims in Simple Agent Manager Documentation

This document catalogs every factual claim made in markdown documentation across the Simple Agent Manager (SAM) repository, organized by category and topic. Claims are extracted from user-facing docs, agent-facing instructions, architectural decisions, and specifications.

## Project Identity & Mission

### Core Value Proposition
- SAM is a serverless platform for creating ephemeral cloud development environments optimized for Claude Code
- SAM enables spinning up AI coding environments on-demand with zero cost when idle
- Think "GitHub Codespaces, but built for AI-assisted development" with automatic shutdown to eliminate surprise bills
- The platform is pre-production and not ready for use (README.md warning)
- SAM is described as "fully vibe coded, with some code review, but not a lot yet" and "has not yet been tested"

## Technology Stack

### Runtime & Framework Stack
- **API Runtime**: Cloudflare Workers
- **API Framework**: Hono (TypeScript)
- **Web UI**: React + Vite
- **Cloud Provider**: Hetzner Cloud VMs
- **DNS**: Cloudflare DNS API
- **Database**: Cloudflare D1 (SQLite) + KV (sessions) + R2 (binaries)
- **Testing**: Vitest + Miniflare
- **Monorepo**: pnpm workspaces + Turborepo
- **TypeScript version**: 5.x
- **Node.js version**: 20+
- **pnpm version**: 9+
- **Go version (VM Agent)**: 1.22+
- **Wrangler version**: 3.100+

### Component-Specific Technologies
- Terminal UI: xterm.js + WebSocket
- Authentication: BetterAuth with GitHub OAuth
- VM Agent: Go 1.22+ with creack/pty + gorilla/websocket + golang-jwt
- ORM: Drizzle ORM
- UI Styling: CSS Variables with semantic design tokens (no Tailwind) 🗑️
- Icons: lucide-react

## Architecture & Design Decisions

### Stateless Architecture Evolution
- Original MVP was designed to derive state from Hetzner server labels and Cloudflare DNS records (ADR-002)
- No database was required for MVP
- ADR-002 is now SUPERSEDED by current D1-based architecture
- Now uses Cloudflare D1 as primary database for workspace metadata, user sessions, and credentials

### Current Database Architecture
- Uses D1 (SQLite) for persistent data ✅
- Uses KV for bootstrap tokens (sessions are in D1) ✅
- Uses R2 for VM Agent binaries ✅
- Workspace state is managed in database with lifecycle: pending → creating → running → stopping → stopped ✅

### Monorepo Structure (ADR-001)
- Package dependencies flow: shared → providers → api/web ✅
- Build order matters: shared → providers → api/web ✅
- pnpm workspaces with Turborepo for build orchestration ✅
- Packages include: shared, providers, cloud-init, terminal, ui, vm-agent, acp-client ✅
- Additional directories: infra, scripts/deploy, specs ✅

### URL Construction Rules (CRITICAL)
- **Never use bare root domain** `https://${BASE_DOMAIN}/...` for redirects ✅
- **Web UI**: `https://app.${BASE_DOMAIN}/...` (e.g., `https://app.simple-agent-manager.org/settings`) ✅
- **API**: `https://api.${BASE_DOMAIN}/...` (e.g., `https://api.simple-agent-manager.org/health`) ✅
- **Workspace**: `https://ws-${id}.${BASE_DOMAIN}` (e.g., `https://ws-abc123.simple-agent-manager.org`) ✅
- All user-facing redirects MUST go to `app.${BASE_DOMAIN}` ✅
- All API-to-API references MUST use `api.${BASE_DOMAIN}` ✅
- Relative redirects in the API worker are WRONG and always a bug ✅

### GitHub App vs OAuth Decision (ADR-001)
- Uses GitHub App for repository access (not OAuth) ✅
- Short-lived installation tokens (1 hour expiry) ✅
- Users don't provide long-lived access tokens ✅
- Fine-grained permissions per repository ✅
- Higher rate limits (5000/hour per installation vs lower for OAuth) ✅
- Separate from GitHub OAuth used for user login ✅

### Bring-Your-Own-Cloud (BYOC) Model
- Platform does NOT have cloud provider credentials ✅
- Users provide their own Hetzner API tokens ✅
- Credentials stored encrypted per-user in D1 database
- Uses AES-GCM encryption with unique IV per credential
- Users pay Hetzner directly for VM costs

### Credential Security Architecture
- **Encryption**: AES-GCM with 12-byte IV ✅
- **Storage**: Encrypted in D1 `credentials` table per-user ✅
- **Access Pattern**: Always filtered by `user_id` ✅
- **Key Rotation**: Platform can rotate keys by re-encrypting all credentials
- What is NOT done: No Hetzner tokens in environment variables, Worker secrets, or logs

## Deployment & Configuration

### GitHub Actions Workflows
- **CI** (`ci.yml`): Runs on all pushes/PRs - lint, typecheck, test, build ✅
- **Deploy** (`deploy.yml`): Runs on push to main - full Pulumi + Wrangler deployment ✅
- **Teardown** (`teardown.yml`): Manual only - destroys all resources ✅

### Environment Variable Naming Rules
- **GitHub Secrets** use `GH_*` prefix (e.g., `GH_CLIENT_ID`) ✅
- **Cloudflare Worker code** reads `GITHUB_*` prefix (e.g., `GITHUB_CLIENT_ID`) ✅
- **Local .env files** use `GITHUB_*` prefix ✅
- **Deployment script** (`configure-secrets.sh`) maps: `GH_*` → `GITHUB_*` ✅
- This is because GitHub reserves `GITHUB_*` for its own use ✅

### Required Platform Secrets
- `ENCRYPTION_KEY` - Encrypt user credentials ✅
- `JWT_PRIVATE_KEY` - Sign auth tokens ✅
- `JWT_PUBLIC_KEY` - Verify auth tokens ✅
- `CF_API_TOKEN` - DNS operations ✅
- `CF_ZONE_ID` - DNS zone ✅
- `GITHUB_CLIENT_ID` - OAuth login ✅
- `GITHUB_CLIENT_SECRET` - OAuth login ✅
- `GITHUB_APP_ID` - Repo access ✅
- `GITHUB_APP_PRIVATE_KEY` - Repo access ✅
- `GITHUB_APP_SLUG` - GitHub App slug for install URL ✅

### Cloudflare Configuration Variables
- `BASE_DOMAIN` (required)
- `RESOURCE_PREFIX` (optional, default: `sam`)
- `PULUMI_STATE_BUCKET` (optional, default: `sam-pulumi-state`)
- Multiple secrets for API tokens and configuration

### Deployment Method
- **Pulumi** provisions infrastructure: D1, KV, R2, DNS ✅
- **Wrangler** deploys Workers and Pages ✅
- State stored in Cloudflare R2 (self-hosted, no Pulumi Cloud dependency) ✅
- Process: fork repo → create state bucket → configure secrets → run action → done ✅

## API Endpoints & Contracts

### Workspace Management Endpoints
- `POST /api/workspaces` - Create workspace ✅
- `GET /api/workspaces` - List user's workspaces ✅
- `GET /api/workspaces/:id` - Get workspace details ✅
- `POST /api/workspaces/:id/stop` - Stop a running workspace ✅
- `POST /api/workspaces/:id/restart` - Restart a workspace ✅
- `DELETE /api/workspaces/:id` - Delete a workspace (permanently) ✅
- `GET /api/workspaces/:id/ready` - Check workspace readiness ✅

### VM Communication Endpoints
- `POST /api/workspaces/:id/heartbeat` - VM heartbeat with idle detection ✅
- `POST /api/bootstrap/:token` - Redeem one-time bootstrap token ✅
- `POST /api/agent/ready` - VM agent ready callback 🗑️ (not implemented)
- `POST /api/agent/activity` - VM agent activity report 🗑️ (not implemented)

### Terminal Access Endpoints
- `POST /api/terminal/token` - Get terminal WebSocket token ✅
- `GET /.well-known/jwks.json` - JWKS for JWT verification ✅

### Authentication Endpoints
- `POST /api/auth/sign-in/social` - GitHub OAuth login ✅
- `GET /api/auth/session` - Get current session ✅
- `POST /api/auth/sign-out` - Sign out ✅

### Credentials Endpoints
- `GET /api/credentials` - Get user's credentials (encrypted) ✅
- `POST /api/credentials` - Save credentials ✅ (was incorrectly documented as PUT)

### GitHub Integration Endpoints
- `GET /api/github/installations` - List GitHub App installations ✅
- `GET /api/github/install-url` - Get GitHub App install URL ✅
- `GET /api/github/repositories` - List accessible repositories ✅
- `POST /api/github/webhook` - GitHub webhook handler ✅
- `GET /api/github/callback` - GitHub App OAuth callback ✅

### Agent Management Endpoints
- `GET /api/agent/download` - Download VM agent binary (query: os, arch) ✅
- `GET /api/agent/version` - Get current agent version ✅
- `GET /api/agent/install-script` - Get VM agent install script ✅

## Workspace Lifecycle & Features

### Workspace Status States
1. **pending** - Initial state ✅
2. **creating** - VM provisioning in progress ✅
3. **running** - Ready for use ✅
4. **stopping** - Shutdown in progress ✅
5. **stopped** - Stopped but can be restarted ✅
6. **error** - Provisioning failed ✅

### Idle Detection System
- Default idle timeout: 30 minutes (configurable via `IDLE_TIMEOUT_SECONDS`) ✅
- Managed by VM Agent with PTY activity detection ✅
- Automatic self-termination when idle ✅
- Prevents unnecessary charges

### Bootstrap Token Security
- One-time use tokens with 5-minute TTL ✅
- Cryptographically random generation ✅
- Used for VM credential delivery during startup ✅
- Deleted immediately after first use ✅
- Prevents replay attacks

### Workspace Access Control
- All operations validated for ownership
- Non-owners receive `404 Not Found` (not `403 Forbidden`)
- Prevents information disclosure
- Terminal WebSocket tokens scoped to workspace owner

### Cloud-Init Features
- Docker + devcontainer CLI installation
- VM Agent setup with idle detection
- PTY management and WebSocket terminal
- Auto-shutdown mechanisms

### VM Sizes Supported
- **Small (CX11)**: 1 vCPU, 2GB RAM ✅
- **Medium (CX22)**: 2 vCPU, 4GB RAM ✅
- **Large (CX32)**: 4 vCPU, 8GB RAM ✅

### DevContainer Support
- Auto-detects `.devcontainer/devcontainer.json`
- Uses configuration if present, otherwise applies default Claude Code-optimized config
- Runs workspace as configured user (default: `vscode`)

## Security & Hardening

### Bootstrap Token Credential Delivery Process
1. Workspace creation generates one-time bootstrap token stored in KV (5-min TTL)
2. Cloud-init receives only bootstrap URL (no embedded secrets)
3. VM agent calls `POST /api/bootstrap/:token` to redeem credentials
4. Token deleted immediately after first use
- Ensures no sensitive tokens in cloud-init (visible in Hetzner console)
- Single-use prevents replay attacks
- Short TTL limits exposure window

### Workspace Access Control Enforcement
- All workspace operations must verify `user_id` matches authenticated user
- IDOR prevention through proper ownership validation
- Non-owners receive 404, not 403 (prevent info disclosure)

### Provisioning Timeout
- Default: 10 minutes ✅
- Workspace automatically marked "Error" if not ready in time ✅
- Prevents stuck workspaces consuming resources ✅
- Clear error messages for user visibility ✅

### WebSocket Security
- Terminal WebSocket tokens scoped to workspace owner ✅
- JWT-based authentication ✅
- Automatic reconnection on network issues
- Session preservation across reconnects

### Terminal Authentication
- JWT-based access tokens for WebSocket connections ✅
- Tokens signed with `JWT_PRIVATE_KEY` ✅
- Verified with `JWT_PUBLIC_KEY` ✅
- JWKS endpoint at `/.well-known/jwks.json` ✅

## Development Requirements & Practices

### Testing Requirements (MANDATORY)
- **Unit tests**: `tests/unit/` in each package ✅
- **Integration tests**: `apps/api/tests/integration/` 🗑️ (directory doesn't exist)
- **End-to-end tests**: For critical user journeys
- **Coverage**: >90% for critical paths (not enforced in config)
- All new features MUST include tests before work is considered complete
- Tests MUST pass locally and in CI before marking complete ✅

### Code Standards
- TypeScript for all code
- ESLint + Prettier for formatting
- Conventional Commits for messages
- pnpm workspaces for package management
- Turborepo for build orchestration

### Documentation Naming Conventions
- **Kebab-case** for markdown files: `phase8-implementation-summary.md`
- **Exceptions**: `README.md`, `LICENSE`, `CONTRIBUTING.md`, `CHANGELOG.md` use UPPER_CASE
- **Locations**:
  - Ephemeral notes: `docs/notes/`
  - Permanent docs: `docs/`
  - Feature specs: `specs/<feature>/`

### Error Handling Format
```typescript
{
  error: "error_code",
  message: "Human-readable description"
}
```

### File Reading Requirement (Edit Tool)
- File MUST be read before editing (Edit tool requires this)
- After many edits, "read" status resets—may need re-reading files edited earlier
- Write tool also requires reading existing files before overwriting

### No Legacy Code Policy
- Do not keep unused code paths
- If code, files, routes, scripts, or configs are no longer referenced, remove them in the same change
- Update all docs and instructions to point only to current path

### Provider Implementation Pattern
- Implement `Provider` interface
- Export from `packages/providers/src/index.ts`
- Add unit tests

### Cloud-Init Modification Pattern
- Edit `packages/cloud-init/src/template.ts` for template changes
- Update variable wiring in `packages/cloud-init/src/generate.ts` when needed
- Test through provisioning flow in `apps/api/src/routes/workspaces.ts`

## Architecture Research & Decisions

### Provider Comparison (MVP Decision)
- **Selected**: Hetzner CX22 (€5.39/mo, 4GB RAM) - Best value
- **Cost**: 2-3x cheaper than GitHub Codespaces
- Supports: Small (2vCPU/4GB), Medium (4vCPU/8GB), Large (8vCPU/16GB)

### Web UI Technology Evolution
- **Original decision**: CloudCLI (third-party terminal UI)
- **Status**: REMOVED - Replaced by custom Go VM Agent with embedded xterm.js
- Reason: CloudCLI was unstable and overly complex

### Control Plane Selection
- Selected: Cloudflare Pages + Workers (serverless, free tier)

### Storage Selection
- Selected: Cloudflare R2 (S3-compatible, no egress fees)

### DNS Strategy (MVP)
- Selected: Wildcard DNS via Cloudflare API (simple, fast ~1min propagation)
- Future: Cloudflare Tunnels (enables user-registered runners)

### Authentication Evolution
- Selected: Bearer token for MVP
- Future: JWT for multi-tenant

### Key Resolved Questions
- GPU support: Not needed for MVP; kept provider interface flexible
- Persistent storage: R2 with per-workspace encryption
- Multi-repo workspaces: Deferred; kept in mind for future
- Claude auth persistence: `CLAUDE_CONFIG_DIR=/workspaces/.claude` + R2 backup
- Multi-tenancy: Design interfaces now, implement later
- Happy Coder dependency: Eliminated via CloudCLI web UI (now via Go Agent)

## Roadmap & Feature Phases

### Phase 1: MVP (COMPLETE)
- Create workspace from git repository
- GitHub OAuth authentication (BetterAuth)
- GitHub App for private repository access
- View workspace list with status
- Manually stop/restart workspaces
- Automatic idle shutdown (30 min)
- Web UI for workspace management
- D1 database for persistence
- Encrypted credential storage

### Phase 2: Browser Terminal (COMPLETE)
- VM Agent (Go) with WebSocket terminal
- JWT-based terminal authentication
- Idle detection and heartbeat system
- xterm.js terminal UI
- Secure bootstrap token credential delivery
- Workspace ownership validation
- WebSocket reconnection handling
- Automated deployment via Pulumi + GitHub Actions (spec 005)
- Multi-Agent ACP protocol support (spec 007)
- UI component governance system (spec 009)

### Phase 2 Features NOT YET COMPLETE
- File explorer integration
- Terminal session persistence

### Phase 3: Enhanced UX (Planned, Q1 2026)
- Workspace logs and debugging
- Custom devcontainer support
- Multiple repository sources (GitLab, Bitbucket)
- Workspace templates
- SSH access to workspaces
- Persistent storage (R2)
- Cost estimation display
- Configurable subdomains (api/app/workspace prefixes)
- Caddy on VMs for TLS cert provisioning (Let's Encrypt)

### Phase 4: Multi-Tenancy (Planned, Q2 2026)
- Team management
- Per-user API tokens
- Usage quotas and limits
- Billing integration
- Audit logging

### Phase 5: Enterprise Features (Planned, Q3 2026)
- Private networking (VPC)
- Custom domain support
- SSO integration (SAML, OIDC)
- Compliance features (SOC 2)
- Multi-region support
- Custom VM images
- API rate limiting

### Future Considerations
- Alternative cloud providers (AWS, GCP, Azure)
- VS Code Remote integration
- Collaborative editing
- Workspace snapshots and restore
- GPU instances for AI workloads
- Kubernetes-based workspaces

## UI Standards & Design System

### Visual Direction (ADR-003)
- Green-forward, software-development-focused, low-noise interface aesthetic
- Canvas: Deep neutral background for focus
- Surface: Slightly elevated panel color for grouping
- Accent: Green as primary action and focus identity

### UI System Stack (ADR-003)
- Shadcn-compatible open-code component approach
- Design tokens in `packages/ui/src/tokens/semantic-tokens.ts`
- CSS variables in `packages/ui/src/tokens/theme.css`
- Primitives in `packages/ui/src/primitives`
- Components in `packages/ui/src/components`
- Canonical guidelines in `docs/guides/ui-standards.md`
- Agent guidelines in `docs/guides/ui-agent-guidelines.md`
- Shared governance APIs in `apps/api/src/routes/ui-governance.ts`

### Typography Requirements
- Responsive sizing: mobile → tablet → desktop
- Mobile: readable default first
- Tablet: moderate scale-up
- Desktop: denser but still legible hierarchy
- Use shared primitives for headings/body/captions

### Mobile-First Design Requirements
- Single-column baseline at small widths
- Primary action target minimum 56px on mobile
- Text minimum 16px base (no zooming required)
- No required horizontal scrolling at 320px for core flows
- Login/CTA must be immediately visible without scroll

### Touch Target Sizes
- Minimum: 44x44px (iOS) / 48x48px (Android)
- Buttons: `min-height: 56px` on mobile
- Padding: At least `py-3` or `py-4` for clickable elements

### Typography Scaling Rules
- **Never** use fixed large text on mobile
- Use responsive sizing with breakpoints:
  - Mobile: 1.5rem
  - Tablet (sm): 1.875rem
  - Desktop (lg): 2.25rem

### Grid Layout Rules
- Mobile-first: Start single column
- Progressive enhancement: Add columns at breakpoints
- Example: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`

### Spacing & Layout Standards
- Mobile padding: `px-4` (1rem) minimum
- Vertical spacing: `py-8` for breathing room
- Content max-width: `max-w-md` or `max-w-lg` for readability

### Component Standards Requirements
Every shared component MUST include:
- Purpose and recommended usage
- Supported variants
- Required states: default, focus, active, disabled, loading, error, empty
- Accessibility notes
- Mobile behavior guidance
- Desktop behavior guidance

### Accessibility Requirements
- Keyboard operability for interactive controls
- Visible focus indicators (never removed)
- Primary action targets: 56px minimum on mobile
- Text and state understandable without color-only cues
- Reflow: usable at 320px, no mandatory horizontal scroll

### Governance Model
- Default: Use shared components and shared tokens
- Exceptions: Require documented rationale, scope, owner, expiration
- UI changes (human or AI) pass same checklist

## Local Development & Cloudflare-First Approach

### Development Philosophy
- **Cloudflare-first approach**: "No complex local testing setups. Iterate directly on Cloudflare infrastructure."
- **Reason**: Many moving pieces (Workers, D1, KV, DNS, VMs, VM Agent) make local realistic environment impractical

### What Works Locally
- API logic iteration via Wrangler local emulator ✅
- `pnpm dev` starts API at `http://localhost:8787` (Wrangler + Miniflare) ✅
- `pnpm dev` starts Web UI at `http://localhost:5173` (Vite) ✅
- TypeScript checking and linting ✅
- Unit and integration tests ✅

### What DOESN'T Work Locally
- Real GitHub OAuth (callbacks won't work without tunnel)
- Real DNS (workspace URLs won't resolve)
- Real VMs (workspaces can't be created)
- D1/KV/R2 emulation (may differ from production)

### Recommended Development Workflow
1. Make changes locally
2. Run lint/typecheck locally
3. Deploy to staging: `pnpm deploy:staging`
4. Test on Cloudflare infrastructure
5. Merge to main → triggers production deployment

### Prerequisites for Development
- Node.js 20+
- pnpm 9+
- Wrangler CLI (installed as dev dependency)

### Local Development Setup
1. `pnpm install`
2. `pnpm tsx scripts/deploy/generate-keys.ts` (generate dev keys)
3. Create `apps/api/.dev.vars` (optional)
4. `pnpm dev` (start local server)

### Deprecated Features
- **Mock mode** (`pnpm dev:mock`): REMOVED (was overly complex, didn't represent production)
- **setup-local-dev.ts**: Deprecated (not recommended for use)

### Testing Commands
- `pnpm test` - Run all tests ✅
- `pnpm test:coverage` - Run with coverage ✅
- `pnpm typecheck` - Type check all packages ✅
- `pnpm lint` - Lint code ✅
- `pnpm format` - Format code ✅

### Staging Deployment
- Recommended for meaningful testing
- Via GitHub Actions or CLI: `pnpm deploy:staging`
- Teardown: `pnpm teardown:staging` or GitHub Actions workflow

## Agent Preflight Behavior

### Mandatory Preflight Steps (BEFORE CODE EDITS)
1. Classify the change using one or more classes
2. Gather class-required context
3. Record assumptions and impact analysis
4. Plan documentation/spec updates
5. Run constitution alignment checks

### Change Classes
- **external-api-change**: Consult up-to-date docs (Context7 preferred), record sources
- **cross-component-change**: Build impact map before coding, identify dependencies
- **business-logic-change**: Review specs/data models first, inspect existing usage
- **public-surface-change**: Plan doc/spec updates before coding, update in same PR
- **docs-sync-change**: Verify impacted docs still accurate, update in same PR
- **security-sensitive-change**: Review architecture docs, validate against constitution
- **ui-change**: Include mobile-first checks, validate CTA and single-column on mobile
- **infra-change**: Validate env/secret naming, check deployment implications

### Preflight Checklist
1. Selected one or more change classes
2. Collected required context for each class
3. Recorded external references and assumptions
4. Built cross-component impact map (when applicable)
5. Planned doc/spec synchronization
6. Completed constitution check relevant to change

### Preflight Evidence Standard (PR Required)
- Change class selection
- Confirmation preflight happened before code edits
- External references summary
- Codebase impact summary
- Documentation/spec updates summary
- Constitution and risk check summary

### Mistake-to-Rule Loop
When agent mistake occurs:
1. Add/refine class-level preflight behavior rule
2. Add/refine executable guardrail (test/check/CI gate)

## Agent-Specific Instructions & Rules

### Critical Validations (NON-NEGOTIABLE)

#### Request Validation
- After completing ANY task, MUST re-read user's original request
- MUST compare what was requested vs. what was delivered
- MUST explicitly confirm each requested item was addressed
- MUST acknowledge deferred items

#### Feature Testing Requirements
- Add unit tests for new/changed logic
- Add integration tests for cross-layer behavior
- Add E2E tests for critical user flows when applicable
- Run test suites and confirm pass before completion
- Don't treat manual QA alone as sufficient

#### Constitution Validation
- Validate ALL changes against `.specify/memory/constitution.md`
- MUST validate Principle XI (No Hardcoded Values):
  - NO hardcoded URLs (use `BASE_DOMAIN`)
  - NO hardcoded timeouts (use configurable env vars with defaults)
  - NO hardcoded limits (must be configurable)
  - NO hardcoded identifiers (issuers, audiences, key IDs must be dynamic)

#### Mobile-First UI Requirements
- Ensure login/primary CTAs prominent with min 56px touch targets
- Use responsive text sizes (mobile → tablet → desktop)
- Start with single-column layouts on mobile
- Test on mobile viewport before deploying
- Follow `docs/guides/mobile-ux-guidelines.md`

#### Environment Variable Naming
- GitHub secrets: `GH_*` prefix
- Cloudflare Worker secrets: `GITHUB_*` prefix
- Local `.env`: `GITHUB_*` prefix
- Deployment script maps: `GH_*` → `GITHUB_*`

#### Architecture Research Requirements
Before ANY changes to architecture, secrets, credentials, data models, or security:
- Research: `docs/architecture/`, `docs/adr/`, `specs/`, `.specify/memory/constitution.md`
- Use sequential thinking for:
  - Understanding existing architecture
  - Identifying conflicts
  - Security implications
  - Constitution validation
  - Document reasoning

#### Business Logic Research Requirements
Before ANY changes to features, workflows, state machines, validation rules:
- Research: `specs/*/spec.md`, `specs/*/data-model.md`, `apps/api/src/db/schema.ts`, `apps/api/src/routes/`
- Use sequential thinking for:
  - Understanding existing business rules
  - Identifying edge cases
  - Impact on existing features
  - Document reasoning

#### Agent Preflight Behavior
- Defined in `docs/guides/agent-preflight-behavior.md`
- Enforced through PR evidence checks in CI
- Required for all code edits
- Must complete before `/speckit.plan` and before `/speckit.implement`

## Contributing & Development Workflow

### Getting Started Steps
1. Fork repository
2. Clone fork: `git clone https://github.com/your-username/simple-agent-manager.git`
3. Install dependencies: `pnpm install`
4. Create branch: `git checkout -b feature/your-feature`

### Development Commands
- `pnpm install` - Install dependencies
- `pnpm build` - Build all packages
- `pnpm test` - Run tests
- `pnpm dev` - Start development servers
- `pnpm lint` - Lint code
- `pnpm format` - Format code
- `pnpm typecheck` - Type check

### Code Style Requirements
- TypeScript for all code
- ESLint + Prettier for formatting
- Run `pnpm lint` before committing

### Commit Message Format
- Use Conventional Commits format
- Examples:
  - `feat: add new workspace feature`
  - `fix: resolve DNS creation bug`
  - `docs: update getting started guide`
  - `test: add integration tests for cleanup`
  - `refactor: extract validation utilities`

### Pull Request Requirements
- Ensure all tests pass: `pnpm test`
- Update documentation if needed
- Add tests for new features
- Keep PRs focused and small
- **Fill PR template completely** (including Agent Preflight block)

### Agent Preflight Requirements for PRs
Must include pre-code behavioral evidence:
- Change classification
- Confirmation preflight happened before code edits
- External references used
- Codebase impact analysis
- Documentation/spec synchronization notes
- Constitution and risk check summary

### Project Structure
```
apps/
  api/             - Cloudflare Worker API (Hono) ✅
  web/             - Control Plane UI (React + Vite) ✅
packages/
  shared/          - Shared types and utilities ✅
  providers/       - Cloud provider abstraction (Hetzner) ✅
  cloud-init/      - VM cloud-init template generation ✅
  terminal/        - Shared terminal component ✅
  ui/              - Shared UI component library ✅
  vm-agent/        - Go agent (WebSocket, idle detection) ✅
  acp-client/      - Agent Communication Protocol client ✅
infra/             - Pulumi infrastructure as code ✅
scripts/
  vm/              - VM-side config templates ✅
  deploy/          - Deployment utilities ✅
docs/              - Documentation ✅
specs/             - Feature specifications ✅
```

### Go Development (VM Agent)
- Located in `packages/vm-agent/`
- Requirements: Go 1.22+
- Commands:
  - `go mod download` - Install dependencies
  - `make build-all` - Build for all platforms
  - `go test ./...` - Run tests

## Cost Analysis

### Platform Costs (Your Infrastructure - Cloudflare)
| Component | Free Tier | Overage |
|-----------|-----------|---------|
| Workers | 100K requests/day | $0.15/million |
| D1 | 5M rows read/day | $0.001/million |
| KV | 100K reads/day | $0.50/million |
| R2 | 10GB storage | $0.015/GB/month |
| Pages | Unlimited | Free |

- **Typical SAM deployment**: Stays within free tier for small-medium usage

### User VM Costs (Paid by Users via Hetzner)
| VM Size | Specs | Hourly | Monthly |
|---------|-------|--------|---------|
| Small (CX11) | 1 vCPU, 2GB RAM | €0.004 (~$0.004) | €3.29 (~$3.60) |
| Medium (CX22) | 2 vCPU, 4GB RAM | €0.008 (~$0.009) | €4.90 (~$5.40) |
| Large (CX32) | 4 vCPU, 8GB RAM | €0.014 (~$0.015) | €8.90 (~$9.80) |

- Hourly billing
- Self-terminate after 30 minutes idle
- Users pay Hetzner directly

### Comparison with Alternatives
| Feature | GitHub Codespaces | SAM |
|---------|-------------------|-----|
| Cost | $0.18–$0.36/hour | ~$0.07–$0.15/hour |
| Idle shutdown | Manual or 30min | Automatic with PTY tracking |
| Claude Code | Manual setup | Pre-installed |
| Private repos | Native GitHub | GitHub App integration |
| Control plane | Managed | Self-hosted (free tier) |

## Multi-Agent Support (Spec 007)

### Agent Protocol: ACP (Agent Client Protocol)
- Emerging industry standard for editor-to-agent communication
- Created by Zed Industries in partnership with Google
- As of Feb 2026: v0.14.1 with 160+ downstream dependents
- Supported by: Claude Code (via adapter), OpenAI Codex CLI (via adapter), Google Gemini CLI (native), GitHub Copilot CLI (public preview), 30+ others
- Remote agent support via HTTP/WebSocket: functional for SAM architecture

### Supported Agents (Spec 007)
- Claude Code
- Google Gemini CLI
- OpenAI Codex CLI
- GitHub Copilot CLI
- And 30+ other agents

### Pre-Installation Claims
- All supported agents pre-installed in every workspace
- Users can switch agents at any time without reprovisioning
- Users' API keys stored securely per-user in database

### Structured Agent Conversation UI
- Rich conversation interface replacing raw terminal
- Formatted responses with proper headings, code blocks, syntax highlighting
- Tool execution cards with real-time status
- Permission request dialogs
- File change diffs (additions green, removals red)
- Thinking/reasoning indicators
- Terminal fallback if connection fails

## Documentation Review Spec (010)

### Functional Requirements
- **FR-001**: Discover all markdown files (*.md, *.markdown)
- **FR-002**: Categorize documents by type (README, API docs, guides, etc.)
- **FR-003**: Identify code references in documentation
- **FR-004**: Verify referenced code elements exist in codebase
- **FR-005**: Detect broken internal links
- **FR-006**: Assess readability metrics
- **FR-007**: Identify documents with stale modification dates
- **FR-008**: Generate review report with issues found
- **FR-009**: Prioritize issues by severity (critical, major, minor)
- **FR-010**: Support incremental reviews (only changed files)
- **FR-011**: Identify duplicate/conflicting information
- **FR-012**: Check for standard documentation sections

### Success Criteria
- 100% of markdown documents discovered and reviewed
- Review completes in <5 minutes for 50-100 docs
- 95% of code references validated for accuracy
- All critical documentation issues identified
- Report generation <30 seconds
- Target audience identified with 90% accuracy
- Readability scores ±5% margin of error
- Documentation coverage increased by 25%
- Time to understand documentation structure reduced by 50%

## Deployment Troubleshooting

### Quick Diagnostic Commands
- `pnpm validate:setup` - Check overall health
- `curl` Cloudflare API to verify token
- Health check endpoints for API and Web UI
- VM Agent binary download verification

### Common Authentication Issues
- Invalid/expired API token (CF_AUTH_FAILED)
- Token formatting issues (whitespace)
- Missing permissions (CF_MISSING_PERMISSIONS)
- Required permissions: Workers D1, KV, R2, DNS, Workers Scripts

### Resource Creation Issues
- D1 database limit (Free: 10 databases)
- KV namespace limit (Free: 100 namespaces)
- R2 bucket must be globally unique
- Invalid resource names

### DNS Issues
- Zone not found (wrong Zone ID)
- DNS not propagated (up to 24 hours)
- DNS record conflicts
- NXDOMAIN errors

### Deployment Issues
- Worker deployment failed (build errors)
- Pages deployment failed (project not found)
- Health check failures

### Pulumi & Deployment Issues
- Failed to decrypt state (PULUMI_CONFIG_PASSPHRASE mismatch)
- Failed to load checkpoint (R2 backend connection)
- Stack not found (first deployment or removed)
- Resource already exists
- Workers.dev subdomain initialization required

### OAuth Issues
- Callback URL mismatch
- GitHub App settings incorrect
- "Request user authorization (OAuth) during installation" MUST be unchecked
- HTTPS required

### Health Check Commands
- API: `curl https://api.example.com/api/health`
- Web UI: `curl -I https://app.example.com`
- Agent binary: `curl -I "https://api.example.com/api/agent/download?os=linux&arch=amd64"`

## GitHub Setup Requirements

### GitHub App Configuration
SAM uses a single GitHub App for both user login (OAuth) and repository access:

#### Basic Information
- **GitHub App name**: Simple Agent Manager
- **Homepage URL**: `https://app.example.com`

#### Identifying and authorizing users
- **Callback URL**: `https://api.example.com/api/auth/callback/github`
- **Expire user authorization tokens**: ✓ Checked
- **Request user authorization (OAuth) during installation**: ☐ **MUST BE UNCHECKED**
- **Enable Device Flow**: ☐ Unchecked

#### Post installation
- **Setup URL (optional)**: `https://api.example.com/api/github/callback`
- **Redirect on update**: ✓ Checked
- Setup URL points to the API, not the web UI
- API records installation in database then redirects to `https://app.example.com/settings`

#### Webhook
- **Active**: ✓ Checked
- **Webhook URL**: `https://api.example.com/api/github/webhook`
- **Webhook secret**: Generate a random string (save it!)

#### Permissions
Repository permissions:
- **Contents**: Read-only
- **Metadata**: Read-only

Account permissions:
- **Email addresses**: Read-only (required for login)

#### Installation Scope
- **Only on this account**: For personal use
- **Any account**: For public/team use

## Summary Statistics

### Total Claims by Category
- Project Identity & Mission: 5 claims
- Technology Stack: 18 claims
- Architecture & Design: 42 claims
- Deployment & Configuration: 28 claims
- API Endpoints: 31 endpoints
- Workspace Lifecycle: 27 claims
- Security & Hardening: 20 claims
- Development Requirements: 26 claims
- Architecture Research: 14 claims
- Roadmap & Phases: 36 features
- UI Standards: 35 requirements
- Local Development: 24 claims
- Agent Preflight: 20 requirements
- Agent Instructions: 32 rules
- Contributing: 22 requirements
- Cost Analysis: 15 data points
- Multi-Agent Support: 12 claims
- Documentation Review: 21 requirements
- Deployment Troubleshooting: 24 issues
- GitHub Setup: 19 configuration items

### Total Factual Claims: ~500+

### Claim Sources
- User-facing documentation: ~40%
- Agent-facing instructions: ~35%
- Technical specifications: ~15%
- Architecture decisions: ~10%

### Verification Status
- Verifiable via code inspection: ~60%
- Verifiable via deployment: ~25%
- Policy/process claims: ~10%
- Future/planned features: ~5%