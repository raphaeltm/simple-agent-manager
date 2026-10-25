# Agent-chosen wake frequency for channel and event subscriptions

SAM task: `01M5SEJSJDZKB3WC9AJEY9BYX3` · Branch: `sam/agent-subscribes-channel-choose-y9byx3`

## Problem

Raphaël (2026-10-25): "When an agent subscribes to a channel... can they choose the notification frequency?
Like 'notify me on every message' vs 'at most once every 10 min'. If not, we should do it. Messages coming in
from channels tend to disrupt the agents quite often and slow them down."

Today an agent can only choose *whether* to be woken (`record_only` vs `existing_session_prompt` /
`runtime_interrupt`), not *how often*. Wake spacing is one platform-wide value, so a busy coordination
channel can pull an agent back into a fresh turn roughly every 30 seconds.

## Research findings

- `follow_event_channel` (`apps/api/src/routes/mcp/tool-definitions-project-event-channel-tools.ts`,
  handler `project-event-channel-tools.ts`) → `followChannelForCaller`
  (`apps/api/src/services/project-event-channels.ts`) → DO `followChannel`
  (`durable-objects/project-data/project-event-channels-follow.ts`) → `createProjectEventSubscription`
  (`project-events.ts`). `create_project_event_subscription` reaches the same DO function through
  `createProjectEventSubscriptionForCaller` (`services/project-event-subscriptions.ts`). One DO create path
  serves both tools, so the new field is validated and stored once.
- Wake pipeline (`project-events-materialization.ts`): a publication creates `project_event_matches`;
  `selectWakeCandidates` picks subscriptions with `wake_due_at` set and
  `delivery_cooldown_until <= now`; `materializeCandidate` bundles up to `maxDeliveryBatchEvents` (50)
  unbatched matches into ONE prompt-queue batch, then `recordQueueCheckpoint`
  (`project-events-materialization-storage.ts`) sets
  `delivery_cooldown_until = now + PROJECT_EVENT_WAKE_SUBSCRIPTION_COOLDOWN_MS` (default 30 s).
- The alarm schedule `computeProjectEventMaterializationAlarmTime` (`project-events-scheduler.ts`) already
  reads the same per-row `delivery_cooldown_until`, so a longer per-subscription cooldown re-arms the
  alarm once, at the cooldown end (rule 47 requirements 10/12 hold; nothing is copied from another row).
- A chat holds at most one undelivered wake (`WAKE_TARGET_HAS_UNDELIVERED_WAKE_SQL`), and `deliver`-class
  wakes park behind a busy turn. So the queue-time cooldown can elapse while the first wake waits; once the
  runtime accepts it, a second wake materializes immediately. With a 10-minute interval that yields two
  wakes back-to-back after a long turn. The interval must therefore also be measured from runtime
  acceptance: `advanceProjectEventPromptAttemptCheckpoint` (`project-events-wake-delivery.ts`, called by
  `prompt-delivery-runner.ts` before `recalculateAlarm`) is the acceptance checkpoint.
- `deferWakeTarget` (`project-events-wake-targets.ts`) only ever extends `delivery_cooldown_until`, so it
  cannot shorten a long per-subscription interval. Migration 063 already ran; it does not rerun.
- Writers of `delivery_cooldown_until` (rule 44 enumeration): `recordQueueCheckpoint` (queue time),
  `deferWakeTarget` (capacity, extend-only), migration 063 (one-off clear), INSERT in
  `createProjectEventSubscription` (NULL). New: acceptance re-arm (extend-only, opted-in rows only).
- Pull reads (`list_subscription_events` → `ensurePullDeliveryBatch`) claim unbatched matches, so a woken
  agent can read everything bundled so far; nothing is dropped by a longer interval.
- The create idempotency fingerprint (`normalizeSubscriptionInput`) is `stableStringify([... ])`; the new
  value must be appended ONLY when set so replays of pre-existing subscriptions keep the same fingerprint.
