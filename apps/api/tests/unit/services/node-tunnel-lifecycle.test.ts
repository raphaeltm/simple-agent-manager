// Register shared boundary mocks before importing production services.
import './node-tunnel-fixture';

import { ProviderError } from '@simple-agent-manager/providers';
import { describe, expect, it, vi } from 'vitest';

import { updateAdminSettings } from '../../../src/services/admin-settings';
import { runNodeTunnelCleanupSweep } from '../../../src/services/node-tunnel-cleanup';
import { resolveManagedNodeTransport } from '../../../src/services/node-tunnel-config';
import { createNodeRecord, provisionNode } from '../../../src/services/nodes';
import { deleteNodeResourcesStrict } from '../../../src/services/strict-node-deletion';
import {
  ACCOUNT,
  allStoredText,
  cf,
  env,
  freshNode,
  journal,
  logged,
  mocks,
  provider,
  readNode,
  setEnv,
  sqlite,
  tunnelEnv,
  USER,
  vmFor,
  ZONE,
} from './node-tunnel-fixture';

describe('managed node tunnel provisioning', () => {
  it('journals and builds the tunnel before the VM exists, then boots the VM with only its connector token', async () => {
    const node = await freshNode();
    mocks.createVM.mockImplementationOnce(async () => {
      // Ordering: ownership journaled and every Cloudflare resource ready BEFORE the VM.
      const [row] = journal(node.id);
      expect(row).toMatchObject({ status: 'active', tunnelId: expect.any(String) });
      expect(readNode(node.id)).toMatchObject({
        transport: 'cloudflare-tunnel',
        tunnelId: row?.tunnelId,
      });
      return vmFor();
    });

    await expect(provisionNode(node.id, env)).resolves.toEqual({ allocationConfirmed: true });

    const [row] = journal(node.id);
    const view = readNode(node.id)!;
    expect(row).toMatchObject({ status: 'active', runtimeIncarnationId: view.incarnation });
    expect(row?.tunnelName).toBe(
      `sam-${node.id.toLowerCase()}-${view.incarnation!.replaceAll('-', '')}`
    );
    expect(view).toMatchObject({
      status: 'running',
      transport: 'cloudflare-tunnel',
      tunnelId: row?.tunnelId,
      tunnelName: row?.tunnelName,
      backendDnsRecordId: null,
      ipAddress: '203.0.113.1',
    });

    const [tunnel] = cf.liveTunnels();
    expect(cf.liveTunnels()).toHaveLength(1);
    expect(tunnel?.ingress).toEqual([
      { hostname: `${node.id.toLowerCase()}.vm.example.test`, service: 'http://127.0.0.1:8444' },
      { service: 'http_status:404' },
    ]);
    expect(cf.records()).toEqual([
      expect.objectContaining({
        id: row?.dnsRecordId,
        name: `${node.id.toLowerCase()}.vm.example.test`,
        type: 'CNAME',
        content: `${tunnel?.id}.cfargotunnel.com`,
        proxied: true,
      }),
    ]);
    expect(mocks.createARecord).not.toHaveBeenCalled();

    const [vars] = mocks.cloudInitVars;
    expect(vars).toMatchObject({
      cloudflareTunnelToken: tunnel?.token,
      cloudflareTunnelPort: '8444',
      cloudflaredVersion: '2026.10.7',
      originCaCertificateUrl: undefined,
    });
    expect(JSON.stringify(vars)).not.toContain('account-api-token');

    // The connector token is a secret: never persisted, never logged.
    expect(allStoredText()).not.toContain(tunnel!.token);
    expect(logged.join('\n')).not.toContain(tunnel!.token);
  });

  it('honours VM_AGENT_TUNNEL_PORT and rejects an invalid port before any mutation', async () => {
    setEnv(tunnelEnv({ VM_AGENT_TUNNEL_PORT: '9555' }));
    const node = await freshNode();
    await provisionNode(node.id, env);
    expect(cf.liveTunnels()[0]?.ingress?.[0]).toMatchObject({ service: 'http://127.0.0.1:9555' });
    expect(mocks.cloudInitVars[0]).toMatchObject({ cloudflareTunnelPort: '9555' });

    setEnv(tunnelEnv({ VM_AGENT_TUNNEL_PORT: '70000' }));
    const bad = await freshNode();
    await provisionNode(bad.id, env);
    expect(readNode(bad.id)?.status).toBe('error');
    expect(journal(bad.id)).toEqual([]);
    expect(mocks.createVM).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy public-IP provisioning byte-for-byte when the transport is not selected', async () => {
    setEnv(tunnelEnv({ VM_AGENT_TRANSPORT: undefined }));
    const node = await freshNode();
    await provisionNode(node.id, env);
    expect(readNode(node.id)).toMatchObject({
      status: 'running',
      transport: 'vm-public-dns',
      tunnelId: null,
      backendDnsRecordId: 'a-record-1',
    });
    expect(mocks.createARecord).toHaveBeenCalledWith(node.id, '203.0.113.1', env);
    expect(cf.calls).toEqual([]);
    expect(journal(node.id)).toEqual([]);
    const [vars] = mocks.cloudInitVars;
    expect(vars?.originCaCertificateUrl).toBe(
      `https://api.example.test/api/nodes/${node.id}/origin-ca-certificate`
    );
    expect(vars).not.toHaveProperty('cloudflareTunnelToken');
    expect(vars).not.toHaveProperty('cloudflareTunnelPort');
  });

  it('gives deployment-role nodes the tunnel for their agent channel and keeps the IP for app routes', async () => {
    const node = await freshNode({ nodeRole: 'deployment' });
    await provisionNode(node.id, env, undefined, undefined, { environmentId: 'env-1' });
    const [tunnel] = cf.liveTunnels();
    expect(tunnel?.ingress).toEqual([
      { hostname: `${node.id.toLowerCase()}.vm.example.test`, service: 'http://127.0.0.1:8444' },
      { service: 'http_status:404' },
    ]);
    expect(readNode(node.id)).toMatchObject({
      status: 'running',
      transport: 'cloudflare-tunnel',
      tunnelId: tunnel?.id,
      // App routes are grey-cloud A records to this IP (dns-app-routes.ts).
      ipAddress: '203.0.113.1',
      backendDnsRecordId: null,
    });
    expect(mocks.createARecord).not.toHaveBeenCalled();
    expect(mocks.cloudInitVars[0]).toMatchObject({
      role: 'deployment',
      environmentId: 'env-1',
      cloudflareTunnelToken: tunnel?.token,
      originCaCertificateUrl: undefined,
    });
    expect(journal(node.id)).toMatchObject([{ status: 'active' }]);
  });

  it('waits for an IP on a deployment tunnel node whose provider reports none at create', async () => {
    mocks.createVM.mockImplementationOnce(async () => ({ ...vmFor(), ip: '' }));
    const deployment = await freshNode({ nodeRole: 'deployment' });
    await provisionNode(deployment.id, env, undefined, undefined, { environmentId: 'env-1' });
    expect(readNode(deployment.id)).toMatchObject({
      status: 'creating',
      transport: 'cloudflare-tunnel',
      ipAddress: null,
      backendDnsRecordId: null,
    });
    // Control: a workspace tunnel node never needs its public IP.
    mocks.createVM.mockImplementationOnce(async () => ({ ...vmFor(), ip: '' }));
    const workspace = await freshNode();
    await provisionNode(workspace.id, env);
    expect(readNode(workspace.id)).toMatchObject({ status: 'running', ipAddress: null });
    expect(mocks.createARecord).not.toHaveBeenCalled();
  });

  it('fails closed on an unknown transport value instead of exposing the public IP', async () => {
    setEnv(tunnelEnv({ VM_AGENT_TRANSPORT: 'cloudflare-tunnle' }));
    const node = await freshNode();
    await provisionNode(node.id, env);
    expect(readNode(node.id)?.status).toBe('error');
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(mocks.createARecord).not.toHaveBeenCalled();
  });

  it('never selects tunnel transport for Instant containers or user-owned machines', () => {
    const env = { VM_AGENT_TRANSPORT: 'cloudflare-tunnel' };
    expect(
      resolveManagedNodeTransport(env, {
        runtime: 'cf-container',
        nodeClass: 'managed',
        nodeRole: 'workspace',
      })
    ).toBeNull();
    expect(
      resolveManagedNodeTransport(env, {
        runtime: 'vm',
        nodeClass: 'user-owned',
        nodeRole: 'workspace',
      })
    ).toBeNull();
    expect(
      resolveManagedNodeTransport(env, {
        runtime: 'vm',
        nodeClass: 'managed',
        nodeRole: 'workspace',
      })
    ).toBe('cloudflare-tunnel');
  });
});

