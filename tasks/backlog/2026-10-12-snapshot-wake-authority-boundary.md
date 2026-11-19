# Revalidate snapshot wake authority at the ProjectData mutation boundary

Found during T1 OOM eviction security review; independent of the new stopped-repair RPC. Do not mutate protected historical chats as part of investigation.

## Evidence and scope
`services/project-data.ts:wakeSessionForSnapshotRecovery` reads the exact D1 wake claim, then awaits ProjectData lookup and a separate wake RPC. `project-data/sessions.ts:wakeSession` does not compare its task argument. A replacement-task/claim change between proof and RPC could leave the proof stale. This is source-review evidence; no production incident or live reproduction established.

T1 closes ordinary/manual/internal stopped revival with synchronous eviction-stop eligibility and moves repair authority validation inside the DO concurrency gate. The broader preexisting wake protocol remains separate because D1 and DO have no shared transaction.

## Acceptance
- Exercise a genuine claimed snapshot wake with claim/task/attempt revocation at the read-to-RPC boundary.
- Validate authority as close as possible to the DO mutation, including exact task identity, without rejecting valid legacy sleeping-session handoffs.
- Preserve ordinary stop intent and refuse unattributed historical stopped sessions.
- Document the remaining distributed transaction boundary and use existing claim ownership fences; no generic stopped resurrection or production backdoor.
