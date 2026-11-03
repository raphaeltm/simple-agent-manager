/**
 * Runtime settings for the Operations project's read-only tools (the "Operations" category in
 * Admin → Settings). Pure data so the admin settings registry can import it without a cycle;
 * `resolveFleetOpsSettings` (./settings.ts) reads them in one batch.
 *
 * Plan: idea 01M6GGY1QPGG4D40HG0PVGQS3R. Policy a35180d5 requires raw debug packages to have
 * bounded retention, which is `operations.debugPackageRetentionDays`.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MIB = 1024 * 1024;

export const FLEET_OPS_SETTINGS = [
  {
    name: 'operations.debugPackageRetentionDays',
    key: 'debugPackageRetentionDays',
    defaultValue: 7,
    description:
      'Days a captured node debug package stays in the Operations project library before the daily purge deletes it.',
    range: { min: 1, max: 90 },
  },
  {
    name: 'operations.debugPackageMaxBytes',
    key: 'debugPackageMaxBytes',
    defaultValue: 20 * MIB,
    description:
      'Largest node debug package, in bytes, an Operations agent may capture. Capture stops reading and fails past this size. Capture holds the package and its encrypted copy in Worker memory, so the maximum leaves headroom under the 128 MB Worker limit.',
    range: { min: MIB, max: 32 * MIB },
  },
  {
    name: 'operations.debugPackagePurgeBatchSize',
    key: 'debugPackagePurgeBatchSize',
    defaultValue: 50,
    description:
      'Expired debug packages the daily purge deletes per run. Deleted in one batch, so the maximum stays under the database statement parameter limit.',
    range: { min: 1, max: 90 },
  },
  {
    name: 'operations.opsAnomalyEmptyNodeGraceMs',
    key: 'emptyNodeGraceMs',
    defaultValue: 15 * MINUTE_MS,
    description:
      'Extra milliseconds past the warm-node cleanup grace before a running node with no workspaces counts as an anomaly.',
    range: { min: 0, max: 7 * 24 * HOUR_MS },
  },
  {
    name: 'operations.opsAnomalyTerminalTaskGraceMs',
    key: 'terminalTaskGraceMs',
    defaultValue: 15 * MINUTE_MS,
    description:
      'Milliseconds after a task ends before its still-running workspace counts as an anomaly.',
    range: { min: 0, max: 7 * 24 * HOUR_MS },
  },
  {
    name: 'operations.opsAnomalyIdleTaskMinutes',
    key: 'idleTaskMinutes',
    defaultValue: 60,
    description:
      'Minutes an in-progress task may go without task or workspace activity before it counts as an anomaly.',
    range: { min: 1, max: 7 * 24 * 60 },
  },
  {
    name: 'operations.opsAnomalyLookbackHours',
    key: 'lookbackHours',
    defaultValue: 24,
    description:
      'Hours of snapshot failures and deletion-quarantine reports the anomaly sweep looks back over.',
    range: { min: 1, max: 30 * 24 },
  },
  {
    name: 'operations.opsAnomalyMaxPerClass',
    key: 'anomalyMaxPerClass',
    defaultValue: 25,
    description:
      'Findings the anomaly sweep returns per class. Each class still reports how many it found in total.',
    range: { min: 1, max: 200 },
  },
  {
    name: 'operations.opsNodeLogMaxLines',
    key: 'nodeLogMaxLines',
    defaultValue: 200,
    description: 'Most node log lines one Operations log read returns.',
    range: { min: 1, max: 1_000 },
  },
  {
    name: 'operations.opsNodeLogMaxBytes',
    key: 'nodeLogMaxBytes',
    defaultValue: 64 * 1024,
    description: 'Most bytes of node log text one Operations log read returns.',
    range: { min: 1_024, max: MIB },
  },
  {
    name: 'operations.opsTimelineMaxEvents',
    key: 'timelineMaxEvents',
    defaultValue: 200,
    description: 'Most events one Operations timeline returns after merging every source.',
    range: { min: 10, max: 1_000 },
  },
  {
    name: 'operations.opsTimelinePerSourceLimit',
    key: 'timelinePerSourceLimit',
    defaultValue: 100,
    description: 'Most events one timeline source contributes before merging.',
    range: { min: 5, max: 500 },
  },
  {
    name: 'operations.opsListMaxRows',
    key: 'listMaxRows',
    defaultValue: 100,
    description: 'Most nodes, workspaces or errors one Operations list returns.',
    range: { min: 1, max: 500 },
  },
  {
    name: 'operations.opsTextFieldMaxLength',
    key: 'textFieldMaxLength',
    defaultValue: 2_000,
    description:
      'Characters of one free-text field (an error message, a log context) an Operations tool returns.',
    range: { min: 100, max: 20_000 },
  },
] as const;

export type FleetOpsSettingName = (typeof FLEET_OPS_SETTINGS)[number]['name'];
export type FleetOpsSettingKey = (typeof FLEET_OPS_SETTINGS)[number]['key'];
export type FleetOpsSettings = Record<FleetOpsSettingKey, number>;

/** Defaults keyed for tests and for callers that must not fail when settings are unreadable. */
export const FLEET_OPS_DEFAULTS: FleetOpsSettings = Object.freeze(
  Object.fromEntries(FLEET_OPS_SETTINGS.map((s) => [s.key, s.defaultValue]))
) as FleetOpsSettings;
