# Track 8: Architecture Alignment & Technical Debt

Status: Complete.

## Executive Summary

Track 8 synthesizes findings from all other evaluation tracks (1-7, 9) into a unified strategic debt map with effort/impact/sequencing recommendations. This is the final synthesis track — it identifies architecture decision drift, constitution compliance gaps, debt hotspots, and produces an implementation wave plan for parallel agent swarms.

**Key Metrics:**
- ADRs: 5 total (1 superseded, 4 active, 1 partially stale)
- Constitution principles: 13 (3 NON-NEGOTIABLE); 2 HIGH violations, 1 documented drift
- Backlog tasks: 165 (categorized by 9 debt types below)
- Cross-track findings synthesized: 132 total from Tracks 1-9
- Quality gate scripts: 9 automated checks in CI
- Specs: 33 directories (15+ implemented, ~5 partially, remainder historical/superseded)
- Files exceeding constitution 400-line limit: 107; exceeding enforced 500-line limit: 61; exceeding 800-line mandatory split: 10

**Overall Architecture Health**: The codebase demonstrates strong architectural patterns in provider abstraction, hybrid storage, and automated quality gates. The primary risks are: (1) non-atomic KV operations for security-critical rate limiting, (2) constitution enforcement drift, (3) agent context budget bloat, and (4) growing orchestration complexity without corresponding documentation.

---

## Section A: ADR Currency Assessment

### ADR Inventory

| ADR | Title | Status | Currency | Last Verified |
|-----|-------|--------|----------|---------------|
| 001a | GitHub App over OAuth | Accepted | CURRENT | 2026-05-07 |
| 001b | Monorepo Structure | Accepted | CURRENT | 2026-05-07 |
| 002 | Stateless Architecture | **Superseded** | CORRECTLY MARKED | N/A |
| 003 | Unified UI System Stack | Accepted | PARTIALLY STALE | 2026-05-07 |
| 004 | Hybrid D1 + DO Storage | Accepted | CURRENT | 2026-05-07 |

**Note**: Two ADR files share the `001` number (`001-github-app-over-oauth.md` and `001-monorepo-structure.md`). This is a minor naming collision — neither has a date field to disambiguate priority.

### ADR Drift Findings

#### FINDING-8A1: ADR-003 UI Stack Drift

- **Severity**: LOW
- **Location**: `docs/adr/003-ui-system-stack.md`
- **Description**: ADR-003 describes a shadcn-compatible component approach with governance APIs in `ui-governance.ts`. The actual codebase adopted Tailwind CSS v4 directly (spec 024, `tailwind-adoption` in Recent Changes) and the governance route was removed. The ADR references `specs/009-ui-system-standards/` which is a historical spec. The decision rationale (open-code components, shared `packages/ui`) remains valid, but implementation details are stale.
- **Impact**: New contributors may reference outdated governance API patterns.
- **Recommendation**: Add an amendment section to ADR-003 noting Tailwind v4 adoption and governance route removal.

#### FINDING-8A2: Missing ADRs for Major Architectural Decisions

- **Severity**: MEDIUM
- **Location**: `docs/adr/` (absence)
- **Description**: Several major architectural decisions made post-ADR-004 lack corresponding ADRs:
  1. **Durable Object proliferation** — 8 DO classes (ProjectData, TaskRunner, NodeLifecycle, TrialOrchestrator, CodexRefreshLock, ProjectOrchestrator, SamSession, AdminLogs). No ADR explains when to create a new DO vs extend an existing one, or the tradeoffs of each DO's storage model.
  2. **MCP tool surface as primary agent API** — 84+ MCP tools registered in `apps/api/src/routes/mcp/`. No ADR documents the protocol choice over alternatives (REST, GraphQL, gRPC), the tool taxonomy, or progressive disclosure strategy.
  3. **Mission/orchestration architecture** — Missions, handoff packets, durable mailbox (5 message classes), ProjectOrchestrator with alarm-driven scheduling, policy propagation. No ADR documents the decision to build a custom DAG scheduler vs using existing workflow engines.
  4. **Agent instruction architecture** — CLAUDE.md (293 lines) + 35 rule files (3,338 lines) = ~4,041 lines always loaded into agent context. No ADR documents this design, its context budget implications, or alternatives considered.
- **Impact**: New architects cannot understand WHY these patterns were chosen. Makes refactoring risky — you can't evaluate tradeoffs without understanding the original constraints.
- **Recommendation**: Create ADR-005 through ADR-008 retroactively. Even post-hoc ADRs that document "this is what we chose and why" are valuable.

#### FINDING-8A3: ADR-001 Number Collision

