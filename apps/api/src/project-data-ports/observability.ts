import type { ObservabilityPort } from '../durable-objects/project-data/ports';
import { persistError } from '../services/observability';
import {
  recordAcpActivityCallbackMetric,
  recordDurableExecutionMetric,
} from '../services/telemetry';
import { workerEnv } from './worker-env';

/** Telemetry metrics and operator-visible platform error rows. */
export const observabilityPort: ObservabilityPort = {
  recordDurableExecutionMetric: (env, metric) =>
    recordDurableExecutionMetric(metric, workerEnv(env)),
  recordAcpActivityMetric: (env, metric) => recordAcpActivityCallbackMetric(metric, workerEnv(env)),
  async persistPlatformError(env, record) {
    if (!env.OBSERVABILITY_DATABASE) return;
    await persistError(env.OBSERVABILITY_DATABASE, record, undefined);
  },
};
