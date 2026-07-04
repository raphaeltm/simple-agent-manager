# Harness Session Handoff Artifact

## Problem

The native Go harness ends sessions with a transcript and optional session-store state, but does not emit the SAM platform `HandoffPacket` shape. Downstream agents and platform code need a structured handoff containing a summary, facts, open questions, artifact references, and suggested actions.

## Research Findings

- Canonical platform shape is in `packages/shared/src/types/mission.ts` on `origin/main`: `HandoffPacket` includes `id`, `missionId`, `fromTaskId`, `toTaskId`, `summary`, `facts`, `openQuestions`, `artifactRefs`, `suggestedActions`, `version`, and `createdAt`.
- Harness terminal states are produced in `packages/harness/agent/loop.go` as `complete`, `max_turns`, `cancelled`, and `error`.
- The LLM abstraction is `packages/harness/llm.Provider`, which is mock-testable.
- The transcript records tool calls and results; successful `write_file`, `edit_file`, and `apply_diff` calls can be used to derive mechanical file artifact references without widening tool APIs.
- CLI transcript writing happens after `agent.Run` in `packages/harness/cmd/harness/main.go`, so handoff generation should happen in the loop while persistence can happen on the CLI exit path.
- Design reference `.library/harness-engineering-course-integration-opportunities.md` recommends targeting the existing platform handoff shape rather than inventing a parallel one.

## Checklist

- [x] Add `packages/harness/handoff` with platform-shaped Go structs and JSON field names.
- [x] Add single-call LLM generation that parses structured JSON defensively.
- [x] Add mechanical fallback for LLM failure or malformed JSON.
- [x] Add mechanical artifact refs for transcript path, modified files, and git branch.
- [x] Hook terminal session exit in `agent/loop.go` with minimal footprint.
- [x] Persist handoff JSON on CLI exit path and print its location.
- [x] Add mock-provider tests for happy path, LLM failure, malformed JSON, and terminal statuses.
- [x] Fix ACP mock-provider streaming suppression exposed by the full Go test gate.
- [x] Run Go tests for `packages/harness`.

## Acceptance Criteria

- Session end can produce a JSON handoff packet with platform-compatible field names.
- Handoff generation never changes the session exit status.
- Failed or malformed LLM handoff calls degrade to mechanical fallback.
- CLI prints the written handoff artifact path.
- PR targets `harness/develop` and remains open for orchestrator review.