- **Severity**: INFO
- **Location**: `docs/adr/001-github-app-over-oauth.md`, `docs/adr/001-monorepo-structure.md`
- **Description**: Two ADRs share the `001` identifier. The monorepo ADR has a date (2026-01-24); the GitHub App ADR has no date field.
- **Impact**: Minimal — only creates confusion when referencing "ADR-001" without the full title.
- **Recommendation**: Renumber the GitHub App ADR to ADR-000 or add a date field for disambiguation.

---

## Section B: Constitution Compliance Assessment

The SAM Constitution (`.specify/memory/constitution.md`, v1.8.0) defines 13 principles, 3 of which are NON-NEGOTIABLE (II, XI, XII; plus XIII added in v1.8.0).

### Principle-by-Principle Analysis

| # | Principle | Status | Key Finding |
|---|-----------|--------|-------------|
| I | Open Source Sustainability | COMPLIANT | AGPL-3.0; no enterprise/ directory; billing code (`ai-billing.ts`) in core (acceptable for now) |
| II | Infrastructure Stability (NON-NEG) | **VIOLATED** | No coverage thresholds in CI; TDD not mechanically enforced (FINDING-8B2) |
| III | Documentation Excellence | PARTIAL | 36 post-mortems (strong); self-hosting guide at 1,164 lines; ADR gaps (Section A) |
| IV | Approachable Code | **VIOLATED** | Constitution: 400-line files / 50-line functions. Enforced: 500/800. 107 files exceed 400 (FINDING-8B1) |
| V | Transparent Roadmap | PARTIAL | No ROADMAP.md; `tasks/` + `strategy/` partially substitute (FINDING-8B3) |
| VI | Automated Quality Gates | STRONG | 9 quality scripts; ESLint with `jsx-a11y`, `simple-import-sort`, `consistent-type-imports`; CI enforcement |
| VII | Inclusive Contribution | PARTIAL | CONTRIBUTING.md exists; no evidence of `good-first-issue` labels or issue templates for newcomers |
| VIII | AI-Friendly Repository | STRONG | CLAUDE.md, 35 rules, AGENTS.md, 11 subagent profiles, 17 skills; but context budget crisis (Track 9) |
| IX | Clean Code Architecture | COMPLIANT | Clear `apps/` vs `packages/` separation; no circular dependencies; dependency order enforced |
| X | Simplicity & Clarity | PARTIAL | Official SDKs used (Hetzner, Cloudflare); but orchestration subsystem is complex (missions/handoffs/mailbox/policies) |
| XI | No Hardcoded Values (NON-NEG) | MOSTLY COMPLIANT | Strong `env.VAR ?? DEFAULT` pattern throughout; minor: `observability.ts:26-27` has `MAX_MESSAGE_LENGTH = 2048` / `MAX_STACK_LENGTH = 4096` without env var override |
| XII | Zero-to-Production (NON-NEG) | MOSTLY COMPLIANT | Self-hosting guide exists (1,164 lines); Pulumi IaC; some new features (AI proxy, sandbox, analytics forwarding) may lack self-hosting docs updates |
| XIII | Fail-Fast (NON-NEG) | PARTIAL | Good boundary validation in recent code (post rule 11); older routes may lack consistent validation (Track 2 findings) |

### Critical Constitution Violations

#### FINDING-8B1: Constitution vs Rule File Size Limits Drift

- **Severity**: HIGH
- **Location**: `.specify/memory/constitution.md:85` ("Functions under 50 lines; files under 400 lines") vs `.claude/rules/18-file-size-limits.md` (500-line warning, 800-line mandatory split)
- **Description**: The constitution (Principle IV) specifies a 400-line file limit and 50-line function limit. The enforced rule uses a 500/800 threshold — 25-100% more permissive. This is a documented, unresolved drift between constitutional law and operational enforcement.
  - **107 source files** exceed the constitution's 400-line threshold
  - **61 source files** exceed the enforced 500-line threshold
  - **10 source files** exceed the 800-line mandatory split threshold
  - Top violators: `schema.ts` (1,448 lines, has documented exception), `row-schemas.ts` (1,023), `tasks/crud.ts` (995), `projects/crud.ts` (920), Go: `bootstrap.go` (2,828), `session_host.go` (2,535)
- **Impact**: The constitution claims a standard that is systematically violated. This undermines the constitution's authority as the "authoritative source for project standards" (constitution Governance section).
- **Recommendation**: Amend constitution Principle IV to match the enforced 500/800 threshold. The 400-line limit was aspirational for a project of this scale; the 500/800 threshold reflects practical reality. Alternatively, implement a `quality:constitution-file-sizes` script at 400 lines to enforce the constitutional standard.

