/**
 * The self-host build's reverse-tunnel entry: the ONLY place the reverse tunnel is mounted.
 * The generated celld entry wraps the shared Worker with it; `apps/api/src/index.ts` never
 * imports it (tests/unit/selfhost/reverse-tunnel-placement.test.ts), so the Cloudflare Worker
 * carries no gateway route, no lease SQL and no reverse sweep.
 *
 * - installs the transport driver (provisioning, release, routing) with L18's boot renderer;
 * - serves `SELF_HOST_GATEWAY_PATH_PREFIX/*` before the shared app, which never sees those
 *   paths, so no session middleware or wildcard can shadow them;
 * - runs the lease backstop sweep on the shared five-minute sweep cron, after and isolated
 *   from the shared scheduled handler, honouring the operational cron kill switch.
 */
import type { Context } from 'hono';

import type { Env } from '../../env';
import { log, serializeError } from '../../lib/logger';
import { DAILY_CRON } from '../../scheduled/daily-jobs';
import { isHourlyPlatformMaintenanceCron } from '../../scheduled/platform-feedback-hourly';
import { CAPACITY_POOL_CONTINUATION_CRON } from '../../services/capacity-pool-refresh-defaults';
import { isOperationalLoopEnabled } from '../../services/operational-kill-switch';
import type { ReverseTunnelEnv } from './env';
import { createSelfHostGatewayRoutes, SELF_HOST_GATEWAY_PATH_PREFIX } from './gateway';
import { runReverseTunnelLeaseSweep } from './leases';
import { installReverseTunnelTransport, type ReverseTunnelBootVariables } from './transport';

export interface SharedWorkerEntry {
  fetch(request: Request, env: Env, ctx: Context['executionCtx']): Response | Promise<Response>;
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
}

/** The shared handler's five-minute sweep tick (every cron that is not a dedicated one). */
export function isReverseTunnelSweepCron(cron: string): boolean {
  return (
    cron !== CAPACITY_POOL_CONTINUATION_CRON &&
    cron !== DAILY_CRON &&
    !isHourlyPlatformMaintenanceCron(cron)
  );
}

/** One isolated backstop pass. Never throws; logs its result or why it did nothing. */
export async function runReverseTunnelSweepTick(
  env: ReverseTunnelEnv,
  cron: string
): Promise<void> {
  try {
    if (!(await isOperationalLoopEnabled(env, 'cron'))) {
      log.info('cron.reverse_tunnel_lease_sweep', { cron, skipReason: 'cron_disabled' });
      return;
    }
    const result = await runReverseTunnelLeaseSweep(env);
    log.info('cron.reverse_tunnel_lease_sweep', {
      cron,
      released: result.released,
      skipReason: 'skipReason' in result ? result.skipReason : null,
    });
  } catch (err) {
    log.error('cron.reverse_tunnel_lease_sweep_failed', { cron, ...serializeError(err) });
  }
}

export function withReverseTunnel<T extends SharedWorkerEntry>(
  worker: T,
  render: (variables: ReverseTunnelBootVariables) => string
): T {
  installReverseTunnelTransport(render);
  const gateway = createSelfHostGatewayRoutes((request, env, ctx) =>
    worker.fetch(request, env, ctx)
  );
  return {
    ...worker,
    fetch(request: Request, env: Env, ctx: Context['executionCtx']) {
      const path = new URL(request.url).pathname;
      if (
        path === SELF_HOST_GATEWAY_PATH_PREFIX ||
        path.startsWith(`${SELF_HOST_GATEWAY_PATH_PREFIX}/`)
      ) {
        return gateway.fetch(request, env, ctx);
      }
      return worker.fetch(request, env, ctx);
    },
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
      try {
        await worker.scheduled(controller, env, ctx);
      } finally {
        // The shared handler isolates its own steps; this backstop still runs if it throws.
        if (isReverseTunnelSweepCron(controller.cron)) {
          await runReverseTunnelSweepTick(env, controller.cron);
        }
      }
    },
  };
}
