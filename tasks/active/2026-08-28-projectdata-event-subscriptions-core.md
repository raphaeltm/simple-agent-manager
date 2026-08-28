# Durable ProjectData event subscription core

## Task

Implement the Wave B1 durable foundation for ProjectData-scoped event subscriptions on branch `sam/wave-b1-retry-implement-ft51wx`, targeting the integration branch `sam/weve-previously-talked-eventing-y207hp`.

## Source of Truth

- SAM task: `01M13PYJP81PDQQGBDBVFT51WX`
- Parent task: `01M13FBEP2YQF3MQRWJXY207HP`
- Contract task: `01M0FARXJ3ESYP9JRJ6AW8J3JX`
- Frozen contract reference: “Wave A frozen contract — 2026-08-28”
- Failed predecessor `01M13PWFXQCF49CCX46HKP0644` failed before startup due an Instant container limit and produced no PR or usable work.

## Explicit Constraints

- Do not deploy to, mutate, or validate against staging.
- Open a draft PR against `sam/weve-previously-talked-eventing-y207hp`; do not merge.
- Keep ProjectData as the per-project source of truth; do not add a singleton/global event bus.
- Reuse existing ProjectData migration, RPC/service, mailbox, prompt-delivery identity, receipt, ambiguity, and crash-recovery conventions.
- Do not create a second prompt-delivery engine.
- Do not implement GitHub/deployment producers, MCP/API subscription tools, inspector UI, Claude/Codex/OpenCode fast paths, or staging behavior.

## Research Findings

- `ProjectData` is the deterministic per-project Durable Object, keyed through `env.PROJECT_DATA.idFromName(projectId)`.
- ProjectData migrations are append-only in `apps/api/src/durable-objects/migrations.ts`; the current latest migration is `037-tool-payload-cleanup-attempts`.
- Prompt delivery already persists exactly-once acceptance through `session_inbox` and `acceptPromptDelivery()`. Event subscription core must record delivery batches/attempts without runtime injection in this task.
- Mailbox and prompt-delivery code use stable source/target identity, idempotency keys, explicit ambiguous states, bounded retry decisions, and typed service wrappers.
- Runtime boundary validation and ProjectData row list reads must be bounded and fault-isolated where applicable.
- All operational caps must be configurable and documented where they become real environment contracts.

## Implementation Checklist

- [x] Add shared versioned TypeScript contracts for normalized ProjectData events, bounded filters, subscriptions, matches, batches, attempts, state/error/result shapes, and limits.
- [x] Add append-only migration and indexes for `project_events`, `project_event_subscriptions`, `project_event_subscription_match_keys`, `project_event_matches`, `project_event_delivery_batches`, `project_event_delivery_attempts`, and `project_event_storage_accounting`.
- [x] Implement deterministic bounded v1 filter validation and match-key compilation.
- [x] Implement ProjectData RPCs and service wrappers for event admission, lifecycle, matching, delivery-batch/attempt recording, recent status, and retention/accounting.
- [x] Enforce project binding, idempotency, visible same-key/different-fingerprint conflicts, revocation/expiry rechecks, caps, bounded metadata/display data, optional raw-payload references, and terminal states including `recorded_not_injected` and `ambiguous`.
- [x] Add migration/unit/integration tests covering the requested failure modes and `SECURITY_CANARY_DO_NOT_EXECUTE` safety.
- [x] Update only relevant technical/configuration documentation.

## Implementation Notes

- Shared contracts live in `packages/shared/src/types/project-events.ts`; configurable defaults live in `packages/shared/src/constants/project-events.ts` and are resolved through `apps/api/src/durable-objects/project-data/project-events-limits.ts`.
- Migration `038-project-event-subscriptions` is append-only and creates the frozen core tables plus indexes for per-project event lookup, subscription lifecycle/owner lookup, match-key lookup, match lists, delivery-batch state/subscription lookup, attempt batch/state lookup, and accounting inspection.
- V1 filters compile to deterministic `field=value` match keys for only `source`, `eventType`, `subjectType`, `subjectId`, and `severity`; unknown fields, predicate-shaped values, invalid severities, empty filters, oversized strings, oversized sets, and over-key filters fail before storage.
- `ProjectData` exposes durable RPCs only through the per-project DO after `ensureProjectId(input.projectId)`. Service wrappers inject the caller project id into every RPC input rather than trusting caller-provided project ids.
- Admission idempotency is keyed by `(project_id, source, delivery_key)`: same fingerprint is `duplicate_replay`; different fingerprint records `state='conflicted'` and returns the existing/incoming fingerprints.
- Delivery batches and attempts are durable records only in this foundation. They record `recorded_not_injected`, `ambiguous`, and other terminal states but do not call `acceptPromptDelivery()`, write `session_inbox`, steer runtimes, interrupt runtimes, or spawn tasks.
- Cancel/expiry paths recheck lifecycle inside the ProjectData transaction and terminalize outstanding unbatched matches as `cancelled`/`expired` for accurate recent-status inspection.
- Retention prunes terminal event-subscription records only and keeps events that still have match rows, preserving future-wave `pending`/`batch_created` delivery work.
- Raw webhook bodies are not represented in the contract. The persisted event record stores bounded normalized metadata, deterministic `display.untrusted === true` data, payload fingerprint, and an optional bounded `rawPayloadRef`.
- Relevant docs updated: public architecture overview, public configuration reference, API `.env.example`, `wrangler.toml` non-secret vars, and env-reference skills.

