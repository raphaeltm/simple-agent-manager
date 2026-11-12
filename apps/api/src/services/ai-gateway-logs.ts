// Moved to @simple-agent-manager/ai-proxy (worker modularization W5). Named re-exports plus a
// wrapper with the original signature that binds the worker's ports.
import * as pkg from '@simple-agent-manager/ai-proxy';

import type { Env } from '../env';
import { aiProxyPorts } from './ai-proxy-ports';

export {
  aggregateByDay,
  aggregateByModel,
  aggregateByProvider,
  type AIGatewayLogEntry,
  type GatewayPeriod,
  getGatewayPeriodBounds,
  getPeriodLabel,
  parseGatewayPeriod,
  resolveGatewayPagination,
  type UsageByDay,
  type UsageByModel,
  type UsageByProvider,
} from '@simple-agent-manager/ai-proxy';

/** Visit every AI Gateway log entry since `startDate`, paging automatically. */
export function iterateGatewayLogs(
  env: Env,
  gatewayId: string,
  startDate: string,
  visitor: (entry: pkg.AIGatewayLogEntry) => void,
  options: pkg.GatewayPaginationOptions = {}
): Promise<void> {
  return pkg.iterateGatewayLogs(env, aiProxyPorts(env), gatewayId, startDate, visitor, options);
}
