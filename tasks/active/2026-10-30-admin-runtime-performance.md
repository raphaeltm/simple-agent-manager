# Admin and project Runtime performance

## Problem
Admin tabs and project Settings → Runtime wait on sequential I/O and uncached client loaders. Production baseline at 608bdbd1b: installations p50 4.4s/p90 165s/max 610s (n20), default pool reconcile 62.6s user/38.9s project, settings 695ms, connector 539–666ms. The original log confirms GET /api/admin/agent-email was canceled after113843ms (CPU7ms), timestamp2026-10-30T13:11:17.832Z.

## Research and preflight
Classes: cross-component-change, business-logic-change, security-sensitive-change, ui-change.
- fetch-timeout.ts clears the timeout at headers, leaving body reads unbounded.
- Agent email Cloudflare API helper currently has no callerSignal parameter; extend existing helper.
- Auth middleware already memoizes session and approval across nested registrations (four approval middleware passes); preserve freshness and account-denial gates.
- Admin settings uses revision fences around sequential reads; replace only the admin view with a D1 atomic batch and retain mutation fences.
- Keep tracing configuration untouched; separate task owns it.
- Preserve existing node billing aggregation semantics and only consolidate queries.
- Use existing per-isolate and user-scoped TanStack caches, no dependencies/infrastructure.

## Implementation checklist
- [x] A1 Bound fetch headers and stalled bodies, with regression test.
- [x] A2 Overall email plan deadline, shorter reads, parallel zone-independent work and bounded parallel SPF levels; clear unavailable state; deadline and fast-path tests.
- [ ] A3 Bound GitHub route/fetches, reuse user/installations, skip unchanged writes and batch safe work; remove unused shell query.
- [x] A4 Trace and parallelize pool reconciliation; reuse catalog cache; bound provider I/O.
- [x] A5 Bound gateway logs, analytics and observability external fetches.
- [ ] A6 Forward web cancellation signal; setup plan retry/staleness settings.
- [x] B1 Atomic admin-settings snapshot and real-SQL parity test.
- [x] B2 Resolve connector/trials keys only.
- [x] B3 Move expired connector-client cleanup off GET path.
- [x] B4 Parallel auth approval/session, cache decrypted OAuth secrets; document middleware multiplier.
- [x] B5 Parallel project details; opt-in bounded recent DO reads; update CLI and tests.
- [x] B6 Parallel smaller independent reads, project runtime config checks and safe projections.
- [x] B7 Period-filtered grouped quotas/usage; remove duplicate quota read; chunk user queries; real-SQL >100-user test.
- [x] B8 SQL error trend buckets.
- [x] B9 Safe credential projection.
- [ ] C1 Settings chunk and active queries preload before project detail; avoid chat preload.
- [ ] C2 Scoped Runtime query cache and mutation updates.
- [ ] C3 Query-based Integrations, independent panels and lazy/bounded projects dropdown.
- [ ] C4 Scoped cached admin loaders, health/error trends/analytics; preserve content on refresh and logout isolation.
- [ ] C5 Independent analytics panels; hidden-tab polling pause and longer gateway interval.
- [ ] Required ordering/cache behavioral tests with deferred promises.
- [ ] Reviewed Playwright screenshots at 375px and 1280px for Runtime, Integrations, Settings, Quotas.
- [ ] Full checks, specialist reviews, staging etiquette and authenticated user-flow sweep; zero console errors.
- [ ] Per-endpoint before/after RT and measured wall/browser timing tables in PR and final report.

## Acceptance criteria
All A/B/C items complete; bounded external calls; no settings request waterfalls or revisit spinners; CLI compatibility; all user-required tests and staging verification pass. At most two sequential PRs, each with full /do gates. Do not refactor RuntimeAssetsSection; file an Idea if duplication confirmed.

## References
User task 01M66P8F6P67ATNM175YHC2ZAY; earlier investigation a9a9718e-d712-4405-bb42-f2164ab6f850. Rules 03,18,39,48,59,60,62. Main sources: fetch-timeout.ts, agent-email/setup.ts, github-app.ts, admin-settings.ts, projects/crud.ts, Project.tsx, AdminPlatformConfig.tsx, ProjectRuntimeConfigSection.tsx.

Backend implementation and verification tracked in `2026-10-30-admin-runtime-performance-backend.md`; frontend requirements remain in scope for sequential PR2.
