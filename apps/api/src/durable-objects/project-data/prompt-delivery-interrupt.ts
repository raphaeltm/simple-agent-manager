/**
 * Stop-and-deliver for urgent durable messages (idea 01M2EPH9WGDYFDQBZCP9QY1FDE,
 * phase 1).
 *
 * When an `interrupt`-or-above message is claimed for a target whose VM just
 * rejected the submit because a prompt turn is in flight, the runner invokes
 * this module through the adapter's `onBusyTurn` hook: it cancels the busy turn
 * through the same transport the user stop button uses, records the turn end
 * from the control plane (so a lost VM `idle` report cannot wedge the stop
 * button, delivery, and idle scheduling together — .claude/rules/57), and lets
 * the turn-end fan-out release the queued delivery so it becomes the agent's
 * very next prompt.
 */
import type { SqlStorage } from '@cloudflare/workers-types';

import { createModuleLogger } from '../../lib/logger';
import { cancelAgentSessionOnNode } from '../../services/node-agent';
import type { VmPromptDeliveryTarget } from '../../services/vm-prompt-delivery-adapter';
import * as activity from './activity';
import type { PromptDeliveryClaim } from './prompt-delivery';
import { publishTurnEnd } from './session-activity-reconciliation';
import * as sessionState from './session-state';
import type { Env } from './types';

const log = createModuleLogger('project_data.prompt_delivery_interrupt');

/** Session-activity fan-out surface the interrupt path needs. */
export interface PromptDeliveryInterruptHooks {
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void;
  nudgeDeliveries: (chatSessionId: string) => number;
  armIdleCleanup: (chatSessionId: string) => void;
  recalculateAlarm: () => Promise<void>;
}

/**
 * What the stop attempt actually accomplished. The runner uses this after
 * parking the urgent delivery in `retry_wait`: when a stop signal reached the
 * VM (or the busy turn had already ended), the parked delivery is re-nudged so
 * it is due immediately and — thanks to the claim engine's urgency ordering —
 * ahead of any sibling the turn-end nudge released. A transport failure keeps
 * the ordinary backoff so a broken node cannot be hot-looped.
 */
export type UrgentBusyTurnStopOutcome = 'stopped' | 'already_idle' | 'skipped';

/**
 * Cancel the target's in-flight turn so the urgent delivery behind it can
 * proceed. Best-effort by design: the delivery is already durably queued, so
 * any failure here only degrades to today's behaviour (parked in `retry_wait`
 * until the turn ends naturally) — it must never fail the delivery attempt
 * itself.
 */
export async function stopBusyTurnForUrgentDelivery(
  sql: SqlStorage,
  env: Env,
  hooks: PromptDeliveryInterruptHooks,
  claim: PromptDeliveryClaim,
  target: VmPromptDeliveryTarget,
  options: { requestTimeoutMs?: number } = {}
): Promise<UrgentBusyTurnStopOutcome> {
  // Capture the observation instant BEFORE the slow VM call, so a prompt that
  // starts while the cancel is in flight is never terminalized by this cancel's
  // own result (.claude/rules/49 — same contract as routes/chat-cancel.ts).
  const observedAt = Date.now();

  let stopSignalReachedVm = false;
  try {
    const result = await cancelAgentSessionOnNode(
      target.nodeId,
      target.workspaceId,
      target.agentSessionId,
      env as unknown as import('../../env').Env,
      target.userId,
      // Background tier: this runs inside the DO alarm's waitUntil context, so
      // a hung node must not hold it for the interactive 30s default.
      options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}
    );
    if (result.success) {
      stopSignalReachedVm = true;
    } else if (result.status === 409) {
      // The turn ended between the rejected submit and the cancel. Nothing left
      // to stop, but the stop-button flow still records the turn end on 409 so
      // a lost VM `idle` report cannot leave a stale `prompting` mirror
      // (.claude/rules/57) — do the same repair below.
    } else {
      log.warn('prompt_delivery.urgent_turn_cancel_failed', {
        deliveryId: claim.message.id,
        targetSessionId: claim.message.targetSessionId,
        agentSessionId: target.agentSessionId,
        status: result.status,
      });
      return 'skipped';
    }
  } catch (error) {
    log.warn('prompt_delivery.urgent_turn_cancel_error', {
      deliveryId: claim.message.id,
      targetSessionId: claim.message.targetSessionId,
      agentSessionId: target.agentSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'skipped';
  }

  // The VM finishes a cancelled prompt as `cancelled`; reuse that terminal
  // reason rather than inventing an `interrupted` one so every consumer of
  // activity_reason keeps a closed vocabulary. Provenance of THIS path stays
  // diagnosable through the activity event recorded below.
  const changed = sessionState.recordTurnEnd(sql, target.agentSessionId, {
    reason: 'cancelled',
    source: 'control_plane',
    observedAt,
    guard: 'turn_start',
  });
  if (!changed) {
    // A newer turn already started (or the row was never/idle-working) — the CAS
    // refused the stomp, which is exactly the guard's job. When a newer turn is
    // in flight the delivery still wants a fast retry so it can stop THAT turn.
    log.info('prompt_delivery.urgent_turn_end_cas_refused', {
      deliveryId: claim.message.id,
      targetSessionId: claim.message.targetSessionId,
      agentSessionId: target.agentSessionId,
    });
    return stopSignalReachedVm ? 'stopped' : 'already_idle';
  }

  if (stopSignalReachedVm) {
    activity.recordActivityEventInternal(
      sql,
      'prompt_delivery.turn_interrupted',
      'system',
      null,
      target.workspaceId,
      claim.message.targetSessionId,
      claim.message.sourceTaskId,
      JSON.stringify({
        deliveryId: claim.message.id,
        messageClass: claim.message.messageClass,
        targetAgentSessionId: target.agentSessionId,
        observedAt,
      })
    );
  }

  const chatSessionId = sessionState.resolveActivityChatSessionId(sql, target.agentSessionId);
  // The TURN ended; the session lives on and will receive the urgent delivery
  // as its next prompt, so it still wants an idle timer.
  await publishTurnEnd(hooks, chatSessionId, { kind: 'idle' });
  return stopSignalReachedVm ? 'stopped' : 'already_idle';
}
