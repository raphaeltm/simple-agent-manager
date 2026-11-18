# Provider-limit holds expire the person's queued message and file "Couldn't wake"

SAM task `01M7MZJJWKJYV88BSMQEGJPBXB`, idea `01M7MMRHF3VZRKREC2XBMSC7HF`. Related (not duplicated):
idea `01M7JC0VW2GHT3JEM1P0WE064P` (stuck-queued watchdog, shipped #2815), idea
`01M7K6XPFHT4G7HPCGZBB1Z9ZK` (parent cannot stop a parked child, out of scope).

## Problem

A chat whose task is held by an AI-provider usage limit (`tasks.provider_limit_wait_json`,
phase `waiting`, reset days away) is asleep. When the person writes to it:

1. The durable delivery wakes it (`resolveVmPromptDeliveryTarget` -> `ensureSessionRecovery`),
   the TaskRunner holds the wake at provider-limit admission (`holdTaskForProviderLimit`), and the
   delivery keeps retrying "Session is waking" (`retry`/`not_ready`, max backoff 5 min).
2. After the delivery TTL (`DEFAULT_PROMPT_DELIVERY_TTL_MS`, 1 h) `expireDuePromptDeliveries()`
   expires the person's message and `processPromptDeliveryAlarm()` calls
   `raiseSessionWakeFailure()` (`ttl_expired`), filing a "Couldn't wake …" inbox item.
3. When the limit resets, the wake proceeds but the message is gone (the provider continuation
   prompt explicitly does not replay prior prompts).

`syncProviderLimitAttention()` only closes wake errors for phase `blocked`, and is not called for
`waiting` holds at all. `session_wake_stalled` reports these held wakes as "waking for 700 min".

## Research findings

- Expiry: `packages/project-data/src/do/prompt-delivery.ts` `expireDuePromptDeliveries` /
  `listExpiringWakeDeliveries`; wake failure: `durability-foundation.ts`
  `processPromptDeliveryAlarm`.
- Retry result application: `applyPromptDeliveryResult` (retry does not spend attempts; TTL is the
  only bound). Runner: `prompt-delivery-runner.ts` `runPromptDeliveryClaim`.
- A committed wake nudges every queued delivery (`applySessionWakeReady` ->
  `nudgePromptDeliveriesForTarget`), so parking retries until the hold's retry time is safe.
- Hold record: `ProviderLimitWait` (`scheduler-core/provider-limit-policy.ts`): `nextRetryAt`,
  `deadlineAt = nextRetryAt + 30 min`; admission blocks a `waiting` hold past `deadlineAt`.
- Existing hold UI: `SessionStatusBanners.tsx` / `SessionHeaderChips.tsx` read
  `taskEmbed.providerLimitReason` from `chat-session-detail.ts`. Not filing the failure lets it show.
- Anomaly: `apps/api/src/services/fleet-ops/anomalies-sessions.ts` `stalledWakes`.
- **Goal 4 verified against production (2026-11-17):** neither cited session spent its wake
  budget because of a post-restore usage rejection. A successful restore resets
  `recovery_attempts` (`markSessionSnapshotRestored`).
  - `a4c110be…`: restored 19:02Z (first prompt rejected, task parked), slept 19:21Z. At
    20:36:26Z the parent cancelled it; three wake claims followed in 25 s (20:36:36, 20:36:46,
    20:37:00). The hold's deadline had passed, so admission blocked it and
    `presentBlockedProviderLimitWait` failed each claim; claims kept coming from delivery
    retries until `recovery_attempts = 3`. So a **blocked provider-limit hold** consumes the wake
    budget, because nothing stops a delivery from claiming a wake for a blocked task.
  - `9d7a8b42…`: three wakes failed with `UNIQUE constraint failed: workspaces.chat_session_id`
    (14:48–16:30Z). Unrelated to provider limits; filed as backlog.
  - Also seen: a task cancelled by its parent was resurrected `cancelled -> queued` by a wake
    claim. Filed as backlog (adjacent to idea `01M7K6XPFHT4G7HPCGZBB1Z9ZK`).

## Throughput / bounds (rule 81)

- Before: one adapter round trip per delivery per ≤5 min until a 1 h TTL.
- After, while held: a delivery to a held chat makes one adapter call, then is parked until the
  hold's `nextRetryAt` (or, for a blocked hold, until its own expiry). Expiry for a person's
  message moves to `max(current, nextRetryAt + ttl)`; holds are bounded by
  `PROVIDER_LIMIT_POLICY.maxResetDelayMs` (8 days), so the worst-case residence is 8 days + 1 h.
  One extra D1 read per `not_ready` retry to a sleeping chat; one per expiring chat.

## Implementation checklist

- [x] `provider-limit-delivery-hold.ts` (project-data DO): read the live task's hold for a chat
      (one D1 read, with the snapshot's expiry); for an active `waiting` hold extend human
      deliveries' expiry to `max(deadlineAt, nextRetryAt + ttl)` and park every active delivery
      until `nextRetryAt`; for a `blocked` hold (or a waiting one past its deadline) keep human
      deliveries until the snapshot expires (capped at `maxResetDelayMs`) and park each to its own
      expiry; close an open wake-error ask as superseded. Fenced on chat status and wake-readiness
      fence across the awaited read (VM and Instant wakes).
- [x] Runner: after an applied `retry`/`not_ready` result, apply the hold (never throws).
- [x] Accept: a person's new message to a sleeping chat applies the hold (only the lane head is
      ever claimed, so a later message would otherwise keep its ordinary TTL) — review finding.
- [x] Expiry: skip `raiseSessionWakeFailure` for `ttl_expired` when the chat's task is in a
      provider-limit hold; lookup failure still files (fail visible).
- [x] `ensureSessionRecovery`: refuse (`provider_limit_blocked`, retry-class, no claim) while the
      chat's live task holds a `blocked` wait. Per caller: delivery target (x2) -> retry, parked;
      inbox `wakeChat` -> conflict naming the reason; owner Resume -> writes `released` first,
      unaffected; eviction recovery -> exempt (one claim per eviction; admission's block returns
      the evicted task to a resumable sleep).
- [x] `stalledWakes`: exclude wakes whose recovery task is in an active `waiting` hold (until the
      hold's `deadlineAt`).
- [x] Docs: `session-troubleshooting.md`, `admin-settings.md`.
- [x] Backlog tasks for the two unrelated findings above.

## Acceptance criteria

- [x] A hold longer than the delivery TTL keeps the person's message (real callback park, real
      sleep sweep, real delivery alarm past TTL) and files no wake error; the message is retried
      at the hold's retry time and released at once by a committed wake.
- [x] A second message queued behind a parked one is kept too.
- [x] Control: an ordinary stalled wake (no hold) still expires and files one wake error.
- [x] A non-human delivery expiring during a hold keeps its own deadline and files no wake error.
- [x] A blocked hold keeps the message until the snapshot expires and does not claim a wake
      (real `ensureSessionRecovery`, budget unchanged); controls: waiting/released/terminal claim.
- [x] `session_wake_stalled` omits an in-deadline `waiting` hold and still reports a stalled
      wake without one, a hold past its deadline, and a blocked hold.
- [ ] Staging: verified end to end.

## Discrimination (each guard removed once)

| Guard removed               | Tests that went red                                                |
| --------------------------- | ------------------------------------------------------------------ |
| Accept-time hold            | 5 of 6 integration hold tests                                      |
| Runner hold                 | "later message queued behind a parked one", blocked-hold test      |
| `sender_type = 'human'`     | non-human delivery test                                            |
| Expiry suppression          | non-human delivery test                                            |
| Blocked keep-until-snapshot | blocked-hold test                                                  |
| Pre-claim refusal           | blocked-hold test (real wake starts the runner); unit refusal test |
| Readiness fence             | Instant race unit test                                             |
| Wake-state re-check         | VM and Instant race unit tests                                     |
| Anomaly predicate           | anomaly hold test                                                  |
