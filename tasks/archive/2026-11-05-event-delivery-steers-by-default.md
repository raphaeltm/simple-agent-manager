# Event delivery steers by default

## Problem

Live steering shipped in PR #2536 (610dec55a), but only the chat composer defaults to it.
Event wakes still queue behind a running turn unless the subscriber explicitly asks for
`runtime_steer`. Agent-to-agent messages therefore wait for the recipient's turn to end: on
2026-11-05 a peer's staging-slot request sent at 09:20:55Z reached its recipient at 10:16:28Z,
55 minutes later, because the recipient was mid-turn the whole time. Raphaël decided event
delivery should steer by default ("Build it. Ship it to prod.").

Steering changes only timing. The same SAM-authored, IDs-only wake text reaches the chat
either way, and a target with no running turn gets an ordinary wake prompt (verified below).

## Research findings

- **Delivery-mode producers** (`grep "requested: '"` in `apps/api/src`):
  - `durable-objects/project-data/agent-message-subscriptions.ts:127` (`ensureManagedSubscription`):
    managed agent-dm pair subscriptions hardcode `requested: 'existing_session_prompt'`. This is
    the only place a waking delivery mode is chosen by SAM rather than by a caller.
  - `services/workflow-waits.ts`, `sam-session/operator/work.ts` and `project-standing-watches-storage.ts`
    use `record_only` (not wakes; out of scope).
  - `create_project_event_subscription` (MCP and REST, both via
    `services/project-event-subscriptions.ts:createProjectEventSubscriptionForCaller`) requires
    `requestedDelivery`; `normalizeRequestedDelivery` (`project-event-subscriptions-access.ts:150`)
    rejects a missing value. The MCP schema lists it in `required`.
  - `follow_event_channel` defaults to `record_only`, a history feed (`services/project-event-channels.ts:92`).
    Its MCP enum offers only `record_only` / `existing_session_prompt`, although the handler accepts
    every mode (`routes/mcp/project-event-channel-tools.ts:delivery`).
- **Real wake path falls back to the queue.** `materializeSubscriptionWake`
  (`project-events-materialization.ts:293`) advertises only the `durable_prompt_queue` adapter with
  `allowPromptQueue: true`. For `runtime_steer`, `selectAdapter` finds no steer adapter, so
  `queueFallbackFor` returns `queued_for_prompt_delivery` (pending); the terminal `unauthorized`
  branch is unreachable here. `buildWakePromptInput` then sets `deliveryIntent: 'steer'`,
  `messageClass: 'deliver'`. The steer lane resolves the target without waking it
  (`vm-steer-delivery-adapter.ts`, `allowWake: false`); a sleeping chat falls back with
  `session_not_awake`, and an idle runtime with `no_running_turn`. The queue lane then delivers
  or wakes. `tests/workers/project-event-runtime-steer-wake.test.ts` covers the steered and
  handed-back paths for an explicit `runtime_steer` subscription.
- **Existing managed subscriptions** last 24h (`DEFAULT_PROJECT_EVENT_WAKE_SUBSCRIPTION_LIFETIME_MS`) and
  are reused while they can wake. Without handling, existing pairs would keep queueing for up to a day.
  `ensureManagedSubscription` already retires unusable rows, keeping a row that still owes a queued
  wake until it drains (its match keys are removed). Treating a row whose `requested_delivery` differs
  from the managed mode as not reusable reuses that machinery, so no DO migration is needed. This is
  safer than an `UPDATE`, which would change a queued batch's mode mid-flight.
- **Agent-channel wake text** uses `agentMessageWakeContent` ("SAM notice ... read with get_event"),
  not the `runtime_steer` prefix, so it reads the same whether steered or queued.
- **Guidance that recommends queueing:** `routes/mcp/instruction-eventing-guidance.ts` (CI waits),
  `routes/mcp/dispatch-coordination-channel.ts`, the `create_project_event_subscription` and
  `follow_event_channel` tool descriptions, `.claude/commands/do.md` (PR-review wait),
  `apps/www/.../guides/agents.md:744`, `reference/api.md:92,106`,
  `.claude/skills/api-reference/SKILL.md`, `.claude/skills/env-reference/SKILL.md:452` (`PROJECT_EVENT_WAKE_ENABLED`
  description omits `runtime_steer`).
- `send_durable_message` keeps `deliveryIntent: 'queue'` by default: notify/deliver messages ride the
  agent-dm channel and are covered by the managed-subscription change. Defaulting it to steer would
  bypass the channel (`mailbox-tools.ts:125`).

## Implementation checklist

- [x] `agent-message-subscriptions.ts`: one exported `AGENT_MESSAGE_REQUESTED_DELIVERY = 'runtime_steer'`
      constant used for the created subscription; a row with a different `requested_delivery` is not
      reusable (retired, or drained if it owes a queued wake).
- [x] `create_project_event_subscription`: `requestedDelivery` optional, default `runtime_steer`
      (shared `DEFAULT_PROJECT_EVENT_REQUESTED_DELIVERY` constant), in the service so MCP and REST agree;
      MCP schema no longer requires it; description says steer is the default.
