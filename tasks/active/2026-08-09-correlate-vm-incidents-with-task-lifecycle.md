# Correlate VM Incidents with Task Lifecycle

**Status:** Active
**SAM task:** `01KZJYFB33CYE956414QT4P94S`
**SAM idea:** `01KZK6NG4MTWNSVJAZB2B0YENY`
**Branch:** `sam/came-across-screenshot-tell-t4p94s`
**PR:** https://github.com/raphaeltm/simple-agent-manager/pull/1779

## Problem

A fatal VM runtime event can capture useful safe evidence without producing a coherent task-level failure story. Production incident `01KZJMDJT3ET7Z3BZ40TTX81Z5` recorded `ACP prompt force-stopped` after a six-hour timeout and uploaded a 1,138-byte allowlisted diagnostic artifact, but the task remained active until its parent manually stopped it. That later control action was stored as a generic failed task and became the visible red failure.

The evidence and lifecycle records also use different correlation dimensions:

- VM incident ingestion persists node/workspace IDs in `apps/api/src/routes/node-diagnostic-incidents.ts`.
- Task and chat failure surfaces deep-link the admin error list by task/session IDs in `apps/web/src/components/debug/FailureCard.tsx`.
- Admin error filtering combines supplied identifiers with `AND` in `apps/api/src/services/observability.ts`.

As a result, the already-captured incident and artifact are not reliably reachable from the visible task failure.

## Preflight

### Change classification

- `cross-component-change`: VM agent → Worker callback → D1/observability D1 → web failure surface.
- `business-logic-change`: fatal prompt timeout and parent-stop terminal-state semantics.
- `public-surface-change`: expected lifecycle endings must render neutrally rather than as unknown platform failures.
- `docs-sync-change`: task post-mortem and cross-boundary prevention rule.
- `ui-change`: failure-card classification styling/labels change through the shared classifier.

No external API, migration, credential, billing, or deployment configuration change is planned. One advanced environment override bounds task-status compare-and-set attempts after a parent hard stop.

### Data-flow trace

1. A task-driven VM session configures its completion callback in `packages/vm-agent/internal/server/server.go:makeTaskCompletionCallback()`.
2. The prompt watchdog expires in `packages/vm-agent/internal/acp/session_host_prompt_state.go:watchPromptTimeout()` and `triggerPromptForceStopIfStuck()` force-stops the agent.
3. `SessionHost.reportLifecycle()` sends the error to the durable VM outbox; `packages/vm-agent/internal/errorreport/reporter.go:Report()` assigns the stable incident ID and requests a safe snapshot.
4. The VM posts the durable report to `POST /api/nodes/:id/errors`; `apps/api/src/routes/node-diagnostic-incidents.ts` persists the exact observability row, then `ensurePendingIncidents()` creates incident metadata for artifact registration.
5. The task completion callback posts `toStatus=failed` to `apps/api/src/routes/tasks/callback.ts`, making the genuine prompt timeout the task outcome.
6. The task failure card builds its admin link in `apps/web/src/components/debug/FailureCard.tsx`; correlated task/session IDs on the platform error allow the admin error route to enrich the row with its diagnostic incident and artifact.
7. If a parent intentionally stops an otherwise-active child, `apps/api/src/routes/mcp/orchestration-comms.ts:handleStopSubtask()` must write `cancelled`, not `failed`.

### Assumptions and verification

- **Verified from production data:** the exact VM error and its artifact existed; task/session IDs were null; the task remained active until the later parent stop.
- **Verified in code:** the force-stop branch clears `activePromptID`, causing `HandlePrompt()` to return without calling `finishPrompt()`, and does not independently invoke `notifyPromptComplete()`.
- **Verified in code:** a task and its workspace share a unique `chatSessionId`, providing an authoritative correlation only when workspace, node, and session binding agree.
- **Verified in code:** intentional SAM stop paths already use `cancelled`; the MCP orchestration communication path is the inconsistent writer.
- **Not verified on staging:** explicitly excluded by the user's request. Automated boundary and behavioral tests must close the local verification gap; the sweep will own staging.

