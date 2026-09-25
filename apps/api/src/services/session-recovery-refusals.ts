/**
 * Session recovery refusals that clear on their own (`ensureSessionRecovery`), so
 * a caller should try the wake again later rather than give up
 * (`.claude/rules/72`): a replaced workspace whose deletion still awaits its
 * proof, and placement that cannot complete right now. One list for every caller
 * that retries a wake: the workspace eviction callback and durable prompt delivery.
 */
const TRANSIENT_SESSION_RECOVERY_REFUSALS: ReadonlySet<string> = new Set([
  'workspace_deletion_unconfirmed',
  'session_recovery_placement_placement',
  'session_recovery_placement_transient',
]);

export function isTransientSessionRecoveryRefusal(reason: string): boolean {
  return TRANSIENT_SESSION_RECOVERY_REFUSALS.has(reason);
}
