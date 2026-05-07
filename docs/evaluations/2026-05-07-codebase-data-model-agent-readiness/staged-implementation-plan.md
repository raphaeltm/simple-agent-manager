# Staged Implementation Plan

**Source**: 2026-05-07 Codebase, Data Model & Agent Readiness Evaluation
**Created**: 2026-05-07
**Purpose**: Convert evaluation findings into staged, swarm-ready task packets with risk-minimizing deployment order.

## Guiding Principles

1. **Backward compatibility first** — no breaking changes without explicit migration path
2. **Low-risk before high-risk** — documentation and scaffolding before security-critical runtime changes
3. **Testing before refactoring** — establish coverage gates before splitting files or changing behavior
4. **Disjoint file ownership** — parallel packets touch non-overlapping files to avoid merge conflicts
5. **Self-contained packets** — each packet is independently executable by a future SAM agent

## Phase Overview

| Phase | Theme | Risk Level | Packet Count | Parallelism |
|-------|-------|------------|-------------|-------------|
| 0 | Baseline & Task Shaping | None | This document | N/A |
| 1 | Low-Risk Documentation & Scaffolding | Low | 4 packets | All parallel |
| 2 | Testing Foundation | Low-Medium | 4 packets | 3 parallel, 1 sequential |
| 3 | Security & Data Integrity | High | 4 packets | All parallel (disjoint files) |
| 4 | Performance & Code Organization | Medium | 6 packets | All parallel (disjoint files) |
| 5 | Architecture Documentation | Low | 3 packets | All parallel |

## Phase 0: Baseline & Task Shaping (This Document)

**Status**: Complete
**Risk**: None — documentation only

This phase produces the staged plan and task packets. No runtime changes.

## Phase 1: Low-Risk Documentation & Scaffolding

**Risk**: Low — no runtime behavior changes
**Can start**: Immediately
**Blocked by**: Nothing

These packets modify only documentation, configuration, and agent instruction files. They cannot break runtime behavior.

| Packet | Finding IDs | Files Touched | Parallel? |
|--------|------------|---------------|-----------|
| [P1-01: Reduce Instruction Budget](task-packets/P1-01-reduce-instruction-budget.md) | F-005 | `AGENTS.md`, `CLAUDE.md`, `.claude/rules/` | Yes |
| [P1-02: Add Nested AGENTS.md](task-packets/P1-02-add-nested-agents-md.md) | F-025 | `apps/*/AGENTS.md`, `packages/*/AGENTS.md` | Yes |
| [P1-03: Create .claude/settings.json](task-packets/P1-03-create-claude-settings.md) | F-028 | `.claude/settings.json` | Yes |
| [P1-04: Update Constitution File-Size Limits](task-packets/P1-04-update-constitution-file-size.md) | F-024 | `.specify/memory/constitution.md`, `.claude/rules/18-file-size-limits.md` | Yes |

**Conflict analysis**: All packets touch disjoint file sets. Safe for full parallelism (4 agents).

## Phase 2: Testing Foundation

**Risk**: Low-Medium — adds CI enforcement, no behavior changes
**Can start**: Immediately (parallel with Phase 1)
**Blocked by**: Nothing

Establishes coverage gates and critical integration tests before any refactoring work.

| Packet | Finding IDs | Files Touched | Parallel? |
|--------|------------|---------------|-----------|
| [P2-01: Enforce Coverage Thresholds](task-packets/P2-01-enforce-coverage-thresholds.md) | F-022 | Vitest configs, CI workflow | Yes |
| [P2-02: TaskRunner & NodeLifecycle Miniflare Tests](task-packets/P2-02-taskrunner-nodelifecycle-miniflare-tests.md) | F-021 | `apps/api/tests/workers/` (new files) | Yes |
| [P2-03: Enable Go Race Detector in CI](task-packets/P2-03-enable-go-race-detector.md) | F-023 | `.github/workflows/ci.yml` | Yes |
| [P2-04: Add Playwright Visual Tests to CI](task-packets/P2-04-playwright-visual-tests-ci.md) | F-027 | `.github/workflows/ci.yml`, Playwright configs | Seq after P2-01 (both touch CI) |

**Conflict analysis**: P2-01 and P2-04 both modify `.github/workflows/ci.yml` — run P2-01 first, then P2-04. P2-02 and P2-03 are independent.

## Phase 3: Security & Data Integrity

**Risk**: High — modifies authentication, authorization, and data integrity paths
**Can start**: After Phase 2 (testing foundation provides safety net)
**BLOCKED**: Until staging baseline and compatibility plan are reviewed by human

These packets address the 5 P0 findings. Each modifies security-critical code paths.

