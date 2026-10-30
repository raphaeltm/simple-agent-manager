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
- [x] A3 Bound GitHub route/fetches, reuse user/installations, skip unchanged writes and batch safe work; remove unused shell query.
- [x] A4 Trace and parallelize pool reconciliation; reuse catalog cache; bound provider I/O.
- [x] A5 Bound gateway logs, analytics and observability external fetches.
- [x] A6 Forward web cancellation signal; setup plan retry/staleness settings.
- [x] B1 Atomic admin-settings snapshot and real-SQL parity test.
- [x] B2 Resolve connector/trials keys only.
- [x] B3 Move expired connector-client cleanup off GET path.
- [x] B4 Parallel auth approval/session, cache decrypted OAuth secrets; document middleware multiplier.
- [x] B5 Parallel project details; opt-in bounded recent DO reads; update CLI and tests.
- [x] B6 Parallel smaller independent reads, project runtime config checks and safe projections.
- [x] B7 Period-filtered grouped quotas/usage; remove duplicate quota read; chunk user queries; real-SQL >100-user test.
- [x] B8 SQL error trend buckets.
- [x] B9 Safe credential projection.
- [x] C1 Settings chunk and active queries preload before project detail; avoid chat preload.
- [x] C2 Scoped Runtime query cache and mutation updates.
- [x] C3 Query-based Integrations, independent panels and lazy/bounded projects dropdown.
- [x] C4 Scoped cached admin loaders, health/error trends/analytics; preserve content on refresh and logout isolation.
- [x] C5 Independent analytics panels; hidden-tab polling pause and longer gateway interval.
- [x] Required ordering/cache behavioral tests with deferred promises.
- [x] Reviewed Playwright screenshots at 375px and 1280px for Runtime, Integrations, Settings, Quotas.
- [x] Full checks, specialist reviews, staging etiquette and authenticated user-flow sweep; zero console errors.
- [x] Per-endpoint before/after RT and measured wall/browser timing tables in PR; final report remains a release gate.

## Acceptance criteria

All A/B/C items complete; bounded external calls; no settings request waterfalls or revisit spinners; CLI compatibility; all user-required tests and staging verification pass. At most two sequential PRs, each with full /do gates. Do not refactor RuntimeAssetsSection; file an Idea if duplication confirmed.

## References

User task 01M66P8F6P67ATNM175YHC2ZAY; earlier investigation a9a9718e-d712-4405-bb42-f2164ab6f850. Rules 03,18,39,48,59,60,62. Main sources: fetch-timeout.ts, agent-email/setup.ts, github-app.ts, admin-settings.ts, projects/crud.ts, Project.tsx, AdminPlatformConfig.tsx, ProjectRuntimeConfigSection.tsx.

Backend implementation and verification tracked in `2026-10-30-admin-runtime-performance-backend.md`; frontend implementation is complete in sequential PR2; final staging and release gates remain pending.

## Completed verification

Backend PR https://github.com/raphaeltm/simple-agent-manager/pull/2480 : full root21tasks PASS, API14,376passed/2skipped, quality35tasks PASS. Real Worker19tests passed with zero unhandled reports; target compatibility flag matches production/test runtimes without changing dates or tracing. Real SQLite snapshot/CAS race and105-user bind-budget tests pass. Auth enters4middleware layers but performs one fresh session lookup and one approval read, saving one approval wave. Stage41128698066 SUCCESS,13smokes passed without retries; both authenticated375/1280 sweeps18GET200/reconcile200,18pages/chat-to-Runtime/Refresh passed, zero console errors. Required eight screenshots inspected. Source8a00054aa, baseline-only follow-up16e10e7bf. Final server timing samples: settings559→283ms, project647→261ms, runtime373→257ms; reconciliation16,266→3,075ms median. Full per-endpoint RT/timing tables in PR.

Frontend full suite384files/4,813tests PASS, lint/type/build35tasks PASS. Deferred promises verify pre-detail Runtime query start, cache revisit without spinner, integrations independent mounting, cancellation, identity isolation and older GET/write races. Mock375/1280 screenshots reviewed across all changed surfaces. Final frontend staging41131612547 SUCCESS13smokes without retries; two strict sweeps18GET200/reconcile200,18coldpages+2held-refresh cache revisits, chat navigation and zero console errors. All eight required current-source screenshots reviewed PASS. Runtime full-form3553/1275ms local and4879/6143ms GHA; cached Runtime54–199ms, Settings176–296ms, no spinner. Cold mobile Settings8135ms outlier retained in PR tables.

## Release gates

- [x] Backend CI, CodeRabbit best-effort wait and merge(#2480,af45a52b0); production deployment/smoke remains pending.
- [x] Final frontend staging, current-source screenshot review and task-completion-validator A–F PASS.
- [ ] Frontend PR only after backend merge; CI, CodeRabbit wait, merge and production deployment/smoke.
- [ ] Final before/after timing report.

RuntimeAssetsSection remains untouched; duplication Idea01M66TJYMJDK61SVXXM9EV3Y0G filed. Final release results will be recorded in PR evidence and workflow state. No third PR is required for release-only evidence.

## Implementation archival

All implementation/testing criteria complete; completion-validator A–F PASS. Archive is the /do pre-PR implementation checkpoint, not a claim that pending release gates have passed. Backend merged; frontend PR, both production deployment monitoring and final report remain explicit release gates. Their canonical final evidence is the sequential PR bodies/workflow state.
