# Track 8: Architecture Alignment & Technical Debt

Status: In Progress.

## Executive Summary

Track 8 synthesizes findings from all other evaluation tracks (1-7, 9) into a unified strategic debt map with effort/impact/sequencing recommendations. This is the final synthesis track — it identifies architecture decision drift, constitution compliance gaps, debt hotspots, and produces an implementation wave plan for parallel agent swarms.

**Key Metrics:**
- ADRs: 5 total (1 superseded, 4 active, 0 stale-but-active)
- Constitution principles: 13 (3 NON-NEGOTIABLE)
- Backlog tasks: 165 (categorized below)
- Cross-track findings synthesized: 99 total from Tracks 1-7 and 9
- Quality gate scripts: 9 automated checks in CI
- Specs: 33 directories (15+ implemented, ~5 partially, remainder historical/superseded)

---

## Section A: ADR Currency Assessment

### ADR Inventory

| ADR | Title | Status | Currency |
|-----|-------|--------|----------|
| 001 (duplicate) | GitHub App over OAuth | Accepted | CURRENT — Still the active auth model |
| 001 | Monorepo Structure | Accepted | CURRENT — Structure matches reality (`apps/`, `packages/`) |
| 002 | Stateless Architecture | **Superseded** | CORRECTLY MARKED — superseded note references D1 migration |
| 003 | Unified UI System Stack | Accepted | PARTIALLY STALE — references `packages/ui` governance API (`ui-governance.ts`) but Tailwind v4 adoption (spec 024) shifted styling approach |
| 004 | Hybrid D1 + DO Storage | Accepted | CURRENT — Accurately describes the live architecture |

### ADR Drift Findings

#### FINDING-8A1: ADR-003 UI Stack Drift

- **Severity**: LOW
- **Location**: `docs/adr/003-ui-system-stack.md`
- **Description**: ADR-003 describes a shadcn-compatible component approach with governance APIs in `ui-governance.ts`. The actual codebase adopted Tailwind CSS v4 directly (spec 024) and the governance route was deprecated. The ADR's decision rationale remains valid, but implementation details are stale.
- **Impact**: Low — new contributors may reference outdated patterns.
- **Recommendation**: Update ADR-003 with an amendment noting the Tailwind v4 adoption and removal of governance API route.

#### FINDING-8A2: Missing ADRs for Major Architectural Decisions

- **Severity**: MEDIUM
- **Location**: `docs/adr/` (absence)
- **Description**: Several major architectural decisions lack corresponding ADRs:
  1. **Durable Object proliferation** (6 DO classes: ProjectData, TaskRunner, NodeLifecycle, TrialOrchestrator, CodexRefreshLock, ProjectOrchestrator, SamSession, AdminLogs) — no ADR explains the DO-per-concern pattern or when to add a new DO vs extend an existing one.
  2. **MCP tool surface as primary agent API** — 84+ MCP tools with no ADR explaining the protocol choice, tool taxonomy, or progressive disclosure strategy.
  3. **Mission/orchestration architecture** — Multi-phase orchestration (missions, handoffs, mailbox, scheduling) with no ADR documenting the decision to build a custom DAG scheduler vs using existing tools.
  4. **Agent instruction architecture** (~4,041 lines of rules always loaded) — No ADR for the CLAUDE.md + 35 rules design or its context budget implications.
- **Impact**: Medium — new architects cannot understand WHY these patterns were chosen; makes future changes risky.
- **Recommendation**: Create ADR-005 through ADR-008 for these decisions, even retroactively.

---

## Section B: Constitution Compliance Assessment

### Principle-by-Principle Analysis

| Principle | Status | Key Violations |
|-----------|--------|----------------|
| I. Open Source Sustainability | COMPLIANT | AGPL-3.0 license; no enterprise/ directory; billing code in main tree (minor concern) |
| II. Infrastructure Stability (NON-NEG) | PARTIAL | No coverage thresholds enforced; only 2% Miniflare integration tests (Track 6) |
| III. Documentation Excellence | PARTIAL | 36 post-mortems (strong); ADR gaps (above); self-hosting guide exists but lags features |
| IV. Approachable Code | VIOLATED | Constitution says 50-line functions / 400-line files; rule 18 says 500/800; 15 files exceed 800 lines (Track 3) |
| V. Transparent Roadmap | PARTIAL | No ROADMAP.md found; `tasks/` system substitutes but isn't public-facing |
| VI. Automated Quality Gates | STRONG | 9 quality scripts; ESLint; pre-commit hooks; CI enforcement |
| VII. Inclusive Contribution | PARTIAL | CONTRIBUTING.md exists; no `good-first-issue` labels observed |
| VIII. AI-Friendly Repository | STRONG | CLAUDE.md, 35 rules, AGENTS.md, subagents; but context budget crisis (Track 9) |
| IX. Clean Code Architecture | COMPLIANT | Clear `apps/` vs `packages/` separation; no circular deps |
| X. Simplicity & Clarity | PARTIAL | Official SDKs used; but orchestration complexity (missions/handoffs/mailbox) is high |
| XI. No Hardcoded Values (NON-NEG) | MOSTLY COMPLIANT | Strong `env.VAR ?? DEFAULT` pattern; minor violations in test fixtures |
| XII. Zero-to-Production (NON-NEG) | PARTIAL | Self-hosting guide exists; Pulumi IaC; but some features lack self-hosting docs (AI proxy, sandbox) |
| XIII. Fail-Fast (NON-NEG) | PARTIAL | Good boundary validation in recent code; older routes lack consistent fail-fast (Track 2 findings) |

