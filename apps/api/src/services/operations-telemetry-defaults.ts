/**
 * Typed defaults, ranges and descriptions for Operations telemetry and approved-action
 * tunables. Import-free so the admin settings registry can depend on it without a cycle.
 */
export const OPERATIONS_TELEMETRY_DEFAULTS = {
  nodeDecisionLogRetentionDays: 14,
  nodeDecisionDedupeWindowMs: 30 * 60 * 1000,
  nodeLogCaptureRetentionDays: 7,
  nodeLogCaptureTimeoutMs: 5_000,
  nodeLogCaptureLinesPerSource: 300,
  nodeLogCaptureMaxBytes: 1_000_000,
  nodeLogCaptureHeartbeatFreshnessMs: 10 * 60 * 1000,
  snapshotTracesPerSession: 10,
  actionApprovalTtlMs: 60 * 60 * 1000,
} as const;

export type OperationsTelemetrySettingKey = keyof typeof OPERATIONS_TELEMETRY_DEFAULTS;
export type OperationsTelemetrySettingName = `operations.${OperationsTelemetrySettingKey}`;

export const OPERATIONS_TELEMETRY_RANGES: Record<
  OperationsTelemetrySettingKey,
  { min: number; max: number }
> = {
  nodeDecisionLogRetentionDays: { min: 1, max: 365 },
  nodeDecisionDedupeWindowMs: { min: 60_000, max: 24 * 60 * 60 * 1000 },
  nodeLogCaptureRetentionDays: { min: 1, max: 90 },
  nodeLogCaptureTimeoutMs: { min: 500, max: 30_000 },
  nodeLogCaptureLinesPerSource: { min: 10, max: 1000 },
  nodeLogCaptureMaxBytes: { min: 10_000, max: 10_000_000 },
  nodeLogCaptureHeartbeatFreshnessMs: { min: 60_000, max: 24 * 60 * 60 * 1000 },
  snapshotTracesPerSession: { min: 1, max: 100 },
  actionApprovalTtlMs: { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 },
};

export const OPERATIONS_TELEMETRY_DESCRIPTIONS: Record<OperationsTelemetrySettingKey, string> = {
  nodeDecisionLogRetentionDays: 'Days to keep node keep/kill decision log rows.',
  nodeDecisionDedupeWindowMs:
    'Milliseconds before an identical repeated cleanup-sweep decision about a node is logged again.',
  nodeLogCaptureRetentionDays:
    'Days to keep black box node log captures (raw VM logs) before deletion.',
  nodeLogCaptureTimeoutMs:
    'Maximum milliseconds a black box log capture may add before node teardown proceeds.',
  nodeLogCaptureLinesPerSource:
    'Log lines captured per source (vm-agent, systemd, cloud-init) in a black box capture.',
  nodeLogCaptureMaxBytes: 'Maximum uncompressed bytes stored per black box node log capture.',
  nodeLogCaptureHeartbeatFreshnessMs:
    'A node must have sent a heartbeat this recently for teardown to attempt a log capture.',
  snapshotTracesPerSession: 'Sleep/wake step traces kept per chat session.',
  actionApprovalTtlMs: 'Milliseconds an operations action approval stays valid.',
};