#### FINDING-8B2: No Coverage Thresholds Enforced (Principle II)

- **Severity**: HIGH
- **Location**: `apps/api/vitest.config.ts`, `apps/web/vitest.config.ts` (absence of `coverage.thresholds`); `.github/workflows/ci.yml:173-174`
- **Description**: Constitution Principle II (NON-NEGOTIABLE) requires ">90% coverage for critical paths" and ">80% overall." Track 6 found that:
  - Coverage reports are generated but no thresholds configured
  - CI runs `pnpm test:coverage` (ci.yml:173-174) but does not fail on regression
  - 521 test files exist against ~768 source files — substantial investment but unmetered
  - No per-package or per-path coverage gates
- **Impact**: Coverage can regress silently. The NON-NEGOTIABLE principle is unenforced.
- **Recommendation**: Add `coverage.thresholds` blocks to vitest configs. Start at a level that matches current reality (estimated ~60-70%) and ratchet quarterly toward the constitutional target. Track critical paths (VM provisioning, auth, credential handling) separately.

#### FINDING-8B3: Missing ROADMAP.md (Principle V)

- **Severity**: LOW
- **Location**: Repository root (absence)
- **Description**: Constitution Principle V requires "ROADMAP.md outlines phases, priorities, and target milestones." No ROADMAP.md exists. The `tasks/` tracking system and `strategy/engineering/` directory partially substitute but are internal-facing tools, not a contributor-friendly public roadmap.
- **Impact**: External contributors cannot easily understand project direction or where to contribute.
- **Recommendation**: Generate ROADMAP.md from `strategy/engineering/` artifacts using the `/engineering-strategy` skill.

#### FINDING-8B4: Hardcoded Observability Limits (Principle XI)

- **Severity**: LOW
- **Location**: `apps/api/src/services/observability.ts:26-27`
- **Description**: `MAX_MESSAGE_LENGTH = 2048` and `MAX_STACK_LENGTH = 4096` are defined as module-level constants without env var override paths. While these are internal truncation limits for error storage (low user impact), they technically violate Principle XI's rule that "ALL limits MUST be configurable."
- **Impact**: Minimal — these limits only affect stored error data truncation.
- **Recommendation**: Add env var overrides following the standard pattern (`parseInt(env.OBSERVABILITY_MAX_MESSAGE_LENGTH || '2048', 10)`).

---

## Section C: Spec vs Reality Drift

### Implemented Specs — Drift Analysis

#### FINDING-8C1: Orchestration Scope Expansion Beyond Spec 021

- **Severity**: MEDIUM
- **Location**: `specs/021-task-chat-architecture/` vs actual implementation across multiple packages
- **Description**: Spec 021 defined a task-driven chat architecture with TaskRunner DO, warm node pooling, project chat UI, and task submission. The actual implementation grew far beyond the spec to include:
  - **Missions** (`missions` D1 table, `create_mission` / `get_mission` MCP tools) — not in spec 021
  - **Handoff packets** (`handoff_packets` DO SQLite table, structured knowledge transfer) — not in spec 021
  - **Durable mailbox** (5 message classes: notify, deliver, interrupt, preempt_and_replan, shutdown_with_final_prompt) — not in spec 021
  - **ProjectOrchestrator DO** with alarm-driven scheduling loop and DAG state machine (11 scheduler states) — not in spec 021
  - **Policy propagation** (4 policy categories, 5 MCP tools, inherited via dispatch) — not in spec 021
  - **Session summarization** (`session-summarize.ts`, AI-powered context summaries for forking) — not in spec 021
- **Impact**: Spec 021 no longer describes the system. The orchestration subsystem is now more complex than the original "task chat" design, with no umbrella document describing the full system.
- **Recommendation**: Create a new architecture document (`docs/architecture/orchestration-system.md`) that maps the full mission/task/handoff/mailbox/scheduling system. Consider writing ADR-007 for the custom DAG scheduler decision.

#### FINDING-8C2: Spec 018 Session Resume Mechanics Changed

- **Severity**: LOW
- **Location**: `specs/018-project-first-architecture/` FR-017 vs spec 027 implementation
- **Description**: Spec 018 described session resume as "a new workspace starts with the session context loaded." Spec 027 (DO Session Ownership) implemented it differently — as "session forking with lineage tracking" where a context summary is generated and a new session is created with that context, rather than loading the prior session into a new workspace.
- **Impact**: The mechanics are better than specified (context summaries > raw session replay), but the spec doesn't reflect reality.

#### FINDING-8C3: Provider Abstraction Exceeded Spec 028

