// Moved to @simple-agent-manager/ai-proxy (worker modularization W5). Named re-exports plus a
// wrapper with the original signature that binds the worker's ports.
import * as pkg from '@simple-agent-manager/ai-proxy';

import type { Env } from '../env';
import { aiProxyPorts } from './ai-proxy-ports';

export {
  MAX_MONTHLY_COST_CACHE_TTL_SECONDS,
  resolveMonthlyCostCacheTtlSeconds,
} from '@simple-agent-manager/ai-proxy';

/** Aggregate this month's AI Gateway cost per user into the KV cache (hourly cron). */
export function runMonthlyCostAggregation(env: Env): Promise<pkg.MonthlyCostCronResult> {
  return pkg.runMonthlyCostAggregation(env, aiProxyPorts(env));
}
