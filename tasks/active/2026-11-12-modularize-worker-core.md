# W0: worker-core package (worker modularization)

Brief: `tasks/active/2026-11-12-worker-modularization.md` (section "W0: worker-core").
Task: `01M77GCZVJFRZZAVXPMGERVKBR`. Coordinator: `01M77BJHHNW5714E98DEEMBCZA`.
Branch: `sam/w0-worker-core-create-ervkbr` (SAM output branch) → PR base `sam/help-identify-parts-worker-embcza`.

## Checklist

- [x] Create `packages/worker-core` from the `packages/providers` template
- [x] Move logger (+ credential-token-redaction, d1-error-code), ulid, runtime-validation (+ bounded-request-body), d1-limits, error helpers, fetch-timeout (+ body), D1 schema
- [x] Re-export file at every old path
- [x] Logger takes no `Env`: error persistence is a port (`createErrorSinkLogger`); worker keeps `createInstrumentedLogger` with the narrow `ObservabilityFieldLimitEnv`
- [x] Pure tests moved with the code; source-reading tests repointed at the new schema path
- [ ] Blocking ESLint boundary rules (packages ↛ apps; worker → package public entries only)
- [ ] Build order / CI path filters
- [ ] "Package template" section in the brief
- [ ] Full API test suite, lint, typecheck, quality checks green locally
- [ ] Specialist reviews
- [ ] CI via `gh workflow run ci.yml --ref sam/w0-worker-core-create-ervkbr`
- [ ] Publish "W0 ready" on `feature.worker-modularization` and message coordinator

## Progress notes

- 2026-11-12: package created, modules moved with `git mv`, shims in place. API typecheck green. Package tests: 4 files / 54 cases.
