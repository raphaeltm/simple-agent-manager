# Add GitHub ProjectData event producers

## Problem

Wave C1 needs GitHub-domain events that already enter SAM to be admitted into the
B4 ProjectData event store so active project-scoped subscriptions can match them.
Admission must remain separate from delivery/routing, store only bounded normalized
metadata/display data, and use idempotent delivery keys with payload fingerprints.

## Research findings

- `apps/api/src/routes/github-webhook.ts` is the verified GitHub App webhook ingress.
  It currently handles installation create/delete, repository rename/delete, and
  asynchronously invokes GitHub trigger routing when `x-github-delivery` and
  `x-github-event` are present.
- `apps/api/src/services/github-trigger-handler.ts` supports existing trigger event
  paths for `issues`, `issue_comment`, `pull_request`, and `push`, with D1 delivery
  deduplication for task-trigger routing.
- `apps/api/src/services/github-trigger-filter.ts` already parses a bounded subset of
  webhook payloads consumed by trigger matching and prompt templates.
- B4 event admission is exposed through `apps/api/src/services/project-data.ts` as
  `admitProjectEvent(env, projectId, input)`, backed by the per-project
  `ProjectData` Durable Object.
- ProjectData admission detects duplicate replay when `(project_id, source, delivery_key)`
  repeats with the same `payloadFingerprint`, and marks conflicts when the same key
  arrives with a different fingerprint.
- `packages/shared/src/types/project-events.ts` defines bounded event fields:
  `source`, `eventType`, `subject`, `severity`, `deliveryKey`,
  `payloadFingerprint`, `metadata`, `display`, and optional `rawPayloadRef`.
- No existing SAM webhook handler processes GitHub `check_run`, `check_suite`,
  `pull_request_review`, or `pull_request_review_comment` events into product
  behavior today; those surfaces should be deferred rather than invented in C1.
- Staging verification is explicitly forbidden for this task; use local tests,
  code review, and PR CI only.

## Checklist

- [x] Add a GitHub ProjectData event producer service for existing verified webhook paths.
- [x] Admit events for supported GitHub trigger paths: `pull_request`, `issue_comment`,
  `issues`, and `push`.
- [x] Admit repository maintenance events where a project can be matched by repository
  id/name.
- [x] Use bounded normalized metadata/display only; do not persist raw webhook bodies.
- [x] Use deterministic delivery keys and payload fingerprints.
- [x] Wire producer admission into GitHub webhook ingress independently from trigger task routing.
- [x] Add tests for normalized event construction, duplicate replay, and same-key /
  different-fingerprint conflicts.
- [x] Add route/service tests proving the real webhook path schedules ProjectData
  admission without changing trigger behavior.
- [x] Run focused API tests and relevant typecheck/lint/format quality gates.
- [x] Run specialist review: task-completion-validator, cloudflare-specialist,
  constitution-validator, security-auditor, and test-engineer.
- [ ] Open draft PR targeting `sam/weve-previously-talked-eventing-y207hp`.
- [ ] Check PR CI after push.

## Implementation summary

- Added `apps/api/src/services/github-project-event-producer.ts` to admit
  bounded ProjectData events for existing GitHub webhook paths.
- Wired `apps/api/src/routes/github-webhook.ts` to schedule ProjectData event
  admission independently from existing trigger routing.
- Emitted GitHub ProjectData event types for `pull_request.<action>`,
  `issues.<action>`, `issue_comment.<action>`, `push`, and
  `repository.<action>`.
- Deferred `check_run`, `check_suite`, `pull_request_review`, and
  `pull_request_review_comment` because SAM has no existing product handlers
  for those webhook surfaces today.

## Local verification

- `pnpm --filter @simple-agent-manager/api exec tsc --noEmit --pretty false`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm exec vitest run tests/unit/routes/github-webhook-project-events.test.ts tests/unit/services/github-trigger-handler.test.ts --reporter=verbose`
- `pnpm exec vitest run --config vitest.workers.config.ts tests/workers/github-project-events.test.ts tests/workers/project-data-events.test.ts --reporter=verbose --testTimeout=20000`
- `pnpm format:check`
- `pnpm --filter @simple-agent-manager/api build`
- `pnpm --filter @simple-agent-manager/shared typecheck`
- `pnpm --filter @simple-agent-manager/shared lint`
- `pnpm --filter @simple-agent-manager/shared build`
- `pnpm lint:oxlint`
- `pnpm quality:type-boundaries`
- `git diff --check origin/sam/wave-b4-reconcile-integrate-nbmzfm..HEAD`

## Specialist review

| Reviewer | Status | Evidence |
| --- | --- | --- |
| task-completion-validator | PASS | Research findings map to checked checklist items; checked items appear in the B4-base diff; acceptance criteria have local test evidence or explicit PR/CI follow-up. |
| cloudflare-specialist | PASS | No wrangler, migration, KV, or R2 changes; Worker `waitUntil` use is best-effort and locally covered; Miniflare tests exercise D1 and ProjectData DO admission. |
| constitution-validator | PASS | No new source hardcoded URLs, timeouts, limits, or deployment identifiers; GitHub event allowlist is protocol/domain shape. |
| security-auditor | PASS | Webhook signature verification remains required; no raw webhook body is persisted, injected, or logged; logs contain only delivery/event/outcome/error summary fields. |
| test-engineer | PASS | Tests cover signed route→producer→ProjectData, service→D1→ProjectData subscription matching, duplicate replay, same-key/different-fingerprint conflict, and unsupported event no-op. |

## Acceptance criteria

- GitHub events already handled by SAM are admitted to the per-project ProjectData
  event store through the B4 service layer.
- Events are project-scoped, bounded, normalized, and marked as untrusted display data.
- Raw webhook bodies are neither persisted nor injected.
- Trigger delivery matching/submission remains separate from event admission.
- Duplicate delivery replay and same-key fingerprint conflict behavior are tested.
- No staging deployment, mutation, or validation is performed.
- Draft PR is opened against `sam/weve-previously-talked-eventing-y207hp` and left unmerged.

## References

- PR #1957 / branch `sam/wave-b4-reconcile-integrate-nbmzfm`
- Final integration target `sam/weve-previously-talked-eventing-y207hp`
- `apps/api/src/durable-objects/project-data/project-events.ts`
- `apps/api/src/services/project-data.ts`
- `apps/api/src/services/project-event-subscriptions.ts`
- `packages/shared/src/types/project-events.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/03-constitution.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
