export const SAM_EVENT_BUS_SUBSCRIPTION_OWNER_TYPES = [
  'task',
  'session',
  'agent_session',
  'policy',
  'system',
] as const;

export type SamEventBusSubscriptionOwnerType =
  (typeof SAM_EVENT_BUS_SUBSCRIPTION_OWNER_TYPES)[number];

export const SAM_EVENT_BUS_DELIVERY_POLICIES = ['none', 'ack_required'] as const;

export type SamEventBusDeliveryPolicy = (typeof SAM_EVENT_BUS_DELIVERY_POLICIES)[number];

export const SAM_EVENT_BUS_DELIVERY_STATES = [
  'queued',
  'delivered',
  'acknowledged',
  'failed',
  'expired',
] as const;

export type SamEventBusDeliveryState = (typeof SAM_EVENT_BUS_DELIVERY_STATES)[number];

export interface SamEventBusReference {
  type: string;
  id: string | null;
}

export interface SamEventBusDeliveryInfo {
  id: string;
  subscriptionId: string;
  state: SamEventBusDeliveryState;
  policy: SamEventBusDeliveryPolicy;
  ackRequired: boolean;
  createdAt: number;
  deliveredAt: number | null;
  acknowledgedAt: number | null;
}

export interface SamEventBusDeliveryRecord extends SamEventBusDeliveryInfo {
  eventId: string;
}

export interface SamEventBusEventSummary {
  id: string;
  sequence: number;
  type: string;
  source: string;
  subject: SamEventBusReference;
  actor: SamEventBusReference;
  metadata: Record<string, unknown>;
  occurredAt: number;
  createdAt: number;
  payloadAvailable: true;
  delivery: SamEventBusDeliveryInfo;
}

export interface SamEventBusEvent extends SamEventBusEventSummary {
  payload: unknown;
}

export interface SamEventBusEventListResult {
  subscriptionId: string;
  events: SamEventBusEventSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SamEventBusAckResult {
  acknowledged: true;
  idempotent: boolean;
  delivery: SamEventBusDeliveryRecord;
}
