# Harden ACP Client Hooks

## Problem

A CTO-level spot check of the ACP client hooks slice (`packages/acp-client/src/hooks` and focused hook tests under `packages/acp-client/tests/unit/hooks`) found that it does not meet the quality bar for a user-facing agent conversation surface.

The package currently has a large amount of test coverage, but the hook slice has avoidable maintainability and correctness risks:

- `useAcpSession.ts` is an 826-line state machine that mixes WebSocket connection lifecycle, reconnection backoff, replay restoration, server status mapping, error normalization, visibility recovery, online/offline recovery, and user-triggered restart behavior.
- `useAcpMessages.ts` is a 589-line parser/state reducer that accepts loosely shaped ACP payloads through broad casts instead of isolating runtime validation at the boundary.
- `useAcpMessages.ts` still emits lint warnings for forbidden non-null assertions, and the hook files have formatting drift that should not survive review in a high-quality package.
- `useAudioPlayback.ts` is 451 lines of user-facing audio control behavior with no focused hook tests, despite coordinating fetch, AbortController, blob URL lifetime, HTMLAudioElement, browser speech synthesis fallback, playback rate, seek/skip, and error state.
- `usePrefersReducedMotion.ts` has no direct coverage even though it affects animation behavior and is reused by streaming/fade hooks.

Passing typecheck and unit tests is not enough when the core modules are this large, this stateful, and this dependent on external browser APIs.

## Research Findings

- Baseline checks:
  - `pnpm --filter @simple-agent-manager/acp-client typecheck` passes.
  - `pnpm --filter @simple-agent-manager/acp-client test` passes with 23 test files and 432 tests.
  - `pnpm --filter @simple-agent-manager/acp-client lint` exits 0 but reports 22 warnings across the package, including 6 forbidden non-null assertions in `useAcpMessages.ts`.
- Focused hook file sizes:
  - `useAcpSession.ts`: 826 lines.
  - `useAcpMessages.ts`: 589 lines.
  - `useAudioPlayback.ts`: 451 lines.
  - `useAutoScroll.ts`: 184 lines.
  - `useStreamingReveal.ts`: 114 lines.
  - `usePrefersReducedMotion.ts`: 21 lines.
- Focused test file sizes:
  - `useAcpSession.test.ts`: 1,261 lines.
  - `useAcpMessages.test.ts`: 790 lines.
  - `useAutoScroll.test.ts`: 627 lines.
  - `useStreamingReveal.test.ts`: 131 lines.
- Recent spot checks intentionally avoided:
  - ProjectData row schemas.
  - Trigger UI accessibility.
  - Provider adapters.
  - Cloud-init validation.
  - AI Gateway usage pagination.
  - Terminal token routing.
  - Agent settings API.
- Relevant rules:
  - `.claude/rules/02-quality-gates.md`: changed behavior must have tests that prove it works; lint warnings and test adequacy matter.
  - `.claude/rules/09-task-tracking.md`: acceptance criteria need direct test or manual verification evidence.
  - `.claude/rules/14-do-workflow-persistence.md`: maintain `.do-state.md` through the `/do` workflow.

## Implementation Checklist

- [ ] Extract ACP session close-code/reconnect helpers and session-state mapping helpers out of `useAcpSession.ts` without changing its public API.
- [ ] Extract ACP message update parsing/reducer helpers out of `useAcpMessages.ts`, using runtime guard functions for supported ACP payload shapes instead of broad in-branch casts.
- [ ] Remove forbidden non-null assertions and formatting drift from the hook slice.
- [ ] Add focused behavioral tests for `useAudioPlayback` covering server TTS success, cached replay, abort/stop cleanup, server failure fallback to browser speech synthesis, playback rate, seek, skip, and cleanup on unmount.
- [ ] Add direct tests for `usePrefersReducedMotion` covering no `matchMedia`, initial match state, and media-query change events.
- [ ] Keep exported hook APIs stable.
- [ ] Run `pnpm --filter @simple-agent-manager/acp-client lint`.
- [ ] Run `pnpm --filter @simple-agent-manager/acp-client typecheck`.
- [ ] Run `pnpm --filter @simple-agent-manager/acp-client test`.

## Acceptance Criteria

- `useAcpSession.ts` and `useAcpMessages.ts` are smaller, easier to audit, and delegate parsing/state-machine helpers to focused modules.
- Supported ACP update payloads are checked at the boundary with small runtime guard helpers; broad casts inside the main message-processing switch are removed or sharply reduced.
- The hook slice has no lint warnings attributable to changed files.
- `useAudioPlayback` has behavioral tests for success, failure/fallback, controls, and cleanup.
- `usePrefersReducedMotion` has direct behavioral coverage.
- ACP client lint, typecheck, and tests pass.
- No public ACP client hook API is broken.
