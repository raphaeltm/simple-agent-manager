// Register shared boundary mocks before importing production services.
import './node-tunnel-fixture';

import { describe, expect, it, vi } from 'vitest';

import { updateAdminSettings } from '../../../src/services/admin-settings';
import { runNodeTunnelCleanupSweep } from '../../../src/services/node-tunnel-cleanup';
import { ensureNodeTunnelForProvisioning } from '../../../src/services/node-tunnel-provisioning';
import { provisionNode } from '../../../src/services/nodes';
import {
  cf,
  env,
  freshNode,
  journal,
  mocks,
  provider,
  readNode,
  sqlite,
  USER,
} from './node-tunnel-fixture';

describe('edge branches of adoption, fencing and bounded cleanup', () => {
  it('aborts a hung Cloudflare request within a row when the sweep deadline expires', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
    await updateAdminSettings(env, {
      actorUserId: USER,
      changes: [{ name: 'vmTunnels.cleanupSweepBudgetMs', value: 25 }],
    });
    let aborted = false;
    const hungFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(init!.signal!.reason);
            },
            { once: true }
          );
        })
    );
    globalThis.fetch = hungFetch as typeof fetch;
    vi.useFakeTimers();
    try {
      const sweep = runNodeTunnelCleanupSweep(env);
      await vi.advanceTimersByTimeAsync(26);
      expect(await sweep).toMatchObject({ attempted: 1, cleaned: 0 });
      expect(aborted).toBe(true);
      expect(hungFetch).toHaveBeenCalledTimes(1);
      expect(journal(node.id)).toMatchObject([{ status: 'cleanup_pending', cleanupAttempts: 1 }]);
      expect(journal(node.id)[0]!.cleanupNextAttemptAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  function journalName(nodeId: string): string {
    return (
      sqlite
        .prepare('SELECT tunnel_name AS name FROM node_cloudflare_tunnels WHERE node_id = ?')
        .get(nodeId) as { name: string }
    ).name;
  }

  it('refuses to pick one of several live tunnels carrying the incarnation name', async () => {
    const node = await freshNode();
    cf.inject('tunnel.list', {
      kind: 'hook',
      run: () => {
        cf.seedTunnel(journalName(node.id));
        cf.seedTunnel(journalName(node.id));
      },
    });
    await provisionNode(node.id, env);
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(cf.callCount('tunnel.create')).toBe(0);
    expect(readNode(node.id)?.status).toBe('error');
    // The release then deletes BOTH by exact name: both carry this incarnation's random UUID.
    expect(journal(node.id)).toMatchObject([
      { status: 'cleaned', tunnelId: null, pendingCreateCount: 0 },
    ]);
    expect(cf.liveTunnels()).toEqual([]);
  });

  it('cleans a tunnel whose id was never recorded (lost create, failed recovery read) by exact name', async () => {
    const node = await freshNode();
    cf.inject('tunnel.create', { kind: 'lost-after-commit' });
    cf.inject('tunnel.list', { kind: 'pass' });
    cf.inject('tunnel.list', { kind: 'status', status: 400, code: 1000 });
    await provisionNode(node.id, env);
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(journal(node.id)).toMatchObject([
      { status: 'cleanup_pending', tunnelId: null, pendingCreateCount: 1 },
    ]);
    expect(cf.tunnels.size).toBe(1);
    expect(cf.liveTunnels()).toEqual([]);
  });

  it('cleans a CNAME whose id was never recorded, and leaves a foreign same-name record alone', async () => {
    const node = await freshNode();
    cf.inject('dns.create', { kind: 'lost-after-commit' });
    cf.inject('dns.list', { kind: 'pass' });
    cf.inject('dns.list', { kind: 'status', status: 400, code: 1004 });
    await provisionNode(node.id, env);
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(journal(node.id)).toMatchObject([
      { status: 'cleanup_pending', dnsRecordId: null, pendingCreateCount: 1 },
    ]);
    expect(cf.records()).toEqual([]);
    expect(cf.liveTunnels()).toEqual([]);
  });

  it('gives up on a CNAME create after one bounded retry', async () => {
    const node = await freshNode();
    cf.inject('dns.create', { kind: 'network' }, 2);
    await provisionNode(node.id, env);
    expect(cf.callCount('dns.create')).toBe(2);
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(readNode(node.id)?.status).toBe('error');
    expect(journal(node.id)).toMatchObject([{ status: 'cleanup_pending', pendingCreateCount: 2 }]);
  });

  it('refuses to re-provision an incarnation whose tunnel is already released, without touching Cloudflare', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    const view = readNode(node.id)!;
    sqlite.prepare(`UPDATE node_cloudflare_tunnels SET status = 'cleanup_pending'`).run();
    const calls = cf.calls.length;
    await expect(
      ensureNodeTunnelForProvisioning(env, {
        nodeId: node.id,
        userId: USER,
        runtimeIncarnationId: view.incarnation!,
      })
    ).rejects.toThrow('already being cleaned up');
    expect(cf.calls.length).toBe(calls);
  });

  it('refuses to continue a journal written for a different Cloudflare account', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    const view = readNode(node.id)!;
    sqlite.prepare(`UPDATE node_cloudflare_tunnels SET account_id = 'other-account'`).run();
    const calls = cf.calls.length;
    await expect(
      ensureNodeTunnelForProvisioning(env, {
        nodeId: node.id,
        userId: USER,
        runtimeIncarnationId: view.incarnation!,
      })
    ).rejects.toThrow('different Cloudflare account');
    expect(cf.calls.length).toBe(calls);
  });

  it('a VM deleted by the direct fallback (strict teardown failed) still releases its tunnel', async () => {
    const node = await freshNode();
    // Authority is revoked right after createVM; strict teardown then fails to resolve the
    // provider, so provisioning falls back to a direct provider delete.
    mocks.assertPlan
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('allocation revoked'));
    mocks.createProvider
      .mockResolvedValueOnce(provider)
      .mockRejectedValueOnce(new Error('credential lookup failed'));
    await provisionNode(node.id, env);
    expect(mocks.deleteVM).toHaveBeenCalledWith('vm-1');
    // No termination proof was recorded (strict teardown failed), so only the fallback's own
    // release can free the tunnel.
    expect(readNode(node.id)?.proof).toBeNull();
    expect(journal(node.id)).toMatchObject([
      { status: 'cleaned', cleanupReason: 'provider_vm_deleted_directly' },
    ]);
    expect(cf.liveTunnels()).toEqual([]);
    expect(cf.records()).toEqual([]);
  });

  it('the sweep is bounded per tick by batch size and converges across ticks', async () => {
    await updateAdminSettings(env, {
      actorUserId: USER,
      changes: [{ name: 'vmTunnels.cleanupBatchSize', value: 2 }],
    });
    const nodes = [];
    for (let i = 0; i < 5; i++) {
      const node = await freshNode();
      await provisionNode(node.id, env);
      nodes.push(node);
    }
    sqlite.prepare('DELETE FROM nodes').run();
    expect(await runNodeTunnelCleanupSweep(env)).toMatchObject({ released: 5, attempted: 2 });
    expect(await runNodeTunnelCleanupSweep(env)).toMatchObject({ released: 0, attempted: 2 });
    expect(await runNodeTunnelCleanupSweep(env)).toMatchObject({ attempted: 1, cleaned: 1 });
    expect(await runNodeTunnelCleanupSweep(env)).toMatchObject({ attempted: 0 });
    expect(nodes.flatMap((node) => journal(node.id)).map((row) => row.status)).toEqual(
      Array(5).fill('cleaned')
    );
    expect(cf.liveTunnels()).toEqual([]);
  });

  it('the sweep stops starting rows once its wall-time budget is spent', async () => {
    await updateAdminSettings(env, {
      actorUserId: USER,
      changes: [{ name: 'vmTunnels.cleanupSweepBudgetMs', value: 1000 }],
    });
    for (let i = 0; i < 3; i++) await provisionNode((await freshNode()).id, env);
    sqlite.prepare('DELETE FROM nodes').run();
    let now = 0;
    // The budget is read before each row: 400 and 800 are within 1000 ms, 1200 is not.
    const clock = () => {
      const value = now;
      now += 400;
      return value;
    };
    expect(await runNodeTunnelCleanupSweep(env, new Date(), clock)).toMatchObject({
      released: 3,
      attempted: 2,
      cleaned: 2,
    });
    expect(await runNodeTunnelCleanupSweep(env)).toMatchObject({ attempted: 1, cleaned: 1 });
  });
});
