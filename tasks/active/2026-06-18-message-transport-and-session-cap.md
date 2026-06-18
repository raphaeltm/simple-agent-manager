# Message Transport Fallback And Session Cap Visibility

## Problem

Two linked SAM issues can make a still-running agent appear stalled:

- Oversized vm-agent message batches can be rejected by the API and then permanently discarded by the reporter, causing silent data loss.
- Long-running sessions can hit the message cap and make new progress invisible while the process continues.

Human constraint for this task: open/update a draft or clearly do-not-merge PR only. Do not merge. Do not deploy to staging. Do not run staging verification.

## Research Findings

- `packages/vm-agent/internal/messagereport/config.go` sets reporter defaults, including `MSG_MAX_MESSAGE_CONTENT_BYTES`.
- `packages/vm-agent/internal/messagereport/reporter.go` owns outbox FIFO delivery, batch formation, truncation, retry classification, and delete-on-success behavior.
- `packages/vm-agent/internal/messagereport/reporter_test.go` already contains reporter tests and should cover oversize fallback behavior.
- `apps/api/src/routes/workspaces/runtime.ts` validates `/api/workspaces/:id/messages` payload bytes and individual message content size before ProjectData persistence.
- `apps/api/src/durable-objects/project-data/messages.ts` enforces `MAX_MESSAGES_PER_SESSION` and updates session message counts.
- `apps/api/src/env.ts`, `apps/api/.env.example`, `apps/api/wrangler.toml`, and worker test config contain session/message limit defaults.
- Relevant rules: `.claude/rules/14-do-workflow-persistence.md`, `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/03-constitution.md`, `.claude/rules/11-fail-fast-patterns.md`, `.claude/rules/06-vm-agent-patterns.md`.

## Implementation Checklist

- [ ] Create implementation branch/worktree from `main` and move this task to `tasks/active/`.
- [ ] Align vm-agent reporter message size defaults with the API individual-message default.
- [ ] Measure marshaled JSON payload bytes for batches, including `toolMetadata`.
- [ ] Add reporter fallback for size-related 400 responses: split/retry safely, then send compact marker if necessary.
- [ ] Ensure oversized rows do not silently disappear or indefinitely block FIFO delivery.
- [ ] Add vm-agent tests for oversized assistant content, oversized tool metadata, JSON overhead, payload-limit 400 retry/fallback, individual-message threshold, and persisted marker behavior.
- [ ] Raise `MAX_MESSAGES_PER_SESSION` default from `10000` to `100000` while preserving env configurability.
- [ ] Change ProjectData batch persistence to persist up to remaining capacity and report cap exhaustion explicitly.
- [ ] Translate exhausted session capacity in `/api/workspaces/:id/messages` to a structured non-success response and observable signal.
- [ ] Add API/worker tests for 99,999 messages, exactly 100,000, partial batch crossing cap, batch after full cap, and route-level 409 behavior.
- [ ] Update env examples/config/docs/tests that encode the old default.
- [ ] Run relevant local tests and quality checks.
- [ ] Run required specialist reviews, address findings, then create a draft/do-not-merge PR.

## Acceptance Criteria

- Oversized messages produce a persisted compact marker or safely truncated message, never invisible silent loss.
- Message reporter does not permanently discard size-related 400 responses before attempting safe fallback.
- Default session message capacity is 100,000 and remains configurable.
- Session-cap exhaustion is visible and structured, not a successful `persisted: 0` no-op.
- Local relevant tests pass.
- PR is left draft or clearly marked do-not-merge, with no merge, no staging deploy, and no staging verification.

## References

- Ideas: `01KTP4THST9V75RAPBAE4HZFWT`, `01KVDK3HWY8PXRJQAY8P3NB385`
- Affected task: `01KVD87ZNME6HSFE54F688DPY3`
- Affected session: `7d307342-f421-419b-9aec-7da5760e4344`
- Debug package: `/workspaces/.private/debug-01KVCSX2JQ0Y55N0VRF9Q4RY0V.tar.gz`
