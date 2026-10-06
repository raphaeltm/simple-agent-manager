/**
 * Small result helpers shared by the D1 retention sweeps (`d1-retention.ts`,
 * `session-snapshot-purge.ts`).
 */
export interface D1MutationResult {
  meta?: { changes?: number };
}

export interface ScheduledSweepResult {
  enabled: boolean;
  skipped: boolean;
  skipReason: string | null;
}

/** Retention sweeps are on unless explicitly disabled. */
export function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== 'false';
}

export function mutationChanges(result: D1MutationResult): number {
  return result.meta?.changes ?? 0;
}
