# CF Container Keepalive and Sleeping State

## Problem

Cloudflare Containers only treat inbound requests as activity. SAM's instant `cf-container` runtime can therefore idle out during a long-running agent turn after the Worker receives the initial 202 response from vm-agent, even though the agent is still working asynchronously inside the container.

The current `VmAgentContainer.onActivityExpired()` path is terminal: it records the node, workspace, and agent session as `error` and future requests return 410 "start a new instant session". For Phases 1 and 2 of idea `01KX4KSXEXQMP41KS34TW9EN01`, active work should keep the container alive, and normal idle expiry should be represented as a non-crash "sleeping" state. Phase 3 wake/rehydrate is explicitly deferred.

## Research Findings

- Idea `01KX4KSXEXQMP41KS34TW9EN01` defines three phases. This task implements only Phases 1 and 2.
- `apps/api/src/durable-objects/vm-agent-container.ts` sets `sleepAfter` to `CF_CONTAINER_SLEEP_AFTER || SANDBOX_SLEEP_AFTER || '10m'` and handles `onActivityExpired()` by calling `markRuntimeEnded('expired', ...)`, then stopping the container.
- `markRuntimeEnded()` maps every non-`stopped` state to `error` for node, workspace, and agent session rows. That conflates normal idle sleep with crashes.
- `apps/api/src/services/vm-agent-container.ts` mirrors the same 10 minute default and is the service boundary for launch, fetch, stop, and destroy.
- `apps/api/src/services/node-agent.ts` is the shared control-plane path for initial prompt dispatch, follow-up prompt dispatch, cancellation, and stop requests. This is the right place to signal active work to the container DO without requiring vm-agent protocol changes.
- `apps/api/src/services/instant-session.ts` launches cf-container sessions and uses `startAgentSessionOnNode()` for the initial prompt.
- `apps/api/tests/unit/cf-container-runtime-contract.test.ts` currently asserts the old terminal idle contract and must be updated.
- Rule 42 requires a nearby code comment referencing the tracked follow-up when Phase 3 wake/rehydrate is intentionally deferred.

## Implementation Checklist

- [x] Add configurable defaults/constants for cf-container sleep and active-work keepalive ceiling, raising the default sleepAfter from 10m to 1-2h.
- [x] Add `VmAgentContainer` active-work lifecycle APIs that mark work started/ended, call `renewActivityTimeout()`, and enforce a defensive max active-work deadline.
- [x] Wire initial prompt, follow-up prompt, cancel, and stop paths through container lifecycle signals for cf-container nodes.
- [x] Change idle expiration to record a distinct sleeping lifecycle state without marking node/workspace/agent_session rows as crash/error.
- [x] Return a clear "container is asleep" response for sleeping containers while Phase 3 wake/rehydrate is deferred, with a code comment referencing idea `01KX4KSXEXQMP41KS34TW9EN01` Phase 3.
- [x] Update cf-container runtime contract tests for keepalive start/end, raised default, non-terminal sleeping classification, and the temporary sleeping response.
- [x] Run focused tests for the changed API runtime contracts, then the required quality suite.
- [x] Deploy to staging with coordination checks, start an instant cf-container session, run a long prompt past the old 10 minute window, and verify idle expiry no longer records an error.

## Staging Verification

- Deployed branch `sam/implement-phases-1-2-japy3a` with deploy-staging run `29118210240`; confirmed it was the latest successful staging deploy before verification.
- Created temporary cf-container profile `01KX6SXFKG5CHVQY33QNECY749` on staging project `01KTKXZ4ZZAT6MJFXRW1ZTQ7RB`, then started instant session `9ed3611f-257c-47e3-8fc2-3c7b592fd772`.
- Started cf-container node `01KX6SXZ74CJVTZAJ0TYG17T0C`, workspace `01KX6SXZC0YJQ151B8SGHZR6ND`, and agent session `01KX6SYA37P35JKTXG313KQP8Z`.
- After an 11 minute quiet interval with no direct session traffic, D1 showed node/workspace/agent session still `running`, node `healthy`, and all error fields `null`; the node heartbeat was current at `2026-07-10T20:19:38.685Z`.
- Confirmed staging had no `CF_CONTAINER_SLEEP_AFTER` or `SANDBOX_SLEEP_AFTER` binding, so the deployed branch used the new `DEFAULT_CF_CONTAINER_SLEEP_AFTER = '1h'`.
- Cancelled the prompt path, waited 65 minutes for real idle expiry, and verified D1 showed node/workspace/agent session all `sleeping`, all error fields `null`, and `updated_at = 2026-07-10T21:21:34.707Z`.
- Verified a follow-up prompt against the sleeping session returned HTTP 409 with `The workspace container is asleep. Send a new message after wake/rehydrate support lands.`, not the previous terminal 410 response.
- Deleted temporary profile `01KX6SXFKG5CHVQY33QNECY749` and test node `01KX6SXZ74CJVTZAJ0TYG17T0C` through the staging API.

## Acceptance Criteria

- Active long-running cf-container prompts do not die solely because no inbound request reaches the container before `sleepAfter`.
- Keepalive state is cleaned up on completion, cancellation, failure, stop, and defensive timeout.
- Default `CF_CONTAINER_SLEEP_AFTER` behavior is 1-2h via a named default constant and remains env-configurable.
- Normal idle sleep is distinguishable from crash and explicit stop in code, storage, logs, and D1 updates.
- Follow-up requests to a sleeping container get a distinct sleeping response, not the old terminal "start a new instant session" crash path.
- Phase 3 wake/rehydrate remains out of scope and is referenced in the sleeping-state code comment.
- Tests cover active keepalive, cleanup, idle lifecycle classification, and prompt-after-idle behavior.

## References

- SAM idea: `01KX4KSXEXQMP41KS34TW9EN01`
- Task: `01KX6JHK01SX696C7BJ2R6FZA9`
- Rule: `.claude/rules/42-no-untracked-degrading-placeholders.md`
- Key files: `apps/api/src/durable-objects/vm-agent-container.ts`, `apps/api/src/services/vm-agent-container.ts`, `apps/api/src/services/node-agent.ts`, `apps/api/src/services/instant-session.ts`, `apps/api/tests/unit/cf-container-runtime-contract.test.ts`