- **Severity**: LOW (positive drift)
- **Location**: `specs/028-provider-infrastructure/` vs `packages/providers/`, `per-project-scaling-provider-locations`
- **Description**: The provider abstraction includes features not in the original spec: per-project scaling parameters (8 configurable values), provider-aware location validation (`PROVIDER_LOCATIONS` registry), and `resolveProjectScalingConfig()` helper for project->env->default fallback chains.
- **Impact**: The code is better than the spec — the abstraction handles more real-world concerns.

### Unimplemented or Partially Implemented Specs

| Spec | Title | Status | Notes |
|------|-------|--------|-------|
| 029 | Conversation Forking | Partially implemented | Session forking exists (027); full UX for user-initiated forking may be incomplete |
| 030 | Workspace Port Exposure | Partially implemented | Referenced in backlog (`port-exposure-security-hardening.md`); basic mechanism works |
| tdf-2 | Orchestration Engine | Implemented (absorbed) | Fed into mission/orchestration system; spec is historical |
| tdf-5 | Workspace Lifecycle | Implemented (absorbed) | Fed into NodeLifecycle DO; spec is historical |
| sam-agent | SAM Agent | Implemented | Full implementation with 29 curated tools, conversation persistence, FTS5 search |

---

## Section D: Technical Debt Inventory (Cross-Track Synthesis)

### Debt Hotspot Map

Areas where debt accumulates across multiple evaluation tracks, indicating systemic issues:

| Hotspot | Tracks | Combined Risk | Description |
|---------|--------|---------------|-------------|
| **ProjectData DO** | 1, 3, 6, 7 | CRITICAL | 19 migrations, 15+ tables, inconsistent FTS5 sanitization (`messages.ts:494-498` vs `knowledge.ts:513-522`), no Miniflare integration tests, growing unbounded complexity |
| **KV Token Budget** | 1, 7 | CRITICAL | Non-atomic read-modify-write at `ai-token-budget.ts:190-221` and MCP rate limiter. Under concurrent requests, budget can be bypassed or double-counted |
| **MCP Tool Surface** | 3, 7, 9 | HIGH | 84 tools in flat list, monolithic 177-case switch (`mcp/index.ts:213-389`), no progressive discovery, non-atomic rate limiter |
| **Agent Context Budget** | 3, 9 | HIGH | CLAUDE.md (293 lines) + 35 rules (3,338 lines) = ~4,041 lines / ~28k tokens always loaded. Only 3/12 packages have AGENTS.md. No `.claude/settings.json`. |
| **VM Agent (Go)** | 3, 6 | HIGH | `internal/server/` package: 9,303 lines; `session_host.go`: 2,535 lines; `bootstrap.go`: 2,828 lines. No `-race` flag in CI. |
| **Cron N+1 Queries** | 5 | HIGH | `stuck-tasks:229-350` handler executes sequential DB query + RPC per node. Scales linearly with infrastructure. |
| **Frontend Bundle** | 5, 9 | MEDIUM | ~700KB unsplit bundle; no code splitting; no lazy routes. Impacts mobile load times. |

### Debt by Category (from 165 Backlog Tasks)

Categorized by reading all 165 task files in `tasks/backlog/`:

| Category | Count | % | Top Tasks |
|----------|-------|---|-----------|
| **Testing debt** | 30 | 18.2% | `fix-flaky-vm-agent-tests.md`, `migrate-source-contract-tests.md`, `improve-test-infrastructure.md` |
| **Reliability debt** | 27 | 16.4% | `task-completion-lifecycle.md`, `project-chat-acp-503-on-new-workspace.md`, `devcontainer-network-resilience.md` |
| **Feature debt** | 25 | 15.2% | 7 provider tasks (DigitalOcean, Linode, Vultr, etc.), `cli-tool.md`, `pwa-push-notification-system.md` |
| **Security debt** | 22 | 13.3% | `docker-exec-env-token-exposure.md`, `mcp-token-do-storage-security.md`, `port-exposure-security-hardening.md` |
| **UX debt** | 22 | 13.3% | `mobile-nav-dropdown-menus.md`, `sidebar-redesign-tier2.md`, `dashboard-chat-session-navigation.md` |
| **Architecture debt** | 15 | 9.1% | `simplify-durable-objects-and-schema.md`, `simplify-vm-agent-architecture.md`, `simplify-deploy-scripts-and-infra.md` |
| **Documentation debt** | 9 | 5.5% | Various stale docs, missing guides |
| **Performance debt** | 8 | 4.8% | `agent-session-startup-optimization.md`, scaling-related tasks |
| **Observability debt** | 7 | 4.2% | `log-viewer-test-coverage-gaps.md`, `task-status-display.md` |

