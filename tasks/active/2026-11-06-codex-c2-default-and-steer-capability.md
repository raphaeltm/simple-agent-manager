# Codex steering in every mode, and a capability-aware Steer chip

## Problem

Raphaël saw "Sent as next message · agent can't steer" on a running Codex task
(task `01M6RCFJSE95WZJJAEP43F8ETP`, node `01M6RCG89BWSQ1KWDJ1Y0NNCVB`). The session's
ACP initialize at 2026-11-06T12:25:44Z logged `steering:false` and the agent process
was the stock npm `codex-acp`.

Root cause: Codex steering needs SAM's C2.3 adapter (it backports `promptRequired`;
`promptRequiredAdapters` in `packages/vm-agent/internal/acp/session_host_steering.go`).
`selectSessionCodexRuntime` (`codex_staging_candidate.go`) chose C2 only when ACP forms or
URLs were enabled, and `buildAcpInteractionRuntimeConfig`
(`apps/api/src/services/acp-interaction-runtime-config.ts`) enables those only for
`taskMode === 'conversation'`. Every task-mode Codex session, and every Instant Codex
session without a profile marker, ran stock `codex-acp@2.1.1` and could not steer. The
runtime choice was keyed on a signal that merely correlated with "needs C2" (rule 74).

The composer also offered **Steer** to sessions that could never steer; the user only
learnt that from the chip after sending.

## Research Findings

- `prepareAgentStartup` and `selectAgent` (`session_host_selection.go`) both call
  `resolveCodexC2Selector` -> `selectSessionCodexRuntime` -> `selectCodexC2Candidate`.
  VM (container exec, `ensureCodexRuntimeInContainer`) and Instant (local
  `ProcessLauncher`, validation only; image bakes `/opt/sam-codex-c2`) both go through it,
  so one change covers both runtimes (rule 61).
- C2 verification requires x86_64 and Node >= 22 in the container and fails closed (never
  falls back to npm). Default devcontainer image is `typescript-node:22-bookworm`.
  Conversation-mode Codex already runs C2 in production, so the failure mode is not new.
  An explicit opt-out (`SAM_CODEX_C2_CANDIDATE=0` on a profile) keeps Codex usable in an
  incompatible devcontainer.
- The profile marker reaches the VM only from the agent profile
  (`workspace-runtime-assets.ts`), not project/skill env.
- Steering capability is known only on the VM (`SessionHost.steering`, set at ACP
  initialize). Activity reports (`prepareActivityReport`) -> the activity callback
  route -> admission/flush (`activityReportExtra`,
  `withoutSensitiveActivityFields`) -> `projectDataService.reportAcpSessionActivity` -> DO
  `reportActivity` -> `session_state` upsert + `session.activity` broadcast. Browser reads
  `state` from session detail (`resolveChatAgentState`) and `session.activity` over WS
  (`useChatWebSocket` -> `useSessionLifecycle`).
- `session_state` is DO SQLite; a new column needs a DO migration (074).
- Old VM agents omit the field: absence must not overwrite (rule 73) and must leave the UI
  at today's behaviour (Steer offered).
- `acp-activity-admission.ts` (782) and `acp-activity-callback-handler.ts` (649) are
  pre-existing >500-line files; this change adds ~2 lines to admission, staying under the
  800 hard limit.

## Implementation Checklist

- [x] VM agent: C2 is the default Codex runtime; `SAM_CODEX_C2_CANDIDATE=0` opts out to stock; selection no longer reads interaction config
- [x] VM agent: C2 verification/install failure names the requirements and the opt-out
- [x] VM agent: activity report carries `steeringSupported` once ACP initialize has run; included in the resend-dedupe snapshot
- [x] Shared fixture `tests/fixtures/acp-activity-report-v1.json` + Go/TS contract tests
- [x] API: schema, `AcpActivityCallbackReport`, admission copy, `activityReportExtra`, service/DO extra types
- [x] DO: migration `074-session-state-steering-supported`; upsert with COALESCE (absence keeps value); read; `session.activity` broadcast includes it
- [x] Shared `SessionStateSnapshot.steeringSupported`; web `sessions.ts` type; `chat-agent-state` plan-merge copy (`wake-state` EMPTY_STATE left alone: the field is optional and null means unknown)
- [x] Web: `useChatWebSocket` passes it; `useSessionLifecycle` holds `steeringSupported` (hydrate + WS); `SessionFooter` hides the Steer chip and sends `queue` when `false`
- [x] Tests: Go selection (task mode, Instant, opt-out, invalid, latch); Go report field; DO upsert/absence/broadcast; route vertical slice; web footer behaviour
- [x] Docs: `apps/www/.../guides/chat-features.md`, `scripts/diagnostics/acp-runtime-distribution.md`, superseded note in `scripts/diagnostics/acp-codex-staging-delivery.md`
- [ ] Playwright visual audit of the footer (mobile + desktop)
- [ ] Staging: delete nodes, deploy, task-mode Codex session steers ("Added to current turn"); Claude control still steers; clean up

## Acceptance Criteria

- [ ] A task-mode Codex session on a VM starts on the C2 runtime and a steered message shows "Added to current turn"
- [ ] An Instant Codex session without a profile marker uses C2
- [ ] A profile with `SAM_CODEX_C2_CANDIDATE=0` runs stock Codex
- [ ] When the session's adapter cannot steer, the composer shows no Steer chip while the agent works and sends as queue
- [ ] Old VM agents (no field) keep today's behaviour (Steer offered)

## Implementation Notes

- `VerifyCodexRuntime` is an internal `SessionHostConfig` test hook (beside `StartProcess`) so
  generic Codex startup tests run the real default selection without the reviewed release on
  disk. `verifyCodexRuntime` (`codex_runtime_distribution.go`) is the single check; its
  failures are wrapped by `codexRuntimeUnavailable`, which names the opt-out.
- Discrimination checks run: old interaction-gated selection reddens the task-mode and
  disabled cases of `TestSelectAgentCodexVerifiesC2RuntimeInEveryMode` and
  `TestCodexRuntimeDefaultIgnoresInteractionConfig` (conversation forms stays green); removing
  the report wiring reddens `TestActivityReportCarriesSteeringSupportFromInitialize`; dropping
  `COALESCE` reddens the workers vertical slice; forcing `canSteer = true` reddens the footer test.
