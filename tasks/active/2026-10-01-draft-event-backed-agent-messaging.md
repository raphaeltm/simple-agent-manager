# Draft: event-backed agent messaging and coordination guidance

**Status:** active (preliminary DRAFT PR — must stay draft and unmerged)
**SAM task:** 01M3WPVNYF2JX9CT94W7NV6BTS
**Branch:** `sam/create-preliminary-draft-pr-nv6bts`
**Design source:** SAM Idea 01M3WAGPW113X8VYMHACWHY6KJ (incl. adoption/feature-coordination addendum)
**Evidence:** SAM Idea 01M3128W1NWW0SYH54K4Q27F1A

## Delivery boundary (overrides /do Phases 6–7)

- Open a DRAFT PR; never mark ready, never merge.
- No staging or production deploy, no live activation. Staging/live validation is explicitly
  deferred for this preliminary draft.
- This task file lives on the output branch only (pushing to `main` auto-deploys production).
- No SAM subtask dispatch; local subagents only for review.
- Unfinished behavior ships disabled (`AGENT_MESSAGE_CHANNELS_ENABLED` defaults off).

## Problem

Ordinary agent-to-agent messages (`send_durable_message` notify/deliver,
`send_message_to_subtask`) inject the sender's raw text into the recipient's prompt as a
user-role turn. If the sender does not introduce itself, the recipient model can mistake
agent text for human input. SAM already records sender provenance, but the model-visible
prompt does not carry it. Separately, agents rarely use eventing in ordinary work (user
observation, not a measured audit): there is no guidance at the point of work for PR-event
waiting or shared feature coordination channels, and dispatch has no way to hand a
coordination channel to descendants.

## Research findings (current `main`, 5fafaee6f)

1. **Messaging paths.** `send_durable_message` (`routes/mcp/mailbox-tools.ts`) and
   `send_message_to_subtask` (`routes/mcp/orchestration-comms.ts`) both resolve a same-project
   active target, then either accept into the durable prompt queue
   (`acceptPromptDelivery`, raw `deliveryContent = message` for ordinary classes) or POST the
   raw text to the VM agent. Urgent classes (`interrupt`+) already wrap content with
   `composeUrgentDeliveryContent` (`services/urgent-delivery-content.ts`): header, sender task,
   fenced untrusted directive — so urgent delivery already distinguishes agent from human.
2. **Channels exist and are canonical.** `publish_channel_event` / `follow_event_channel` /
   `get_channel_history` / `catch_up_event_channel` (`routes/mcp/project-event-channel-tools.ts`,
   `durable-objects/project-data/project-event-channels-*.ts`) store events in
   `project_events` with server-derived `metadata.actor`, retained-event idempotency
   (`deliveryKey` = sha256 of project/user/chat/channel/key), strict fanout and a per-project
   publish rate. `follow` can only subscribe the caller (owner = `${projectId}:${chatSessionId}`).
3. **Wake path.** Matches on prompt-delivery subscriptions materialize into a SAM-authored,
   IDs-only wake prompt (`project-events-materialization.ts::buildWakePromptInput`,
   `senderType: 'system'`, `payloadPolicy: 'ids_only'`). Wake candidates require
   `owner_type='agent'`, `owner_chat_session_id = target_session_id`, an `owner_task_id`
   source guard, and a target chat in `active|sleeping`. Recipient reads with `get_event`,
   acks with `ack_event_delivery(deliveryId = wake batch id)`.
4. **No self-echo suppression.** `createMatchesForEvent` and `catchUpChannel` match a
   publisher's own prompt-delivery subscription to its own channel event, so a publisher
   that follows a channel with `existing_session_prompt` wakes itself.
5. **Bounds that shape the design.** Channel message cap 4096 bytes
   (`DEFAULT_PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES`) vs. agent message cap 32768 chars;
   128 channels per project (`DEFAULT_PROJECT_EVENT_CHANNEL_MAX_CHANNELS`) shared by every
   channel; 200 active subscriptions per project; 50 wakes and 24h delivery lifetime per
   prompt subscription; 30s subscription/target wake cooldowns batch bursts.
6. **Chat session IDs are UUIDs**, so `agent-dm.<a>.<b>` would exceed the 64-byte channel
   name cap: the pair channel name must be a hash of the unordered pair.
7. **Event metadata limits** (8192 bytes, depth 4) bound message + caller metadata together.
8. **Wake/eventing evidence.** 2026-09-21 verified a PR `issue_comment.created` waking an
   *idle, live* chat (Idea 01M3128W1NWW0SYH54K4Q27F1A). Not verified: sleeping-session
   restoration, CI/review families, other delivery modes. New read-only evidence
   (2026-10-01, production Workers Logs, last 72h, newest 500
   `github.webhook.project_events_admitted` lines): check_run 309, workflow_run 77,
   check_suite 53, issue_comment 26, pull_request 25, push 7, pull_request_review_comment 2,
   pull_request_review 1. So CI and review producers **do admit** events; end-to-end agent
   delivery for those families remains unverified. Note `github_webhook_deliveries` (D1)
   only audits trigger-supported types (issues/issue_comment/pull_request/push), so its
   lack of CI rows is not evidence of absence.
