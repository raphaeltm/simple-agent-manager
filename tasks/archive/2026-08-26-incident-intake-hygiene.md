# Incident intake hygiene: association gate, dispatch economics, diagnosis budget

## Problem

Production evidence from SAM idea `01M0YGNQZJM2MQKJAYSY6TGS03` showed the private incident intake loop dispatching too eagerly. On 2026-08-26 it fired 7 VM tasks in 3 hours, including single fresh signatures, warn-class alerts, and days-old one-off errors. At the same time, 19 of 29 production signatures carried failed diagnosis budget reasons, so agent dispatch often started from raw evidence instead of a completed automated diagnosis.

The intake loop needs cheap pre-dispatch hygiene: attach recurring occurrences to existing tracked work, avoid dispatching warnings and fresh singletons, expire stale one-off signatures, rate-limit trigger fan-out, and raise diagnosis defaults enough for the configured six-turn agent loop to complete.

## Research findings

- `apps/api/src/services/platform-feedback-triage.ts` groups recent `platform_errors`, upserts `platform_feedback_triages`, runs `runDebugDiagnosis()`, and creates or updates draft Ideas. It currently calls `markIncidentPending()` for every grouped signature before checking whether it is linked to an existing Idea, so linked/warn groups remain dispatch-eligible.
- `apps/api/src/services/platform-feedback-incidents.ts` owns the incident queue state machine and dispatch summary. It already has `idea_id`, `diagnosis_id`, `resolved_by_task_id`, severity, occurrence count, queue state, dispatch attempts, and expiry fields; this task can reuse those columns without a D1 migration.
- `apps/api/src/scheduled/incident-triggers.ts` loads active `source_type='incident'` triggers and dispatches when `buildIncidentBacklogSummary()` returns any pending incident. It has no batch/age admission gate and no per-trigger dispatch rate cap, so a single fresh pending signature can start a VM task.
- Existing dispatch escape paths from `tasks/archive/2026-08-26-diagnostic-incident-deduplication.md` must be preserved: budget deferrals stay pending/retryable, dispatch leases requeue/reject, agent claims requeue, and unresolved active incidents expire by max age.
- Rule `.claude/rules/47-control-loop-io-budget.md` applies: the scheduled sweep must keep bounded candidate sets, every selected candidate needs a success/terminal/expiring marker path, and budget exhaustion must remain a retryable deferral rather than an ordinary rejection.
- Rule `.claude/rules/67-shared-predicates-that-trigger-actions.md` applies to new admission/linkage predicates: keep classifiers separate from trigger actions and test discriminating controls so warning/linkage suppression does not accidentally suppress unlinked error dispatch.
- `packages/shared/src/constants/ai-services.ts`, `apps/api/src/services/platform-feedback-incident-config.ts`, `apps/api/src/env.ts`, `apps/api/.env.example`, `scripts/deploy/sync-wrangler-config.ts`, `.github/workflows/deploy-reusable.yml`, and public docs/config references are the existing pattern for env-configurable incident limits.
- `DEFAULT_DEBUG_AGENT_RUN_TOKEN_LIMIT` is currently `24_000` and `DEFAULT_DEBUG_AGENT_DAILY_TOKEN_LIMIT` is `120_000`. `runDebugDiagnosis()` and `DiagnosisRunner` both resolve the same config, so changing shared defaults covers synchronous automated triage and durable admin runs while preserving env overrides.
- Existing focused coverage lives in `apps/api/tests/unit/services/platform-feedback-triage.test.ts`, `apps/api/tests/unit/services/platform-feedback-incidents.test.ts`, `apps/api/tests/unit/scheduled/incident-triggers.test.ts`, and `apps/api/tests/unit/services/debug-agent-vertical.test.ts`.

## Implementation checklist

