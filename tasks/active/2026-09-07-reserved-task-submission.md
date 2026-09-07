# Retry-safe task submission for scheduled sessions

## Parent scope

This is foundation slice D0 of `2026-09-06-eventing-delivery-scheduling-channels.md`. It feeds the same integration branch and one open, green PR. No child PR, staging mutation, merge or main push. Existing event alarm/delivery work remains owned by slice A. This bounded slice can proceed while A's runtime is unavailable because it changes the normal task creation boundary, not event matching or wake delivery.

## Concrete problem

`services/trigger-submit.ts` generates a fresh task ID on every invocation, then separately inserts a status event, creates a randomly identified ProjectData session, persists a randomly identified initial message, and starts TaskRunner. Its lost-TaskRunner-ack check is useful but cannot recover interruption after task/session creation. Calling it again for one schedule could create a second task. A one-off schedule and a standing watch must reserve immutable task/session/message identities in their own durable intent before crossing this boundary.

The current placement resolver is already canonical. `messages.persistMessage` already supports caller-provided IDs and duplicate-content conflict checks. Session creation needs an equivalent narrowly scoped internal boundary. This work must preserve all authorization, archive-routing, capacity, summary, lifecycle and task-backed-session guarantees.

## Implementation checklist

- [ ] Extract or extend a small shared task-submission boundary used by existing trigger submission and the upcoming schedule/watch callers. Accept caller-reserved task, chat session, initial-message and initial-status-event identities plus immutable source provenance. Preserve the legacy trigger wrapper's external contract and existing behavior.
- [ ] Validate the reserved identity/input contract at runtime. Store or verify a durable immutable submission fingerprint. Reusing identity with different project, user, source, prompt, profile/skill or placement intent must fail visibly before side effects. Same identity and same intent must converge after an uncertain return.
- [ ] Atomically create the D1 task plus initial status record and a submission checkpoint, using conditional writes and indexed unique identities. D1 migration 0147 is reserved if needed; B owns 0144, C1 owns 0145, C2 owns 0146. Do not renumber those migrations.
- [ ] Add retry-safe ProjectData creation of the reserved task-backed session and reserved first message using existing tables, with one local transaction and post-commit hooks gated on actual insertion. Existing message identity checks should be reused. No DO schema migration or alteration to A's event/prompt modules in this slice. Reject a conflicting, archived or terminal existing session rather than reviving or relabeling it.
- [ ] Reuse `resolveTaskStartPlacement`, skill/profile resolution and credential attribution. Do not copy placement or fallback logic. Resolve current authorization before initial admission and recheck immediately before a physical start/recovery. Never persist bearer tokens or decrypted credentials. Preserve explicitly pinned configuration and the actual accepted snapshot during retries.
- [ ] Retry the same TaskRunner identity. Distinguish confirmed not-started, confirmed started and ambiguous startup. Do not mark an already-running task failed or stop its session merely because an acknowledgement was lost. Terminal/archived tasks must not be restarted by a late replay.
- [ ] Expose bounded reconciliation of one reserved submission with typed pending, admitted, conflict and terminal outcomes. The future schedule/watch loop owns due-time indexing and retry scheduling; do not add another global sweep or queue here. Document what the caller must persist before invoking the adapter.
- [ ] Preserve triggered task lineage, conversation-mode task backing, normal capacity admission, profile/skill sharing and platform credential fallback. Keep task title and branch identity stable once accepted.
- [ ] Test real D1/ProjectData interruption after each boundary, simultaneous same-intent calls, conflicting reuse, lost startup acknowledgement, already terminal tasks, unauthorized/revoked user/profile access, and VM/container placement through the normal resolver. Assert one task, one initial status event, one chat and one initial prompt for a committed intent.
- [ ] Run existing trigger submission, trigger admission/cron, placement and session/message regressions, plus relevant lint/typecheck/file-size checks. Record which tests use real workerd and which external boundaries are substituted. Push a checkpoint before expensive checks, and serialize checks to avoid host memory pressure.

## Delivery

Return commits, the exact adapter input/result types, recovery semantics, any D1 migration/config, and test evidence. Parent will review and integrate this foundation, then wire it into the actual schedule/watch actions after slice A arrives. This slice alone does not complete scheduling or the parent task.