| Packet | Finding IDs | Files Touched | Parallel? |
|--------|------------|---------------|-----------|
| [P3-01: Atomic Token Budget Accounting](task-packets/P3-01-atomic-token-budget.md) | F-001 | `apps/api/src/services/ai-token-budget.ts`, possible new DO | Yes |
| [P3-02: Workspace Proxy Ownership Check](task-packets/P3-02-workspace-proxy-ownership.md) | F-002 | `apps/api/src/index.ts` | Yes |
| [P3-03: FTS5 Query Sanitization Hardening](task-packets/P3-03-fts5-sanitization.md) | F-003 | `apps/api/src/durable-objects/project-data/` | Yes |
| [P3-04: Callback Token/JWT Hardening](task-packets/P3-04-callback-token-jwt-hardening.md) | F-004, F-010 | Callback auth services, VM agent callback flow | Yes |

**Conflict analysis**: All packets touch disjoint file sets. Safe for full parallelism (4 agents). However, P3-01 and P3-03 both touch Durable Object code — verify no shared imports before parallel execution.

**BLOCKING CONDITION**: These packets are marked BLOCKED until:
1. Phase 2 testing foundation is in place (coverage thresholds, Miniflare tests)
2. A human has reviewed this plan and confirmed the staging baseline is acceptable
3. Each packet's rollback plan has been validated

## Phase 4: Performance & Code Organization

**Risk**: Medium — refactoring with behavior preservation required
**Can start**: After Phase 2 (tests provide refactoring safety net)
**Recommended**: After Phase 3 (security fixes should land first)

| Packet | Finding IDs | Files Touched | Parallel? |
|--------|------------|---------------|-----------|
| [P4-01: Batch Cron Queries](task-packets/P4-01-batch-cron-queries.md) | F-017 | `apps/api/src/scheduled/stuck-tasks.ts` | Yes |
| [P4-02: Parallelize VM RPCs](task-packets/P4-02-parallelize-vm-rpcs.md) | F-018 | `apps/api/src/scheduled/node-cleanup.ts` | Yes |
| [P4-03: Frontend Code Splitting](task-packets/P4-03-frontend-code-splitting.md) | F-019 | `apps/web/src/App.tsx`, route components | Yes |
| [P4-04: Split Oversized VM Agent Packages](task-packets/P4-04-split-vm-agent-packages.md) | F-012, F-013 | `packages/vm-agent/internal/server/`, `session_host.go` | Yes |
| [P4-05: Modularize MCP Tool Routing](task-packets/P4-05-modularize-mcp-routing.md) | F-020, F-026 | `apps/api/src/routes/mcp/` | Yes |
| [P4-06: Split Oversized Route Files](task-packets/P4-06-split-oversized-route-files.md) | F-011, F-015 | `apps/api/src/routes/` (oversized files) | Yes |

**Conflict analysis**: All packets touch disjoint directories/files. Safe for full parallelism (6 agents).

## Phase 5: Architecture Documentation

**Risk**: Low — documentation only
**Can start**: After Phases 3-4 (docs should reflect implemented state)

| Packet | Finding IDs | Files Touched | Parallel? |
|--------|------------|---------------|-----------|
| [P5-01: Backfill Missing ADRs](task-packets/P5-01-backfill-adrs.md) | F-024 (Track 8) | `docs/adr/` | Yes |
| [P5-02: Define Plugin Architecture Boundary](task-packets/P5-02-plugin-architecture.md) | Track 8 plugin readiness | `docs/architecture/` | Yes |
| [P5-03: Oversized Route Valibot Validation](task-packets/P5-03-valibot-validation.md) | F-014 (Track 4) | `apps/api/src/routes/`, `apps/api/src/schemas/` | Yes |

**Note**: P5-03 (Valibot validation) is placed here because it touches many route files and benefits from P4-06 (route splitting) landing first.

## P0/P1 Coverage Matrix

Every P0/P1 finding from `findings-index.md` is accounted for below.

### P0 Findings (5 total — all packetized)

| Finding | Title | Packet |
|---------|-------|--------|
| F-001 (CRITICAL) | KV token budget non-atomic read-modify-write | P3-01 |
| F-002 (HIGH) | Workspace subdomain proxy bypasses ownership | P3-02 |
| F-003 (HIGH) | FTS5 query sanitization inconsistent | P3-03 |
| F-004 (HIGH) | Callback JWT/bootstrap token exposure | P3-04 |
| F-005 (HIGH) | Always-loaded instruction budget exceeds context | P1-01 |

### P1 Findings (23 total — all packetized or deferred)