9. **CI events are keyed by commit, not PR.** `github-project-event-producer.ts::resolveSubject`
   uses `subject {type:'commit', id: headSha}` for check_run/check_suite/workflow_run and
   `{type:'pull_request', id: number}` for PR, review and PR-comment events. A PR-number
   filter never matches CI — a guidance gap, not a delivery bug.
10. **Followers cannot follow a channel before its first publish**
    (`followChannel` → `ProjectEventNotFoundError`), so coordinators should publish a kickoff.
11. **Dispatch context propagation.** `dispatch_task` appends `references` (one level) and
    inherits `missionId` (`explicit ?? currentTask.missionId`); missions also append all
    project policies to child descriptions. Nothing carries a coordination channel.
    Task writers that must preserve an inherited value: MCP `dispatch_task`, MCP
    `retry_subtask` (`orchestration-tools.ts`), session recovery (`services/session-recovery.ts`).
12. **File-size pressure.** `dispatch-tool.ts` is 796 lines (CI hard limit 800);
    `mailbox-tools.ts` 516, `orchestration-comms.ts` 686, `instruction-tools.ts` 699.

## Scope of this draft

### Implemented slice
- Feature flag `AGENT_MESSAGE_CHANNELS_ENABLED` (default `false`). Effective only when
  `PROJECT_EVENT_WAKE_ENABLED=true` and durable prompt delivery is enabled; otherwise the
  legacy path runs and a configuration warning is logged.
- When enabled, `notify`/`deliver` messages from both tools go through one canonical
  paired-channel operation; urgent classes keep stop-and-deliver unchanged (explicit mapping).
- Canonical pair channel `agent-dm.<sha256(project, sorted chat pair)[0:40]>`; reserved prefix
  (generic `publish_channel_event` rejects it) with its own channel capacity.
- One ProjectData transaction: validate recipient chat → ensure both managed subscriptions
  (reuse, or retire-and-replace when it can no longer wake) → publish → self-echo suppressed.
- Optional `idempotencyKey` on both tools: lost-response retry replays the same event;
  changed content conflicts without mutating the original.
- Recipient sees a SAM-authored notice (not human input) with event IDs, channel, and read/reply/ack steps.
- Truthful receipts: `accepted: true, delivered: false` plus `recipient.subscriptionMatched`, `eventId`, `channel`, `sequence`; never "delivered" or "read".
- Self-echo suppression for every prompt-delivery channel subscription (record-only feeds unchanged).
- Coordination channel: `dispatch_task.coordinationChannel` (validated), inherited by
  descendants, copied by retry and session recovery, surfaced in the child description and
  `get_instructions`.
- Concise guidance: `get_instructions` eventing lines, tool descriptions, `/workflow` and `/do`
  command text, public docs.

### Remaining (documented in the PR, not implemented)
- Staging/live validation of everything above (deferred by the task boundary).
- Messaging targets that are sleeping or have no running agent session (draft keeps the
  existing target eligibility).
- Urgent classes over channels (need per-message urgency on a shared subscription).
- Messages > 4096 bytes (rejected with an actionable error when enabled).
- Sender-visible receipt progression (notified/fetched/acked) and UI attribution of notices.
- Migration/drain of in-flight legacy mailbox entries is not needed (one path per message),
  but rollout/rollback observation is.
- SAM-session (top-level SAM agent) dispatch/retry tools do not carry `coordinationChannel`.
- Following a not-yet-published channel; adoption/delivery measurement.

## Implementation checklist

### Refactor (separate commits, no behavior change)
- [x] Extract mailbox helpers from `mailbox-tools.ts` to stay well under the size limits
- [x] Extract `handleStopSubtask` from `orchestration-comms.ts`
- [x] Extract knowledge formatting helpers from `instruction-tools.ts`
- [x] Extract dispatch description building from `dispatch-tool.ts`

### Shared
- [x] Constants: reserved prefix, DM channel cap, rotation grace, flag default
- [x] Types: `SendAgentChannelMessageInput` / `SendAgentChannelMessageResult`

### ProjectData DO
- [x] Self-echo suppression helper + use in `createMatchesForEvent` and `catchUpChannel`
- [x] Reserved prefix rejected in generic publish; namespace-aware channel capacity
- [x] `agent-message-channels.ts`: pair channel name, prepare, ensure/rotate managed
      subscriptions, transactional send with replay/conflict handling
- [x] `sendAgentChannelMessage` RPC + service wrapper
- [x] Agent-message wake notice text in `buildWakePromptInput`

