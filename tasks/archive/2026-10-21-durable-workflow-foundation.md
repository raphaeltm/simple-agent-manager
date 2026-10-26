# Durable workflow foundation

## Problem
Mission grouping exists but no submission path creates deferred steps. Implement an agent-submitted dependency plan which SAM advances without a coordinator, with durable handoffs and truthful failures. User authorized implementation and normal release on 2026-10-21.

## Research
- Design idea 01M59MBMZJVYHPHH1GJ7X8TZT1, Phase 0. No UI/templates/external waits in scope.
- ProjectOrchestrator owns existing mission alarms. Legacy scheduling must not terminalize a workflow merely because its currently created tasks finish.
- `submitReservedTask` already preserves task/session/message identities, freezes configuration, checks live authority and recovers ambiguous starts. Extend this operation rather than introduce a launcher.
- Task terminal hooks plus ProjectData source outbox are existing lifecycle event seams. Persist workflow events atomically with state; reconciliation handles missed notifications.
- Submission checkpoints are a leaf table (no incoming FKs); widening its source CHECK must preserve all data/indexes. Never drop a FK parent.
- Prior double-start incident #2302: claim task/session identity before launching; never launch from an unclaimed queued mission task.
- Current repository at c0fb8edd8; existing SAM isolated task branch is clean and current. PR-only policy overrides skill's direct-main task commit.

## Checklist
- [x] Persist bounded validated DAG plan with idempotent start key, owner, steps, attempt identities, frozen launch intent and status/reasons.
- [x] Extend reserved task submission with workflow source, root attribution, mission/parent/depth, admission limits and current authority.
- [x] Extend existing orchestrator to reconcile workflow steps with bounded retries/deadline and no duplicate starts.
- [x] Persist predecessor summary/artifact references and supply bounded handoff prompts.
- [x] Emit lifecycle events with run/step/attempt/task identities through existing outbox; terminal events nudge reconciliation.
- [x] MCP start_workflow_run/get_workflow_run with same-owner and current membership checks.
- [x] Status includes steps, task/session links, attempts, reasons and activity history.
- [x] Tests: real D1 submission/terminal path, failed prerequisite, duplicate events, concurrent start replay, restart/lost ACK, authorization, plan validation, migrations.
- [x] Update relevant API documentation.
- [x] Full quality checks and independent local specialist reviews.
- [x] Staging real 3-step document handoff, failure and recovery evidence; bounded resource cleanup.
- [x] PR, CI, best-effort CodeRabbit, merge and production smoke. (reconciled 2026-10-26: #2404 final-head CI 39685539091 and E2E 39685539086 success on `4f6034efb`; CodeRabbit CHANGES_REQUESTED fixed in `a6ad98f83`/`07c1e5e8f`, all 3 threads resolved; merged as `2585626df`; main CI 39690107247 and production 39691992669 success; post-deploy `/health` 200 healthy, app 200)

## Acceptance
An agent starts a three-step plan and ends its turn. SAM completes it without coordinator intervention, passing the document/result references between steps. Failed prerequisites never launch dependents or yield a successful run. Duplicate delivery/restarts never create duplicate tasks/sessions. Current authorization and admission controls remain enforced. No new UI, automatic agent-failure retries, templates or arbitrary event subscriptions in this slice.

## Local validation and review
- 13,004 API tests passed (2 skipped); 53 Workers tests passed across workflow, reserved TaskRunner and ProjectData suites.
- Migration upgrade tests preserve checkpoints, indexes, FKs and parent rows; canonical new source accepts workflow. Old leaf table retained as a historical archive to satisfy no-DROP policy.
- API lint/typecheck, format ratchet, migration safety/ordering, DO migration safety, file sizes, type boundaries, runtime tunables and instruction context budget passed.
- Cloudflare reliability review: registration lease, prepared-profile/current-limit checks, deadline ordering and durable history fixes accepted.
- Security review: only same-run step-authored handoffs imported; malformed own outputs fail explicitly and references are bounded. Rereview passed.
- Documentation/constitution/completion review: failed run replay normalized to needs_attention; no remaining implementation findings. Release gates still pending.

## Live staging evidence (2026-10-21)
- Deployment39644535871 attempt2 passed including smoke checks at9a95c2cff. An initial Cloudflare startup-limit rejection cleared on one retry; same bundle had previously reported575ms startup.
- Workflow91a985a1-7eb9-4f0b-a696-f986bf6fa525 completed all three real Claude tasks: draft, review, revise. Identical MCP submissions returned the same run with reusedfalse/true.
- Parent ended its turn and was explicitly put to sleep at18:09UTC. Review and revision advanced afterward without waking it. Draft and review workspaces were also slept after completion.
- Library01M5FTKT4D1A5BH0ZZJKP6R7KQ was passed via predecessor summaries; authenticated download verified exact final content: `Workflow marker WFD20261021. The answer is forty-two.`
- Existing user OAuth credentials and pool settings were used; no token-cap changes. At most two test VMs. Both VM DELETE requests returned200; final read-only cleanup check recorded in task state.
- Bounded live failure test: staging workflow `b3054356-ef88-4f21-aceb-1b08bff65ffa` started with two steps. Authenticated task status API marked step1 task `01M5G524JENSF4Y96BEP8822P6` failed. D1 readback showed step1 `failed`, step2 `blocked` with `Blocked: step1 did not succeed`, no step2 task row, and mission `failed`. Fixture controller task `01M5G4T1AH7P33DB00ZMH8ESD2` completed. Workspace `01M5G501ZTTMAMQ049PQ0HJHCC` and nodes `01M5G4TC52MXVJZFPJ7NH8SBNP` / `01M5G53S40PVEZR1T213YZNFYS` were deleted by supported API (all HTTP 200); staging D1 readback at 21:17 UTC showed zero running/provisioning/starting nodes and workspaces.
- After merging current main, final-head staging deployment `39677698937` succeeded at `ddf4b8f88dd33692ea1dbf45532e6aad083b37cb`, including deployment smoke tests. Authenticated Playwright navigation loaded dashboard and Projects with HTTP 200 and no page errors; the zero-workspace user's Projects page showed cloud onboarding as expected. API `/health` returned HTTP 200.

## Reconciliation 2026-10-26

- Shipped by #2404 (`2585626df`, merged 2026-10-21); first successful production deploy:
  run 39691992669 (head `2585626df`, 2026-10-21).
- Unticked: 0 — none.
- Verdict: ARCHIVE. Phase 0 acceptance is met and deployed; later phases (visibility, steering,
  templates) were out of scope and stay in design idea `01M59MBMZJVYHPHH1GJ7X8TZT1`.
