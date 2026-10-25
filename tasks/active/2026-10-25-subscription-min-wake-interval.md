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

- [ ] Shared types: `minWakeIntervalMs` on `CreateProjectEventSubscriptionInput`,
      `ProjectEventSubscriptionCreateRequest`, and (optional) `ProjectEventSubscriptionRecord`
- [ ] DO migration 069 (ALTER TABLE ADD COLUMN), row schema, mapper
- [ ] DO normalization: validate (positive integer ms, wake modes only, ≤ lifetime), clamp to floor,
      fingerprint only when set; INSERT the column
- [ ] Queue-time cooldown uses `max(floor, minWakeIntervalMs)` in `materializeCandidate`
- [ ] Acceptance-time re-arm (extend-only, opted-in rows only) in `advanceProjectEventPromptAttemptCheckpoint`
- [ ] Services: pass `minWakeIntervalMs` through `followChannelForCaller` and
      `createProjectEventSubscriptionForCaller`
- [ ] MCP: schema + parsing (`minWakeIntervalSeconds` → ms) for both tools; tool descriptions
- [ ] Agent guidance: coordination-channel section + eventing instructions mention the option
- [ ] Docs: api.md, agents.md, configuration.md, api-reference skill, env-reference skill
- [ ] Worker tests (real MCP tools + real scheduler/sweep loop + real acceptance checkpoint):
  - [ ] channel follow with interval: wakes spaced by the interval from acceptance, events bundled
  - [ ] control: no interval → today's 30 s spacing
  - [ ] long busy turn: no second wake until interval after acceptance (discriminates the re-arm)
  - [ ] create_project_event_subscription honours the interval
  - [ ] validation: record_only rejected, above-lifetime rejected, below-floor raised, replay conflict,
        bad MCP values rejected
- [ ] Prove each new guard discriminating (revert queue-time and acceptance re-arm separately)

## Acceptance criteria

- [ ] An agent can follow a channel with `minWakeIntervalSeconds: 600` and is woken at most once per
      10 minutes, measured from when it received the previous wake; messages in between arrive in one wake
- [ ] Without the argument, behaviour is byte-for-byte today's (30 s floor), including DMs
- [ ] Invalid combinations fail with clear errors; the subscription record shows the effective interval
- [ ] Docs and agent guidance describe the option
- [ ] Staging: a live agent chat follows a channel with an interval and the wake spacing is observed

## References

- `.claude/rules/47` (alarm schedule from the same per-row record), `.claude/rules/62` (real triggers),
  `.claude/rules/44` (enumerate writers), `apps/api/.claude/rules/31` (additive DO migration)
- Prior wake-occupancy fix: PR #2292, `tests/workers/project-event-wake-target-occupancy.test.ts`
