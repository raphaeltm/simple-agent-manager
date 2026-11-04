import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';
import {
  LIFECYCLE_LATENCY_DEFAULTS,
  type LifecycleLatencySettingKey,
} from './lifecycle-latency/defaults';

const MAX_BUDGET_MINUTES = 10_080; // 7 days

const BUDGET_DESCRIPTIONS = {
  workspacePendingMinutes: 'a workspace may stay pending',
  workspaceCreatingMinutes: 'a workspace may stay creating',
  workspaceRecoveryMinutes: 'a workspace may stay in recovery',
  workspaceStoppingMinutes: 'a workspace may stay stopping (stop and deletion confirmation)',
  nodePendingMinutes: 'a node may stay pending',
  nodeCreatingMinutes: 'a node may stay creating',
  nodeRecoveryMinutes: 'a node may stay in recovery',
  nodeStoppingMinutes: 'a node may stay stopping',
  sessionSleepPreparingMinutes: 'a session sleep may stay preparing (snapshot capture)',
  sessionSleepStoppingMinutes: 'a session sleep may stay stopping',
  sessionWakingMinutes: 'a session wake may stay waking',
} satisfies Partial<Record<LifecycleLatencySettingKey, string>>;

type BudgetKey = keyof typeof BUDGET_DESCRIPTIONS;

const budgetSettings = (Object.keys(BUDGET_DESCRIPTIONS) as BudgetKey[]).map((key) =>
  integerDefinition(
    `lifecycleLatency.${key}`,
    LIFECYCLE_LATENCY_DEFAULTS[key],
    'Operations',
    `Minutes ${BUDGET_DESCRIPTIONS[key]} before the latency watchdog records a slow-state error and the daily check treats it as over budget. 0 turns the watch off.`,
    { min: 0, max: MAX_BUDGET_MINUTES }
  )
);

export const LIFECYCLE_LATENCY_SETTINGS: AdminSettingDefinition[] = [
  ...budgetSettings,
  integerDefinition(
    'lifecycleLatency.alertsPerStatePerTick',
    LIFECYCLE_LATENCY_DEFAULTS.alertsPerStatePerTick,
    'Operations',
    'Slow-state errors the latency watchdog records per state in one five-minute run. Older episodes are recorded first; the rest are counted in the run log and recorded on later runs.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'lifecycleLatency.regressionPercent',
    LIFECYCLE_LATENCY_DEFAULTS.regressionPercent,
    'Operations',
    "The daily latency check records a regression when a state's 24-hour p95 is above this percent of its p95 over the previous 7 days.",
    { min: 101, max: 10_000 }
  ),
  integerDefinition(
    'lifecycleLatency.minSamples',
    LIFECYCLE_LATENCY_DEFAULTS.minSamples,
    'Operations',
    'Fewest completed episodes in a window before the daily latency check judges its percentiles.',
    { min: 1, max: 10_000 }
  ),
  integerDefinition(
    'lifecycleLatency.retentionDays',
    LIFECYCLE_LATENCY_DEFAULTS.retentionDays,
    'Operations',
    'Days lifecycle state transitions and slow-state alert records are kept before the daily purge removes them.',
    { min: 8, max: 365 }
  ),
  integerDefinition(
    'lifecycleLatency.evaluationSampleLimit',
    LIFECYCLE_LATENCY_DEFAULTS.evaluationSampleLimit,
    'Operations',
    'Most recent completed episodes the daily latency check reads per state.',
    { min: 10, max: 20_000 }
  ),
];
