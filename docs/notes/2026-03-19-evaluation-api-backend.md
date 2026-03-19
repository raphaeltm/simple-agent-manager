# API & Backend Module Evaluation

**Date**: 2026-03-19
**Scope**: `apps/api/`, `apps/tail-worker/`, `packages/providers/`, `packages/cloud-init/`

---

## 1. apps/api/ — Cloudflare Worker API (Hono)

### Purpose & Scope

Main API worker handling all control-plane operations: project management, workspace/node lifecycle, task execution, chat sessions, MCP server, admin observability, and GitHub OAuth. ~60,500 LOC across 99 source files. Well-scoped to its domain with clean separation into routes, services, middleware, Durable Objects, and DB schema.

### Code Quality

**Strengths:**
- Excellent service layer separation — routes delegate to services, no business logic in handlers
- Five well-scoped Durable Objects (ProjectData, TaskRunner, NodeLifecycle, AdminLogs, Notification), each with clear responsibility
- Consistent error handling via `AppError` class and global `app.onError()` handler
- Strong type safety with discriminated unions and branded types
- D1 schema is normalized with proper foreign keys, CASCADE deletes, and well-placed indexes

**Issues:**
- Some route files are oversized: `mcp.ts` (2,216 LOC), `tasks/crud.ts` (931 LOC), `nodes.ts` (742 LOC)
- ProjectData DO is 2,478 LOC — could benefit from splitting methods into sub-modules
- Inconsistent timestamp modes in schema: `users.createdAt` uses `timestamp_ms` (integer) while `projects.createdAt` uses TEXT with `CURRENT_TIMESTAMP`
- Error context could be richer — `AppError` lacks structured context fields and error cause chaining

### Test Coverage

112 test files, ~31,373 LOC (1.12:1 test-to-source ratio). Strong DO and service-level coverage. Key gaps:
- Route-level integration tests are sparse outside MCP and admin-observability
- No capability tests covering multi-boundary flows (task submit → runner → workspace → agent)
- Miniflare-based tests don't catch real binding issues that only manifest in staging

### Dead Code / Tech Debt

- `services/boot-log.ts` — unclear if actively integrated; needs audit
- `lib/route-helpers.ts:parsePositiveInt()` — only used in `mcp.ts`; could move to MCP-specific utils if routes are split
- No commented-out code or stale imports found otherwise

### Recommendations

1. **Split oversized routes** — Extract `mcp.ts` into method handler modules; separate node health/heartbeat from `nodes.ts`
2. **Add capability tests** — At least one test covering task submission → TaskRunner DO → workspace provisioning flow
3. **Standardize timestamps** — Pick one approach (integer ms or TEXT) across all schema tables

---

## 2. apps/tail-worker/ — Observability Tail Worker

### Purpose & Scope

Single-file Cloudflare Tail Worker (97 LOC) that captures API Worker logs, filters to error/warn/info, parses structured JSON, and forwards to AdminLogs DO via service binding. Extremely well-scoped — does exactly one thing.

### Code Quality

Clean, focused implementation. Correct error handling pattern for tail workers (fail silently — must never throw). Proper level filtering, timestamp normalization, and script name attribution. Full TypeScript strict mode.

One minor edge case: `new Date(log.timestamp)` could produce `"Invalid Date"` string if timestamp is malformed — low risk but worth a defensive check.

### Test Coverage

13 unit tests covering all main paths (level filtering, JSON parsing, fetch failures, missing bindings). Adequate for the module's complexity. No integration tests, which is acceptable since tail_consumers can't be tested with Miniflare.

### Dead Code / Tech Debt

None. All exports, types, and constants are actively used. No TODOs or deprecated patterns.

### Recommendations

1. **Add defensive timestamp validation** — Fallback to `new Date()` if `log.timestamp` produces invalid Date
2. **Add test for malformed timestamp** — Verify graceful handling

---

## 3. packages/providers/ — Cloud Provider Abstraction

### Purpose & Scope

Provider abstraction layer (1,424 LOC) with three complete implementations: Hetzner (266 LOC), Scaleway (361 LOC), and GCP (455 LOC). Clean `Provider` interface with factory pattern via `createProvider()`.