### Impact and risk analysis

- Fatal prompt timeouts will now terminalize task state instead of silently stranding it.
- VM incident ingestion will perform a bounded set of main-D1 correlation lookups per batch, chunked at the shared D1 100-bind protocol ceiling (the configured ingestion batch limit remains authoritative).
- Correlation must fail open for observability delivery and fail closed for identity attachment: an absent, stale, mismatched, or ambiguous binding leaves task/session null.
- Missing or malformed producer timestamps must use receipt time only for evidence persistence and must never participate in task-lifetime correlation; every rejected attachment emits a bounded structured reason and action.
- Stable incident retry semantics must allow null correlation fields to be enriched without allowing a non-null ID to be rebound.
- Parent-stop control must stop the runtime before accepting the cancelled terminal state and must run standard terminal cleanup/synchronization.

### Constitution alignment

- No new URL, timeout, arbitrary limit, or identifier is hardcoded. D1 chunking derives from the shared protocol ceiling, and parent-stop CAS attempts use a bounded operator override.
- Existing configurable prompt timeout and VM error batch limits remain authoritative.
- Canonical IDs are validated through node/workspace/session relationships; display names are never used for correlation.

### Documentation plan

- Keep this task record as the bug post-mortem and evidence trace.
- Add a cross-boundary rule covering fatal-runtime completion callbacks, correlation joins, and intentional termination state consistency.
- Update the public agents-managing-agents article so `stop_subtask` documents the canonical cancelled result.
- Document the advanced parent-stop CAS attempt override in the environment example and configuration reference.

## Implementation Plan

- [x] Make watchdog force-stop notify task completion exactly once with the fatal timeout reason.
- [x] Correlate VM reports to task/session only when the callback node owns the workspace and task/workspace session bindings agree for the incident timestamp.
- [x] Make strict stable-incident persistence permit monotonic null → correlated enrichment while rejecting conflicting non-null rebinding.
- [x] Record MCP parent stops as `cancelled`, including completed timestamp, status event, trigger synchronization, and terminal cleanup.
- [x] Classify `stopped_by_parent` and expected human-input expiry as non-bug lifecycle outcomes with neutral failure-card presentation.
- [x] Add the preventive cross-boundary quality rule.
- [x] Run focused tests, impacted package gates, full repository gates, and all applicable specialist reviews.
- [x] Open a PR, get required CI green, and leave it unmerged.
- [x] Skip staging deployment and verification at the user's explicit request; the sweep owns that phase.

## Acceptance Criteria

- [x] A forced task prompt timeout invokes the fatal completion callback with the timeout reason and does not leave the task active.
- [x] The VM incident/error ingestion vertical slice persists matching task/session IDs for an authoritative node → workspace → session → task binding.
- [x] Mismatched node/workspace bindings, task/workspace session mismatches, post-dated tasks, and ambiguous candidates remain uncorrelated.
- [x] A stable incident retry may enrich missing task/session IDs but can never replace a conflicting non-null ID.
- [x] Parent `stop_subtask` invokes the runtime stop before writing `cancelled`, records a cancelled event, synchronizes trigger state, and performs terminal cleanup.
- [x] Legacy `stopped_by_parent` messages and human-input expiry classify as lifecycle outcomes instead of unknown failures.
- [x] Failure-card unit and Playwright visual tests prove lifecycle outcomes are neutral and usable at mobile and desktop sizes.
- [x] Focused and full validation pass; the PR's required GitHub checks are green.
- [x] PR remains open and unmerged; no staging workflow is dispatched.

## Post-Mortem

### What broke

The six-hour prompt watchdog killed the agent but never informed the control plane that the task had fatally ended. The task therefore stalled. When its parent later stopped it, the stop was incorrectly stored as a failed task, and that later lifecycle action displaced the genuine timeout in the user-visible story. The earlier VM incident retained useful evidence but lacked the task/session IDs used by the failure-card debugger link.

### Root cause

