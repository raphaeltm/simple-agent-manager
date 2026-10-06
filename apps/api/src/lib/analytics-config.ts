import type { Env } from '../env';

const ANALYTICS_DATASET_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getAnalyticsDataset(env: Pick<Env, 'ANALYTICS_DATASET'>): string {
  const dataset = env.ANALYTICS_DATASET?.trim();

  if (!dataset) {
    throw new Error('ANALYTICS_DATASET is not configured');
  }

  if (!ANALYTICS_DATASET_RE.test(dataset)) {
    throw new Error('ANALYTICS_DATASET contains invalid characters');
  }

  return dataset;
}
