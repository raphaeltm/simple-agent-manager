# W0: worker-core package (worker modularization)

Brief: `tasks/archive/2026-11-12-worker-modularization.md` (section "W0: worker-core").
Task: `01M77GCZVJFRZZAVXPMGERVKBR`. Coordinator: `01M77BJHHNW5714E98DEEMBCZA`.
Branch: `sam/w0-worker-core-create-ervkbr` (SAM output branch) → PR base `sam/help-identify-parts-worker-embcza`.

## Checklist

- [x] Create `packages/worker-core` from the `packages/providers` template
- [x] Move logger (+ credential-token-redaction, d1-error-code), ulid, runtime-validation (+ bounded-request-body), d1-limits, error helpers, fetch-timeout (+ body), D1 schema
- [x] Re-export file at every old path
- [x] Logger takes no `Env`: error persistence is a port (`createErrorSinkLogger`); worker keeps `createInstrumentedLogger` with the narrow `ObservabilityFieldLimitEnv`
- [x] Pure tests moved with the code; source-reading tests repointed at the new schema path
- [x] Blocking ESLint boundary rules (packages ↛ apps; worker → package public entries only), proven by `scripts/quality/worker-module-boundaries.test.ts`
- [x] Build order / CI path filters
- [x] "Package template" section in the brief
- [x] Full API test suite, lint, typecheck, quality checks green locally
- [x] Specialist reviews (architecture, task-completion, cloudflare: PASS or ADDRESSED, see PR #2684)
- [x] CI via `gh workflow run ci.yml --ref sam/w0-worker-core-create-ervkbr` (run 43194907710 on 2c364fa95: green except the inherited expired Gitleaks baseline entry)
- [x] Publish "W0 ready" on `feature.worker-modularization` and message coordinator

## Progress notes

- 2026-11-12: package created, modules moved with `git mv`, shims in place. API typecheck green. Package tests at that point: the 4 moved files / 54 cases.
- 2026-11-12: boundary lint added (both rules proven discriminating by switching each off: 7 and 6 reject cases went red). Fixed the 5 existing worker-test violations (manifest read as data; provider fixtures allowed via `tests/fixtures/` exception for worker tests). Package template recorded. API unit suite: 1080 files / 15,958 tests passed. Package: 6 files / 64 tests.
- 2026-11-12: review fixes. Boundary lint now also covers dynamic `import()` / `require()` and package-to-package deep paths; fixtures exception cannot `..` out; app-name list is checked against `apps/*`. `drizzle-orm` moved to the pnpm catalog. Runtime-boundary semantic scan extended to `packages/worker-core/src`. CLI CI filter, Sonar exclusion, oxlint override, and a schema path comment updated. Template decisions 6-10 revised.

- 2026-11-12: coordinator-approved additions moved in: `lib/route-helpers`, `services/durable-object-retry`, `lib/search-query-limits`, `lib/fts5` (re-exports at old paths; their 3 pure test files moved).

## Test counts (before → after)

| Suite                          | Before (core branch)                                           | After                                                                 |
| ------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/api` unit (`vitest run`) | 1087 files / 16,016 cases (derived: after + the 7 moved files) | 1080 files / 15,928 cases (15,924 passed, 4 skipped as before)        |
| `packages/worker-core`         | —                                                              | 9 files / 98 cases (88 moved + 10 new)                                |
| `scripts/quality`              | 59 files / 852 cases                                           | 60 files / 891 cases (+ `worker-module-boundaries.test.ts`, 39 cases) |
| Total                          |                                                                | +49 cases, nothing deleted                                            |

Moved, not deleted (case counts unchanged): `d1-error-code` (30), `fetch-timeout` (16), `runtime-validation` (6), `structured-logging-format` (2), `route-helpers`, `durable-object-retry`, `search-query-limits` (34 together) = 88. Edited in place with unchanged case counts: `credential-token-redaction`, `cf-container-runtime-contract`, `omitted-worker-var-defaults`, and the schema-path readers.