### API / MCP
- [x] `services/agent-message-channels.ts`: config resolution, recipient wake-authority
      precheck, DO call, receipts, safe-identifier error mapping
- [x] Route `send_durable_message` notify/deliver + `send_message_to_subtask` through it
- [x] Optional `idempotencyKey` param; tool descriptions updated
- [x] D1 migration `tasks.coordination_channel` + schema
- [x] `dispatch_task.coordinationChannel` parse/validate/inherit/persist + description section
- [x] Copy in `retry_subtask` and session recovery
- [x] `get_instructions`: eventing guidance + `task.coordinationChannel`

### Docs / guidance
- [x] `apps/www` API reference + agents guide
- [x] `.claude/commands/workflow.md`, `.claude/commands/do.md`
- [x] `apps/api/.env.example` + env reference skill

### Tests
- [x] Worker test via real MCP route: A→B creates one channel + two subscriptions, recipient
      matched, sender not matched, SAM notice materialized for recipient only
- [x] Concurrent first sends A→B and B→A: one channel, no duplicate subscriptions, each
      event matched only to the other participant
- [x] Retry with same key replays; changed content conflicts and leaves the original intact
- [x] Provenance: forged `metadata.actor` cannot shadow server actor
- [x] Authorization: cross-project target rejected; recipient without wake authority rejected
- [x] Reserved prefix rejected by generic publish
- [x] Flag off / prerequisites off → legacy path unchanged
- [x] Urgent class keeps stop-and-deliver path
- [x] Rotation when the managed subscription cannot wake; no duplicate wake after rotation
- [x] Self-echo suppression on generic prompt follow (catch-up and live); record-only unchanged
- [x] Dispatch coordination channel: validation, inheritance, retry, recovery copy, instructions
- [x] Each new guard proven discriminating (remove → test red → restore)

## Acceptance criteria (draft)

- [x] With the flag off, existing messaging behavior and tests are unchanged. (worker: "keeps the legacy raw-prompt path…"; full route/service unit suites green)
- [x] With the flag on, an existing send creates one reusable shared channel and both
      subscriptions without manual setup.
- [x] Simultaneous first sends cannot create duplicate channels/subscriptions or miss the
      first event; retries never duplicate a message.
- [x] Publishing never wakes the publisher for its own event. (G1/G2 tests)
- [x] Recipient sees a SAM-authored notice; content is retrieved via tools with verified authorship. (worker: "records the message once…")
- [x] Sender identity is token-derived; forged actor metadata and cross-project targets rejected. (G7, cross-project test)
- [x] Urgent delivery keeps its documented behavior; accepted is never reported as processed. (G9; receipts assert delivered:false)
- [x] Bounded: message bytes, DM channel cardinality, subscriptions per pair, retention. (payload-cap, G10, rotation tests; retention reuses canonical event retention)
- [x] Coordination channel reaches children and grandchildren and survives retry/recovery. (C1, C4, C5)
- [x] Guidance is concise, at entry points, and does not claim unverified families/modes work. (instruction tests pin "not verified yet" wording)
- [ ] Draft PR documents scope, architecture, before/after, implemented vs remaining,
      compatibility questions, checks, risks, and deferred staging validation.

## Notes

- Read-only production evidence only (one D1 aggregate, one Workers Logs query); no probes,
  no mutations.
- Commits: cbfb7f1cb refactor (pure moves), e8ff06808 messaging slice, bf5672943 coordination
  channel + guidance, e5ee3c2d9 worker tests, fdc73c8cd dispatch/recovery/retry/instruction
  tests, c9662c62a docs.
- Discrimination evidence (guard removed → exactly these went red, then restored):
  G1 live echo guard → 8 tests; G2 catch-up echo → 1; G3 changed-retry conflict precheck → 1;
  G4 recipient wake-authority precheck → 1; G5 reserved prefix → 1; G6 rotation wake budget → 1;
  G7 metadata nesting/precedence → 1; G8 wake prerequisite gate → 1; G9 urgent exclusion → 1;
  G10 separate DM cap → 1; C1 dispatch inheritance → 2; C2 description section → 1;
  C3 reserved prefix on dispatch → 1; C4 recovery copy → 1; C5 retry copy → 1;
  C6 task-token gate → 1; C7 effective-preview gate → 1.
- Pre-existing bug found and filed (not fixed here): SAM Idea 01M3WTZATH40CGC2JZ16201E0G —
  `list_subscription_events`/`get_event` fail with "Project event pull match claim lost
  contention" once a wake match is terminalized `recorded_not_injected` without a batch.
  Reproduced locally through the MCP route. The managed messaging path avoids it by retiring an
  exhausted subscription before publishing.
- Formatting: only files already Prettier-clean were reformatted; `index.ts`,
  `configuration.md` and `agents.md` (pre-existing format debt) got minimal hand edits.
