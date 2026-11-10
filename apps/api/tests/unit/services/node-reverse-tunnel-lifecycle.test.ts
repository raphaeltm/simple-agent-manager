// Register shared boundary mocks before importing production services.
import './node-tunnel-fixture';

import { ProviderError } from '@simple-agent-manager/providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchNodeAgent } from '../../../src/services/node-agent';
import { runReverseTunnelLeaseSweep } from '../../../src/services/node-reverse-tunnel-leases';
import { createNodeRecord, provisionNode } from '../../../src/services/nodes';
import { deleteNodeResourcesStrict } from '../../../src/services/strict-node-deletion';
import { applySqliteMigration } from '../../helpers/sqlite-d1';
import {
  allStoredText,
  cf,
  env,
  freshNode,
  mocks,
  provider,
  readNode,
  setEnv,
  sqlite,
  tunnelEnv,
  USER,
  vmFor,
} from './node-tunnel-fixture';

/**
 * Vertical slice for the reverse-tunnel (frp) transport: the real provisionNode, lease
 * allocation on the SHIPPED 0232 DDL (partial unique index, CHECKs), strict deletion, the cron
 * release sweep and the fetchNodeAgent routing seam. Same boundary mocks as the Cloudflare
 * tunnel slice; the Cloudflare fake records every call so the test can prove none are made.
 */
// Built at runtime so no secret-shaped literal sits in the source (gitleaks).
const GATEWAY_SECRET = ['gateway', 'fixture', 'value', 'for', 'reverse', 'tunnel', 'tests'].join(
  '-'
);

function reverseEnv(overrides: Record<string, string | undefined> = {}) {
  return tunnelEnv({
    VM_AGENT_TRANSPORT: 'reverse-tunnel',
    REVERSE_TUNNEL_GATEWAY_SECRET: GATEWAY_SECRET,
    ENCRYPTION_KEY: 'test-encryption-key-for-reverse-tunnel-credentials',
    CF_API_TOKEN: undefined,
    CF_ACCOUNT_ID: undefined,
    CF_ZONE_ID: undefined,
    ...overrides,
  });
}

interface LeaseView {
  id: string;
  runtimeIncarnationId: string;
  port: number;
  credentialHash: string;
  status: string;
  releaseReason: string | null;
}
function leases(nodeId: string): LeaseView[] {
  return sqlite
    .prepare(
      `SELECT id, runtime_incarnation_id AS runtimeIncarnationId, port,
              credential_hash AS credentialHash, status, release_reason AS releaseReason
         FROM node_reverse_tunnel_leases WHERE node_id = ? ORDER BY created_at, id`
    )
    .all(nodeId) as LeaseView[];
}

beforeEach(() => {
  // Exercise the shipped DDL, not the schema-derived approximation.
  sqlite.exec('DROP TABLE node_reverse_tunnel_leases');
  applySqliteMigration(
    sqlite,
    new URL('../../../src/db/migrations/0232_node_reverse_tunnel_leases.sql', import.meta.url)
  );
  setEnv(reverseEnv());
});