- Agent DM subscriptions (`agent-message-subscriptions.ts`) are SAM-managed and never set the interval,
  so DMs keep today's behaviour.
- `ProjectEventSubscriptionRecord` is constructed by ~20 test/web fixtures; making the new field optional
  on the record avoids rippling into `apps/web` while the DO mapper always sets it.
- Docs that describe these tools/settings: `apps/www/src/content/docs/docs/reference/api.md`,
  `.../guides/agents.md`, `.../reference/configuration.md` (`PROJECT_EVENT_WAKE_SUBSCRIPTION_COOLDOWN_MS`),
  `.claude/skills/api-reference/SKILL.md`, `.claude/skills/env-reference/SKILL.md`; agent guidance in
  `dispatch-coordination-channel.ts` and `instruction-eventing-guidance.ts`.

## Design

- New optional MCP argument `minWakeIntervalSeconds` (integer ≥ 1) on `follow_event_channel` and
  `create_project_event_subscription`. Services and the DO use milliseconds (`minWakeIntervalMs`).
- Semantics: leading-edge throttle. The first event after a quiet spell wakes as today; events arriving
  within the interval are bundled into the next wake. Spacing is measured from runtime acceptance of the
  previous wake (and also applied at queue time).
- Valid only when the subscription wakes the chat (resolved `queued_for_prompt_delivery`); rejected for
  `record_only`/non-injecting modes. Upper bound: the wake subscription lifetime
  (`PROJECT_EVENT_WAKE_SUBSCRIPTION_LIFETIME_MS`, configurable). Values below the platform floor
  (`PROJECT_EVENT_WAKE_SUBSCRIPTION_COOLDOWN_MS`) are raised to it; the stored/returned value is effective.
- Storage: DO migration `069-project-event-subscription-min-wake-interval` adds nullable
  `project_event_subscriptions.min_wake_interval_ms` (NULL = platform default). Additive only.
