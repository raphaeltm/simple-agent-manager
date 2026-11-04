# Cron schedule advancement recovery

## Problem

A failed schedule write can escape trigger isolation. Retrying a due occurrence must reuse its admission identity rather than submit another task.

## Research and preflight

- Class: business-logic-change, cross-component-change.
- Flow: scheduled/handler.ts → scheduled/cron-triggers.ts → services/trigger-admission.ts → trigger-submit.ts → reserved-task-submission.ts.
- Admission accepts caller-owned execution IDs; submission reserves deterministic task/session identities per execution.
- Cron currently supplies no execution identity and advances again from its catch handler.
- Existing open PRs, recent main commits, and SAM cron task search revealed no matching implementation.
- Use existing occurrence/execution records and idempotent submission; avoid new queues or schema changes unless required by tests.
- Keep all operational diagnostics outside tracked files and public artifacts. Database cause remains unproven; never infer overload from a wrapper error.

## Checklist

- [x] Failure-injection regression tests through real sweep, admission, and SQLite boundary.
- [x] Stable occurrence identity, including recovery of existing execution records and concurrent admission.
- [x] Preserve pending work on exceptions; advance only after a durable admission outcome.
- [x] Rotate bounded due selection with an isolated KV cursor so a failed prefix cannot starve later work.
- [x] Isolate advancement failures and attempt at most one write per trigger per sweep.
- [x] Safe allowlisted database cause categories, without raw query messages or parameters.
- [x] Update scheduling documentation.
- [x] Full lint/typecheck/test/build and task completion validation.
- [x] Independent local specialist reviews and resolve findings.
- [ ] Staging deployment and live verification.
- [ ] PR, CI, best-effort CodeRabbit review, merge, production deploy and basic smoke.

## Acceptance

Later due triggers run despite admission or advancement errors. Later sweeps reuse accepted executions and recover pending ones. Exceptions do not discard due occurrences. Retries are bounded per sweep, remain observable, and leak no database parameters through new diagnostics. No production repair is performed.

## Selection budget

At most CRON_MAX_FIRE_PER_SWEEP candidates (default 5) per sweep, one KV read/write, and at most two bounded due-selection queries. Existing per-candidate admission work remains bounded by the selected page; schedule advancement is attempted once per selected occurrence. Indexed trigger lookup reuses an existing occurrence before submission.

## Validation and review

- Full repository lint, typecheck, test and build passed. Test rerun: 21/21 tasks green; API 1,017 files passed, 1 skipped, 14,832 tests passed, 2 skipped. First parallel run hit timeouts in the unchanged session-sleep suite; its 42 tests and the complete rerun passed.
- Focused recovery/admission/category suite: 35 passed. Actual workerd D1 sweep regression: 1 passed.
- Independent Cloudflare and test reviews found capped-prefix starvation; cursor rotation and a red-to-green cap=1 test addressed it. Delta reviews passed. Completion, constitution and documentation reviews passed.
- Staging, PR/CI, CodeRabbit and production release remain pending below.
