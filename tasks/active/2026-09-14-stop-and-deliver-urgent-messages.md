# Stop-and-deliver for interrupt-class durable messages (urgent delivery phase 1)

**SAM idea:** `01M2EPH9WGDYFDQBZCP9QY1FDE` (phase 1 only)
**Related:** PR #2011 / commit `7c5d85316` (turn-end CAS guard fix), `tasks/active/2026-08-16-session-activity-state-machine.md` (activity wedge context), `.claude/rules/49`, `.claude/rules/57`, `.claude/rules/67`

## Problem

Durable messages queue in the ProjectData `session_inbox` and are only submitted when the target
agent's turn ends. When the target is mid-prompt, the delivery attempt gets a 409 `not_ready`
("Target VM is currently processing a prompt") and parks in `retry_wait` until the turn ends
naturally — which can be 10-20 minutes of committed work later. Agents repeatedly act on stale
assumptions and collide over shared resources because "I sent a durable message" never actually
interrupts the peer (see `AgentMessagingRequirements` knowledge: staging slot-claim sat 40s in
`retry_wait`; peers collided meanwhile).

The mailbox already models urgency with message classes
(`notify < deliver < interrupt < preempt_and_replan < shutdown_with_final_prompt`) and the claim
engine already prioritizes them, but nothing ever *acts* on the urgency: an `interrupt` message
waits behind the busy turn exactly like a `deliver`.

## Research findings

1. **Durable send path**: MCP `send_durable_message` (`routes/mcp/mailbox-tools.ts:91-106`) passes
   the caller's `messageClass` through `projectDataService.acceptPromptDelivery` → DO
   `acceptPromptDeliveryInTransaction` (`prompt-delivery.ts:51`) which persists a transcript user
   message (`displayContent`) and enqueues a `session_inbox` row whose `content` is the
   `deliveryContent` submitted as the prompt. `displayContent` and `deliveryContent` can differ.
2. **Claim engine**: DO alarm → `processPromptDeliveryAlarm` (`durability-foundation.ts:308`) →
   `claimDuePromptDeliveries` (priority-ordered by message class) → `runPromptDeliveryClaim`
   (`prompt-delivery-runner.ts:276`) via `ctx.waitUntil` → `DefaultVmPromptDeliveryAdapter.submit`
   → on 409 busy → `applyPromptDeliveryResult` → `retry_wait` + exponential backoff (base 5s).
   `acceptPromptDelivery` recalculates the alarm immediately after accept (min alarm delay 1s), so
   the first claim attempt happens within ~1-2s of the send.
3. **Busy signal is precise**: the adapter's versioned submit maps the VM's 409
   `not_ready`-with-receipt response to `retry: busy` (`vm-prompt-delivery-adapter.ts:296-312`) —
   it means and only means "a prompt turn is in flight on the target host". This is the exact
   stop-and-deliver trigger condition, and it comes from the authoritative source (the VM), not
   the `session_state` mirror.
4. **Cancel transport exists end-to-end**: `cancelAgentSessionOnNode`
   (`services/node-agent.ts:711`) → vm-agent `POST .../agent-sessions/:id/cancel` →
   `CancelPromptFromControlPlane` (`session_host.go:733`) cancels the prompt context, forwards
   `session/cancel`, restarts the agent process, and the host returns to ready. 409 means "no
   prompt in flight" (idempotent no-op). The user stop button uses exactly this
   (`routes/chat-cancel.ts`).
5. **Turn-end bookkeeping pattern**: `chat-cancel.ts` captures `observedAt` BEFORE the VM call
   (rule 49), cancels, then `recordSessionTurnEnd` → DO `sessionState.recordTurnEnd` (CAS with
   `turn_start` guard) → `publishTurnEnd` fan-out (`session-activity-reconciliation.ts:464`) →
   `nudgeDeliveries` releases queued deliveries + `armIdleCleanup` re-arms the idle schedule.
   The VM's own `idle` report also nudges (`durability-foundation.reportActivity`), so delivery
   converges once the host is ready again.
6. **DOs already talk to VMs**: `DefaultVmPromptDeliveryAdapter` (constructed inside the DO alarm
   path, `durability-foundation.ts:317`) calls `nodeAgentRequest`/`sendPromptToAgentOnNode` from
   DO context, so issuing the cancel from the claim runner is an established pattern.
