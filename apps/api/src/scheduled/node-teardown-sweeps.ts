/**
 * The node teardown group of the 5-minute cron (`handler.ts`), in order, each step isolated
 * (`.claude/rules/53`). Split from `handler.ts` (file size limit).
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { runAppRouteDnsReconciliation } from '../services/app-route-dns-reconciliation';
import { runDeploymentNodeProviderExistenceSweep } from '../services/deployment-node-provider-existence';
import { runNodeTunnelCleanupSweep } from '../services/node-tunnel-cleanup';
import { runDeploymentNodeCleanup } from './deployment-node-cleanup';
import { notifyFailedSweeps } from './failed-sweep-notifications';
import { runNodeCleanupSweep } from './node-cleanup';
import { createSweepIsolator, type SweepIsolator } from './sweep-isolation';
import { runTerminalNodeLifecycleRepair } from './terminal-node-lifecycle-repair';

export async function runNodeTeardownSweeps(
  sweeps: SweepIsolator,
  env: Env,
  waitUntil: (work: Promise<unknown>) => void
) {
  const nodeCleanup = await sweeps.isolate('node_cleanup', () => runNodeCleanupSweep(env));
  await sweeps.isolate('deployment_node_cleanup', () => runDeploymentNodeCleanup(env, waitUntil));
  const terminalNodeLifecycleRepair = await sweeps.isolate('terminal_node_lifecycle_repair', () =>
    runTerminalNodeLifecycleRepair(env)
  );
  // After node teardown: releases tunnels of incarnations torn down this tick and retries
  // any pending Cloudflare tunnel/DNS deletion (services/node-tunnel-cleanup.ts).
  const nodeTunnelCleanup = await sweeps.isolate('node_tunnel_cleanup', () =>
    runNodeTunnelCleanupSweep(env)
  );
  // After node teardown: releases running deployment nodes whose VM the provider has twice
  // confirmed deleted, so their app-route records go through the node release choke point
  // (services/deployment-node-provider-existence.ts). Provider I/O, so out of band
  // (`.claude/rules/47`).
  waitUntil(
    runOutOfBand(env, 'deployment_node_provider_existence', () =>
      runDeploymentNodeProviderExistenceSweep(env)
    )
  );
  // After node teardown: deletes app-route A records left pointing at released node IPs (the
  // subdomain-takeover backstop, services/app-route-dns-reconciliation.ts). Its DNS API calls run
  // out of band, so a slow Cloudflare API cannot delay the later sweeps. It has its own
  // `waitUntil`, so a slow provider sweep above can never use up its time. The two may delete the
  // same record concurrently; both paths re-read it first and a DNS delete tolerates a 404
  // (`deleteObservedAppRouteDnsRecord`, `deleteDNSRecord`).
  waitUntil(
    runOutOfBand(env, 'app_route_dns_reconciliation', () => runAppRouteDnsReconciliation(env))
  );
  return { nodeCleanup, terminalNodeLifecycleRepair, nodeTunnelCleanup };
}

/**
 * Run a sweep after the cron's foreground chain, with the same isolation and failure reporting:
 * its own isolator records the failure (`cron.sweep_failed`, /admin/errors), and the operator
 * notification is sent once it settles, since the foreground `cron.completed` snapshot is taken
 * before it finishes.
 */
async function runOutOfBand<T>(
  env: Env,
  name: string,
  fn: () => Promise<T>
): Promise<T | undefined> {
  const isolated = createSweepIsolator(env);
  const result = await isolated.isolate(name, fn);
  const failed = isolated.failedSweeps();
  if (failed.length > 0) {
    await notifyFailedSweeps(env, failed).catch((err) => {
      log.error('cron.sweep_failure_notification_failed', {
        sweeps: failed,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return result;
}