describe('ambiguous Cloudflare outcomes and retries', () => {
  it('adopts a tunnel whose create response was lost instead of creating a second one', async () => {
    const node = await freshNode();
    cf.inject('tunnel.create', { kind: 'lost-after-commit' });
    await provisionNode(node.id, env);
    expect(cf.callCount('tunnel.create')).toBe(1);
    expect(cf.liveTunnels()).toHaveLength(1);
    expect(readNode(node.id)).toMatchObject({
      status: 'running',
      tunnelId: cf.liveTunnels()[0]?.id,
    });
  });

  it('retries transient failures of idempotent calls and adopts a CNAME whose create response was lost', async () => {
    const node = await freshNode();
    cf.inject('tunnel.configure', { kind: 'status', status: 503 });
    cf.inject('tunnel.token', { kind: 'network' });
    cf.inject('dns.create', { kind: 'lost-after-commit' });
    await provisionNode(node.id, env);
    expect(readNode(node.id)?.status).toBe('running');
    expect(cf.callCount('tunnel.configure')).toBe(2);
    expect(cf.callCount('tunnel.token')).toBe(2);
    expect(cf.records()).toHaveLength(1);
    expect(journal(node.id)[0]?.dnsRecordId).toBe(cf.records()[0]?.id);
  });

  it('a durable resume of the same incarnation reuses the journaled tunnel', async () => {
    const node = await freshNode();
    const initial = readNode(node.id)!.incarnation!;
    const incarnationId = crypto.randomUUID();
    const durable = { createdAt: Date.now(), initialIncarnationId: initial, incarnationId };
    mocks.createVM.mockRejectedValueOnce(new ProviderError('hetzner', undefined, 'socket hang up'));
    await expect(
      provisionNode(node.id, env, undefined, { durableAllocation: durable })
    ).rejects.toThrow();
    expect(cf.liveTunnels()).toHaveLength(1);
    const before = journal(node.id);
    expect(before).toMatchObject([{ status: 'active', runtimeIncarnationId: incarnationId }]);

    // Resume: the VM may exist with this incarnation's token, so the journaled tunnel must be
    // adopted, never re-created. (Empty inventory then fails recovery as uncertain.)
    const listVMs = vi.fn().mockResolvedValue([]);
    mocks.createProvider.mockResolvedValue({
      ...provider,
      provider: { ...provider.provider, listVMs },
    });
    await expect(
      provisionNode(node.id, env, undefined, { durableAllocation: durable })
    ).rejects.toThrow(/second create is forbidden/);
    expect(listVMs).toHaveBeenCalled();
    expect(cf.callCount('tunnel.create')).toBe(1);
    expect(mocks.createVM).toHaveBeenCalledTimes(1);
    // Ownership is unchanged; only the recorded cause of the failed attempt moved.
    expect(journal(node.id).map(({ lastError: _ignored, ...rest }) => rest)).toEqual(
      before.map(({ lastError: _ignored, ...rest }) => rest)
    );
    expect(journal(node.id)[0]!.lastError).toMatch(
      /^failed during provider_create: NodeAllocationUncertainError: .*second create is forbidden/
    );
    // The resume fast path: the active row needs only its DNS re-check and the token.
    expect(cf.callCount('tunnel.configure')).toBe(1);
    expect(cf.callCount('dns.list')).toBe(1);
  });
});

