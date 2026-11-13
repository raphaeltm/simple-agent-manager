// Register shared boundary mocks before importing production services.
import './node-tunnel-fixture';

import { ProviderError } from '@simple-agent-manager/providers';
import { describe, expect, it } from 'vitest';

import { runNodeTunnelCleanupSweep } from '../../../src/services/node-tunnel-cleanup';
import { provisionNode } from '../../../src/services/nodes';
import { deleteNodeResourcesStrict } from '../../../src/services/strict-node-deletion';
import { cf, env, freshNode, journal, mocks, readNode, sqlite, USER } from './node-tunnel-fixture';

describe('tunnel lifecycle crash and cancellation fences', () => {
  // The resumed steps of an already-active row: its DNS re-check and the token fetch (the resume
  // fast path skips ingress and CNAME convergence; see node-tunnel-provisioning.ts).
  it.each(['dns.get', 'tunnel.token'])(
    'retains a possibly allocated VM tunnel when resumed %s fails',
    async (operation) => {
      const node = await freshNode();
      const durable = {
        createdAt: Date.now(),
        initialIncarnationId: readNode(node.id)!.incarnation!,
        incarnationId: crypto.randomUUID(),
      };
      mocks.createVM.mockRejectedValueOnce(
        new ProviderError('hetzner', undefined, 'lost provider response')
      );
      await expect(
        provisionNode(node.id, env, undefined, { durableAllocation: durable })
      ).rejects.toThrow();
      cf.inject(operation, { kind: 'status', status: 403 });
      await provisionNode(node.id, env, undefined, { durableAllocation: durable });
      await runNodeTunnelCleanupSweep(env);
      expect(journal(node.id)).toMatchObject([{ status: 'active' }]);
      expect(cf.liveTunnels()).toHaveLength(1);
      expect(cf.records()).toHaveLength(1);
      expect(mocks.createVM).toHaveBeenCalledTimes(1);
    }
  );

  it('switches a new incarnation back to public DNS without stale tunnel auth or heartbeat classification', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    await deleteNodeResourcesStrict(node.id, USER, env);
    await runNodeTunnelCleanupSweep(env);
    const previous = readNode(node.id)!;
    sqlite
      .prepare("UPDATE nodes SET status = 'creating', provider_instance_id = NULL WHERE id = ?")
      .run(node.id);
    env.VM_AGENT_TRANSPORT = 'vm-public-dns';
    await provisionNode(node.id, env);
    expect(readNode(node.id)).toMatchObject({
      status: 'running',
      transport: 'vm-public-dns',
      tunnelId: null,
      tunnelName: null,
      backendDnsRecordId: 'a-record-1',
    });
    expect(readNode(node.id)!.incarnation).not.toBe(previous.incarnation);
    expect(mocks.cloudInitVars.at(-1)?.originCaCertificateUrl).toContain('/origin-ca-certificate');
    expect(mocks.cloudInitVars.at(-1)?.cloudflareTunnelToken).toBeUndefined();
  });

  it('persists tunnel selection with the incarnation before callback signing or external mutations', async () => {
    const node = await freshNode();
    mocks.signCallbackToken.mockImplementationOnce(async () => {
      expect(readNode(node.id)).toMatchObject({ transport: 'cloudflare-tunnel', tunnelId: null });
      expect(journal(node.id)).toEqual([]);
      expect(cf.calls).toEqual([]);
      return 'callback-token';
    });
    await provisionNode(node.id, env);
  });

  it.each(['tunnel.create', 'dns.create'])(
    'continues reconciliation when %s commits after an empty cleanup',
    async (operation) => {
      const node = await freshNode();
      cf.inject(operation, { kind: 'commit-later' });
      // DNS convergence may retry once; force that retry to reject definitively.
      if (operation === 'dns.create') cf.inject(operation, { kind: 'status', status: 400 });
      await provisionNode(node.id, env);
      expect(mocks.createVM).not.toHaveBeenCalled();
      expect(journal(node.id)).toMatchObject([
        { status: 'cleanup_pending', pendingCreateCount: 1 },
      ]);
      expect(cf.liveTunnels()).toEqual([]);
      expect(cf.records()).toEqual([]);

      cf.commitDelayed();
      expect(operation === 'tunnel.create' ? cf.liveTunnels() : cf.records()).toHaveLength(1);
      const next = journal(node.id)[0]!.cleanupNextAttemptAt!;
      await runNodeTunnelCleanupSweep(env, new Date(Date.parse(next) + 1));
      expect(cf.liveTunnels()).toEqual([]);
      expect(cf.records()).toEqual([]);
      expect(journal(node.id)).toMatchObject([
        { status: 'cleanup_pending', pendingCreateCount: 1 },
      ]);
      expect(journal(node.id)[0]!.cleanupAttempts).toBeGreaterThan(1);
    }
  );

  it('does not finalize cleanup while an acknowledged create is still in flight', async () => {
    const node = await freshNode();
    cf.inject('tunnel.create', {
      kind: 'hook',
      run: async () => {
        sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
        await runNodeTunnelCleanupSweep(env);
        expect(journal(node.id)).toMatchObject([
          { status: 'cleanup_pending', pendingCreateCount: 1 },
        ]);
      },
    });
    await provisionNode(node.id, env);
    expect(cf.liveTunnels()).toHaveLength(1);
    expect(journal(node.id)).toMatchObject([{ status: 'cleanup_pending', pendingCreateCount: 0 }]);
    await runNodeTunnelCleanupSweep(
      env,
      new Date(Date.parse(journal(node.id)[0]!.cleanupNextAttemptAt!) + 1)
    );
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned' }]);
    expect(cf.liveTunnels()).toEqual([]);
  });
});