- [x] `follow_event_channel`: MCP enum adds `runtime_steer`; description recommends it for waking follows
      (default stays `record_only`, a history feed).
- [x] Guidance and docs recommend `runtime_steer` for wakes: instruction-eventing-guidance, dispatch
      coordination text, `.claude/commands/do.md`, `guides/agents.md`, `reference/api.md`, api-reference
      skill, env-reference skill.
- [x] Tests:
  - [x] Workers: peer `send_durable_message` creates a `runtime_steer` managed subscription and its wake
        rides the steer lane, steered into a running turn (real MCP, materializer, delivery alarm).
  - [x] Workers: the same peer wake to an idle runtime falls back and is delivered once through the queue.
  - [x] Workers: an existing `existing_session_prompt` managed subscription is replaced on the next send;
        one owing a queued wake drains and is not cancelled.
  - [x] Workers/unit: `create_project_event_subscription` with no `requestedDelivery` stores `runtime_steer`;
        an explicit `existing_session_prompt` is still honoured.
  - [x] Update unit tests that assert the missing-requestedDelivery rejection (none existed; related unit suites pass unchanged).
  - [x] Each new guard proven discriminating (revert, see red, restore).

## Acceptance criteria

- [x] A peer agent message reaches a running Claude, Codex and OpenCode turn on a staging VM as a steer
      (`steer_outcome = steered`), without waiting for the turn to end.
- [x] A subscription created without `requestedDelivery` steers its event into a running VM turn on staging.
- [x] An idle target still receives the same wakes as an ordinary prompt (fallback, delivered once).
- [x] Existing managed pair subscriptions switch to steering on their next message without dropping a
      queued wake.
- [x] An explicit `existing_session_prompt` subscription keeps queueing.

## Implementation notes

- No DO migration: `ensureManagedSubscription` treats a row whose `requested_delivery` is not
  `AGENT_MESSAGE_REQUESTED_DELIVERY` as not reusable. It drains while it owes any wake (matched
  or queued; its match keys are removed so the replacement alone matches new messages), else it
  is retired. Using `hasPendingWake` here, not `hasQueuedWake`, keeps a matched-but-unbatched
  pre-deploy notice from being dropped.
- Self-publication suppression (`isSelfOriginatedChannelWake`) keys on `resolved =
  queued_for_prompt_delivery`, so it already covers `runtime_steer` follows; the echo test now
  includes a steering follower.
- Discrimination (Workers): managed mode reverted to queue → 4/4 red; reuse ignoring mode → the
  two rotation tests red; old drain rule (queued only) → the drain test red; service default
  removed → "steers by default" red. All restored green.
- Main is push-protected, so the task file travels on the feature branch.

## Staging evidence (2026-11-05, deploy run 42083339183, head ece33c165)

Each VM target chat created `create_project_event_subscription` on `feature.evsteer-<tag>` with no
`requestedDelivery`, then ran six 30-second foreground steps. Once step 1 was running, a separate
Instant chat ("Claude Code Chat") called `send_durable_message` to the target task and
`publish_channel_event` on that channel. Transcript rows read back through the API:

| Agent (VM) | Peer notice | Channel event wake | Same turn |
| --- | --- | --- | --- |
| Claude Code (session 75dd7e53) | `intent=steer outcome=steered`, 18:49:57 | steered, 18:50:00 (`runtime_steer` prefix) | ran PEERSTEER, EVENTSTEER after step4, before step5 |
| Codex C2.3 (session 2031f7fd) | steered, 19:13:03 | steered, 19:13:06 | ran both after step2, before step3 |
| OpenCode sam-s1 (session 77c4a1ea) | steered, 19:04:46 | steered, 19:04:49 | ran both after step3, before step4 |

The event wake carrying the `runtime_steer` prefix shows that the subscription created without
`requestedDelivery` defaulted to `runtime_steer`. Each agent read both events with `get_event`
and acked them.

Idle target (Claude VM, after its turn ended): a third peer message became
`intent=steer outcome=queued_fallback reason=no_running_turn` and was delivered as an ordinary
prompt; the agent read it and ran IDLEWAKE.

Discarded runs: OpenCode run 1 (the sender's model refused the wording; it was softened), Codex
run 1 (queued for staging VM capacity; the runner was restarted), and Codex run 2 (the reattached
runner polled from a blank page and saw nothing).

Found and backlogged: an Instant follow-up failed to wake a sleeping sender chat
(`tasks/backlog/2026-11-05-instant-sleeping-container-cannot-wake.md`), and a transient 503 on the
task GET poll (`tasks/backlog/2026-11-05-transient-503-on-task-get.md`). Neither touches this change.

Cleanup: test nodes 01M6PG992Y…, 01M6PGHPF… and 01M6PH7AQ… and workspaces 01M6PGTE7… and
01M6PH6SQ… deleted (API 200). Staging was released to the next queued task at 19:45Z.

## References

- PR #2536 (live steering), idea 01M2EPH9WGDYFDQBZCP9QY1FDE
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/35-vertical-slice-testing.md`
- `apps/api/.claude/rules/67-shared-predicates-that-trigger-actions.md`, `44-dual-write-migration-enumerate-writers.md`