### Critical Constitution Violations

#### FINDING-8B1: Constitution vs Rule File Size Limits Contradiction

- **Severity**: HIGH
- **Location**: `.specify/memory/constitution.md:85` vs `.claude/rules/18-file-size-limits.md`
- **Description**: The constitution (Principle IV) specifies "Functions under 50 lines; files under 400 lines (excluding tests)". The enforced rule (rule 18) uses 500-line warning / 800-line mandatory split threshold. This 2x drift between constitutional law and enforced policy means the constitution is effectively unenforced for file sizes. Track 3 found 15 files exceeding 800 lines and many more exceeding 400.
- **Impact**: High — the constitution claims a standard that is systematically violated. Either the constitution should be amended or enforcement should tighten.
- **Recommendation**: Amend constitution Principle IV to match the enforced 500/800 threshold (reflecting practical reality for a project of this scale), or implement the 400-line limit via a new quality script.

#### FINDING-8B2: No Coverage Thresholds Enforced (Principle II Violation)

- **Severity**: HIGH
- **Location**: CI configuration (absence in `vitest.config.ts` files)
- **Description**: Constitution Principle II requires ">90% coverage for critical paths" and ">80% overall". Track 6 found NO coverage thresholds are configured in any vitest config or CI workflow. Coverage can regress silently.
- **Impact**: High — the NON-NEGOTIABLE principle is unenforced. Cannot verify compliance without thresholds.
- **Recommendation**: Add `coverage.thresholds` to vitest configs; start with 60% (current estimated level) and ratchet up quarterly.

#### FINDING-8B3: Missing ROADMAP.md (Principle V Violation)

- **Severity**: LOW
- **Location**: Repository root (absence)
- **Description**: Constitution Principle V requires a ROADMAP.md. None exists. The `tasks/` system and `strategy/engineering/` partially substitute but are internal-facing, not contributor-friendly.
- **Impact**: Low — external contributors cannot easily understand project direction.
- **Recommendation**: Generate ROADMAP.md from `strategy/engineering/` artifacts.

---

## Section C: Spec vs Reality Drift

### Implemented Specs with Notable Drift

#### FINDING-8C1: Orchestration Complexity Beyond Original Spec

- **Severity**: MEDIUM
- **Location**: `specs/021-task-chat-architecture/` vs actual implementation
- **Description**: Spec 021 defined a task-driven chat architecture. The actual implementation grew far beyond the spec to include: missions (spec unplanned), handoff packets, durable mailbox (5 message classes), ProjectOrchestrator DO with alarm-driven scheduling, policy propagation, and a full DAG scheduler. This represents significant scope expansion from "task chat" to "autonomous orchestration platform."
- **Impact**: Medium — the spec no longer describes the system. New contributors reading spec 021 will have an incomplete mental model.
- **Recommendation**: Create a new umbrella spec or architecture document for the orchestration subsystem.

#### FINDING-8C2: Provider Abstraction Exceeded Spec Scope

- **Severity**: LOW
- **Location**: `specs/028-provider-infrastructure/` vs `packages/providers/`
- **Description**: Three providers are implemented (Hetzner, Scaleway, GCP) with a clean `Provider` interface. The abstraction is well-designed. Minor drift: the spec may not cover all the per-project scaling parameters and provider-aware location validation that were added later.
- **Impact**: Low — the code is better than the spec in this case.

### Unimplemented Spec Features

Based on the 33 spec directories, several early specs are historical (001-005) and represent superseded designs. The active feature pipeline (018-030+) is largely implemented per CLAUDE.md "Recent Changes." Notable gaps:

