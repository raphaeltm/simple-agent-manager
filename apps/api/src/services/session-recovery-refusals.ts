/**
 * Session recovery refusals whose usual cause clears on its own
 * (`ensureSessionRecovery`), so a caller should try the wake again later rather
 * than give up (`.claude/rules/72`): a replaced workspace whose deletion still
 * awaits its proof (the first minutes after a sleep), and placement that cannot
 * complete right now (no capacity, a lookup that failed). One list for every
 * caller that retries a wake: the workspace eviction callback and durable prompt
 * delivery. Each caller bounds its own retries; a delivery's is its TTL.
 *
 * Known permanent causes share these names today: a dead-lettered deletion, a
 * malformed stored plan, and deterministic placement errors caught generically.
 * Those retry until the caller's bound instead of failing at once. All of them
 * refuse before a recovery is claimed, so no task, runtime or wake attempt is
 * spent; splitting them into their own reasons belongs where they are produced.
 */
const TRANSIENT_SESSION_RECOVERY_REFUSALS: ReadonlySet<string> = new Set([
  'workspace_deletion_unconfirmed',
  'session_recovery_placement_placement',
  'session_recovery_placement_transient',
]);

export function isTransientSessionRecoveryRefusal(reason: string): boolean {
  return TRANSIENT_SESSION_RECOVERY_REFUSALS.has(reason);
}
