import type { Env } from '../env';
import { activeLocalAnalyticsSink } from '../services/analytics-sink';

const ANALYTICS_DATASET_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getAnalyticsDataset(env: Env): string {
  // A self-host local sink has one fixed table and no generated dataset name.
  const local = activeLocalAnalyticsSink(env);
  if (local) return local.table;
  const dataset = env.ANALYTICS_DATASET?.trim();

  if (!dataset) {
    throw new Error('ANALYTICS_DATASET is not configured');
  }

  if (!ANALYTICS_DATASET_RE.test(dataset)) {
    throw new Error('ANALYTICS_DATASET contains invalid characters');
  }

  return dataset;
}
