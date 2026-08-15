/** Stable receipts make follow-up delivery durable by default, including across sleep/wake. */
export const DEFAULT_DURABLE_PROMPT_DELIVERY_ENABLED = true;

/** Explicit opt-in for the pre-receipt VM request/202 compatibility path. */
export const DEFAULT_PROMPT_DELIVERY_LEGACY_VM_COMPAT_ENABLED = false;

/** Automatic long-turn checkpoint selection/preemption remains inert in this foundation. */
export const DEFAULT_ACP_LONG_TURN_SUPERVISOR_ENABLED = false;

/** Productive prompts become checkpoint candidates after five hours. */
export const DEFAULT_ACP_LONG_TURN_CHECKPOINT_MS = 5 * 60 * 60 * 1000;

/** Bounded graceful shutdown window reserved for the VM rollover integration. */
export const DEFAULT_ACP_CHECKPOINT_PREEMPT_GRACE_MS = 30 * 1000;

/** Maximum delivery records claimed by one ProjectData alarm pass. */
export const DEFAULT_PROMPT_DELIVERY_MAX_CANDIDATES_PER_ALARM = 5;

/** Maximum VM delivery attempts before an explicit terminal failure. */
export const DEFAULT_PROMPT_DELIVERY_MAX_ATTEMPTS = 5;

/** Initial retry delay for positive busy/not-ready responses. */
export const DEFAULT_PROMPT_DELIVERY_RETRY_BASE_MS = 5 * 1000;

/** Maximum exponential retry delay. */
export const DEFAULT_PROMPT_DELIVERY_RETRY_MAX_MS = 5 * 60 * 1000;

/** Accepted prompt intent must resolve within this finite lifetime. */
export const DEFAULT_PROMPT_DELIVERY_TTL_MS = 60 * 60 * 1000;

/** A claimed attempt is reconciled after this duration rather than blindly replayed. */
export const DEFAULT_PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS = 30 * 1000;

/** Background VM calls use a short control-loop timeout, not the interactive timeout. */
export const DEFAULT_PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS = 5 * 1000;

/** Avoid immediate alarm hot loops while still reacting promptly to readiness. */
export const DEFAULT_PROMPT_DELIVERY_MIN_ALARM_DELAY_MS = 1000;

/** Version of the stable VM prompt receipt contract published by this foundation. */
export const VM_PROMPT_DELIVERY_PROTOCOL_VERSION = 1;

/** Capability token advertised by VM runtimes that persist stable prompt receipts. */
export const VM_PROMPT_DELIVERY_RECEIPTS_CAPABILITY = 'prompt_delivery_receipts_v1';

export function buildVmPromptDeliveryCapabilitiesPath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/agent-capabilities`;
}

export function buildVmPromptDeliveryReceiptPath(
  workspaceId: string,
  acpSessionId: string,
  deliveryId: string
): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/agent-sessions/${encodeURIComponent(acpSessionId)}/prompt-receipts/${encodeURIComponent(deliveryId)}`;
}