| Finding | Title | Packet | Notes |
|---------|-------|--------|-------|
| F-006 | Duplicate D1 migration number prefixes | **Deferred** | Low risk, requires careful migration sequencing — not worth disrupting current migration numbering |
| F-007 | Missing onDelete on workspaces.installationId FK | **Deferred** | Schema change requires migration; low urgency since installation deletion is rare. Track in backlog. |
| F-008 | JSON columns lack runtime validation | P5-03 | Covered by Valibot validation packet |
| F-009 | ProjectData DO responsibility overload | **Deferred** | XL effort, needs design phase before implementation. Architecture doc in P5-01 will inform future work. |
| F-010 | Dual callback token validation paths | P3-04 | Combined with F-004 |
| F-011 | 15 files exceed 800-line hard limit | P4-06 | Route file splitting |
| F-012 | Top functions exceed 300+ lines | P4-04 | VM agent package split |
| F-013 | VM agent server package is 9,303 lines | P4-04 | VM agent package split |
| F-014 | Runtime validation gap at API boundaries | P5-03 | Valibot validation |
| F-015 | Oversized route files | P4-06 | Route file splitting |
| F-016 | Hardcoded colors bypass design token system | **Deferred** | UI-only, low security risk. File as backlog task. |
| F-017 | Cron N+1 query pattern | P4-01 | Cron batch queries |
| F-018 | Sequential VM agent RPCs in cleanup cron | P4-02 | Parallelize VM RPCs |
| F-019 | No frontend code splitting | P4-03 | Frontend code splitting |
| F-020 | Unbounded search in MCP idea tools | P4-05 | MCP modularization |
| F-021 | TaskRunner/NodeLifecycle lack Miniflare tests | P2-02 | Miniflare tests |
| F-022 | Coverage thresholds not enforced | P2-01 | Coverage thresholds |
| F-023 | Go race detector not in CI | P2-03 | Go race detector |
| F-024 | Constitution file-size limits drift | P1-04 | Constitution update |
| F-025 | 9 of 12 packages lack nested AGENTS.md | P1-02 | Nested AGENTS.md |
| F-026 | No progressive MCP tool discovery | P4-05 | MCP modularization |
| F-027 | Playwright visual tests not in CI | P2-04 | Playwright CI |
| F-028 | Missing .claude/settings.json | P1-03 | Settings.json |

### Explicitly Deferred Findings (4 total)

| Finding | Reason for Deferral |
|---------|-------------------|
| F-006 (Duplicate migration prefixes) | Low risk — migration numbering is stable. Changing it risks introducing new migration ordering bugs. |
| F-007 (Missing onDelete FK) | Schema change requires careful migration. Installation deletion is rare. Low urgency. |
| F-009 (ProjectData DO overload) | XL effort requiring design phase. The ADR in P5-01 will document current patterns and inform future splitting decisions. |
| F-016 (Hardcoded colors) | UI-only finding with no security or data integrity impact. Should be filed as a separate backlog task for the UI team. |

## Sequencing Diagram

```
Phase 0 (This document)
  │
  ├──→ Phase 1 (Docs/Scaffolding) ──→ ┐
  │    P1-01, P1-02, P1-03, P1-04     │
  │                                     │
  ├──→ Phase 2 (Testing Foundation) ──→ ├──→ Phase 3 (Security) ──→ Phase 4 (Perf/Code) ──→ Phase 5 (Arch Docs)
  │    P2-01, P2-02, P2-03, P2-04     │    P3-01..P3-04 [BLOCKED]   P4-01..P4-06            P5-01..P5-03
  │                                     │
  └────────────────────────────────────┘
```

## Dispatch Guidelines for Future Orchestrators

1. **Maximum 5 active implementation tasks** — per the evaluation's recommendation
2. **Disjoint file ownership** — verify no two active packets touch the same file
3. **Each packet uses `/do` skill** — ensures full research, implement, review, staging verify, PR workflow
4. **Commit and push frequently** — environments are ephemeral
5. **Security packets (Phase 3) require human review** before merge — add `needs-human-review` label
6. **Phase 3 is BLOCKED** — do not dispatch until human confirms staging baseline is acceptable

## Task Packet Index

All task packets are in the `task-packets/` subdirectory of this evaluation:

| Packet | Phase | Priority | Risk | Effort |
|--------|-------|----------|------|--------|
| P1-01 | 1 | P0 | Low | M |
| P1-02 | 1 | P1 | Low | M |
| P1-03 | 1 | P1 | Low | S |
| P1-04 | 1 | P1 | Low | S |
| P2-01 | 2 | P1 | Low | S |
| P2-02 | 2 | P1 | Low-Med | L |
| P2-03 | 2 | P1 | Low | S |
| P2-04 | 2 | P1 | Low | M |
| P3-01 | 3 | P0 | High | M |
| P3-02 | 3 | P0 | High | S |
| P3-03 | 3 | P0 | High | S |
| P3-04 | 3 | P0 | High | M |
| P4-01 | 4 | P1 | Medium | S |
| P4-02 | 4 | P1 | Medium | S |
| P4-03 | 4 | P1 | Medium | M |
| P4-04 | 4 | P1 | Medium | XL |
| P4-05 | 4 | P1 | Medium | L |
| P4-06 | 4 | P1 | Medium | L |
| P5-01 | 5 | P2 | Low | M |
| P5-02 | 5 | P2 | Low | M |
| P5-03 | 5 | P1 | Medium | M |