- `specs/029-conversation-forking/` — Designed but implementation status unclear
- `specs/030-workspace-port-exposure/` — Designed but only partially referenced in recent changes
- `specs/tdf-2-orchestration-engine/` and `specs/tdf-5-workspace-lifecycle/` — Task decomposition specs that fed into the orchestration system

---

## Section D: Technical Debt Inventory (Cross-Track Synthesis)

### Debt Hotspot Map

The following areas accumulate debt across multiple tracks, indicating systemic issues:

| Hotspot | Tracks | Combined Severity | Description |
|---------|--------|-------------------|-------------|
| **ProjectData DO** | 1, 3, 6, 7 | CRITICAL | 19 migrations, 15+ tables, FTS5 inconsistency, no Miniflare tests, growing complexity |
| **MCP Tool Surface** | 3, 7, 9 | HIGH | 84 tools, monolithic switch, no progressive discovery, rate limiter non-atomic |
| **Agent Context Budget** | 3, 9 | HIGH | 4,041 lines / ~28k tokens always loaded; CLAUDE.md 293 lines + 35 rules 3,338 lines |
| **VM Agent (Go)** | 3, 6 | HIGH | 9,303-line server package, 2,535-line session_host.go, no -race in CI |
| **KV Token Budget** | 1, 7 | CRITICAL | Non-atomic read-modify-write for rate limiting and budget enforcement |
| **Cron N+1 Queries** | 5 | HIGH | Sequential DB + RPC calls in scheduled handlers, linear scaling |
| **Frontend Bundle** | 5, 9 | MEDIUM | ~700KB unplit bundle, no code splitting, no lazy routes |

### Debt by Category (from 165 Backlog Tasks)

| Category | Count | Key Examples |
|----------|-------|--------------|
| Feature debt (new providers, new capabilities) | ~50 | 7 provider tasks, MCP servers, CLI tool, PWA notifications |
| Reliability debt (races, lifecycle bugs) | ~35 | ACP reconnect, session context loss, workspace cleanup |
| Architecture debt (simplification, refactoring) | ~25 | Simplify DOs, simplify VM agent, simplify deploy scripts |
| UX debt (mobile, navigation, chat) | ~20 | Mobile nav, sidebar redesign, chat continuation |
| Testing debt (missing tests, flaky tests) | ~15 | Flaky VM agent tests, source contract migration, infrastructure |
| Security debt (auth, tokens, encryption) | ~10 | Bootstrap token dead code, provisioning 401, callback auth |
| Observability debt (logging, debugging) | ~5 | Log viewer gaps, task status display |
| Documentation debt | ~5 | Stale docs, missing guides |

### Unknown Debt (Not in Backlog)

Track findings that are NOT represented in any existing backlog task:

1. **KV race condition for token budgets** (Track 1, CRITICAL) — `ai-token-budget.ts:190-221` uses non-atomic read-modify-write. Not in backlog.
2. **Workspace subdomain proxy ownership bypass** (Track 7, HIGH) — `index.ts:188-256`. Not in backlog.
3. **Context budget crisis** (Track 9, HIGH) — 4,041 lines always loaded. Not in backlog.
4. **No JWT revocation mechanism** (Track 7, HIGH) — Design gap. Not in backlog.
5. **Sequential VM RPCs in node cleanup** (Track 5, HIGH) — `node-cleanup:276-320`. Not in backlog.

---

## Section E: Architecture Evolutionary Assessment

### Plugin Architecture Readiness

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Core/extension separation | NOT READY | No `enterprise/` or `plugins/` directory; billing code mixed in main tree |
| Hook/event system | PARTIAL | DO alarm system; cron scheduler; but no plugin lifecycle hooks |
| Extension points identified | NOT READY | No documented extension API; MCP tools are flat list |
| Billing isolation | NOT READY | AI billing (`ai-billing.ts`, `ai-proxy-shared.ts`) in core `apps/api/src/services/` |
| Feature flags for gating | MINIMAL | Only `SANDBOX_ENABLED`, `AI_PROXY_ENABLED`; no generic feature flag system |

**Assessment**: Plugin architecture would require significant refactoring. The monolithic API worker with all routes, services, and DOs in a single deployment makes extraction difficult. Recommended path: start with billing service extraction behind a feature boundary.

### Provider Abstraction Quality

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Interface defined | STRONG | `Provider` interface in `packages/providers/src/types.ts:90-126` |
| Multiple implementations | STRONG | Hetzner, Scaleway, GCP all implement the interface |
| Provider-agnostic orchestration | STRONG | TaskRunner and NodeLifecycle use provider abstraction |
| Per-project overrides | STRONG | `per-project-scaling-provider-locations` feature |
| Easy to add new providers | STRONG | Interface is minimal (7 methods); config is discriminated union |

