# Harness Feature Gate

## Problem

The native Go harness currently treats model silence as successful completion. For opt-in feature-list sessions, the harness must own progress state, validate feature transitions through internal tools, persist state across resume, and prevent successful termination until declared features are done.

## Constraints

- Base branch: `origin/harness/develop`.
- Output branch: `sam/implement-feature-list-state-01kwph`.
- PR target: `harness/develop`.
- Do not deploy to staging for this harness-only Go change.
- Do not self-merge; leave the PR open for orchestrator review.
- Preserve no-feature-list behavior for existing evals.

## Research Findings

- `packages/harness/agent/loop.go` currently returns `StopReason: "complete"` when the model returns no tool calls and `StopReason: "max_turns"` when the loop budget is exhausted.
- Tool exposure is centralized through `tools.Registry`; internal feature tools can be registered with the same interface.
- `session.Store` persists sessions/messages/status in SQLite and can be extended with feature JSON state.
- The CLI creates the registry in `cmd/harness/main.go` and prints only turn count, stop reason, and final message today.
- The library reference recommends harness-owned feature triples and a bounded termination gate that injects missing-evidence feedback when the model tries to stop early.

## Implementation Checklist

- [x] Add `features` package with feature records, list/state validation, JSON loading, transition methods, terminal summaries, and internal tools.
- [x] Extend `session.Store` to persist and reload feature state.
- [x] Add opt-in feature-list config to `agent.Config`, register internal tools, nudge when the model stops early, and terminate incomplete on exhausted nudges or max turns.
- [x] Add CLI flags for `--features` and `--feature-max-nudges`; print terminal status and unfinished features.
- [x] Add Go tests for early stop nudging, successful evidence completion, missing-evidence rejection, WIP enforcement, max-turn incomplete, no-feature regression, and session persistence.
- [x] Run Go test suite and mock harness eval suite.
- [x] Run specialist validation for Go/test/constitution/task completion concerns.
- [ ] Rebase on `origin/harness/develop`, push branch, open PR targeting `harness/develop`.

## Acceptance Criteria

- Feature-list mode is opt-in and no-feature sessions behave as before.
- Only one feature can be in progress at a time.
- `feature_complete` requires evidence coverage for every verification entry.
- Feature state is persisted in the session store and restored on resume.
- The loop reports `complete` only when every feature is done.
- Early stop and max-turn exhaustion report `incomplete` with unfinished features.
- Terminal status and unfinished features are visible in transcript/session output and CLI output.
