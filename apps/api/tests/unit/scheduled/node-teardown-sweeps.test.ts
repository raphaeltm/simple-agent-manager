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
  notify: vi.fn(async () => ({ notifiedSweeps: 1, notificationsSent: 1 })),
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
vi.mock('../../../src/scheduled/failed-sweep-notifications', () => ({
  notifyFailedSweeps: mocks.notify,
}));

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
    const waitUntil = vi.fn();
    await runNodeTeardownSweeps(sweeps, env, waitUntil);
    // The DNS sweep runs out of band: handed to waitUntil, not awaited inline.
    const outOfBand = waitUntil.mock.calls.at(-1)?.[0] as Promise<unknown>;
    expect(await outOfBand).toEqual({ deleted: 2 });
    expect(calls).toEqual([
      'node_cleanup',
      'deployment_node_cleanup',
      'terminal_node_lifecycle_repair',
      'node_tunnel_cleanup',
      'app_route_dns_reconciliation',
    ]);
    expect(mocks.appRouteDns).toHaveBeenCalledWith(env);
    expect(sweeps.failedSweeps()).toEqual([]);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('still sweeps DNS when an earlier step throws, and names a DNS sweep failure', async () => {
    mocks.tunnelCleanup.mockRejectedValue(new Error('tunnel API down'));
    mocks.appRouteDns.mockRejectedValue(new Error('dns API down'));
    const sweeps = createSweepIsolator(env);
    const waitUntil = vi.fn();
    await runNodeTeardownSweeps(sweeps, env, waitUntil);
    expect(mocks.appRouteDns).toHaveBeenCalledTimes(1);
    // A failed sweep is undefined, never a zero-valued result.
    expect(await (waitUntil.mock.calls.at(-1)?.[0] as Promise<unknown>)).toBeUndefined();
    // The foreground isolator reports its own failure; the out-of-band sweep reports through
    // its own isolator and notifies operators once it settles.
    expect(sweeps.failedSweeps()).toEqual(['node_tunnel_cleanup']);
    expect(mocks.notify).toHaveBeenCalledWith(env, ['app_route_dns_reconciliation']);
  });
});
