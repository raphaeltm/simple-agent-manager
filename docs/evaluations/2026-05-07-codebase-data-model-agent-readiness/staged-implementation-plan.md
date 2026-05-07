# Staged Implementation Plan

Status: Draft.

Source evaluation: `docs/evaluations/2026-05-07-codebase-data-model-agent-readiness/`

Orchestrator task: `01KR0DBHQWK0XJW610HR7CPGS9`

## Safety Policy

Backward compatibility for already deployed SAM instances is the top priority. Prefer additive, reversible, compatibility-preserving changes. Avoid destructive migrations, required configuration changes without defaults, breaking API contracts, or changes that make older deployed instances unable to keep running.

Do not start high-risk implementation until `staging-baseline-2026-05-07.md` and this plan contain the required current-state, expected-state, compatibility, rollback, test, and staging verification details.

## Phase 0: Baseline And Task Shaping

Risk: Low, documentation and evidence only.

Status: In progress.

Scope:
- Establish staging baseline across Cloudflare Workers, routes, D1, Durable Objects, KV, R2, logs/errors, deploy history, app/API health, and current data shape.
- Convert the evaluation backlog into swarm-ready implementation task packets.
- Add compatibility and rollback requirements to each task packet.

Acceptance criteria:
- [ ] Baseline document contains concrete commands, timestamps, and findings.
- [ ] Every P0/P1 recommendation has an implementation packet with scope, files likely touched, risk, compatibility constraints, tests, staging verification, rollback notes, acceptance criteria, and finding links.
- [ ] Risky tasks are explicitly blocked until baseline and verification plans are reviewed.

## Phase 1: Documentation And Agent-Readiness Scaffolding

Risk: Low to medium, mostly docs/config. No deployed behavior changes unless a settings/config file changes agent behavior.

Candidate findings:
- F-005: Reduce always-loaded instruction budget.
- F-025: Add nested `AGENTS.md` files.
- F-028: Add `.claude/settings.json`.
- F-024: Align constitution/file-size rule decision, if scoped to docs first.

Compatibility constraints:
- Do not remove a hard rule unless an equivalent source of truth remains.
- Keep root instructions concise but preserve high-risk rule discoverability.
- Settings must avoid overbroad permissions and must not assume a single local environment.

## Phase 2: Security/Data-Integrity Fixes With Narrow Blast Radius

Risk: High. Requires baseline, compatibility plan, tests, staging deployment, log review, and realistic user workflow verification.

Candidate findings:
- F-002: Workspace proxy ownership verification.
- F-003: FTS5 query sanitization hardening.
- F-001: Atomic token budget accounting.
- F-004/F-010: Callback JWT/bootstrap token hardening.

Compatibility constraints:
- Existing sessions, workspaces, and callback flows must keep working.
- Any new storage primitive must be additive and have safe defaults.
- Token/JWT changes must support already-running VMs or include a migration/overlap window.

## Phase 3: Testing Foundation

Risk: Medium. CI behavior changes can block deployment but should not alter runtime behavior.

Candidate findings:
- F-021: TaskRunner and NodeLifecycle Miniflare tests.
- F-022: Coverage thresholds.
- F-023: Go race detector in CI.
- F-027: Playwright visual tests in CI.

Compatibility constraints:
- Initial thresholds must match current reality and ratchet upward later.
- Race detector additions must be scoped to tests that are stable in CI.

## Phase 4: Performance And Code Organization

Risk: Medium to high depending on touched surface. Requires Phase 3 coverage where practical.

Candidate findings:
- F-017/F-018: Batch cron queries and bounded parallel VM RPCs.
- F-019: Frontend route code splitting.
- F-011/F-012/F-013/F-015: Split oversized files/packages.
- F-020/F-026: Modularize MCP routing and progressive discovery.

Compatibility constraints:
- Preserve API contracts, MCP tool names, route paths, and existing UI behavior.
- Refactors should be behavior-preserving and split into disjoint file ownership.

## Phase 5: Architecture Documentation And Extension Boundaries

Risk: Low to medium. Documentation first; runtime plugin boundaries later.

Candidate findings:
- ADR gaps for Durable Objects, MCP surface, orchestration, instruction architecture.
- Plugin architecture boundary.
- ROADMAP and public/contributor planning gaps.

## Task Packet Template

Each implementation task must include:

- Scope.
- Files likely touched.
- Risk level.
- Compatibility constraints.
- Automated tests to add/run.
- Manual staging checks.
- Expected Cloudflare staging state before and after deployment.
- Visible behavior changes.
- Rollback strategy.
- Acceptance criteria.
- Links back to evaluation findings and track reports.
