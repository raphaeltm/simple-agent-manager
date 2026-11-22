/**
 * The node teardown group of the 5-minute cron through the real sweep isolator: every step runs
 * in order, and a failing step neither stops the dangling app-route DNS sweep nor hides it
 * (`.claude/rules/53`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const calls = vi.hoisted(() => [] as string[]);
const mocks = vi.hoisted(() => ({
  nodeCleanup: vi.fn(),
  deploymentNodeCleanup: vi.fn(),
  terminalRepair: vi.fn(),
  tunnelCleanup: vi.fn(),
  appRouteDns: vi.fn(),
}));
vi.mock('../../../src/scheduled/node-cleanup', () => ({ runNodeCleanupSweep: mocks.nodeCleanup }));
vi.mock('../../../src/scheduled/deployment-node-cleanup', () => ({
  runDeploymentNodeCleanup: mocks.deploymentNodeCleanup,
}));
vi.mock('../../../src/scheduled/terminal-node-lifecycle-repair', () => ({
  runTerminalNodeLifecycleRepair: mocks.terminalRepair,
}));
vi.mock('../../../src/services/node-tunnel-cleanup', () => ({
  runNodeTunnelCleanupSweep: mocks.tunnelCleanup,
}));
vi.mock('../../../src/services/app-route-dns-reconciliation', () => ({
  runAppRouteDnsReconciliation: mocks.appRouteDns,
}));
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));

const { runNodeTeardownSweeps } = await import('../../../src/scheduled/node-teardown-sweeps');
const { createSweepIsolator } = await import('../../../src/scheduled/sweep-isolation');

const env = {} as Env;

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  const record = (name: string, value: unknown) => async () => {
    calls.push(name);
    return value;
  };
  mocks.nodeCleanup.mockImplementation(record('node_cleanup', { errors: 0 }));
  mocks.deploymentNodeCleanup.mockImplementation(record('deployment_node_cleanup', {}));
  mocks.terminalRepair.mockImplementation(record('terminal_node_lifecycle_repair', {}));
  mocks.tunnelCleanup.mockImplementation(record('node_tunnel_cleanup', { cleaned: 0 }));
  mocks.appRouteDns.mockImplementation(record('app_route_dns_reconciliation', { deleted: 2 }));
});

describe('runNodeTeardownSweeps', () => {
  it('runs the app-route DNS sweep last, after every node teardown step', async () => {
    const sweeps = createSweepIsolator(env);
    const result = await runNodeTeardownSweeps(sweeps, env, vi.fn());
    expect(calls).toEqual([
      'node_cleanup',
      'deployment_node_cleanup',
      'terminal_node_lifecycle_repair',
      'node_tunnel_cleanup',
      'app_route_dns_reconciliation',
    ]);
    expect(mocks.appRouteDns).toHaveBeenCalledWith(env);
    expect(result.appRouteDns).toEqual({ deleted: 2 });
    expect(sweeps.failedSweeps()).toEqual([]);
  });

  it('still sweeps DNS when an earlier step throws, and names a DNS sweep failure', async () => {
    mocks.tunnelCleanup.mockRejectedValue(new Error('tunnel API down'));
    mocks.appRouteDns.mockRejectedValue(new Error('dns API down'));
    const sweeps = createSweepIsolator(env);
    const result = await runNodeTeardownSweeps(sweeps, env, vi.fn());
    expect(mocks.appRouteDns).toHaveBeenCalledTimes(1);
    // A failed sweep is undefined, never a zero-valued result.
    expect(result.appRouteDns).toBeUndefined();
    expect(sweeps.failedSweeps()).toEqual(['node_tunnel_cleanup', 'app_route_dns_reconciliation']);
  });
});
