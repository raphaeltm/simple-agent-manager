/**
 * Why a sleeping session's wake is waiting, in words the chat can show.
 *
 * "Waiting for server capacity..." covered every kind of wait, so a wake blocked
 * for 25 minutes by three different causes (the previous workspace still shutting
 * down, the cloud provider out of capacity, a new server booting) looked like one
 * stuck spinner (production, 2026-11-02). The server already records the cause:
 * the admission reasons below are written to `tasks.admission_reason`
 * (`apps/api/src/services/vm-admission-control-types.ts`), and
 * `previous_workspace_cleanup` is derived from the slept workspace not yet being
 * deleted (`apps/api/src/routes/chat/wake-state.ts`).
 */
export const WAKE_WAIT_REASONS = [
  'previous_workspace_cleanup',
  'compatible_node_provisioning',
  'compatible_node_building_workspace',
  'provider_transient_capacity',
  'provider_account_capacity',
  'user_node_limit',
  'capacity_pool_node_limit',
] as const;

export type WakeWaitReason = (typeof WAKE_WAIT_REASONS)[number];

export const WAKE_WAIT_REASON_LABELS: Record<WakeWaitReason, string> = {
  previous_workspace_cleanup: 'Waiting for the previous workspace to finish shutting down...',
  compatible_node_provisioning: 'Waiting for a new server to finish starting...',
  compatible_node_building_workspace: 'Waiting for a server that is still setting up...',
  provider_transient_capacity: 'Your cloud provider has no capacity right now. Retrying...',
  provider_account_capacity: "Your cloud account's server limit is reached. Retrying...",
  user_node_limit: 'Your SAM server limit is reached. Waiting for a free slot...',
  capacity_pool_node_limit: "This project's server limit is reached. Waiting for a free slot...",
};

export function isWakeWaitReason(value: unknown): value is WakeWaitReason {
  return typeof value === 'string' && (WAKE_WAIT_REASONS as readonly string[]).includes(value);
}
