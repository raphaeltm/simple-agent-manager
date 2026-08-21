# Private feedback incident backlog and trigger dispatch

## Problem

Canonical idea `01KXN5YQ9TGN29ZZ8DP2DKAKHN` has shipped the hosted debug agent, safe VM diagnostic incident snapshots, hourly platform error grouping/triage, Report-an-Issue draft Ideas, and race-safe trigger admission. The missing final hop is a private, durable incident backlog that an incident trigger can dispatch against once per grouped backlog summary, not once per occurrence.

This slice must preserve the existing safety boundary: diagnostic/report/log text is untrusted, raw or broad debug packages remain private operator-only, machine-generated diagnostics/feedback must not go to public GitHub issues, and server-side project scope must be enforced.

## Research findings

- The 2026-08-19 refinement says the queue unit should be a grouped incident signature, not an occurrence. It explicitly prefers extending `platform_feedback_triages` instead of adding Cloudflare Queues or parallel tables.
- `apps/api/src/services/platform-feedback-triage.ts` already groups `platform_errors` by sanitized signature, upserts `platform_feedback_triages`, lease-claims triage work, creates/updates one draft Idea per group, and circuit-breaks after bounded failures.
- `apps/api/src/db/schema.ts` and migrations `0101`/`0102` define `platform_feedback_triages` with `signature`, summary/window/count/evidence refs, claim/failure fields, `diagnosis_id`, `idea_id`, and `rejected_at`.
- `apps/api/src/services/report-issue.ts` still writes one draft Idea per report. This slice should move report ingestion into the grouped incident backlog to remove the one-Idea-per-submission anomaly while preserving consent-gated ref validation and untrusted evidence fencing.
- `apps/api/src/services/trigger-admission.ts` already provides the race-safe admission chokepoint. Its atomic reservation counts `queued` and `running` executions and `skipIfRunning=true` already enforces one active agent per trigger.
- `apps/api/src/scheduled/cron-triggers.ts` is a source adapter that calls admission. Incident triggers should follow the same pattern and be isolated in `apps/api/src/scheduled/handler.ts` via `createSweepIsolator`.
- MCP tools are centralized in `apps/api/src/routes/mcp/index.ts`; definitions are composed from `tool-definitions.ts`. New server-scoped incident tools must use MCP token project context and must not trust caller-supplied project IDs.
- Existing untrusted formatting lives in `apps/api/src/services/untrusted-idea-content.ts`; new incident read/summary paths should reuse the same instruction/evidence boundary.
- Relevant rules: `.claude/rules/47-control-loop-io-budget.md`, `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`, `.claude/rules/11-fail-fast-patterns.md`, `.claude/rules/31-migration-safety.md`, `.claude/rules/35-vertical-slice-testing.md`.

## Implementation checklist

- [ ] Add append-only D1 migration and Drizzle schema fields extending `platform_feedback_triages` with incident backlog state, queued/dispatched/terminal timestamps, dispatch lease token/expiry, dispatched trigger/task/execution IDs, dispatch attempts, and bounded resolution metadata.
- [ ] Add shared configurable defaults/env parsing for incident backlog limits, lease TTL, max attempts, stale/terminal expiry, backlog summary count, and text/content limits.
- [ ] Implement a service layer for grouped incident upsert, listing, reading, claiming, lease reclaim, resolve/reject terminal transitions, expiry/circuit-breaker visibility, and backlog summary rendering.
- [ ] Move hosted Report-an-Issue ingestion onto the grouped incident backlog while preserving ref authorization, title/description redaction, and untrusted evidence fencing.
- [ ] Ensure platform error grouping marks backlog rows pending without dispatching per occurrence and excludes errors/tasks associated with the configured feedback project to prevent self-amplification.
- [ ] Add `incident` trigger source type through shared trigger schemas/types/read paths and create a scheduled incident trigger sweep that calls `admitAndSubmitTriggerExecution`.
- [ ] Render incident trigger prompts as a bounded backlog summary with counts/signatures/state only; do not include raw payloads or unfenced report/log text.
- [ ] Add MCP tools `list_incident_queue`, `get_incident`, `claim_incident`, and `resolve_incident` gated to the configured feedback project server-side.
- [ ] Add adversarial tests for duplicates, simultaneous claims, lease reclaim, trigger already running, self-errors, injection strings, canary secrets, cross-project access, terminal exits, and circuit-breaker visibility.
- [ ] Update API reference/docs/config references proportionally.
- [ ] Run focused tests, local quality, mandatory specialist reviews, draft PR, and CI. Do not deploy staging or merge.

## Acceptance criteria

- [ ] Multiple matching reports/errors collapse into one durable grouped incident with occurrence accounting.
- [ ] A pending incident trigger dispatches one agent for a bounded backlog summary, and another pending occurrence while the trigger is running is preserved in backlog rather than lost.
- [ ] Incident claim/resolve transitions use bounded CAS/lease/expiry/terminal state rules and simultaneous claims cannot both win.
- [ ] Lease expiry/reclaim, terminal exits, max attempts, and circuit-breaker/paused visibility are observable and tested.
- [ ] Feedback-project tasks/errors cannot create a self-amplifying incident dispatch loop.
- [ ] MCP incident tools derive project scope from the server-side configured feedback project and caller token; cross-project probes do not reveal existence or mutate rows.
- [ ] Model-visible incident content is bounded, redacted, and fenced as untrusted evidence; seeded canary secrets do not appear in responses, prompts, Ideas, logs, or stored model-visible summaries.
- [ ] No machine-generated diagnostic or feedback content is posted to public GitHub issues.
- [ ] Local adversarial experiments/tests pass; required skills report PASS or findings are addressed.
- [ ] Draft PR is open and CI is allowed to run; staging plan is documented but no staging mutation occurs without parent approval.

## References

- Canonical idea `01KXN5YQ9TGN29ZZ8DP2DKAKHN`, especially 2026-08-19 refinement.
- `apps/api/src/services/platform-feedback-triage.ts`
- `apps/api/src/services/report-issue.ts`
- `apps/api/src/services/trigger-admission.ts`
- `apps/api/src/scheduled/cron-triggers.ts`
- `apps/api/src/routes/mcp/index.ts`
- `tasks/archive/2026-07-29-automated-error-store-triage.md`
- `tasks/archive/2026-07-30-platform-feedback-triage-resilience.md`
- `tasks/archive/2026-07-30-harden-feedback-idea-boundaries.md`
- `tasks/backlog/2026-08-11-trigger-paused-reason-signal.md`
