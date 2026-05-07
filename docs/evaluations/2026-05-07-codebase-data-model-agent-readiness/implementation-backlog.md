# Implementation Backlog

This backlog converts the evaluation into implementation-ready work packets for future SAM agent swarms. Waves are ordered by risk and dependency. Tasks within a wave are designed to minimize file conflicts.

## Wave 1: Security And Data Integrity

Can start immediately. These are the highest-risk items.

### 1A. Atomic Token Budget Accounting

**Priority**: P0
**Source Findings**: F-001
**Owned Paths**: `apps/api/src/services/ai-token-budget.ts`, possible new Durable Object/service files
**Recommended Skill(s)**: `$cloudflare-specialist`, `$security-auditor`, `$test-engineer`

**Problem**: KV read-modify-write budget accounting can race under concurrent requests.

**Acceptance Criteria**:
- [ ] Token budget increments are atomic under concurrent requests.
- [ ] Existing budget semantics are preserved.
- [ ] Regression test simulates concurrent spend attempts.
- [ ] Documentation explains why KV is no longer used for the atomic counter.

**Verification**:
- `pnpm --filter @simple-agent-manager/api test`
- Targeted Miniflare/DO concurrency test.

### 1B. Workspace Proxy Ownership Check

**Priority**: P0
**Source Findings**: F-002
**Owned Paths**: `apps/api/src/index.ts`, workspace ownership helpers/tests
**Recommended Skill(s)**: `$security-auditor`, `$test-engineer`

**Problem**: Workspace subdomain proxying must verify that the authenticated user owns the target workspace.

**Acceptance Criteria**:
- [ ] Proxy path rejects authenticated users who do not own the workspace.
- [ ] Admin-only behavior, if any, is explicit and tested.
- [ ] Regression tests cover same-user allow and cross-user deny.

**Verification**:
- `pnpm --filter @simple-agent-manager/api test`
- Security review before PR merge.

### 1C. FTS5 Query Sanitization Hardening

**Priority**: P0
**Source Findings**: F-003
**Owned Paths**: `apps/api/src/durable-objects/project-data/`
**Recommended Skill(s)**: `$cloudflare-specialist`, `$security-auditor`

**Problem**: FTS5 sanitization behavior differs across ProjectData query paths.

**Acceptance Criteria**:
- [ ] One shared sanitizer is used for all FTS5 MATCH queries.
- [ ] Tests cover quotes, operators, punctuation, and empty queries.
- [ ] Fallback LIKE path remains safe and documented.

**Verification**:
- `pnpm --filter @simple-agent-manager/api test`

### 1D. Callback Token/JWT Hardening

**Priority**: P0
**Source Findings**: F-004, F-010
**Owned Paths**: callback auth services, VM agent callback validation, bootstrap KV handling
**Recommended Skill(s)**: `$security-auditor`, `$go-specialist`

**Problem**: Callback token validation is split across multiple paths and bootstrap material needs stricter lifecycle handling.

**Acceptance Criteria**:
- [ ] Worker and VM agent callback validation share one documented contract.
- [ ] Bootstrap token/JWT storage lifecycle is minimized and tested.
- [ ] Contract test covers auth mechanism, request shape, and failure modes.

**Verification**:
- API unit tests plus VM agent Go tests.
- Cross-boundary contract test.

## Wave 2: Agent Context Budget And Repo Navigation

Can run parallel with Wave 1.

### 2A. Reduce Always-Loaded Instruction Budget

**Priority**: P0
**Source Findings**: F-005
**Owned Paths**: `AGENTS.md`, `CLAUDE.md`, `.claude/rules/`, `.agents/skills/`
**Recommended Skill(s)**: `$doc-sync-validator`

**Problem**: Root instructions consume too much agent context every session.

**Acceptance Criteria**:
- [ ] Duplicate root instructions are consolidated.
- [ ] Specialized content moves into skills or focused guides.
- [ ] A measured before/after line and approximate token count is documented.
- [ ] No hard rule is removed without a replacement source of truth.

**Verification**:
- Manual doc review.
- `$doc-sync-validator` review.

### 2B. Add Nested AGENTS.md Files

**Priority**: P1
**Source Findings**: F-025
**Owned Paths**: `apps/*/AGENTS.md`, `packages/*/AGENTS.md`
**Recommended Skill(s)**: `$doc-sync-validator`

**Problem**: Most packages lack local instructions, forcing agents to load broad root context.

**Acceptance Criteria**:
- [ ] Add nested instructions for `apps/api`, `apps/web`, `apps/www`, `packages/vm-agent`, `packages/ui`, `packages/providers`, and other high-traffic packages.
- [ ] Each file includes local commands, owned paths, verification commands, and local gotchas.
- [ ] Root AGENTS.md explains precedence and links to nested files.

**Verification**:
- Markdown review.
- Spot-check that local commands exist.

### 2C. Create `.claude/settings.json`

**Priority**: P1
**Source Findings**: F-028
**Owned Paths**: `.claude/settings.json`
**Recommended Skill(s)**: General

**Problem**: Permission and hook configuration is not versioned with the repo.

