# Findings Index

This index normalizes the highest-priority findings across the nine track reports. The track reports remain the source of truth for full detail and file:line references.

## Counts

| Track | Reported Findings | Critical | High | Medium | Low | Info |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. Data Model | 14 | 1 | 4 | 6 | 2 | 1 |
| 2. Data Flow | 11 | 0 | 1 | 4 | 3 | 3 |
| 3. Code Organization | 19 | 0 | 6 | 6 | 3 | 4 |
| 4. Coding Standards | 12 | 0 | 3 | 5 | 2 | 2 |
| 5. Performance & Cost | 13 | 0 | 4 | 4 | 4 | 1 |
| 6. Testing & Experiments | 13 | 0 | 3 | 5 | 3 | 2 |
| 7. Security & Isolation | 21 | 0 | 6 | 8 | 4 | 3 |
| 8. Architecture & Debt | 12 | 0 | 3 | 5 | 3 | 1 |
| 9. Agent Readiness | 18 | 0 | 5 | 7 | 4 | 2 |

## P0 / Critical

| ID | Severity | Track | Category | Title | Primary Location | Implementation Owner | Effort | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-001 | CRITICAL | 1 | data-model/security | KV token budget non-atomic read-modify-write | `apps/api/src/services/ai-token-budget.ts` | `$cloudflare-specialist`, `$security-auditor` | M | Ready |
| F-002 | HIGH | 7 | security | Workspace subdomain proxy bypasses ownership verification | `apps/api/src/index.ts` | `$security-auditor` | S | Ready |
| F-003 | HIGH | 7 | security | FTS5 query sanitization inconsistent across ProjectData paths | `apps/api/src/durable-objects/project-data/` | `$cloudflare-specialist`, `$security-auditor` | S | Ready |
| F-004 | HIGH | 7 | security | Callback JWT/bootstrap token exposure needs hardening | `apps/api/src/services/`, cloud-init bootstrap flow | `$security-auditor` | M | Ready |
| F-005 | HIGH | 9 | agent-readiness | Always-loaded instruction budget exceeds useful agent context budget | `AGENTS.md`, `CLAUDE.md`, `.claude/rules/` | General | M | Ready |

## P1 / High

| ID | Severity | Track | Category | Title | Primary Location | Implementation Owner | Effort | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-006 | HIGH | 1 | data-model | Duplicate D1 migration number prefixes | `apps/api/src/db/migrations/` | `$cloudflare-specialist` | S | Ready |
| F-007 | HIGH | 1 | data-model | Missing `onDelete` on `workspaces.installationId` FK | `apps/api/src/db/schema.ts` | `$cloudflare-specialist` | S | Ready |
| F-008 | HIGH | 1 | data-model | JSON columns lack runtime validation | `apps/api/src/db/schema.ts`, route/service validators | General, `$test-engineer` | M | Ready |
| F-009 | HIGH | 1 | architecture | ProjectData Durable Object responsibility overload | `apps/api/src/durable-objects/project-data.ts` | `$cloudflare-specialist` | XL | Needs design |
| F-010 | HIGH | 2 | data-flow/security | Dual callback token validation paths | Worker callback auth paths, VM agent callback flow | `$security-auditor`, `$go-specialist` | M | Ready |
| F-011 | HIGH | 3 | navigability | 15 files exceed 800-line hard limit | `apps/`, `packages/` | General | L | Ready |
| F-012 | HIGH | 3 | navigability | Top functions exceed 300+ lines | `packages/vm-agent/internal/acp/session_host.go`, others | `$go-specialist` | L | Ready |
| F-013 | HIGH | 3 | navigability | VM agent `server` package is a 9,303-line package | `packages/vm-agent/internal/server/` | `$go-specialist` | XL | Needs sequencing |
| F-014 | HIGH | 4 | standards | Runtime validation gap at API mutation boundaries | `apps/api/src/routes/` | General, `$test-engineer` | L | Ready |
| F-015 | HIGH | 4 | standards | Oversized route files exceed file-size limits | `apps/api/src/routes/` | General | L | Ready |
| F-016 | HIGH | 4 | ui | Hardcoded colors bypass design token system | `apps/web/src/`, `packages/ui/` | `$ui-ux-specialist` | S | Ready |
| F-017 | HIGH | 5 | performance | Cron N+1 query pattern in stuck task recovery | `apps/api/src/routes/cron.ts` | `$cloudflare-specialist` | M | Ready |
| F-018 | HIGH | 5 | performance | Sequential VM agent RPCs in node cleanup cron | `apps/api/src/routes/cron.ts` | `$cloudflare-specialist`, `$go-specialist` | M | Ready |
| F-019 | HIGH | 5 | frontend | No frontend code splitting | `apps/web/src/App.tsx`, route components | `$ui-ux-specialist` | M | Ready |
| F-020 | HIGH | 5 | performance | Unbounded search in MCP idea tools | `apps/api/src/routes/mcp/` | General | S | Ready |
| F-021 | HIGH | 6 | testing | TaskRunner and NodeLifecycle lack Miniflare integration tests | `apps/api/tests/`, DO bindings | `$cloudflare-specialist`, `$test-engineer` | L | Ready |
| F-022 | HIGH | 6 | testing | Coverage thresholds are not enforced | Vitest configs, `.github/workflows/ci.yml` | `$test-engineer` | M | Ready |
| F-023 | HIGH | 6 | testing | Go race detector not enabled in CI | `.github/workflows/ci.yml`, `packages/vm-agent/` | `$go-specialist` | S | Ready |
| F-024 | HIGH | 8 | architecture | Constitution file-size limits drift from enforced limits | `.specify/memory/constitution.md`, `.claude/rules/18-file-size-limits.md` | General | M | Needs decision |
| F-025 | HIGH | 9 | agent-readiness | 9 of 12 packages lack nested `AGENTS.md` | `apps/`, `packages/` | General | M | Ready |
| F-026 | HIGH | 9 | agent-readiness | No progressive MCP tool discovery for 84-tool surface | `apps/api/src/routes/mcp/` | General, `$api-reference` | L | Needs design |
| F-027 | HIGH | 9 | testing/ui | Playwright visual tests not in CI | `.github/workflows/ci.yml`, Playwright configs | `$ui-ux-specialist`, `$test-engineer` | M | Ready |
| F-028 | HIGH | 9 | agent-readiness | Missing `.claude/settings.json` for permission/hook configuration | `.claude/settings.json` | General | S | Ready |

## Medium Clusters To Preserve

| Cluster | Source Tracks | Why It Matters |
| --- | --- | --- |
| WebSocket and event propagation reliability | 2, 5, 6 | Several medium findings point to swallowed errors, polling where events exist, and missing contract tests. |
| Shared fixtures and staging smoke coverage | 6, 9 | Missing fixtures and staging smoke suites slow agent iteration and reduce confidence. |
| Plugin architecture readiness | 8 | Billing and plugin seams are not ready for open-source/closed-source split. |
| Agent knowledge hygiene | 9 | Handoff packets and knowledge graph are strong primitives but underused. |
