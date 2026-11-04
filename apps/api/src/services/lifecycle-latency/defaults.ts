/**
 * Code defaults for lifecycle latency monitoring. Every value is an admin setting
 * (`lifecycleLatency.<key>`, Operations group). A budget of 0 turns off both the watchdog and the daily check for that state.
 */
export const LIFECYCLE_LATENCY_DEFAULTS = Object.freeze({
  workspacePendingMinutes: 15,
  workspaceCreatingMinutes: 15,
  workspaceRecoveryMinutes: 15,
  workspaceStoppingMinutes: 10,
  nodePendingMinutes: 15,
  nodeCreatingMinutes: 15,
  nodeRecoveryMinutes: 15,
  nodeStoppingMinutes: 20,
  sessionSleepPreparingMinutes: 15,
  sessionSleepStoppingMinutes: 15,
  sessionWakingMinutes: 15,
  /** Slow episodes alerted per state per watchdog tick; the rest are counted, not dropped. */
  alertsPerStatePerTick: 5,
  /** Daily check flags a state whose 24h p95 exceeds this percent of the prior 7-day p95. */
  regressionPercent: 200,
  /** Fewest completed episodes in a window before its percentiles are judged. */
  minSamples: 5,
  /** Days transition history and alert records are kept. */
  retentionDays: 30,
  /** Most recent completed episodes read per state by the daily check. */
  evaluationSampleLimit: 2_000,
});

export type LifecycleLatencySettingKey = keyof typeof LIFECYCLE_LATENCY_DEFAULTS;
