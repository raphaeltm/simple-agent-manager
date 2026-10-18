# Prevent stranded CI waits through accurate guidance

## Problem and research

The GitHub producer appends actions, and ProjectData matches exact event types
and subject IDs. Tool guidance advertised bare CI names; short SHAs also fail to
match. Subscription expiry is not a wake. Stale owner continuations caused repeated
deferral. Existing ownership and release gates must remain intact.

## Scope and acceptance

- [x] Tool schema descriptions and runtime instructions advertise exact completion
      names and full 40-character PR head SHAs.
- [x] Reconcile current checks before registration, immediately after it, and on resume.
- [x] Document independent bounded fallback, expired subscription recovery, and
      shepherd single-owner escalation; no live schedule/prompt mutation.
- [x] Add regression tests for advertised filters against the unchanged matcher
      and agent-facing schema/recovery expectations.
- [x] Focused tests, lint/typecheck, context-budget validation and independent review.
- [ ] Open draft PR with exact validation evidence; no merge or production testing.

## References

- `apps/api/src/services/github-project-event-producer.ts:projectDataEventType`
- `apps/api/src/durable-objects/project-data/project-events-normalization.ts:filterMatchesProjectEvent`
- `docs/guides/ci-wait-recovery.md`

No matcher, security, expiry mechanism or broad CI changes. Four journal PRs are
owned elsewhere. Keep this task active until user confirms completion.

Validation: 36 tests passed in four focused suites; targeted ESLint, Prettier,
API typecheck, dependency builds and context-budget check passed. Independent
completion/docs/API/test review PASS. Live CI wake delivery remains unverified;
this guidance-only change does not deploy or alter runtime semantics.