**Patterns Observed:**
- **Security task cluster**: Heavy concentration around token/credential exposure vectors — docker exec process table, DO storage, file paths, proxy auth headers, git injection (`git show` refspec). Many are post-merge security audit follow-ups filed as backlog rather than blocking the original merge.
- **Reliability task cluster**: Task lifecycle and session management dominate. Tasks stuck in `in_progress`, 503 on new workspace (DNS propagation), session context loss on follow-up — all relate to the distributed state machine spanning Worker -> DO -> VM Agent.
- **Simplification cluster**: 5 tasks in `2026-03-03` date range all prefixed "simplify-*" — indicating a deliberate simplification initiative that was planned but never executed.
- **Provider feature debt**: 7 provider implementation tasks are well-scoped and independent — ideal for parallel agent swarms given the strong `Provider` interface.

### Unknown Debt (Findings Not in Backlog)

These track findings have NO corresponding backlog task — they are newly discovered debt:

| Finding | Source Track | Severity | Description |
|---------|-------------|----------|-------------|
| KV race condition for token budgets | Track 1 | CRITICAL | `ai-token-budget.ts:190-221` non-atomic read-modify-write |
| Workspace subdomain proxy bypass | Track 7 | HIGH | `index.ts:188-256` missing ownership verification |
| Agent context budget crisis | Track 9 | HIGH | 4,041 lines always loaded, no progressive disclosure |
| No JWT revocation mechanism | Track 7 | HIGH | No KV blocklist or short-lived token rotation |
| Sequential VM RPCs in node cleanup | Track 5 | HIGH | `node-cleanup:276-320` linear scaling |
| No Go -race in CI | Track 6 | HIGH | Concurrency bugs undetectable |
| Constitution file-size drift | Track 8 | HIGH | 400 vs 500/800 line thresholds |
| Coverage thresholds absent | Track 6 + 8 | HIGH | NON-NEGOTIABLE principle unenforced |
| MCP tool progressive discovery | Track 9 | MEDIUM | 84 tools vs SAM's curated 29 |
| Frontend code splitting | Track 5 | MEDIUM | ~700KB unsplit bundle |

---

## Section E: Architecture Evolutionary Assessment

### Plugin Architecture Readiness

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Core/extension separation | NOT READY | No `enterprise/` or `plugins/` directory; billing code (`ai-billing.ts`, `ai-proxy-shared.ts`, `compute-usage.ts`) mixed in `apps/api/src/services/` |
| Hook/event system | PARTIAL | DO alarm system; cron scheduler; Analytics Engine event tracking; but no plugin lifecycle hooks |
| Extension points identified | NOT READY | No documented extension API; MCP tools are flat registered list with no plugin namespace |
| Billing isolation | NOT READY | AI billing, usage tracking, cost monitoring all in core `apps/api/src/` tree |
| Feature flags for gating | MINIMAL | Only `SANDBOX_ENABLED`, `AI_PROXY_ENABLED`, `TRIAL_*`; no generic feature flag framework (Track 6: only 1 runtime flag) |

**Assessment**: Plugin architecture would require significant refactoring. The monolithic API Worker with all routes, services, and DOs in a single deployment makes extraction difficult. The constitution (Principle I) requires core functionality to remain OSS with premium features "clearly separated (e.g., `enterprise/` directory)" — this separation does not yet exist.

**Recommended path**: (1) Extract billing services behind a service boundary interface, (2) implement a generic feature flag system in KV, (3) create `enterprise/` directory for premium-only code, (4) define MCP tool namespacing for extension tools.

### Provider Abstraction Quality

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Clean interface | STRONG | `Provider` interface at `packages/providers/src/types.ts:90-126` — 7 methods, clear contracts |
| Multiple implementations | STRONG | `HetznerProvider`, `ScalewayProvider`, `GcpProvider` all implement the interface |
| Discriminated union config | STRONG | `ProviderConfig` type at `types.ts:132` — type-safe provider selection |
| Provider-agnostic orchestration | STRONG | TaskRunner and NodeLifecycle consume `Provider` abstraction without provider-specific logic |
| Per-project overrides | STRONG | `PROVIDER_LOCATIONS` registry, `isValidLocationForProvider()`, `resolveProjectScalingConfig()` |
| Error normalization | STRONG | `ProviderError` class at `types.ts:168-193` wraps all provider-specific errors |

**Assessment**: Provider abstraction is the strongest architectural pattern in the codebase and a model for other abstractions. Adding a new provider requires: (1) implement 7-method `Provider` interface, (2) add config variant to `ProviderConfig` union, (3) add location registry entry. The 7 backlog provider tasks are well-suited for parallel agent execution.

