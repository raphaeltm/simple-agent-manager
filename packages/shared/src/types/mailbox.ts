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
  'checkpoint_continuation',
  'parent_wakeup',
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
}

// ─── API request/response shapes ───────────────────────────────────────────

export interface SendDurableMessageRequest {
  targetTaskId: string;
  message: string;
  messageClass: MessageClass;
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