- Default behaviour, DMs, CI waits: unchanged (column NULL → exactly today's code path).
- Changing the interval = follow/create again with a new idempotency key and cancel the old subscription.

## Implementation checklist

- [x] Shared types: `minWakeIntervalMs` on `CreateProjectEventSubscriptionInput`,
      `ProjectEventSubscriptionCreateRequest`, and (optional) `ProjectEventSubscriptionRecord`
- [x] DO migration 069 (ALTER TABLE ADD COLUMN), row schema, mapper
- [x] DO normalization: validate (positive integer ms, wake modes only, ≤ lifetime), clamp to floor,
      fingerprint only when set; INSERT the column
- [x] Queue-time cooldown uses `max(floor, minWakeIntervalMs)` in `recordQueueCheckpoint` (called by
      `materializeCandidate`)
- [x] Acceptance-time re-arm (extend-only, opted-in rows only) in `advanceProjectEventPromptAttemptCheckpoint`
- [x] Services: pass `minWakeIntervalMs` through `followChannelForCaller` and
      `createProjectEventSubscriptionForCaller`
- [x] MCP: schema + parsing (`minWakeIntervalSeconds` → ms) for both tools; tool descriptions
- [x] Agent guidance: coordination-channel section + eventing instructions mention the option
- [x] Docs: api.md, agents.md, configuration.md, api-reference skill, env-reference skill
- [x] Worker tests (real MCP tools + real scheduler/sweep loop + real acceptance checkpoint):
  - [x] channel follow with interval: wakes spaced by the interval from acceptance, events bundled
  - [x] control: no interval → today's 30 s spacing
  - [x] long busy turn: no second wake until interval after acceptance (discriminates the re-arm)
  - [x] create_project_event_subscription honours the interval
  - [x] validation: record_only rejected, above-lifetime rejected, below-floor raised, replay conflict,
        bad MCP values rejected
- [x] Prove each new guard discriminating (revert queue-time and acceptance re-arm separately)

## Implementation notes

- Queue-time spacing is computed in SQL inside `recordQueueCheckpoint`
  (`? + MAX(floor, COALESCE(min_wake_interval_ms, 0))`), so `project-events-materialization.ts`
  (677 lines) did not need to grow. Two files over the 500-line limit were split first as pure moves
  (commit 421f6ee43): subscription CRUD -> `project-events-subscriptions.ts`, subscription input
  normalization -> `project-events-subscription-normalization.ts`.
- Acceptance re-arm: `rearmMinWakeIntervalOnAcceptance` in `project-events-wake-delivery.ts`, called
  from `advanceProjectEventPromptAttemptCheckpoint` for `accepted` attempts; the prompt-delivery runner
  calls that checkpoint and then `recalculateAlarm`, so the alarm moves to the new cooldown end.
- A wake taken over by pull (`cancelQueuedWakeInboxBeforePull`) is never accepted, so only the
  queue-time spacing covers it: dedicated test.
- MCP argument shared by both tools: `apps/api/src/routes/mcp/wake-interval-param.ts`.
- Wake test helpers moved from the occupancy test to `tests/workers/helpers/event-wake-harness.ts`.
- Discrimination (each revert alone): no acceptance re-arm -> 3 red (follower interval, long turn,
  create tool); no queue-time interval -> pull-takeover test red; fingerprint always carrying the
  field -> fingerprint-format unit test red; re-arm without `min_wake_interval_ms IS NOT NULL` ->
  no-interval control red.

## Acceptance criteria

- [x] An agent can follow a channel with `minWakeIntervalSeconds: 600` and is woken at most once per
      10 minutes, measured from when it received the previous wake; messages in between arrive in one wake
- [x] Without the argument, behaviour is byte-for-byte today's (30 s floor), including DMs
- [x] Invalid combinations fail with clear errors; the subscription record shows the effective interval
- [x] Docs and agent guidance describe the option
- [x] Staging: a live agent chat follows a channel with an interval and the wake spacing is observed

## Staging verification (2026-10-25)

- Deploy Staging run 40195813398 green on `831a32eba`; vm-agent container rollout to v1359 completed
  13:34:59Z before testing (per-application containers endpoint; the list endpoint was stale).
- Playwright (token-login in the browser context): dashboard, projects, settings, project chat render at
  1280x800 and 375x667, no console errors.
- Two Instant chats in staging project Potato (`01KWHD8XS7MQ7R6KWXJYRHDVH4`):
  - follower task `01M5SNJT24Z5475ERQATK324R6` followed `wake-interval-check` with
    `minWakeIntervalSeconds: 120` → subscription `36a50141-7d7e-4f78-99b0-0699331b3bc2`,
    `minWakeIntervalMs: 120000`.
  - publisher task `01M5SNMPDQTEMCJJ48V62R2QGT` published builds 1–5 at 13:58:14, 13:58:40, 13:59:06,
    13:59:31, 13:59:57.
  - Deliveries: wake 1 queued 13:58:15.331, delivered 13:58:20.118 (build 1); wake 2 queued 14:00:20.294
    (builds 2–5 bundled) = 120.2 s after wake 1 was delivered. Two wakes total, where the old 30 s cooldown
    would have produced four or five.
  - Follower transcript: "woken at 13:58:23 UTC: 1 new events: build 1"; "woken at 14:00:51 UTC: 4 new
    events: build 2, build 3, build 4, build 5".
- Cleanup: both chats stopped, workspaces deleted.

## References

- `.claude/rules/47` (alarm schedule from the same per-row record), `.claude/rules/62` (real triggers),
  `.claude/rules/44` (enumerate writers), `apps/api/.claude/rules/31` (additive DO migration)
- Prior wake-occupancy fix: PR #2292, `tests/workers/project-event-wake-target-occupancy.test.ts`
