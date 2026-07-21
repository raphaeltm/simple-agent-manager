/**
 * Shared types and utilities for ProjectData DO modules.
 */

import type { VmAgentContainer } from '../vm-agent-container';

export type Env = {
  DATABASE: D1Database;
  VM_AGENT_CONTAINER?: DurableObjectNamespace<VmAgentContainer>;
  TASK_LIVENESS_PROBE_TIMEOUT_MS?: string;
  BASE_DOMAIN?: string;
  DO_SUMMARY_SYNC_DEBOUNCE_MS?: string;
  MAX_SESSIONS_PER_PROJECT?: string;
  MAX_MESSAGES_PER_SESSION?: string;
  DOCUMENT_CARD_RAW_OUTPUT_MAX_BYTES?: string;
  ACTIVITY_RETENTION_DAYS?: string;
  SESSION_IDLE_TIMEOUT_MINUTES?: string;
  IDLE_CLEANUP_RETRY_DELAY_MS?: string;
  IDLE_CLEANUP_MAX_RETRIES?: string;
  ACP_SESSION_DETECTION_WINDOW_MS?: string;
  ACP_SESSION_MAX_FORK_DEPTH?: string;
  WORKSPACE_IDLE_TIMEOUT_MS?: string;
  KNOWLEDGE_MAX_ENTITIES_PER_PROJECT?: string;
  KNOWLEDGE_MAX_OBSERVATIONS_PER_ENTITY?: string;
  MAILBOX_ACK_TIMEOUT_MS?: string;
  MAILBOX_REDELIVERY_MAX_ATTEMPTS?: string;
  MAILBOX_TTL_MS?: string;
  MAILBOX_DELIVERY_POLL_INTERVAL_MS?: string;
  MAILBOX_MAX_MESSAGES_PER_PROJECT?: string;
  POLICY_MAX_PER_PROJECT?: string;
  HUMAN_INPUT_TIMEOUT_MS?: string;
  TASK_RECONCILIATION_IDLE_MS?: string;
  TASK_RECONCILIATION_RESPONSE_DEADLINE_MS?: string;
  TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS?: string;
  TASK_RECONCILIATION_PROMPT_HARD_STALL_MS?: string;
  TASK_RECONCILIATION_MIN_ALARM_DELAY_MS?: string;
  SESSION_ACTIVITY_STALE_THRESHOLD_MS?: string;
};

export interface SummaryData {
  lastActivityAt: string;
  activeSessionCount: number;
}

export function generateId(): string {
  return crypto.randomUUID();
}