describe('reverse-tunnel provisioning', () => {
  it('leases a port before the VM exists and boots it with frpc, no DNS, no Origin CA, no Cloudflare', async () => {
    const node = await freshNode();
    mocks.createVM.mockImplementationOnce(async () => {
      const [lease] = leases(node.id);
      expect(lease).toMatchObject({ status: 'active', port: 20000 });
      expect(readNode(node.id)?.transport).toBe('reverse-tunnel');
      return vmFor();
    });

    await expect(provisionNode(node.id, env)).resolves.toEqual({ allocationConfirmed: true });

    const view = readNode(node.id)!;
    const [lease] = leases(node.id);
    expect(lease).toMatchObject({ status: 'active', runtimeIncarnationId: view.incarnation });
    expect(view).toMatchObject({
      status: 'running',
      transport: 'reverse-tunnel',
      tunnelId: null,
      tunnelName: null,
      backendDnsRecordId: null,
    });
    expect(mocks.createARecord).not.toHaveBeenCalled();
    expect(cf.calls).toEqual([]);

    const [vars] = mocks.cloudInitVars;
    expect(vars).toMatchObject({
      reverseTunnelRemotePort: String(lease?.port),
      reverseTunnelLocalPort: '8444',
      originCaCertificateUrl: undefined,
    });
    expect(vars?.cloudflareTunnelToken).toBeUndefined();
    const credential = vars?.reverseTunnelCredential as string;
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The credential reaches cloud-init only; D1 holds its hash.
    expect(allStoredText()).not.toContain(credential);
    expect(lease?.credentialHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives concurrent nodes distinct ports', async () => {
    const nodes = await Promise.all(Array.from({ length: 6 }, () => freshNode()));
    await Promise.all(nodes.map((n) => provisionNode(n.id, env)));
    const ports = nodes.map((n) => leases(n.id)[0]?.port);
    expect(new Set(ports).size).toBe(6);
  });

  it('an exhausted range fails before any VM is requested', async () => {
    setEnv(
      reverseEnv({
        REVERSE_TUNNEL_PORT_RANGE_START: '20500',
        REVERSE_TUNNEL_PORT_RANGE_END: '20500',
      })
    );
    const first = await freshNode();
    const second = await freshNode();
    await provisionNode(first.id, env);
    await provisionNode(second.id, env);
    expect(mocks.createVM).toHaveBeenCalledTimes(1);
    expect(readNode(second.id)?.status).toBe('error');
    expect(leases(second.id)).toEqual([]);
  });

  it('refuses to provision without the gateway secret (fail closed, no lease, no VM)', async () => {
    setEnv(reverseEnv({ REVERSE_TUNNEL_GATEWAY_SECRET: 'too-short' }));
    const node = await freshNode();
    await provisionNode(node.id, env);
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(readNode(node.id)?.status).toBe('error');
    expect(leases(node.id)).toEqual([]);
  });

  it.each([undefined, 'vm-public-dns'])(
    'control: with VM_AGENT_TRANSPORT=%j a managed node stays on public DNS with no lease',
    async (transport) => {
      setEnv(reverseEnv({ VM_AGENT_TRANSPORT: transport }));
      const node = await freshNode();
      await provisionNode(node.id, env);
      expect(readNode(node.id)?.transport).toBe('vm-public-dns');
      expect(leases(node.id)).toEqual([]);
      expect(mocks.createARecord).toHaveBeenCalled();
      const [vars] = mocks.cloudInitVars;
      expect(vars?.reverseTunnelCredential).toBeUndefined();
      expect(vars?.originCaCertificateUrl).toContain('/origin-ca-certificate');
    }
  );

  it('excludes deployment nodes and keeps them on public DNS', async () => {
    const node = await freshNode({ nodeRole: 'deployment' });
    await provisionNode(node.id, env, undefined, undefined, { environmentId: 'env-1' });
    expect(readNode(node.id)?.transport).toBe('vm-public-dns');
    expect(leases(node.id)).toEqual([]);
    expect(mocks.createARecord).toHaveBeenCalled();
  });

  it('a durable resume adopts the same lease and re-derives the same credential', async () => {
    const node = await freshNode();
    const initial = readNode(node.id)!.incarnation!;
    const incarnationId = crypto.randomUUID();
    const durable = { createdAt: Date.now(), initialIncarnationId: initial, incarnationId };
    mocks.createVM.mockRejectedValueOnce(new ProviderError('hetzner', undefined, 'socket hang up'));
    await expect(
      provisionNode(node.id, env, undefined, { durableAllocation: durable })
    ).rejects.toThrow();
    const before = leases(node.id);
    expect(before).toMatchObject([{ status: 'active', runtimeIncarnationId: incarnationId }]);
    const firstCredential = mocks.cloudInitVars[0]?.reverseTunnelCredential;

    const listVMs = vi.fn().mockResolvedValue([]);
    mocks.createProvider.mockResolvedValue({
      ...provider,
      provider: { ...provider.provider, listVMs },
    });
    await expect(
      provisionNode(node.id, env, undefined, { durableAllocation: durable })
    ).rejects.toThrow();
    expect(leases(node.id)).toEqual(before);
    for (const vars of mocks.cloudInitVars) {
      expect(vars.reverseTunnelCredential).toBe(firstCredential);
    }
  });
});

describe('every lifecycle path releases the lease', () => {
  it('authority revoked just before createVM (no VM requested) releases it', async () => {
    const node = await freshNode();
    mocks.assertPlan.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
    await provisionNode(node.id, env);
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(leases(node.id)).toMatchObject([
      { status: 'released', releaseReason: 'provisioning_failed_before_vm' },
    ]);
  });

  it('a provider capacity rejection (node row deleted) releases it', async () => {
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
    expect(leases(node.id)).toMatchObject([{ status: 'released' }]);
  });

  it('an ambiguous createVM keeps it (a VM may hold its credential) across two sweeps', async () => {
    const node = await freshNode();
    mocks.createVM.mockRejectedValueOnce(
      new ProviderError('hetzner', undefined, 'Network timeout')
    );
    await provisionNode(node.id, env);
    expect(leases(node.id)).toMatchObject([{ status: 'active' }]);
    expect(await runReverseTunnelLeaseSweep(env)).toEqual({ released: 0 });
    expect(await runReverseTunnelLeaseSweep(env)).toEqual({ released: 0 });
    expect(leases(node.id)).toMatchObject([{ status: 'active' }]);
  });

  it('strict deletion releases it after termination proof, and the port is reusable', async () => {
    setEnv(
      reverseEnv({
        REVERSE_TUNNEL_PORT_RANGE_START: '20600',
        REVERSE_TUNNEL_PORT_RANGE_END: '20600',
      })
    );
    const node = await freshNode();
    await provisionNode(node.id, env);
    await deleteNodeResourcesStrict(node.id, USER, env);
    expect(mocks.deleteVM).toHaveBeenCalled();
    expect(leases(node.id)).toMatchObject([
      { status: 'released', releaseReason: 'runtime_terminated', port: 20600 },
    ]);
    const next = await freshNode();
    await provisionNode(next.id, env);
    expect(leases(next.id)).toMatchObject([{ status: 'active', port: 20600 }]);
  });

  it('a repeated strict deletion on the existing-proof path keeps it released', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    await deleteNodeResourcesStrict(node.id, USER, env);
    sqlite.exec("UPDATE node_reverse_tunnel_leases SET status = 'active'");
    await deleteNodeResourcesStrict(node.id, USER, env);
    expect(leases(node.id)).toMatchObject([{ status: 'released' }]);
  });

  it('the sweep releases a hard-deleted node row and a replaced incarnation, never a live one', async () => {
    const gone = await freshNode();
    const replaced = await freshNode();
    const live = await freshNode();
    for (const n of [gone, replaced, live]) await provisionNode(n.id, env);
    sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(gone.id);
    sqlite
      .prepare('UPDATE nodes SET runtime_incarnation_id = ? WHERE id = ?')
      .run(crypto.randomUUID(), replaced.id);
    expect(await runReverseTunnelLeaseSweep(env)).toEqual({ released: 2 });
    expect(leases(gone.id)).toMatchObject([
      { status: 'released', releaseReason: 'runtime_not_live' },
    ]);
    expect(leases(replaced.id)).toMatchObject([{ status: 'released' }]);
    expect(leases(live.id)).toMatchObject([{ status: 'active' }]);
    expect(await runReverseTunnelLeaseSweep(env)).toEqual({ released: 0 });
  });
});

