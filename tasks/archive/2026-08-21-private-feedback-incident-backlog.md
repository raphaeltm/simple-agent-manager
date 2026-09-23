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
- 2026-08-21 continuation: the existing PR branch was rebased onto `origin/main` after #1875 and #1876 merged. The new request supersedes the earlier draft-only/no-staging constraint: add in-app admin UX for selecting the private feedback project, run staging verification, and merge PR #1877 if green and mergeable.
- Existing platform integration config already uses `platform_settings` key/value rows, environment fallbacks, a per-isolate `resolvePlatformConfig` cache, and superadmin-only `/api/admin/platform-config`. The feedback project selector should reuse this resolver/write/cache-invalidation path rather than adding a parallel config system.
- Existing `GET /api/projects` returns projects the current user can access via active membership. The admin dropdown should use that accessible-project list. Save validation must also require the selected project to exist and be accessible to the current superadmin, instead of accepting arbitrary project IDs.
- Existing Report Issue availability already flows through `GET /api/report-issue/config`; once that endpoint uses the effective setting, both Report Issue entry points remain hidden when no effective project exists or when the configured project is missing.
- Current report intake, platform-error triage, incident trigger sweep, and MCP incident scope guard read `env.PLATFORM_FEEDBACK_PROJECT_ID` directly. All must use one shared effective setting (`platform_settings` runtime value first, then env fallback) so admin changes apply consistently.
- Existing `/admin/integrations` Playwright audit (`apps/web/tests/playwright/platform-config-audit.spec.ts`) covers the platform config surface; extend it for the feedback project selector rather than creating duplicate UI audit coverage.
- Relevant retained lessons for this continuation: `.claude/rules/06-technical-patterns.md` (UI-to-backend dropdown must not be cosmetic), `.claude/rules/24-no-duplicate-ui-controls.md` (one canonical config control/resolver), `.claude/rules/44-dual-write-migration-enumerate-writers.md` (enumerate writers/cache invalidation for config state), `.claude/rules/13-staging-verification.md` and `.claude/rules/30-never-ship-broken-features.md` (staging must exercise the actual feature).

## Implementation checklist

- [x] Add append-only D1 migration and Drizzle schema fields extending `platform_feedback_triages` with incident backlog state, queued/dispatched/terminal timestamps, dispatch lease token/expiry, dispatched trigger/task/execution IDs, dispatch attempts, and bounded resolution metadata.
- [x] Add shared configurable defaults/env parsing for incident backlog limits, lease TTL, max attempts, stale/terminal expiry, backlog summary count, and text/content limits.
- [x] Implement a service layer for grouped incident upsert, listing, reading, claiming, lease reclaim, resolve/reject terminal transitions, expiry/circuit-breaker visibility, and backlog summary rendering.
- [x] Move hosted Report-an-Issue ingestion onto the grouped incident backlog while preserving ref authorization, title/description redaction, and untrusted evidence fencing.
- [x] Ensure platform error grouping marks backlog rows pending without dispatching per occurrence and excludes errors/tasks associated with the configured feedback project to prevent self-amplification.
- [x] Add `incident` trigger source type through shared trigger schemas/types/read paths and create a scheduled incident trigger sweep that calls `admitAndSubmitTriggerExecution`.
- [x] Render incident trigger prompts as a bounded backlog summary with counts/signatures/state only; do not include raw payloads or unfenced report/log text.
- [x] Add MCP tools `list_incident_queue`, `get_incident`, `claim_incident`, and `resolve_incident` gated to the configured feedback project server-side.
- [x] Add adversarial tests for duplicates, simultaneous claims, lease reclaim, trigger already running, self-errors, injection strings, canary secrets, cross-project access, terminal exits, and circuit-breaker visibility.
- [x] Update API reference/docs/config references proportionally.
- [x] Run focused tests, local quality, mandatory specialist reviews, draft PR, and CI for the initial slice. The 2026-08-21 continuation supersedes the prior no-staging/no-merge constraint.
- [x] Add a runtime `feedback.projectId` platform setting with `PLATFORM_FEEDBACK_PROJECT_ID` as the bootstrap/default fallback and cache invalidation on writes.
- [x] Add feedback-project status to admin platform config responses, including unset/configured/missing/inaccessible state and project display metadata when available.
- [x] Validate feedback project saves through the superadmin admin route: selected project must exist and be accessible to the caller; clearing runtime selection reveals the environment fallback/unset state.
- [x] Replace direct `env.PLATFORM_FEEDBACK_PROJECT_ID` reads in report intake, automated platform feedback triage, incident trigger sweep, and MCP incident tools with the shared effective resolver.
- [x] Add admin `/admin/integrations` dropdown UX using accessible projects, with clear status copy for configured, unset, and missing/inaccessible project states.
- [x] Add focused API/service/route/UI tests proving env fallback, runtime override, missing project hidden state, authorization failure, UI payload propagation, and MCP/triage effective scope.
- [x] Update docs and env/API references to say UI configuration is preferred and `PLATFORM_FEEDBACK_PROJECT_ID` remains bootstrap/fallback.
- [x] Run local visual audit for the updated admin integrations surface at mobile and desktop sizes.
- [ ] Deploy PR #1877 to staging, verify admin project selection, Report Issue hide/show, draft Idea creation in the selected project, and MCP incident scope against the effective project.
- [ ] If CI, staging, and mergeability are green, mark PR #1877 ready and merge; leave PR #1873 untouched.

## Acceptance criteria

- [x] Multiple matching reports/errors collapse into one durable grouped incident with occurrence accounting.
- [x] A pending incident trigger dispatches one agent for a bounded backlog summary, and another pending occurrence while the trigger is running is preserved in backlog rather than lost.
- [x] Incident claim/resolve transitions use bounded CAS/lease/expiry/terminal state rules and simultaneous claims cannot both win.
- [x] Lease expiry/reclaim, terminal exits, max attempts, and circuit-breaker/paused visibility are observable and tested.
- [x] Feedback-project tasks/errors cannot create a self-amplifying incident dispatch loop.
- [x] MCP incident tools derive project scope from the server-side configured feedback project and caller token; cross-project probes do not reveal existence or mutate rows.
- [x] Model-visible incident content is bounded, redacted, and fenced as untrusted evidence; seeded canary secrets do not appear in responses, prompts, Ideas, logs, or stored model-visible summaries.
- [x] No machine-generated diagnostic or feedback content is posted to public GitHub issues.
- [x] Local adversarial experiments/tests pass; required skills report PASS or findings are addressed.
- [x] Draft PR is open and CI is allowed to run; the continuation request authorizes staging and merge if green/mergeable.
- [x] Admin can select an accessible feedback project from `/admin/integrations`; the selection is persisted in `platform_settings` and takes effect without redeploy.
- [x] Environment `PLATFORM_FEEDBACK_PROJECT_ID` remains a fallback when no runtime setting is present.
- [x] Missing or inaccessible configured projects are shown clearly to the admin and keep Report Issue hidden rather than exposing a broken button.
- [x] Report intake, automatic triage, incident trigger sweep, and MCP incident tools all scope to the same effective feedback project.
- [x] Changing the feedback project affects new reports/triage only; existing incident rows are not migrated.
- [ ] Staging verification proves the selected project receives a new draft Idea from Report Issue and MCP incident tools are available only in the effective feedback project.

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