**Assessment**: Provider abstraction is the strongest architectural pattern in the codebase. Adding a new provider requires only implementing the interface and adding a config variant. The 7 backlog tasks for new providers (DigitalOcean, Linode, Vultr, OVH, UpCloud, Lightsail) are straightforward implementations.

### Cloudflare Containers Readiness

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Binding infrastructure | READY | `sync-wrangler-config.ts:124` handles `containers` binding |
| Experimental prototype | READY | `admin-sandbox.ts` with full CRUD against `env.SANDBOX` binding |
| Env type declared | READY | `apps/api/src/env.ts:52` — `SANDBOX` binding typed |
| Integration design | DOCUMENTED | `docs/architecture/agent-harness-integration.md` maps CF Containers for agent runtime |
| Kill switch | READY | `SANDBOX_ENABLED` env var (default: false) |
| Production readiness | NOT READY | Admin-only; no user-facing workflow; no session persistence in containers |

**Assessment**: Cloudflare Containers is well-prototyped. The path from current VM-based execution to container-based execution is documented in the harness integration design. Key blocker: containers lack persistent storage, so the current per-project SQLite (DO-based) would need a different persistence strategy for container workloads.

### Scalability Bottlenecks

From Track 5's analysis, key scaling walls:

| Bottleneck | Threshold | Impact | Mitigation |
|------------|-----------|--------|------------|
| D1 read limits | ~500 concurrent users | Dashboard fan-out queries hit row scan limits | Pagination, caching, materialized views |
| Cron N+1 | Linear with active nodes | Each node = 1 DB query + 1 RPC in stuck-task handler | Batch queries, parallel RPCs |
| Single Worker deployment | All routes in one Worker | Cold start, memory pressure at scale | Route-based Worker splitting |
| KV eventual consistency | Under concurrent writes | Token budget race conditions | Durable Object for atomic counters |
| Frontend bundle size | 700KB | Slow initial load, poor mobile experience | Code splitting, lazy routes |

---

## Section F: Strategic Debt Map

### Effort/Impact Matrix

```
                    HIGH IMPACT
                        |
    KV Race Fix (P0)    |    Context Budget (P0)
    Subdomain Auth (P0) |    DO Test Coverage (P1)
                        |    MCP Progressive Discovery (P1)
   ─────────────────────┼───────────────────────────────
                        |
    ADR Backfill (P2)   |    Plugin Architecture (P2)
    Constitution Amend  |    Frontend Code Split (P1)
    ROADMAP.md (P2)     |    Cron Parallelization (P1)
                        |
                   LOW IMPACT

         LOW EFFORT ─────────────── HIGH EFFORT
```

### Priority Sequencing

| Priority | Theme | Findings | Rationale |
|----------|-------|----------|-----------|
| **P0** (Immediate) | Security & Data Integrity | KV race (1-CRITICAL), subdomain bypass (7-HIGH), JWT revocation (7-HIGH) | User data at risk |
| **P0** (Immediate) | Context Budget | 4,041 lines always-loaded rules (9-HIGH), CLAUDE.md bloat | Agent effectiveness degrading |
| **P1** (Next Sprint) | Testing Foundation | Coverage thresholds, Miniflare DO tests, Go -race CI (6-HIGH) | Safety net for all other changes |
| **P1** (Next Sprint) | Performance | Cron N+1 fix, sequential RPC parallelization, frontend code split (5-HIGH) | Cost and UX at scale |
| **P1** (Next Sprint) | Code Organization | File size ratchet, VM agent split, MCP tool modularization (3-HIGH) | Maintainability for agents |
| **P2** (Next Quarter) | Architecture Docs | Missing ADRs, constitution amendment, ROADMAP.md | Contributor onboarding |
| **P2** (Next Quarter) | Platform Extensibility | Plugin boundaries, billing extraction, feature flag system | Business model support |

---

## Section G: Implementation Wave Plan

Waves group non-conflicting work packets that can be executed by parallel agent swarms without merge conflicts.

### Wave 1: Security Hardening (2-3 agents, ~1 day)

| Packet | Files | Agent Profile | Dependency |
|--------|-------|---------------|------------|
| 1A: Atomic token budget | `apps/api/src/services/ai-token-budget.ts` | cloudflare-specialist | None |
| 1B: Subdomain proxy ownership | `apps/api/src/index.ts:188-256` | security-auditor | None |
| 1C: JWT revocation via KV blocklist | `apps/api/src/middleware/`, `apps/api/src/services/` | security-auditor | None |
| 1D: FTS5 input sanitization | `apps/api/src/durable-objects/project-data/` | cloudflare-specialist | None |