7. **runtime_interrupt is modeled but unwired**: the delivery resolver
   (`project-events-delivery-resolver.ts:255-261`) defines the `runtime_interrupt` mode with
   capability/authorization/action, and `queueFallbackFor` (line 205) already resolves
   `runtime_interrupt` → pending `queued_for_prompt_delivery` when only the prompt-queue adapter
   is advertised (reason `queue_fallback`). What blocks it: `resolveDeliveryPreference`
   (`services/project-event-subscriptions-access.ts:157-172`) maps every non-
   `record_only`/`existing_session_prompt` mode to `recorded_not_injected` at creation, and the
   wake pipeline's SQL filters only select `requested_delivery = 'existing_session_prompt'`
   subscriptions (8 sites: materialization ×3, scheduler, wake-delivery ×2, wake-targets,
   storage-helpers). `buildWakePromptInput` hardcodes `messageClass: 'deliver'`
   (`project-events-materialization.ts:408`).
8. **No shared class-severity helper exists**: urgency ordering is duplicated as inline SQL CASE
   in `mailbox.ts:153-161` and `prompt-delivery.ts:204-214`; there is no TS comparator
   (`MessageClass` in `packages/shared/src/types/mailbox.ts`).
9. **Activity state machine is stable enough to build on**: the `activity_at` CAS bug that voided
   cancels is fixed (PR #2011, `TurnEndGuard` = `turn_start` compares
   `COALESCE(prompt_started_at, activity_at)`); `recordTurnEnd` is the single intended write path
   for every turn ending; `publishTurnEnd` fans out to all three consumers. Terminal reasons:
   `completed | cancelled | force_stopped | dead | probe_reconciled | stale_no_evidence`
   (no `interrupted` — the VM itself finishes a cancelled prompt as `cancelled`, so reuse it).

## Design

Stop-and-deliver lives in the durable claim runner, not at each accept site, so every source of an
urgent delivery (MCP `send_durable_message`, event wakes, future sources) gets the behavior
uniformly and the stop only fires on authoritative busy evidence:

```
send interrupt-class message → acceptPromptDelivery (queued, due now)
  → DO alarm (~1s) → claim → adapter.submit → 409 busy   ← authoritative "turn in flight"
  → [NEW] urgent class ⇒ onBusyTurn hook:
        observedAt = now (before VM call, rule 49)
        cancelAgentSessionOnNode(...)                     ← existing cancel transport
        success ⇒ recordTurnEnd(reason 'cancelled', guard 'turn_start')
                   + publishTurnEnd → nudgeDeliveries + armIdleCleanup
        409 ⇒ turn already ended (VM idle report nudges) ; error ⇒ warn + degrade to today's retry
  → applyPromptDeliveryResult(retry: busy) → retry_wait (5s backoff)
  → VM idle report / nudge → re-claim → submit when host ready → next turn = message payload
```

Informational classes (`notify`, `deliver`) never trigger the hook — the busy retry path is
byte-for-byte today's behavior for them.

## Implementation checklist

- [x] Shared: add `MESSAGE_CLASS_URGENCY` rank map + `isUrgentMessageClass()` to
      `packages/shared/src/types/mailbox.ts` (interrupt and above), exported through the types
      index; unit tests for the helper.
- [x] Adapter: add optional `onBusyTurn?: (target: VmPromptDeliveryTarget) => Promise<void>` to
      `VmPromptDeliveryAdapterInput`; in the 409-busy branch of `submit`, invoke it (guarded
      try/catch, log on failure) only when `isUrgentMessageClass(claim.message.messageClass)`.
- [x] Runner: new `stopBusyTurnForUrgentDelivery` helper (new module
      `prompt-delivery-interrupt.ts`) implementing the hook body: rule-49 `observedAt`,
      `cancelAgentSessionOnNode`, `sessionState.recordTurnEnd` (reason `cancelled`, source
      `control_plane`, guard `turn_start`), `resolveActivityChatSessionId`,
      `publishTurnEnd({kind:'idle'})` with session-activity hooks, and an activity event
      (`prompt_delivery.turn_interrupted`) for diagnosability.