### Cloudflare Containers Readiness

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Binding infrastructure | READY | `sync-wrangler-config.ts:124` propagates `containers` binding to env sections |
| Experimental prototype | READY | `apps/api/src/routes/admin-sandbox.ts` — full CRUD against `env.SANDBOX` binding, admin-gated |
| Env type declared | READY | `apps/api/src/env.ts:52` — `SANDBOX` binding typed with comment |
| Integration design | DOCUMENTED | `docs/architecture/agent-harness-integration.md` maps CF Containers for SAM agent runtime |
| Kill switch | READY | `SANDBOX_ENABLED` env var (default: false) |
| Model selection | DOCUMENTED | Default sandbox model: Gemma 4 26B (`packages/shared/src/constants/ai-services.ts`) based on 2026-05-05 harness evaluation |
| Production readiness | NOT READY | Admin-only; no user-facing workflow; no session persistence; no warm pool equivalent for containers |

**Assessment**: Cloudflare Containers is well-prototyped with clear migration path documented. Key blockers for production use:
1. **No persistent storage in containers** — current per-project SQLite (DO-based) needs different persistence strategy
2. **No warm pool equivalent** — containers have cold start; the NodeLifecycle warm pool pattern doesn't translate directly
3. **Session state management** — current ACP sessions are VM-scoped; container sessions would need different lifecycle
4. **Debugging story** — debug package (`/api/nodes/:id/debug-package`) is VM-centric; containers need equivalent observability

### Scalability Bottlenecks

From Track 5's analysis, with cross-track correlation:

| Bottleneck | Est. Threshold | Impact | Mitigation | Track Source |
|------------|---------------|--------|------------|-------------|
| D1 row scan limits | ~500 concurrent users | Dashboard queries degrade | Pagination, result caching, materialized summary views | Track 5 |
| Cron N+1 queries | Linear with active nodes | `stuck-tasks:229-350` sequential per-node | Batch queries (`SELECT WHERE id IN(...)`), parallel RPCs via `Promise.all()` | Track 5 |
| Single Worker deployment | Memory pressure at scale | All 84 MCP tools + routes + DOs in one Worker | Route-based Worker splitting or Worker-per-DO-class | Track 3, 5 |
| KV eventual consistency | Under concurrent writes | Token budget bypass, double-counting | Migrate atomic counters to Durable Object storage | Track 1, 7 |
| Frontend bundle size | ~700KB initial load | Poor mobile experience, slow TTI | React.lazy() routes, dynamic imports, tree-shaking audit | Track 5, 9 |
| Monthly cost projection | ~$15,000-25,000 at 1,000 users | Dominated by Hetzner VMs ($75-125 per user/month) | Smaller VM tiers, container migration, usage-based pricing | Track 5 |

---

## Section F: Strategic Debt Map

### Effort/Impact Matrix

```
                       HIGH IMPACT
                           |
  LOW EFFORT               |                HIGH EFFORT
                           |
   KV Race Fix (P0)        |    Context Budget Reduction (P0)
   Subdomain Auth (P0)     |    DO Miniflare Tests (P1)
   FTS5 Sanitize (P0)      |    MCP Progressive Discovery (P1)
   Coverage Thresholds (P1) |    VM Agent Split (P1)
                           |
  ─────────────────────────┼────────────────────────────────
                           |
   ADR Backfill (P2)       |    Plugin Architecture (P2+)
   Constitution Amend (P2) |    Worker Splitting (P2+)
   ROADMAP.md (P2)         |    CF Containers Prod (P2+)
   ADR-001 Renumber (P2)   |
                           |
                      LOW IMPACT
```

### Priority Sequencing

| Priority | Theme | Key Findings | Rationale |
|----------|-------|-------------|-----------|
| **P0** (Immediate) | Security & Data Integrity | KV race (Track 1 CRITICAL), subdomain bypass (Track 7 HIGH-1), FTS5 sanitization (Track 7 HIGH-2), JWT revocation (Track 7 HIGH-4) | Active security risk to user data and multi-tenant isolation |
| **P0** (Immediate) | Agent Context Budget | 4,041 lines always-loaded (Track 9 HIGH), rule consolidation, CLAUDE.md pruning | Directly degrades agent productivity on every task |
| **P1** (Next Sprint) | Testing Foundation | Coverage thresholds (Track 6 HIGH + this track), Miniflare DO tests (Track 6 HIGH), Go -race CI (Track 6 HIGH) | Safety net required before all other refactoring |
| **P1** (Next Sprint) | Performance | Cron N+1 (Track 5 HIGH), sequential RPC parallelization (Track 5 HIGH), frontend code split (Track 5 HIGH) | Cost efficiency and user experience at growth |
| **P1** (Next Sprint) | Code Organization | File size ratchet (Track 3 HIGH), VM agent split (Track 3 HIGH), MCP modularization (Track 3 HIGH) | Agent navigability and maintainability |
| **P2** (Next Quarter) | Architecture Documentation | Missing ADRs (this track), constitution amendment (this track), ROADMAP.md (this track), orchestration system docs (this track) | Contributor onboarding and institutional knowledge |
| **P2+** (Future) | Platform Extensibility | Plugin boundaries, billing extraction, feature flag system, CF Containers production | Business model support and platform evolution |