**Acceptance Criteria**:
- [ ] Add minimal repo-appropriate settings.
- [ ] Document why each hook/permission is included.
- [ ] Avoid overbroad permissions.

**Verification**:
- Manual review.

## Wave 3: Testing Foundation

Should land before large refactors.

### 3A. Enforce Coverage Thresholds

**Priority**: P1
**Source Findings**: F-022, F-024
**Owned Paths**: Vitest configs, `.github/workflows/ci.yml`
**Recommended Skill(s)**: `$test-engineer`

**Acceptance Criteria**:
- [ ] Coverage thresholds exist for API and web.
- [ ] Initial thresholds match current reality and can ratchet upward.
- [ ] Critical paths get separate thresholds or explicit coverage targets.

### 3B. Add TaskRunner And NodeLifecycle Miniflare Tests

**Priority**: P1
**Source Findings**: F-021
**Owned Paths**: `apps/api/tests/`, DO test setup
**Recommended Skill(s)**: `$cloudflare-specialist`, `$test-engineer`

**Acceptance Criteria**:
- [ ] TaskRunner happy path and key failure path covered in Miniflare.
- [ ] NodeLifecycle warm/destroy alarm behavior covered in Miniflare.
- [ ] Tests use realistic D1/KV/DO bindings, not source-contract assertions.

### 3C. Enable Go Race Detector In CI

**Priority**: P1
**Source Findings**: F-023
**Owned Paths**: `.github/workflows/ci.yml`, `packages/vm-agent/`
**Recommended Skill(s)**: `$go-specialist`

**Acceptance Criteria**:
- [ ] CI runs relevant Go tests with `-race`.
- [ ] Any pre-existing race failures are fixed or documented as blockers.

## Wave 4: Performance And Code Organization

Depends on Wave 3 for safer refactoring.

### 4A. Batch Cron Queries And Parallelize VM RPCs

**Priority**: P1
**Source Findings**: F-017, F-018
**Owned Paths**: `apps/api/src/routes/cron.ts`
**Recommended Skill(s)**: `$cloudflare-specialist`

**Acceptance Criteria**:
- [ ] Stuck-task recovery avoids per-node query loops.
- [ ] Node cleanup RPCs are bounded and parallelized.
- [ ] Tests cover multi-node behavior.

### 4B. Add Frontend Route Code Splitting

**Priority**: P1
**Source Findings**: F-019
**Owned Paths**: `apps/web/src/App.tsx`, route components
**Recommended Skill(s)**: `$ui-ux-specialist`

**Acceptance Criteria**:
- [ ] Major routes use `React.lazy()` or equivalent.
- [ ] Loading states are accessible and visually acceptable.
- [ ] Bundle analysis shows initial JS reduction.

### 4C. Split Oversized VM Agent Packages

**Priority**: P1
**Source Findings**: F-012, F-013
**Owned Paths**: `packages/vm-agent/internal/server/`, `packages/vm-agent/internal/acp/session_host.go`
**Recommended Skill(s)**: `$go-specialist`

**Acceptance Criteria**:
- [ ] Split along package responsibilities without behavior changes.
- [ ] Go tests pass with race detector.
- [ ] Public interfaces remain small and documented.

### 4D. Modularize MCP Tool Routing

**Priority**: P1
**Source Findings**: F-020, F-026
**Owned Paths**: `apps/api/src/routes/mcp/`
**Recommended Skill(s)**: General, `$api-reference`

**Acceptance Criteria**:
- [ ] Tool handlers are domain-registered instead of centralized in a monolithic switch.
- [ ] Tool metadata is discoverable and testable.
- [ ] Existing tool names remain backwards compatible.

## Wave 5: Architecture Documentation And Extensibility

Should follow early fixes so docs reflect current reality.

### 5A. Backfill Missing ADRs

**Priority**: P2
**Source Findings**: F-024 and Track 8 ADR gaps
**Owned Paths**: `docs/adr/`
**Recommended Skill(s)**: `$doc-sync-validator`

**Acceptance Criteria**:
- [ ] Add ADRs for Durable Object patterns, MCP tool surface, orchestration system, and instruction architecture.
- [ ] Each ADR cites current code paths.

### 5B. Update Constitution Or File-Size Enforcement

**Priority**: P2
**Source Findings**: F-024
**Owned Paths**: `.specify/memory/constitution.md`, `.claude/rules/18-file-size-limits.md`, quality scripts
**Recommended Skill(s)**: `$constitution-validator`

**Acceptance Criteria**:
- [ ] Decide whether the real rule is 400 lines or 500/800.
- [ ] Constitution, rule files, and CI checks agree.

### 5C. Define Plugin Architecture Boundary

**Priority**: P2
**Source Findings**: Track 8 plugin readiness
**Owned Paths**: `docs/architecture/`, billing services, future plugin boundary
**Recommended Skill(s)**: `$engineering-strategy`, `$business-strategy`

**Acceptance Criteria**:
- [ ] Document OSS/core vs premium extension boundary.
- [ ] Identify first extraction seam for billing.
- [ ] Define how plugins register routes/tools without bloating root context.
