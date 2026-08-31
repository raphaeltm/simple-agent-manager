# ProjectData activity callback load protection

## Problem

Production evidence from the task brief says 638 of 709 ProjectData overloads in
the latest health window were ACP activity callbacks. This is load relief, not
storage relief: the hot path must stop sending every redundant activity callback
through the ProjectData Durable Object while preserving transcript/message
persistence and critical control-plane writes.

The three live consumers of `session_state.activity` must keep converging:

- stop-button/session activity state
- durable-message delivery gating
- idle/sleep scheduling, including runtime-work leases

## Research findings

- `apps/api/src/routes/projects/agent-activity-callback.ts` verifies callback
  JWTs, loads the ProjectData ACP session, validates node/workspace binding,
  writes `reportAcpSessionActivity()`, optionally reads `getSessionState()`,
  and then fans out terminal `error` and idle handback effects.
- `apps/api/src/services/project-data.ts` intentionally uses no retry for raw
  `persistMessage()` and `persistMessageBatch()`. This task must not change or
  slow those transcript paths.
- Normal SAM startup creates the ProjectData ACP session with the D1
  `agent_sessions.id` (`agent-session-bootstrap.ts:ensureAcpSessionWithEnv`).
  D1 can therefore validate non-destructive activity callbacks against
  `agent_sessions → workspaces → nodes` without a ProjectData read; destructive
  `error` transitions still need the ProjectData ACP row.
- The VM agent activity sender treats `5xx` as retryable and stops on any
  `2xx`. Expected coalescing must return `204`, not `429`/`503`, or it creates
  more VM retries.
- `session-activity-reconciliation.ts` already provides the healing path for
  stale working states. Coalescing must preserve newest state and terminal/error
  transitions, but redundant intermediate state may rely on the probe to heal
  missed convergence.
- Idle callbacks with `runtimeWorkState=active|settling` are not ordinary idle
  handbacks. They protect sleep/idleness leases and must either be admitted or
  coalesced with a bounded, prompt flush.
- Relevant rules: `.claude/rules/34-vm-agent-callback-auth.md`,
  `.claude/rules/47-control-loop-io-budget.md`,
  `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`,
  `.claude/rules/57-write-only-cross-boundary-state.md`, and Constitution
  Principle XI.
- The referenced `/health-reports/health-report-2026-08-31.md` was not present
  in this workspace; the task prompt's production count is the available
  evidence source.

## Implementation checklist

- [ ] Add env-backed activity admission/coalescing configuration with documented
      defaults and validation.
- [ ] Add a bounded in-memory admission/coalescing buffer for redundant
      nonterminal activity callbacks, with finite size, TTL, and timer cleanup.
- [ ] Avoid ProjectData reads/writes for coalesced redundant callbacks by using
      D1 session/workspace/node binding where safe; keep ProjectData revalidation
      for terminal/error/destructive transitions and cache misses.
- [ ] Preserve JWT verification, token-to-node/workspace binding, reported-node
      matching, stale Instant error rejection, and designed 4xx/410 behavior.
- [ ] Admit or force-flush state transitions that change liveness semantics:
      newest working state, idle handback, runtime-work active/settling edges,
      and all terminal/error reports.
- [ ] Ensure coalesced callbacks return 204 and do not become persisted error
      noise or VM retry storms.
- [ ] Add structured telemetry for admitted, coalesced, healed, rejected, and
      forced-terminal transitions without logging sensitive payloads.
- [ ] Add unit/worker tests for callback storms, state ordering, terminal
      preservation, reconciliation after coalescing, simultaneous transcript
      writes, DO reset/retry behavior, and liveness/session-state regressions.
- [ ] Run focused validation and specialist reviews: cloudflare, security,
      constitution/env/doc sync, test-engineer, task-completion-validator.
- [ ] Open a draft PR for coordinator/Fable review. Do not deploy to staging,
      mutate production/configuration, or merge.

## Acceptance criteria

- Redundant callback storms return 204 while materially reducing ProjectData RPCs.
- The latest coalesced nonterminal state is flushed or converges through the
  existing reconciliation probe; it is never blindly discarded.
- Raw message/transcript persistence remains outside admission control and uses
  its existing no-retry direct ProjectData path.
- Terminal/error activity is never coalesced behind lower-priority intermediate
  state and still performs current D1/ProjectData failure fan-out when valid.
- Stale-generation, session identity, workspace/node binding, sleep/idleness
  semantics, and designed 4xx/410 statuses are preserved.
- All new maps/queues/timers have configurable bounds and finite eviction.
- Logs/metrics expose admitted, coalesced, healed, rejected, and forced-terminal
  outcomes without status-error payloads or transcript content.
- Local tests and reviews are complete. Staging is intentionally skipped by
  explicit instruction; PR remains draft/unmerged.

## References

- Task brief production evidence: 638/709 ProjectData overloads were activity callbacks
- `apps/api/src/routes/projects/agent-activity-callback.ts`
- `apps/api/src/durable-objects/project-data/session-activity-reconciliation.ts`
- `apps/api/src/durable-objects/project-data/session-state.ts`
- `packages/vm-agent/internal/acp/session_host_reporting.go`
