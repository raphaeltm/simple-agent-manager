# Resolve private feedback API incident groups

SAM task: `01M0YC7NY9G38VQCNYAHCETYF4`
Output branch: `sam/sam-private-incident-triage-cetyf4`

## Problem statement

Three private grouped API platform incidents were dispatched for triage. The fix must use
the private MCP incident claim/resolve tools and must not copy machine-generated diagnostic
or feedback content into public GitHub issues or repository artifacts.

The grouped incidents fall into three sanitized classes:

- ProjectData Durable Object code-update resets on the project session event WebSocket route.
- ProjectData storage warning alerts for a large hot Durable Object.
- Repeated VM message-persistence rejections after a workspace has already transitioned out
  of an active state.

## Research findings

- `apps/api/src/routes/chat.ts` exposes `GET /api/projects/:projectId/sessions/ws` and
  forwards the browser WebSocket upgrade through `projectDataService.forwardWebSocket()`.
- `apps/api/src/services/project-data.ts` already has env-backed ProjectData Durable Object
  retry handling via `callProjectDataWithRetry()`, but `forwardWebSocket()` still called
  `stub.fetch()` directly.
- Prior retained task `tasks/archive/2026-06-05-durable-object-reset-retry.md` established
  that Cloudflare code-update Durable Object resets are transient and should be retried
  rather than recorded as hard session-load failures.
- `tasks/active/2026-08-26-projectdata-storage-safety-warning-alerts.md` and current main
  already route ProjectData `warning` storage states to operator-visible platform alerts and
  add bounded cleanup reach. The live warning is a real capacity signal, not a spoofed or
  code-update error.
- `apps/api/src/routes/workspaces/runtime.ts` intentionally rejects
  `POST /api/workspaces/:id/messages` for inactive workspaces before writing into ProjectData.
  The observed warning class is downstream noise from workspace/task lifecycle closure, not
  unsafe message persistence.
- Recent retained lifecycle work (`tasks/archive/2026-08-26-fix-reconciliation-checkin-attention-expiry.md`,
  `tasks/active/2026-08-26-shared-agent-session-closure-finalizer.md`, and
  `tasks/archive/2026-08-26-instant-execution-step-contract.md`) addresses known causes of
  false task/session runtime deaths and stale lifecycle mirrors. This task should not
  reimplement those broad fixes.
- The inactive-workspace rejection group still exposed a narrow stale-liveness gap:
  cron and ProjectData idle-cleanup liveness only considered ACP heartbeat freshness after
  a successful node-health probe. Fresh ProjectData prompt/runtime-work state should also
  count as task-scoped positive liveness, with bounded freshness windows.
- Relevant rules: `.claude/rules/31-migration-safety.md`,
  `.claude/rules/47-control-loop-io-budget.md`, `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`,
  `.claude/rules/59-understand-before-adding.md`, and the private-feedback policy against
  public machine-generated diagnostic content.

## Implementation checklist

- [x] Load SAM MCP instructions before work.
- [x] Claim all dispatched private API incident groups with MCP incident tools.
- [x] Read bounded private incident evidence and live observability metadata without copying
      evidence into public artifacts.
- [x] Query only the referenced production rows and relevant lifecycle metadata for diagnosis.
- [x] Route ProjectData WebSocket forwarding through the shared Durable Object retry wrapper.
- [x] Add a regression test proving `forwardWebSocket()` retries a transient code-update reset
      before returning the DO response.
- [x] Add bounded ProjectData session-work liveness signals for prompt turns and harness
      runtime work, and feed them to both liveness adapters.
- [x] Run focused validation for the changed ProjectData retry and liveness paths.
- [x] Decide terminal outcome for the storage warning group based on current storage telemetry.
- [x] Decide terminal outcome for the inactive-workspace rejection group based on current
      lifecycle fixes and recurrence checks.
- [x] Resolve or reject all claimed private incident groups using MCP incident tools with
      bounded private notes.
- [x] Run required validation and specialist reviews.
- [ ] Push the output branch and complete the SAM task.

## Acceptance criteria

- ProjectData WebSocket forwarding uses the same bounded, env-configurable Durable Object retry
  policy as other ProjectData RPC paths.
- A transient Durable Object code-update reset in WebSocket forwarding no longer immediately
  bubbles to the route-level 500/platform-error path.
- Fresh ProjectData prompt-turn or harness runtime-work state prevents a stale ACP heartbeat
  from becoming a conclusive task-death verdict after node health is independently confirmed.
- That liveness escape is bounded by existing configurable freshness/lease windows and does
  not preserve stale prompt state indefinitely.
- Storage warning incident handling is terminally recorded through MCP as either resolved by
  existing automation/known tracking or rejected/escalated if still not safely addressable in
  this code slice.
- Inactive-workspace message rejection handling is terminally recorded through MCP after
  confirming it is downstream of lifecycle state and not a message-routing safety bug.
- No private diagnostic/report/log text is copied into public GitHub issues, PR descriptions,
  or repository task files.

## Validation evidence

- `pnpm --filter @simple-agent-manager/shared build` — passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/project-data-retry.test.ts`
  — passed, 7 tests.
- `pnpm --filter @simple-agent-manager/cloud-init build` — passed; required to load the
  stuck-task vertical-slice tests.
- `pnpm --filter @simple-agent-manager/providers build` — passed; required to load the
  stuck-task vertical-slice tests.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/project-data-retry.test.ts tests/unit/services/task-runtime-liveness.test.ts tests/unit/stuck-task-slept-session-liveness.test.ts tests/unit/conversation-idle-timeout.test.ts`
  — passed, 108 tests.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/stuck-tasks.test.ts` —
  passed, 56 tests.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `git diff --check` — passed.
- `pnpm --filter @simple-agent-manager/api test` — passed, 609 test files / 8,309 tests.
- `pnpm lint` — passed; repo had pre-existing warnings only.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `pnpm test` — default parallel Turbo run exposed transient cross-package test timeouts in
  unrelated API test files; the three reported files passed immediately when rerun directly.
- `pnpm exec turbo run test --concurrency=1 --output-logs=errors-only` — passed from cache,
  21 tasks.
- `pnpm test -- --output-logs=errors-only` — passed from cache, 21 tasks.
- Specialist reviews applied:
  - Cloudflare: no migration/config change; DO query is bounded, parameterized, and keeps
    slow ProjectData probes timeout-inconclusive in the cron adapter.
  - Constitution: no new hardcoded deployment URLs, unconfigurable timeouts, or unbounded
    limits; new freshness behavior reuses existing env-backed knobs.
  - Security: WebSocket auth/ownership behavior is unchanged; retry wrapper preserves the
    original request and only retries transient DO errors.
  - Test engineering: added unit regression for WebSocket retry plus classifier and real
    ProjectData SQL vertical-slice coverage for fresh prompt/runtime-work liveness and stale
    prompt expiry.
  - Task completion: implementation covers the sanitized findings and acceptance criteria;
    remaining push/complete step is tracked separately.