describe('control plane -> node routing seam', () => {
  it('routes a reverse-tunnel node to its loopback lease port and never to public DNS', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    const port = leases(node.id)[0]!.port;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response('ok');
    }) as typeof fetch;
    await fetchNodeAgent(
      node.id,
      env,
      `https://${node.id.toLowerCase()}.vm.example.test:8443/health?x=1`,
      { method: 'GET' },
      1000
    );
    expect(seen).toEqual([`http://127.0.0.1:${port}/health?x=1`]);

    // Released lease: fail closed, no request at all (no DNS record exists to fall back to).
    await deleteNodeResourcesStrict(node.id, USER, env);
    seen.length = 0;
    await expect(
      fetchNodeAgent(
        node.id,
        env,
        `https://${node.id.toLowerCase()}.vm.example.test:8443/health`,
        {},
        1000
      )
    ).rejects.toThrow(/no active lease/);
    expect(seen).toEqual([]);
  });

  it('never routes to a lease held by a superseded incarnation', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    sqlite
      .prepare('UPDATE nodes SET runtime_incarnation_id = ? WHERE id = ?')
      .run(crypto.randomUUID(), node.id);
    expect(leases(node.id)).toMatchObject([{ status: 'active' }]);
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response('ok');
    }) as typeof fetch;
    await expect(
      fetchNodeAgent(
        node.id,
        env,
        `https://${node.id.toLowerCase()}.vm.example.test:8443/health`,
        {},
        1000
      )
    ).rejects.toThrow(/no active lease/);
    expect(seen).toEqual([]);
  });

  it.each(['vm-public-dns', 'cloudflare-tunnel', null] as const)(
    'control: a %s node is still fetched at its public backend URL unchanged',
    async (transport) => {
      const node = await createNodeRecord(env, {
        userId: USER,
        name: 'n',
        vmSize: 'medium',
        vmLocation: 'nbg1',
        heartbeatStaleAfterSeconds: 180,
        cloudProvider: 'hetzner',
        runtime: 'vm',
      });
      sqlite.prepare('UPDATE nodes SET transport = ? WHERE id = ?').run(transport, node.id);
      const seen: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        seen.push(String(input instanceof Request ? input.url : input));
        return new Response('ok');
      }) as typeof fetch;
      const url = `https://${node.id.toLowerCase()}.vm.example.test:8443/health`;
      await fetchNodeAgent(node.id, env, url, { method: 'GET' }, 1000);
      expect(seen).toEqual([url]);
    }
  );
});
