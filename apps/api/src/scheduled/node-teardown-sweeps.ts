/**
 * The node teardown group of the 5-minute cron (`handler.ts`), in order, each step isolated
 * (`.claude/rules/53`). Split from `handler.ts` (file size limit).
 */
import type { Env } from '../env';
import { runAppRouteDnsReconciliation } from '../services/app-route-dns-reconciliation';
import { runNodeTunnelCleanupSweep } from '../services/node-tunnel-cleanup';
import { runDeploymentNodeCleanup } from './deployment-node-cleanup';
import { runNodeCleanupSweep } from './node-cleanup';
import type { SweepIsolator } from './sweep-isolation';
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
  // After node teardown: deletes app-route A records left pointing at released node IPs (the
  // subdomain-takeover backstop). Deadline-bounded by appRouteDns.sweepBudgetMs and resumed
  // from a KV page cursor (services/app-route-dns-reconciliation.ts).
  const appRouteDns = await sweeps.isolate('app_route_dns_reconciliation', () =>
    runAppRouteDnsReconciliation(env)
  );
  return { nodeCleanup, terminalNodeLifecycleRepair, nodeTunnelCleanup, appRouteDns };
}