- Commit `c11b8aa76f` (2026-05-09) introduced the force-stop path. It deliberately clears `activePromptID`, so `HandlePrompt()` exits before normal completion handling, but the branch omitted the replacement `notifyPromptComplete(fatal_error, timeout)` call.
- Commit `4542295f81` (2026-04-07) introduced MCP parent stopping with `status='failed'` and a `stopped_by_parent` underscored reason, diverging from the platform's later canonical `cancelled` stop semantics.
- PR #1750 / commit `a857a337e` (2026-08-07) added durable VM incidents and safe artifacts but persisted only the identifiers present in the VM report (node/workspace), while the task failure link added by PR #1765 resolves by task/session.

### Timeline

- 2026-04-07: parent-stop path begins writing failed terminal state.
- 2026-05-09: force-stop watchdog begins bypassing task completion callback.
- 2026-08-07–08: incident artifacts and rich failure/debug surfaces ship independently with incompatible correlation dimensions.
- 2026-08-09 06:47 UTC: production prompt is force-stopped; safe evidence uploads, but task remains active.
- 2026-08-09 09:34 UTC: parent stops the stalled task; generic failed card becomes visible.
- 2026-08-09: screenshot-led investigation correlates the three records and identifies the broken handoffs.

### Why it was not caught

- Timeout tests exercised the normal deadline-return path, not a provider process that remained stuck beyond cancellation grace and entered the forced-stop branch.
- Parent-stop tests accepted the local `failed` behavior instead of comparing it with the canonical stop/cancel contract used by other orchestration paths.
- Incident tests proved artifact durability and per-row identifiers independently, but no vertical slice began with a workspace-only VM report and asserted that a task/session deep link could retrieve the resulting evidence.

### Class of bug

Cross-boundary lifecycle and identity fragmentation: each component behaved plausibly in isolation, but a fatal runtime transition, a later control-plane termination, and a separate observability store did not preserve one causal/correlation contract end to end.

### Process fix

Extend `.claude/rules/23-cross-boundary-contract-tests.md` to require:

1. every fatal runtime-owned exit path to prove its terminal callback reaches authoritative task state;
2. every intentional stop/cancel writer to use the canonical terminal status and cleanup contract;
3. observability correlation tests to start with the least-correlated producer payload and prove safe, non-ambiguous enrichment through the consumer's lookup dimensions.

## Verification Record

- Shared failure-classification tests: 23 passed.
- API focused correlation, strict persistence, observability ingestion, parent-stop, and task-callback suites: 79 passed.
- Web focused failure-card and lifecycle presentation suites: 95 passed.
- VM-agent ACP tests, including exact-once fatal completion: passed.
- Playwright lifecycle audit at 375×667 and 1280×800: passed with no horizontal overflow; both screenshots were inspected.
- Full repository build and typecheck passed. The first full test attempt passed 6,787 of 6,788 API tests; one unrelated orchestration-test setup hook exceeded its 10-second timeout under suite load, then the complete 31-test file passed in 2.88 seconds in isolation. The full retry cleared that failure and passed all 6,788 API tests, but one unrelated command-palette assertion failed after 2,938 web tests passed; its complete 23-test file then passed in 3.42 seconds in isolation. Required PR checks are the final full-suite green gate.
- Repository lint, changed-file formatting, quality checks, `git diff --check`, and VM-agent `go vet ./...`: passed. Existing lint warnings and repository-wide formatting drift remain unchanged.
- Full VM-agent `go test ./...` is blocked locally only in three Docker-dependent PTY/server tests because this workspace has no Docker binary; all other packages, including the changed `internal/acp` package and server callback tests, passed.
- Go, Cloudflare, test, security, constitution, environment, documentation-sync, and UI/UX specialist reviews passed after their findings were addressed.
- PR #1779 passed the complete implementation rollup: tests, Playwright visual audits, VM-agent smoke/integration/E2E, Durable Objects, build, typecheck, lint, code quality, UI compliance, Pulumi tests, benchmarks, and SonarCloud. The PR preflight evidence block was corrected before the final synchronization event.
- Staging was not deployed or verified, per the user's explicit request.