- [x] Add shared `DEFAULT_*` constants and Worker env/config fields for incident dispatch minimum severity, minimum batch size, minimum pending age, per-trigger rate cap/window, and stale-singleton expiry age.
- [x] Update deployment env propagation, `.env.example`, env reference/docs, and public reporting/config docs for the new knobs and changed debug-agent budget defaults.
- [x] Add incident queue helpers that classify dispatch eligibility without widening existing action predicates: open tracked work linkage via `idea_id`, `diagnosis_id -> debug_diagnoses.idea_id`, or `resolved_by_task_id`, severity floor, and stale singleton expiry.
- [x] Keep platform feedback triage recurrence attachment intact while making linked/open and warn-only groups non-dispatchable through the shared dispatch-eligibility predicate.
- [x] Update incident trigger sweep admission so it applies the association/severity gate before dispatch, requires minimum batch size or pending age, and enforces a per-trigger dispatch rate cap before calling the submitter.
- [x] Raise `DEFAULT_DEBUG_AGENT_RUN_TOKEN_LIMIT` and `DEFAULT_DEBUG_AGENT_DAILY_TOKEN_LIMIT` so a six-turn diagnosis is reachable by default, while keeping `DEBUG_AGENT_*` overrides authoritative and budget exhaustion retryable.
- [x] Add/adjust tests for association-gate skip plus no-linkage dispatch control, severity floor, batch/age/rate admission cases, stale-singleton two-sweep expiry, and diagnosis completion beyond two turns under the new default ceiling.
- [x] Run focused tests for triage, incidents, incident triggers, and debug-agent config/vertical behavior.
- [x] Run full local quality gates and specialist reviews before PR.

## Acceptance criteria

- [x] A signature linked to open tracked work has its occurrence/evidence attached and is skipped by incident-trigger dispatch; an otherwise identical unlinked error signature still dispatches.
- [x] Warn signatures are linked/recorded but excluded from dedicated incident-trigger dispatch by default.
- [x] A fresh singleton error is deferred until either the pending batch reaches the configured minimum size or the oldest pending item reaches the configured age.
- [x] Per-trigger dispatch rate limiting prevents more than the configured number of incident dispatches in the configured window.
- [x] Stale singleton signatures expire on the first sweep and are not reselected on the second sweep.
- [x] Debug diagnosis can complete more than two model turns under default config, and env overrides still control the ceilings.
- [x] Control-loop load remains bounded: no new unbounded D1 scans, no additional network calls before durable dispatch state, and every skipped/deferred candidate has an explicit retry or terminal path.

## Validation evidence

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/scheduled/incident-triggers.test.ts tests/unit/services/platform-feedback-incidents.test.ts tests/unit/services/platform-feedback-triage.test.ts tests/unit/services/trigger-execution-cleanup.test.ts tests/unit/services/debug-agent-vertical.test.ts tests/unit/services/debug-agent-config.test.ts` — passed (`6` files / `76` tests).
- `pnpm vitest run --config scripts/quality/vitest.config.ts scripts/quality/sync-wrangler-config.test.ts scripts/quality/deploy-reusable-workflow.test.ts` — passed.
- `pnpm typecheck` — passed.
- `pnpm format:check` — passed.
- `pnpm lint` — passed with pre-existing warnings in `packages/acp-client` and `apps/web`.
- `pnpm test` — passed (`@simple-agent-manager/api`: 609 files / 8,345 tests; `@simple-agent-manager/web`: 294 files / 3,522 tests).
- `pnpm build` — passed.
- `pnpm lint:oxlint` — passed as advisory-only (`2677` report-only diagnostics; ESLint remains authoritative).
- `pnpm quality:type-boundaries` — passed (`0` blocking findings).
- `git diff --check` — passed.

## References

- SAM idea `01M0YGNQZJM2MQKJAYSY6TGS03`
- `apps/api/src/scheduled/incident-triggers.ts`
- `apps/api/src/services/platform-feedback-triage.ts`
- `apps/api/src/services/platform-feedback-incidents.ts`
- `apps/api/src/services/debug-agent.ts`
- `apps/api/src/durable-objects/diagnosis-runner.ts`
- `packages/shared/src/constants/ai-services.ts`
- `apps/api/tests/unit/scheduled/incident-triggers.test.ts`
- `apps/api/tests/unit/services/platform-feedback-triage.test.ts`
- `apps/api/tests/unit/services/platform-feedback-incidents.test.ts`
- `apps/api/tests/unit/services/debug-agent-vertical.test.ts`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/67-shared-predicates-that-trigger-actions.md`