---

## Section G: Implementation Wave Plan

Waves group non-conflicting work packets for parallel agent swarms. Each wave targets files/modules with minimal merge conflict risk.

### Wave 1: Security Hardening (3-4 agents, ~1 day)

Can run parallel to Wave 2.

| Packet | Target Files | Agent Profile | Deps |
|--------|-------------|---------------|------|
| 1A: Atomic token budget | `apps/api/src/services/ai-token-budget.ts` — migrate KV read-modify-write to DO atomic counter | cloudflare-specialist | None |
| 1B: Subdomain proxy ownership | `apps/api/src/index.ts:188-256` — add workspace ownership check before proxy | security-auditor | None |
| 1C: JWT revocation blocklist | `apps/api/src/middleware/auth.ts`, new `apps/api/src/services/jwt-revocation.ts` — KV-backed revocation list | security-auditor | None |
| 1D: FTS5 input sanitization | `apps/api/src/durable-objects/project-data/messages.ts:494-498`, `knowledge.ts:513-522` — unify sanitization pattern | cloudflare-specialist | None |

**Conflict analysis**: Each packet touches distinct file sets. 1A and 1D both touch DO-related files but different DOs and different service files. Safe for parallel execution.

### Wave 2: Agent Context Budget (1-2 agents, ~1 day)

Can run parallel to Wave 1.

| Packet | Target Files | Agent Profile | Deps |
|--------|-------------|---------------|------|
| 2A: Rule consolidation & deduplication | `.claude/rules/*.md` — merge overlapping rules (e.g., rules 13, 30, 33 all address staging verification) | general-purpose | None |
| 2B: CLAUDE.md Recent Changes pruning | `CLAUDE.md` — archive older entries to a changelog file, keep only last ~10 changes | general-purpose | None |
| 2C: AGENTS.md per-package expansion | `packages/*/AGENTS.md` — create per-package AGENTS.md for 9 packages that lack them | general-purpose | 2A |

**Note**: 2A should be reviewed carefully — rule consolidation must preserve all behavioral requirements while reducing token count. Target: 50% reduction from 3,338 to ~1,700 lines.

### Wave 3: Testing Foundation (2-3 agents, ~2 days)

Depends on: none (can start immediately, but benefits from Wave 1 security fixes being testable).

| Packet | Target Files | Agent Profile | Deps |
|--------|-------------|---------------|------|
| 3A: Coverage thresholds in CI | `apps/api/vitest.config.ts`, `apps/web/vitest.config.ts`, `.github/workflows/ci.yml` | test-engineer | None |
| 3B: TaskRunner Miniflare tests | New `apps/api/tests/integration/task-runner.test.ts` | cloudflare-specialist | None |
| 3C: NodeLifecycle Miniflare tests | New `apps/api/tests/integration/node-lifecycle.test.ts` | cloudflare-specialist | 3B (may share vitest.workers.config.ts setup) |
| 3D: Go -race CI | `.github/workflows/ci.yml`, `packages/vm-agent/Makefile` | go-specialist | None |

**Conflict analysis**: 3B and 3C may both modify `vitest.workers.config.ts` bindings — execute 3B first, then 3C. 3A and 3D touch CI config but different sections (JS vs Go jobs). Safe for parallel execution.

### Wave 4: Performance & Code Organization (3-4 agents, ~3 days)

Depends on: Wave 3 (tests should exist before refactoring).

| Packet | Target Files | Agent Profile | Deps |
|--------|-------------|---------------|------|
| 4A: Cron N+1 batch fix | `apps/api/src/routes/cron.ts` (stuck-tasks handler at :229-350) | cloudflare-specialist | Wave 3B |
| 4B: Frontend code splitting | `apps/web/src/App.tsx`, route files — add `React.lazy()` for all route components | ui-ux-specialist | None |
| 4C: VM agent server package split | `packages/vm-agent/internal/server/` — extract into sub-packages | go-specialist | Wave 3D |
| 4D: MCP tool file modularization | `apps/api/src/routes/mcp/index.ts` — break 177-case switch into domain-grouped handlers | general-purpose | None |
| 4E: File size ratchet quality script | New `scripts/quality/check-file-size-ratchet.ts`, `package.json` | general-purpose | None |

