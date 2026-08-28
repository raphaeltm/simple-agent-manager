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
- ProjectData admission already detects duplicate replay when `(project_id, source,
  delivery_key)` repeats with the same `payloadFingerprint`, and marks conflicts when
  the same key arrives with a different fingerprint.
- `packages/shared/src/types/project-events.ts` defines bounded event fields:
  `source`, `eventType`, `subject`, `severity`, `deliveryKey`,
  `payloadFingerprint`, `metadata`, `display`, and optional `rawPayloadRef`.
- No existing SAM webhook handler processes GitHub `check_run`, `check_suite`,
  `pull_request_review`, or `pull_request_review_comment` events into product
  behavior today; those surfaces should be deferred rather than invented in C1.
- Staging verification is explicitly forbidden for this task; use local tests,
  code review, and PR CI only.

## Checklist

- [ ] Add a GitHub ProjectData event producer service for existing verified webhook paths.
- [ ] Admit events for supported GitHub trigger paths: `pull_request`, `issue_comment`,
  `issues`, and `push`.
- [ ] Admit repository maintenance events where a project can be matched by repository
  id/name.
- [ ] Use bounded normalized metadata/display only; do not persist raw webhook bodies.
- [ ] Use deterministic delivery keys and payload fingerprints.
- [ ] Wire producer admission into GitHub webhook ingress independently from trigger task routing.
- [ ] Add tests for normalized event construction, duplicate replay, and same-key /
  different-fingerprint conflicts.
- [ ] Add route/service tests proving the real webhook path schedules ProjectData
  admission without changing trigger behavior.
- [ ] Run focused API tests and relevant typecheck/lint/format quality gates.
- [ ] Run specialist review: task-completion-validator, cloudflare-specialist,
  constitution-validator, security-auditor, and test-engineer.
- [ ] Open draft PR targeting `sam/weve-previously-talked-eventing-y207hp`.
- [ ] Check PR CI after push.

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
