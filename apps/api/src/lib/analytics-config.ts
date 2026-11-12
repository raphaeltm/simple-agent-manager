import type { Env } from '../env';
import { ANALYTICS_EVENTS_TABLE, isAnalyticsD1SinkEnabled } from '../services/analytics-d1-sink';

const ANALYTICS_DATASET_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getAnalyticsDataset(
  env: Pick<Env, 'ANALYTICS_DATASET' | 'ANALYTICS_SINK' | 'OBSERVABILITY_DATABASE'>
): string {
  // The D1 sink has one fixed table and no generated dataset name.
  if (isAnalyticsD1SinkEnabled(env)) return ANALYTICS_EVENTS_TABLE;
  const dataset = env.ANALYTICS_DATASET?.trim();

  if (!dataset) {
    throw new Error('ANALYTICS_DATASET is not configured');
  }

  if (!ANALYTICS_DATASET_RE.test(dataset)) {
    throw new Error('ANALYTICS_DATASET contains invalid characters');
  }

  return dataset;
}