**No conflicts**: Each packet touches distinct files/modules.

### Wave 2: Agent Context Budget Reduction (1-2 agents, ~1 day)

| Packet | Files | Agent Profile | Dependency |
|--------|-------|---------------|------------|
| 2A: Rule consolidation | `.claude/rules/*.md` | general-purpose | None |
| 2B: CLAUDE.md Recent Changes pruning | `CLAUDE.md` | general-purpose | None |
| 2C: Conditional rule loading design | `.claude/settings.json`, rule files | general-purpose | 2A |

**Note**: Wave 2 can run parallel to Wave 1 (different file domains).

### Wave 3: Testing Foundation (2-3 agents, ~2 days)

| Packet | Files | Agent Profile | Dependency |
|--------|-------|---------------|------------|
| 3A: Coverage thresholds | `apps/api/vitest.config.ts`, `apps/web/vitest.config.ts`, CI workflow | test-engineer | None |
| 3B: TaskRunner Miniflare tests | `apps/api/tests/integration/task-runner.*` | cloudflare-specialist | None |
| 3C: NodeLifecycle Miniflare tests | `apps/api/tests/integration/node-lifecycle.*` | cloudflare-specialist | None |
| 3D: Go -race CI integration | `.github/workflows/ci.yml`, `packages/vm-agent/` | go-specialist | None |

**Conflicts**: 3B and 3C may both touch `vitest.workers.config.ts` — sequence them or coordinate config changes.

### Wave 4: Performance & Code Organization (3-4 agents, ~3 days)

| Packet | Files | Agent Profile | Dependency |
|--------|-------|---------------|------------|
| 4A: Cron N+1 batch fix | `apps/api/src/routes/cron.ts` (stuck-tasks handler) | cloudflare-specialist | Wave 3 (tests first) |
| 4B: Frontend code splitting | `apps/web/src/App.tsx`, route files | ui-ux-specialist | None |
| 4C: VM agent server package split | `packages/vm-agent/internal/server/` | go-specialist | None |
| 4D: MCP tool file split | `apps/api/src/routes/mcp/` | general-purpose | None |
| 4E: File size ratchet quality script | `scripts/quality/`, `package.json` | general-purpose | None |

**Conflicts**: 4D touches MCP files that 4A's cron fix should not need. 4C is isolated Go code.

### Wave 5: Architecture Documentation (1-2 agents, ~1 day)

| Packet | Files | Agent Profile | Dependency |
|--------|-------|---------------|------------|
| 5A: ADR-005 DO Proliferation | `docs/adr/005-durable-object-patterns.md` | general-purpose | Waves 1-4 |
| 5B: ADR-006 MCP Tool Surface | `docs/adr/006-mcp-tool-surface.md` | general-purpose | Wave 4D |
| 5C: Constitution v1.9 amendment | `.specify/memory/constitution.md` | general-purpose | Wave 4E |
| 5D: ROADMAP.md generation | `ROADMAP.md` | general-purpose | None |

---

## Section H: Cross-Track Finding Summary

| Track | Findings | CRITICAL | HIGH | MEDIUM | LOW/INFO |
|-------|----------|----------|------|--------|----------|
| 1: Data Model | 14 | 1 | 4 | 6 | 3 |
| 2: Data Flow | 11 | 0 | 1 | ~6 | ~4 |
| 3: Code Organization | 19 | 0 | 5 | ~8 | ~6 |
| 4: Coding Standards | 12 | 0 | 1 | ~7 | ~4 |
| 5: Performance & Cost | 13 | 0 | 3 | ~6 | ~4 |
| 6: Testing | 12 | 0 | 3 | ~5 | ~4 |
| 7: Security & Isolation | 21 | 0 | 6 | 8 | 7 |
| 8: Architecture (this track) | 12 | 0 | 3 | 5 | 4 |
| 9: Agent Readiness | 18 | 0 | 5 | 7 | 6 |
| **TOTAL** | **132** | **1** | **31** | **~58** | **~42** |

---

## Appendix: Evaluation Methodology

This track synthesized findings by:
1. Reading all completed track reports (Tracks 1, 3, 5, 6, 7, 9)
2. Using prior summaries for pending tracks (Tracks 2, 4)
3. Reading all 5 ADRs and assessing currency against current codebase
4. Reading the full constitution (v1.8.0, 13 principles) and checking compliance
5. Categorizing all 165 backlog tasks by debt type
6. Examining the provider abstraction, plugin readiness, and CF Containers prototype
7. Cross-referencing track findings to identify hotspots and sequencing dependencies