describe('failures before the VM exists release and delete the tunnel', () => {
  it.each([
    ['tunnel create rejected', 'tunnel.create', { kind: 'status', status: 400, code: 1000 }, 0],
    ['ingress config rejected', 'tunnel.configure', { kind: 'status', status: 400, code: 1055 }, 1],
    ['token fetch rejected', 'tunnel.token', { kind: 'status', status: 403, code: 10000 }, 1],
  ] as const)(
    '%s: no VM, node error, journal cleaned, no Cloudflare residue',
    async (_name, op, fault, created) => {
      const node = await freshNode();
      cf.inject(op, fault);
      await provisionNode(node.id, env);
      expect(mocks.createVM).not.toHaveBeenCalled();
      expect(readNode(node.id)?.status).toBe('error');
      expect(journal(node.id)).toMatchObject([
        { status: 'cleaned', cleanupReason: 'provisioning_failed_before_vm' },
      ]);
      expect(cf.tunnels.size).toBe(created);
      expect(cf.liveTunnels()).toEqual([]);
      expect(cf.records()).toEqual([]);
    }
  );

  it('DNS conflict with a foreign record: refuses, cleans its own tunnel and leaves the foreign record alone', async () => {
    const node = await freshNode();
    const foreign = cf.seedDnsRecord({
      name: `${node.id.toLowerCase()}.vm.example.test`,
      type: 'A',
      content: '198.51.100.7',
      proxied: true,
    });
    await provisionNode(node.id, env);
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(readNode(node.id)?.status).toBe('error');
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned' }]);
    expect(cf.liveTunnels()).toEqual([]);
    expect(cf.records()).toEqual([foreign]);
  });

  it('authority revoked just before createVM releases the tunnel', async () => {
    const node = await freshNode();
    mocks.assertPlan
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('plan revoked'));
    await provisionNode(node.id, env);
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned' }]);
    expect(cf.liveTunnels()).toEqual([]);
  });

  it('cancellation during tunnel creation marks it for cleanup without more Cloudflare calls; the sweep deletes it', async () => {
    const node = await freshNode();
    const controller = new AbortController();
    cf.inject('tunnel.configure', {
      kind: 'hook',
      run: () => controller.abort(new Error('task cancelled')),
    });
    await expect(
      provisionNode(node.id, env, undefined, { signal: controller.signal })
    ).rejects.toThrow('task cancelled');
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(journal(node.id)).toMatchObject([{ status: 'cleanup_pending' }]);
    const callsAtCancel = cf.calls.length;
    expect(cf.liveTunnels()).toHaveLength(1);

    const sweep = await runNodeTunnelCleanupSweep(env);
    expect(sweep).toMatchObject({ attempted: 1, cleaned: 1 });
    expect(cf.calls.length).toBeGreaterThan(callsAtCancel);
    expect(cf.liveTunnels()).toEqual([]);
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned' }]);
  });

  it('a provider capacity rejection deletes the node row and the tunnel with it', async () => {
    const node = await freshNode();
    mocks.createVM.mockRejectedValueOnce(
      new ProviderError('hetzner', 412, 'Placement unavailable', {
        providerCode: 'placement_error',
      })
    );
    await expect(
      provisionNode(node.id, env, undefined, { rethrowProviderError: true })
    ).rejects.toThrow('Placement unavailable');
    expect(readNode(node.id)).toBeUndefined();
    expect(journal(node.id)).toMatchObject([
      { status: 'cleaned', cleanupReason: 'provisioning_failed' },
    ]);
    expect(cf.liveTunnels()).toEqual([]);
    expect(cf.records()).toEqual([]);
  });

  it('an ambiguous createVM failure keeps the tunnel: a VM may exist and hold its token', async () => {
    const node = await freshNode();
    mocks.createVM.mockRejectedValueOnce(
      new ProviderError('hetzner', undefined, 'Network timeout')
    );
    await provisionNode(node.id, env);
    expect(readNode(node.id)).toMatchObject({
      status: 'error',
      providerInstanceId: null,
      proof: null,
    });
    expect(journal(node.id)).toMatchObject([{ status: 'active' }]);
    // Two sweeps: still live, never selected.
    await runNodeTunnelCleanupSweep(env);
    await runNodeTunnelCleanupSweep(env);
    expect(journal(node.id)).toMatchObject([{ status: 'active' }]);
    expect(cf.liveTunnels()).toHaveLength(1);
  });
});

