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
- [ ] Failure-injection regression tests through real sweep, admission, and SQLite boundary.
- [ ] Stable occurrence identity, including recovery of existing execution records and concurrent admission.
- [ ] Preserve pending work on exceptions; advance only after a durable admission outcome.
- [ ] Isolate advancement failures and attempt at most one write per trigger per sweep.
- [ ] Safe allowlisted database cause categories, without raw query messages or parameters.
- [ ] Update scheduling documentation.
- [ ] Full lint/typecheck/test/build and task completion validation.
- [ ] Independent local specialist reviews and resolve findings.
- [ ] Staging deployment and live verification.
- [ ] PR, CI, best-effort CodeRabbit review, merge, production deploy and basic smoke.

## Acceptance
Later due triggers run despite admission or advancement errors. Later sweeps reuse accepted executions and recover pending ones. Exceptions do not discard due occurrences. Retries are bounded per sweep, remain observable, and leak no database parameters through new diagnostics. No production repair is performed.