**Conflict analysis**: 4A touches `cron.ts` only. 4B is frontend-only. 4C is Go-only. 4D touches MCP routes. 4E adds a new file. All safe for parallel execution.

### Wave 5: Architecture Documentation (1-2 agents, ~1 day)

Depends on: Waves 1-4 (documentation should reflect implemented state).

| Packet | Target Files | Agent Profile | Deps |
|--------|-------------|---------------|------|
| 5A: ADR-005 DO Patterns | New `docs/adr/005-durable-object-patterns.md` | general-purpose | Waves 1-4 |
| 5B: ADR-006 MCP Tool Surface | New `docs/adr/006-mcp-tool-surface.md` | general-purpose | Wave 4D |
| 5C: ADR-007 Orchestration System | New `docs/adr/007-orchestration-system.md` | general-purpose | None |
| 5D: Constitution v1.9 | `.specify/memory/constitution.md` — amend Principle IV file size limits | general-purpose | Wave 4E |
| 5E: ROADMAP.md | New `ROADMAP.md` | general-purpose | None |

---

## Section H: Cross-Track Finding Summary

### Finding Counts by Track

| Track | Title | Findings | CRITICAL | HIGH | MEDIUM | LOW | INFO |
|-------|-------|----------|----------|------|--------|-----|------|
| 1 | Data Model Integrity | 14 | 1 | 4 | 6 | 2 | 1 |
| 2 | Data Flow & Communication | 11* | 0 | 1 | ~6 | ~3 | ~1 |
| 3 | Code Organization | 19 | 0 | 5 | 8 | 4 | 2 |
| 4 | Coding Standards | 12* | 0 | 1 | ~7 | ~3 | ~1 |
| 5 | Performance & Cost | 13 | 0 | 3 | 6 | 3 | 1 |
| 6 | Testing & Experiments | 12 | 0 | 3 | 5 | 3 | 1 |
| 7 | Security & Isolation | 21 | 0 | 6 | 8 | 4 | 3 |
| **8** | **Architecture & Debt (this)** | **12** | **0** | **3** | **5** | **3** | **1** |
| 9 | Agent Readiness | 18 | 0 | 5 | 7 | 4 | 2 |
| **TOTAL** | | **132** | **1** | **31** | **~58** | **~29** | **~13** |

*Tracks 2 and 4 were pending at evaluation time; counts are from prior summaries.

### Track 8 Finding Index

| ID | Severity | Title | Section |
|----|----------|-------|---------|
| 8A1 | LOW | ADR-003 UI Stack Drift | A |
| 8A2 | MEDIUM | Missing ADRs for Major Decisions | A |
| 8A3 | INFO | ADR-001 Number Collision | A |
| 8B1 | HIGH | Constitution vs Rule File Size Drift | B |
| 8B2 | HIGH | No Coverage Thresholds (Principle II) | B |
| 8B3 | LOW | Missing ROADMAP.md (Principle V) | B |
| 8B4 | LOW | Hardcoded Observability Limits (Principle XI) | B |
| 8C1 | MEDIUM | Orchestration Scope Expansion | C |
| 8C2 | LOW | Spec 018 Session Resume Changed | C |
| 8C3 | LOW (positive) | Provider Abstraction Exceeded Spec | C |
| 8D1 | MEDIUM | 10 Unknown Debt Items Not in Backlog | D |
| 8E1 | MEDIUM | Plugin Architecture Not Ready | E |

---

## Appendix: Evaluation Methodology

This track synthesized findings by:
1. Reading all 6 completed track reports (Tracks 1, 3, 5, 6, 7, 9) in full
2. Using prior task summaries for the 2 pending tracks (Tracks 2, 4)
3. Reading all 5 ADRs in `docs/adr/` and assessing currency against current codebase state
4. Reading the full constitution (v1.8.0, 13 principles, 928 lines) and checking compliance principle-by-principle
5. Categorizing all 165 backlog tasks in `tasks/backlog/` by 9 debt categories
6. Examining provider abstraction (`packages/providers/src/types.ts`), plugin readiness, and CF Containers prototype (`admin-sandbox.ts`)
7. Cross-referencing track findings to identify multi-track hotspots and sequencing dependencies
8. Designing wave plan by analyzing file-level conflict boundaries between work packets
9. Using 3 parallel subagents for: backlog categorization, spec drift analysis, and constitution compliance verification
