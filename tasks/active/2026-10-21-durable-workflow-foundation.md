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
- [ ] Persist bounded validated DAG plan with idempotent start key, owner, steps, attempt identities, frozen launch intent and status/reasons.
- [ ] Extend reserved task submission with workflow source, root attribution, mission/parent/depth, admission limits and current authority.
- [ ] Extend existing orchestrator to reconcile workflow steps with bounded retries/deadline and no duplicate starts.
- [ ] Persist predecessor summary/artifact references and supply bounded handoff prompts.
- [ ] Emit lifecycle events with run/step/attempt/task identities through existing outbox; terminal events nudge reconciliation.
- [ ] MCP start_workflow_run/get_workflow_run with same-owner and current membership checks.
- [ ] Status includes steps, task/session links, attempts, reasons and activity history.
- [ ] Tests: real D1 submission/terminal path, failed prerequisite, duplicate events, concurrent start replay, restart/lost ACK, authorization, plan validation, migrations.
- [ ] Update relevant API documentation.
- [ ] Full quality checks and independent local specialist reviews.
- [ ] Staging real 3-step document handoff, failure and recovery evidence; bounded resource cleanup.
- [ ] PR, CI, best-effort CodeRabbit, merge and production smoke.

## Acceptance
An agent starts a three-step plan and ends its turn. SAM completes it without coordinator intervention, passing the document/result references between steps. Failed prerequisites never launch dependents or yield a successful run. Duplicate delivery/restarts never create duplicate tasks/sessions. Current authorization and admission controls remain enforced. No new UI, automatic agent-failure retries, templates or arbitrary event subscriptions in this slice.