describe('node deletion and stale-incarnation cleanup', () => {
  it('strict deletion removes the VM and only marks the tunnel (no Cloudflare I/O); the sweep deletes CNAME, connectors, tunnel in order', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    cf.liveTunnels()[0]!.connections = 2; // a live connector must be dropped first
    const callsBeforeDelete = cf.calls.length;
    const result = await deleteNodeResourcesStrict(node.id, USER, env);
    expect(result.providerVm).toBe('deleted');
    expect(mocks.deleteVM).toHaveBeenCalledWith('vm-1');
    // Teardown paths (delete route, DOs, other sweeps) never wait on the Cloudflare API.
    expect(cf.calls.length).toBe(callsBeforeDelete);
    expect(journal(node.id)).toMatchObject([
      { status: 'cleanup_pending', cleanupReason: 'runtime_terminated' },
    ]);

    expect(await runNodeTunnelCleanupSweep(env)).toMatchObject({ attempted: 1, cleaned: 1 });
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned' }]);
    expect(cf.liveTunnels()).toEqual([]);
    expect(cf.records()).toEqual([]);
    const ops = cf.calls.slice(callsBeforeDelete).map((call) => call.op);
    expect(ops.lastIndexOf('dns.delete')).toBeLessThan(ops.indexOf('tunnel.connections_delete'));
    expect(ops.indexOf('tunnel.connections_delete')).toBeLessThan(ops.lastIndexOf('tunnel.delete'));
  });

  it('a repeated strict deletion on the existing-proof path still releases the tunnel', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    await deleteNodeResourcesStrict(node.id, USER, env);
    // Simulate the release write being lost (e.g. a D1 failure swallowed by the helper).
    sqlite.prepare(`UPDATE node_cloudflare_tunnels SET status = 'active'`).run();
    const retry = await deleteNodeResourcesStrict(node.id, USER, env);
    expect(retry.providerVm).toBe('already-absent');
    expect(mocks.deleteVM).toHaveBeenCalledTimes(1);
    expect(journal(node.id)).toMatchObject([{ status: 'cleanup_pending' }]);
  });

  it('a failed Cloudflare cleanup stays pending with doubling, capped backoff and is finished by a later sweep', async () => {
    await updateAdminSettings(env, {
      actorUserId: USER,
      changes: [{ name: 'vmTunnels.cleanupBackoffMaxMs', value: 150000 }],
    });
    const node = await freshNode();
    await provisionNode(node.id, env);
    await deleteNodeResourcesStrict(node.id, USER, env);
    cf.inject('tunnel.delete', { kind: 'status', status: 500 }, 3);

    const delays: number[] = [];
    let clock = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = Date.now();
      expect(await runNodeTunnelCleanupSweep(env, new Date(clock))).toMatchObject({
        attempted: 1,
        cleaned: 0,
      });
      const [pending] = journal(node.id);
      expect(pending).toMatchObject({ status: 'cleanup_pending', cleanupAttempts: attempt });
      expect(pending?.lastError).toContain('HTTP 500');
      delays.push(Date.parse(pending!.cleanupNextAttemptAt!) - before);
      // Not due yet: the sweep must not hammer Cloudflare.
      const calls = cf.calls.length;
      expect(await runNodeTunnelCleanupSweep(env, new Date(clock))).toMatchObject({ attempted: 0 });
      expect(cf.calls.length).toBe(calls);
      clock = Date.parse(pending!.cleanupNextAttemptAt!) + 1;
    }
    // 60 s, 120 s, then capped at 150 s (single-attempt requests: one call per failure).
    expect(delays[0]).toBeGreaterThanOrEqual(60_000);
    expect(delays[0]).toBeLessThan(61_000);
    expect(delays[1]).toBeGreaterThanOrEqual(120_000);
    expect(delays[1]).toBeLessThan(121_000);
    expect(delays[2]).toBeGreaterThanOrEqual(150_000);
    expect(delays[2]).toBeLessThan(151_000);
    expect(cf.callCount('tunnel.delete')).toBe(3);

    // Due again: the identity survived every failure, so the retry deletes exactly that tunnel.
    expect(await runNodeTunnelCleanupSweep(env, new Date(clock))).toMatchObject({
      attempted: 1,
      cleaned: 1,
    });
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned', lastError: null }]);
    expect(cf.liveTunnels()).toEqual([]);
  });

  it('a hard-deleted node row still gets its tunnel cleaned by the sweep', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
    expect(await runNodeTunnelCleanupSweep(env)).toMatchObject({ released: 1, cleaned: 1 });
    expect(cf.liveTunnels()).toEqual([]);
  });

  it('a live node is never released by the sweep (discriminating control)', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    await runNodeTunnelCleanupSweep(env);
    await runNodeTunnelCleanupSweep(env);
    expect(journal(node.id)).toMatchObject([{ status: 'active' }]);
    expect(cf.liveTunnels()).toHaveLength(1);
    expect(cf.records()).toHaveLength(1);
  });

  it('a replacement incarnation cleans the stale one first, and stale cleanup never touches the replacement', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    const [first] = journal(node.id);
    // Stale cleanup fails, so incarnation A still owns the shared hostname (and is in backoff).
    await deleteNodeResourcesStrict(node.id, USER, env);
    cf.inject('dns.get', { kind: 'status', status: 500 });
    expect(await runNodeTunnelCleanupSweep(env)).toMatchObject({ attempted: 1, cleaned: 0 });
    expect(journal(node.id)[0]).toMatchObject({ status: 'cleanup_pending', cleanupAttempts: 1 });

    // Re-provision the same node row (new incarnation B), as a durable re-allocation does.
    sqlite
      .prepare("UPDATE nodes SET status = 'creating', provider_instance_id = NULL WHERE id = ?")
      .run(node.id);
    await provisionNode(node.id, env);
    const rows = journal(node.id);
    expect(rows).toHaveLength(2);
    const second = rows.find((row) => row.id !== first?.id)!;
    expect(rows.find((row) => row.id === first?.id)).toMatchObject({ status: 'cleaned' });
    expect(second).toMatchObject({ status: 'active' });
    expect(readNode(node.id)).toMatchObject({ status: 'running', tunnelId: second.tunnelId });
    expect(cf.liveTunnels().map((tunnel) => tunnel.id)).toEqual([second.tunnelId]);
    expect(cf.records()).toEqual([
      expect.objectContaining({ content: `${second.tunnelId}.cfargotunnel.com` }),
    ]);

    // Replaying A's cleanup (e.g. a late duplicate sweep) cannot touch B's record or tunnel.
    sqlite
      .prepare(
        `UPDATE node_cloudflare_tunnels
            SET status = 'cleanup_pending', cleanup_next_attempt_at = NULL WHERE id = ?`
      )
      .run(first!.id);
    expect(await runNodeTunnelCleanupSweep(env)).toMatchObject({ attempted: 1, cleaned: 1 });
    expect(cf.liveTunnels().map((tunnel) => tunnel.id)).toEqual([second.tunnelId]);
    expect(cf.records()).toHaveLength(1);
  });

  it('fails closed when the configured Cloudflare account no longer matches the journal', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
    setEnv(tunnelEnv({ CF_ACCOUNT_ID: 'other-account' }));
    await runNodeTunnelCleanupSweep(env);
    expect(journal(node.id)).toMatchObject([
      {
        status: 'cleanup_pending',
        lastError: expect.stringContaining('different Cloudflare account'),
      },
    ]);
    expect(cf.liveTunnels()).toHaveLength(1);
  });

  it('Instant container teardown never reads or writes tunnel state', async () => {
    const container = await createNodeRecord(env, {
      userId: USER,
      name: 'Instant',
      vmSize: 'small',
      vmLocation: 'cf',
      heartbeatStaleAfterSeconds: 180,
      runtime: 'cf-container',
    });
    sqlite
      .prepare(
        `INSERT INTO node_cloudflare_tunnels (id, node_id, user_id, runtime_incarnation_id, account_id,
           zone_id, tunnel_name, hostname, status, cleanup_attempts, created_at, updated_at)
         VALUES ('sentinel', ?, ?, 'other', ?, ?, 'sentinel', 'h', 'active', 0, 'x', 'x')`
      )
      .run(container.id, USER, ACCOUNT, ZONE);
    await deleteNodeResourcesStrict(container.id, USER, env);
    expect(mocks.destroyContainer).toHaveBeenCalled();
    expect(cf.calls).toEqual([]);
    expect(journal(container.id)).toMatchObject([{ status: 'active' }]);
  });

  it('the shipped migration rejects an unknown journal status', () => {
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO node_cloudflare_tunnels (id, node_id, user_id, runtime_incarnation_id, account_id,
             zone_id, tunnel_name, hostname, status, cleanup_attempts, created_at, updated_at)
           VALUES ('bad', 'n', 'u', 'i', 'a', 'z', 't', 'h', 'deleted', 0, 'x', 'x')`
        )
        .run()
    ).toThrow(/CHECK constraint failed/);
  });
});
