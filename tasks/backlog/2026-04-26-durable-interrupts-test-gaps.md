# Durable Interrupts Phase 1 — Test Coverage Gaps

## Problem

The task-completion-validator identified 4 test gaps in the durable messaging layer (PR #818). All core functionality is implemented and working, but these specific behavioral paths lack automated test coverage.

## Context

Discovered during Phase 5 review of the durable-interrupts-phase1 task. The validator completed after the PR was merged. All findings are test gaps — no functional bugs.

## Checklist

- [ ] G3: Integration test for unacked message re-delivery after timeout — enqueue a durable message, mark delivered, manipulate `last_delivery_at` to past timestamp, call `runDeliverySweep()`, assert message returns to `queued` state
- [ ] G5: Backwards compatibility test for `send_message_to_subtask` new queuing behavior — update `mcp-orchestration-comms.test.ts` with a test where workspace mock includes `chatSessionId`, assert 409-on-busy returns `{ queued: true, messageId: ..., delivered: false, reason: 'agent_busy' }`
- [ ] G6: Cross-boundary capability test (Worker → DO → VM agent mock) — test `handleSendDurableMessage()` end-to-end with mocked D1, project-data service, and `sendPromptToAgentOnNode`, assert all three called with correct payloads
- [ ] G4: shutdown_with_final_prompt termination test — blocked on Phase 2 implementation of session termination; defer until Phase 2

## Acceptance Criteria

- [ ] G3, G5, G6 tests added and passing
- [ ] G4 deferred with explicit Phase 2 dependency noted
- [ ] All tests in `pnpm test` pass after additions

## References

- PR #818: https://github.com/raphaeltm/simple-agent-manager/pull/818
- Task completion validator output: Phase 5 review findings
- Rule 10 (capability tests): `.claude/rules/10-e2e-verification.md`
