/**
 * Shared types for the durable agent mailbox system (Phase 1: Orchestrator).
 *
 * Message classes define escalating urgency levels for agent-to-agent
 * and orchestrator-to-agent communication.
 */

// ─── Message Classes (escalating urgency) ──────────────────────────────────

export const MESSAGE_CLASSES = [
  'notify',
  'deliver',
  'interrupt',
  'preempt_and_replan',
  'shutdown_with_final_prompt',
] as const;

export type MessageClass = (typeof MESSAGE_CLASSES)[number];

/** Classes that require durable storage and guaranteed delivery. */
export const DURABLE_MESSAGE_CLASSES: readonly MessageClass[] = [
  'deliver',
  'interrupt',
  'preempt_and_replan',
  'shutdown_with_final_prompt',
];

/**
 * Numeric urgency rank per message class. Mirrors the SQL CASE ordering used by
 * the delivery claim engine (`prompt-delivery.ts` / `mailbox.ts`) so TypeScript
 * callers and SQL ordering can never drift apart.
 */
export const MESSAGE_CLASS_URGENCY: Record<MessageClass, number> = {
  notify: 1,
  deliver: 2,
  interrupt: 3,
  preempt_and_replan: 4,
  shutdown_with_final_prompt: 5,
};

/**
 * The lowest urgency rank that authorizes stop-and-deliver: a message of this
 * class or above may cancel the target's in-flight turn so it is delivered as
 * the very next prompt instead of parking in `retry_wait` behind the busy turn.
 */
export const TURN_STOP_URGENCY_THRESHOLD = MESSAGE_CLASS_URGENCY.interrupt;

/** True when a message class is urgent enough to trigger stop-and-deliver. */
export function isUrgentMessageClass(messageClass: MessageClass): boolean {
  return MESSAGE_CLASS_URGENCY[messageClass] >= TURN_STOP_URGENCY_THRESHOLD;
}

// ─── Delivery Intent (separate from urgency) ───────────────────────────────

/**
 * What the sender wants done with a message to a working agent. `queue` waits for
 * the next turn. `steer` adds it to the running turn when the agent's runtime can
 * take live input, and otherwise falls back, visibly, to `queue`. Urgency
 * (`MessageClass`) is independent: stopping a turn stays the `interrupt` path,
 * and an urgent class never steers.
 */
export const PROMPT_DELIVERY_INTENTS = ['queue', 'steer'] as const;

export type PromptDeliveryIntent = (typeof PROMPT_DELIVERY_INTENTS)[number];

/** True when a message class may carry the `steer` intent. */
export function canSteerMessageClass(messageClass: MessageClass): boolean {
  return !isUrgentMessageClass(messageClass);
}

/**
 * What became of a `steer`. `steered`: the runtime accepted it into the running
 * turn (not proof the model acted on it). `queued_fallback`: it was not taken and
 * is now an ordinary next-turn message; `steerReason` says why.
 */
export const STEER_OUTCOMES = ['steered', 'queued_fallback'] as const;

export type SteerOutcome = (typeof STEER_OUTCOMES)[number];

// ─── Delivery State Machine ────────────────────────────────────────────────