- [x] Runner: extend `PromptDeliveryRunnerHooks` with `armIdleCleanup` + `nudgeDeliveries`; wire
      `onBusyTurn` into the adapter input for urgent claims only.
- [x] durability-foundation: extend `DurabilityFoundationHooks` with `armIdleCleanup` +
      `nudgeDeliveries`; pass through in `processPromptDeliveryAlarm`; wire in
      `index.ts durabilityHooks()` (idleCleanup.resetIdleCleanup /
      promptDelivery.nudgePromptDeliveriesForTarget); update `project-schedules.test.ts` hook
      helper.
- [x] MCP send path: for urgent classes compose `deliveryContent` with a context preamble
      (why the turn stopped + sender identity) while `displayContent` stays the raw message; new
      composer in `apps/api/src/services/urgent-delivery-content.ts` + tests.
- [x] Event wake mapping: `resolveDeliveryPreference` maps `runtime_interrupt` →
      `queued_for_prompt_delivery`; update the 8 wake-pipeline SQL predicates to
      `requested_delivery IN ('existing_session_prompt', 'runtime_interrupt')`;
      `buildWakePromptInput` uses `messageClass: 'interrupt'` + an interrupt notice in the wake
      content for `runtime_interrupt` subscriptions.
- [x] Tool schema text: `create_project_event_subscription` requestedDelivery description and
      `send_durable_message` description document stop-and-deliver semantics.
- [x] Tests: adapter busy-hook (urgent vs informational, hook failure isolation); runner
      stop-and-deliver (cancel success / 409 / error; turn-end CAS + nudge fan-out; retry state
      still applied); mailbox MCP urgent send (composed deliveryContent, raw displayContent);
      resolveDeliveryPreference runtime_interrupt mapping; materializer interrupt-class wake
      delivery.
- [x] Docs sync: grep for stale `recorded_not_injected` claims about injection modes and message
      class behavior; update api-reference skill / www docs where they describe these surfaces.

## Acceptance criteria

1. Sending a durable message with class `interrupt`, `preempt_and_replan`, or
   `shutdown_with_final_prompt` to a session that is mid-prompt results in the in-flight turn
   being cancelled via the existing cancel transport within seconds, and the message payload
   being submitted as the agent's next prompt once the host is ready.
2. The agent's next turn contains context: why its turn stopped, who sent the directive, and the
   message text (delivery content composed for urgent classes; transcript keeps the raw message).
3. `notify` and `deliver` messages NEVER stop a turn — their busy-retry behavior is unchanged.
4. The existing cancel/stop flow (user stop button, `chat-cancel.ts`) is untouched and its tests
   pass unmodified.
5. A subscription created with `requestedDelivery: 'runtime_interrupt'` resolves to
   `queued_for_prompt_delivery`, its events wake the target chat with an `interrupt`-class prompt
   delivery, and that wake stops a busy target turn the same way.
6. Full quality suite green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
7. Staging verification demonstrates the stop-and-deliver loop end-to-end (or the closest
   observable equivalent with evidence).

## Out of scope (later phases of the idea)

- `runtime_steer` / true in-harness steering adapters; `spawn_task` execution.
- Legacy (non-durable) mailbox path stop behavior — durable engine is the production path.
- Ack-time semantics changes, receipt indicator work, phase 2+ of the idea.
- Migrating `reconciliation.ts:cancelStalledPrompt` (tracked separately in backlog).

## References

- `packages/shared/src/types/mailbox.ts` — message classes, delivery states
- `apps/api/src/durable-objects/project-data/prompt-delivery.ts` — accept/claim/apply engine
- `apps/api/src/durable-objects/project-data/prompt-delivery-runner.ts` — claim execution
- `apps/api/src/services/vm-prompt-delivery-adapter.ts` — submit + busy 409 mapping
- `apps/api/src/routes/mcp/mailbox-tools.ts` — send_durable_message
- `apps/api/src/routes/chat-cancel.ts` — cancel + turn-end pattern to mirror
- `apps/api/src/services/project-event-subscriptions-access.ts` — resolveDeliveryPreference
- `apps/api/src/durable-objects/project-data/project-events-materialization.ts` — wake executor
- `apps/api/src/durable-objects/project-data/project-events-delivery-resolver.ts` — resolver
- `apps/api/src/durable-objects/project-data/session-state.ts` — recordTurnEnd / guards