### Code Quality

**Strengths:**
- Excellent interface design with discriminated union `ProviderConfig`
- All three providers fully implemented — no stub methods
- Consistent error handling via `ProviderError` class with HTTP status codes
- Idempotent delete operations (404 = success) across all providers
- Hetzner has production-quality 412 placement retry with location fallback
- No `any` types; response bodies properly typed via interfaces
- Centralized `providerFetch()` wrapper with uniform timeout and error handling

**Issues:**
- GCP `createVM()` has high cyclomatic complexity (~80 LOC single method) — could extract image lookup and operation polling

### Test Coverage

163 tests total (all passing). Hetzner has the deepest coverage (57 tests including 412 retry logic with fake timers). Scaleway well-tested (56 tests). GCP coverage is thinner (27 tests, only 1 createVM test vs. Hetzner's 15). Reusable contract test suite exists but only applied to Hetzner.

### Dead Code / Tech Debt

**`UpCloudProviderConfig`** type is defined in `types.ts` and exported from `index.ts`, but no implementation exists and `createProvider()` has no `case 'upcloud'`. This violates the project's no-dead-code principle.

### Recommendations

1. **Remove `UpCloudProviderConfig`** — Dead type with no implementation; confusing API surface
2. **Expand GCP test coverage** — Add createVM tests covering firewall creation, operation polling, cross-zone lookup
3. **Apply contract tests to Scaleway and GCP** — Reuse `runProviderContractTests()` for consistency

---

## 4. packages/cloud-init/ — Cloud-Init Template Generator

### Purpose & Scope

Generates cloud-init YAML configurations for VM provisioning (230 LOC across 3 files). Handles system setup, Docker installation, VM agent deployment, TLS certificate injection, and journald configuration.

### Code Quality

Clean separation: template string in `template.ts`, substitution logic in `generate.ts`, public API in `index.ts`. The `indentForYamlBlock()` function correctly handles YAML literal block scalar indentation for multi-line PEM content. All configuration values are properly parameterized via `CloudInitVariables` interface — no hardcoded values (Constitution Principle XI compliant).

### Test Coverage

**Exceptional** — 30+ assertions across ~355 lines. This module was hardened after the 2026-03-12 TLS YAML indentation production bug:
- Uses **realistic multi-line PEM data** (20+ line certs/keys), not short stubs
- **Parses generated YAML** using `YAML.parse()` instead of string containment checks
- Verifies **exact content round-trip integrity** (`expect(parsedCert).toBe(REALISTIC_CERT)`)
- Explicit regression test comments citing the postmortem
- Size validation tests against Hetzner's 32KB user-data limit

This is the gold standard for structured output testing in the project.

### Dead Code / Tech Debt

None. All exports actively used by `apps/api/src/services/nodes.ts`.

### Recommendations

1. **Extract default values to constants file** — Currently spread between `generate.ts` conditional logic; a `constants.ts` would improve discoverability
2. **Add test for PEM data with blank lines** — Edge case not currently covered

---

## Summary

| Module | Quality | Tests | Debt | Overall |
|--------|---------|-------|------|---------|
| **apps/api** | Strong architecture, some oversized files | Good ratio, gaps in capability tests | Timestamp inconsistency, possible dead `boot-log.ts` | **B+** |
| **apps/tail-worker** | Excellent, focused | Adequate for scope | None | **A** |
| **packages/providers** | Clean abstraction, 3 complete providers | Strong Hetzner/Scaleway, thin GCP | Dead `UpCloudProviderConfig` type | **A-** |
| **packages/cloud-init** | Excellent, hardened from past incident | Exceptional (YAML parsing, realistic data) | None | **A+** |

### Top Cross-Cutting Recommendations

1. **Capability test coverage** (Medium) — The API lacks end-to-end tests covering multi-boundary flows. Add 2-3 integration tests for task submission → completion and workspace provisioning → health reporting.
2. **Remove dead code** (Low) — Delete `UpCloudProviderConfig` from providers; audit `boot-log.ts` integration in API.
3. **Split oversized route files** (Low) — `mcp.ts` at 2,216 LOC is the most impactful candidate for decomposition.