export const DELIVERY_STATES = [
  'queued',
  'delivering',
  'retry_wait',
  'delivered',
  'acked',
  'failed',
  'ambiguous',
  'expired',
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** Valid state transitions for the delivery state machine. */
export const DELIVERY_STATE_TRANSITIONS: Record<DeliveryState, DeliveryState[]> = {
  queued: ['delivering', 'delivered', 'failed', 'ambiguous', 'expired'],
  delivering: ['retry_wait', 'delivered', 'failed', 'ambiguous', 'expired'],
  retry_wait: ['delivering', 'failed', 'ambiguous', 'expired'],
  delivered: ['acked', 'expired', 'queued'],
  acked: [],
  failed: [],
  ambiguous: [],
  expired: [],
};

export const DELIVERY_TERMINAL_STATES: readonly DeliveryState[] = [
  'acked',
  'failed',
  'ambiguous',
  'expired',
];

export const PROMPT_DELIVERY_SOURCES = [
  'user_followup',
  'comment_directive',
  'agent_mailbox',
  'orchestration_handoff',
  // SAM's first prompt to a restored session that has nothing queued (`restored-session-prompt.ts`).
  'checkpoint_continuation',
  'parent_wakeup',
  'project_event_wake',
  'github_trigger',
  'scheduled_action',
  // A superadmin's approve/deny decision on an Operations action, delivered to the requesting
  // agent's session (`services/operations-actions/decision-delivery.ts`).
  'operations_decision',
  // A human supplied or declined an agent's secret request, or it expired; delivered to the
  // requesting agent's session (`services/runtime-secret-requests.ts`). Metadata only.
  'secret_request',
] as const;

export type PromptDeliverySource = (typeof PROMPT_DELIVERY_SOURCES)[number];

export const VM_PROMPT_RECEIPT_STATES = [
  'accepted',
  'in_flight',
  'completed',
  'not_found',
  'ambiguous',
] as const;

export type VmPromptReceiptState = (typeof VM_PROMPT_RECEIPT_STATES)[number];

export interface VmPromptDeliveryCapabilities {
  protocolVersion: number;
  runtimeIdentity: string;
  promptReceipts: {
    supported: boolean;
    lookup: boolean;
    states: readonly VmPromptReceiptState[];
  };
  /** Absent on VM agents that predate live steering. */
  steering?: {
    supported: boolean;
    version: number;
    lookup: boolean;
    states: readonly VmSteerReceiptState[];
  };
  checkpointRollover: {
    supported: boolean;
    automatic: boolean;
    states: readonly string[];
    defaultGraceMs: number;
    maxGraceMs: number;
    operationTimeoutMs: number;
  };
}

export interface VmPromptDeliveryReceipt {
  deliveryId: string;
  state: VmPromptReceiptState;
  runtimeIdentity: string;
  acceptedAt: number | null;
  completedAt: number | null;
}

export interface VmPromptDeliveryResponse {
  status: 'accepted' | 'duplicate' | 'not_ready' | 'conflict';
  sessionId: string;
  receipt: VmPromptDeliveryReceipt;
}

export const VM_STEER_RECEIPT_STATES = [
  'accepted',
  'in_flight',
  'injected',
  'not_consumed',
  'ambiguous',
  'not_found',
] as const;

export type VmSteerReceiptState = (typeof VM_STEER_RECEIPT_STATES)[number];

/** The VM's durable record of one steer. `not_consumed` guarantees the agent never saw it. */
export interface VmSteerReceipt {
  deliveryId: string;
  state: VmSteerReceiptState;
  reason?: string;
  runtimeIdentity: string;
  /** Start of the prompt turn the steer attached to (Unix ms). */
  promptEpoch: number | null;
  acceptedAt: number | null;
  completedAt: number | null;
}

export interface VmSteerResponse {
  status: VmSteerReceiptState | 'conflict';
  sessionId: string;
  receipt: VmSteerReceipt;
}

// ─── Sender identity ──────────────────────────────────────────────────────

export const SENDER_TYPES = ['agent', 'orchestrator', 'system', 'human'] as const;
export type SenderType = (typeof SENDER_TYPES)[number];

// ─── Agent Mailbox Message ─────────────────────────────────────────────────

export interface AgentMailboxMessage {
  id: string;
  targetSessionId: string;
  sourceTaskId: string | null;
  senderType: SenderType;
  senderId: string | null;
  messageClass: MessageClass;
  deliveryState: DeliveryState;
  content: string;
  metadata: Record<string, unknown> | null;
  ackRequired: boolean;
  ackTimeoutMs: number | null;
  deliveryAttempts: number;
  lastDeliveryAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  deliveredAt: number | null;
  ackedAt: number | null;
  sourceKind: PromptDeliverySource;
  promptMessageId: string;
  nextAttemptAt: number | null;
  lastError: string | null;
  terminalReason: string | null;
  attemptId: string | null;
  attemptStartedAt: number | null;
  runtimeIdentity: string | null;
  receiptState: VmPromptReceiptState | null;
  receiptRuntimeIdentity: string | null;
  receiptCheckedAt: number | null;
  acceptedAt: number | null;
  adapterProtocolVersion: number | null;
  receiptSupported: boolean | null;
  deliveryIntent: PromptDeliveryIntent;
  steerOutcome: SteerOutcome | null;
  steerReason: string | null;
}

// ─── API request/response shapes ───────────────────────────────────────────

export interface SendDurableMessageRequest {
  targetTaskId: string;
  message: string;
  messageClass: MessageClass;
  deliveryIntent?: PromptDeliveryIntent;
  metadata?: Record<string, unknown>;
}

export interface SendDurableMessageResponse {
  messageId: string;
  deliveryState: DeliveryState;
  delivered: boolean;
}

export interface GetPendingMessagesResponse {
  messages: AgentMailboxMessage[];
}

export interface AckMessageRequest {
  messageId: string;
}

export interface AckMessageResponse {
  acked: boolean;
  messageId: string;
}

export interface ListMailboxResponse {
  messages: AgentMailboxMessage[];
  total: number;
}

// ─── Configurable defaults ──────────────────────────────────���──────────────

export const MAILBOX_DEFAULTS = {
  /** Time to wait for ack before re-delivery (ms). Override: MAILBOX_ACK_TIMEOUT_MS */
  ACK_TIMEOUT_MS: 300_000, // 5 minutes
  /** Max delivery attempts before marking expired. Override: MAILBOX_REDELIVERY_MAX_ATTEMPTS */
  REDELIVERY_MAX_ATTEMPTS: 5,
  /** Default TTL for messages (ms). Override: MAILBOX_TTL_MS */
  TTL_MS: 3_600_000, // 1 hour
  /** Interval for DO alarm delivery sweep (ms). Override: MAILBOX_DELIVERY_POLL_INTERVAL_MS */
  DELIVERY_POLL_INTERVAL_MS: 30_000, // 30 seconds
  /** Max messages per project. Override: MAILBOX_MAX_MESSAGES_PER_PROJECT */
  MAX_MESSAGES_PER_PROJECT: 1_000,
  /** Max content length for messages. Override: MAILBOX_MESSAGE_MAX_LENGTH */
  MESSAGE_MAX_LENGTH: 32_768,
} as const;