## Validation Evidence

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/migrations.test.ts tests/unit/durable-objects/project-events-normalization.test.ts` — passed, 20 tests.
- `pnpm vitest run --config vitest.workers.config.ts tests/workers/project-data-events.test.ts --reporter=verbose` from `apps/api` — passed, 8 tests.
- `pnpm vitest run --config vitest.workers.config.ts tests/workers/project-data-service.test.ts --reporter=dot` from `apps/api` — passed, 60 tests; known storage telemetry warning logs only.
- `pnpm --filter @simple-agent-manager/shared build && pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm --filter @simple-agent-manager/shared typecheck && pnpm --filter @simple-agent-manager/shared lint` — passed.
- `pnpm format:check` — passed.
- `pnpm quality:do-migration-safety` — passed.
- `pnpm quality:migration-safety` — passed.
- `pnpm quality:wrangler-bindings` — passed.
- `pnpm quality:file-sizes` — passed; warnings only for existing 500–800 line files.
- `pnpm quality:type-boundaries` — passed blocking checks; report-only counts unchanged in class.
- `pnpm quality:source-contract-tests` — passed.
- `pnpm quality:runtime-boundary-semantics` — passed.
- `pnpm lint:oxlint` — passed as advisory shadow lint; ESLint remains authoritative.
- `git diff --check` — passed.

## Specialist Review Results

- `$test-engineer`: PASS. Added unit coverage for deterministic filter compilation, invalid filter shapes, deep/oversized metadata, raw-payload references, and worker integration coverage for the complete ProjectData RPC/service path with realistic DO storage.
- `$cloudflare-specialist`: PASS. Migration is append-only, uses integer timestamps, project-scoped indexes, and Durable Object SQLite storage; `wrangler.toml` adds non-secret vars only. Existing `compatibility_date = "2026-01-01"` is older than the six-month checklist preference but was not changed because this task forbids staging validation and does not require a runtime-compatibility shift.
- `$env-validator`: PASS. All 20 `PROJECT_EVENT_*` vars are present in `apps/api/src/env.ts`, `apps/api/src/durable-objects/project-data/types.ts`, `apps/api/wrangler.toml`, `apps/api/.env.example`, `apps/www/src/content/docs/docs/reference/configuration.md`, and `.claude/skills/env-reference/SKILL.md`; the Codex wrapper also references the new category.
- `$constitution-validator`: PASS. Business limits and retention windows use `PROJECT_EVENT_*` env overrides with shared defaults; no internal URLs, deployment identifiers, or unconfigurable timeouts were added.
- `$security-auditor`: PASS. No credentials, shell execution, runtime steering, prompt injection, or `session_inbox` writes were added; raw webhook bodies are not a contract field or persisted field, and the canary test confirms untrusted data remains quoted/stored only.
- `$doc-sync-validator`: PASS. Public architecture and configuration docs match the implemented table/env contract; no public API/MCP route docs were added because those surfaces are intentionally deferred.

## Task Completion Validation Report

**Task**: `tasks/active/2026-08-28-projectdata-event-subscriptions-core.md`
**Branch**: `sam/wave-b1-retry-implement-ft51wx`
**Diff Base**: `origin/sam/weve-previously-talked-eventing-y207hp` at `b53b28a5fa2c956f51ce83231aee2cb25a7e9cc1`
**Date**: 2026-08-28

### Verdict: PASS

| Check | Status | Issues |
| ----- | ------ | ------ |
| A: Research → Checklist | PASS | 0 |
| B: Checklist → Diff | PASS | 0 |
| C: Criteria → Tests | PASS | 0 |
| D: UI → Backend | N/A | No UI inputs or API route forms were added |
| E: Multi-Resource | N/A | No provider/resource-selection logic was added |
| F: Vertical Slice | PASS | Worker tests exercise service wrapper → ProjectData DO RPC → SQLite storage |

### Validator Findings

- Research lines 26–31 are each covered by checklist lines 35–41 and implementation notes lines 45–54.
- Every checked checklist item maps to substantive code/docs/test changes in the working tree.
- Acceptance and explicit constraints are covered by automated tests and documented validation evidence. Staging is intentionally skipped by the user’s explicit task instruction, not omitted as an unverified gate.
- UI-to-backend scan found no `apps/web` input/API payload changes.
- Multi-resource scan found no new `.limit(1)` or provider-selection logic in the diff.
- Vertical-slice coverage is present in `apps/api/tests/workers/project-data-events.test.ts`, which uses Cloudflare worker-pool Durable Objects instead of mocking the ProjectData storage boundary.

## Validation Plan

- Focused unit tests for migration shape, filter validation, match-key compilation, event normalization, and state transitions.
- Workers integration tests for ProjectData RPC/service behavior, duplicate replay, conflict visibility, project binding, lifecycle races, caps, retention/accounting, and canary handling.
- Proportional broader API test/typecheck/lint/static checks before PR handoff.
- Specialist reviews: task-completion-validator, test-engineer, cloudflare-specialist, constitution-validator, security-auditor, and doc-sync-validator if docs change.

## Handoff Notes

- Staging validation is intentionally skipped by task instruction.
- PR must be draft, target the integration branch, and list deferred producer/API/UI/runtime-injection surfaces.
