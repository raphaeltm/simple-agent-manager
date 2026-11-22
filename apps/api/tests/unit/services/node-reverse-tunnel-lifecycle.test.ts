// FILE SIZE EXCEPTION: cohesive provisioning/deletion vertical slice with shared real SQLite authority.
// Register shared boundary mocks before importing production services.
import './node-tunnel-fixture';

import { generateCloudInit } from '@simple-agent-manager/cloud-init';
import { ProviderError } from '@simple-agent-manager/providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureReverseTunnelLease, releaseNonLiveReverseTunnelLeases, releaseUnallocatedReverseTunnelLease, runReverseTunnelLeaseSweep } from '../../../src/selfhost/reverse-tunnel/leases';
import { installReverseTunnelTransport } from '../../../src/selfhost/reverse-tunnel/transport';
import { buildNodeProviderLabels } from '../../../src/services/node-provider-labels';
import { releaseTerminatedNodeIngress } from '../../../src/services/node-provisioning-ingress';
import { deleteCreatedProviderVmDirectly } from '../../../src/services/node-provisioning-race-cleanup';
import * as transportRegistry from '../../../src/services/node-transport-extension';
import { provisionNode } from '../../../src/services/nodes';
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
 * allocation on the self-host 0255 DDL (partial unique index, CHECKs), strict deletion, the cron
 * release sweep. Same boundary mocks as the Cloudflare
 * tunnel slice; the Cloudflare fake records every call so the test can prove none are made.
 */
// Built at runtime so no secret-shaped literal sits in the source (gitleaks).
const GATEWAY_SECRET = ['gateway', 'fixture', 'value', 'for', 'reverse', 'tunnel', 'tests'].join(
  '-'
);

// The fixture records cloud-init variables; render them with the real generator.
const realCloudInit = await vi.importActual<typeof import('@simple-agent-manager/cloud-init')>(
  '@simple-agent-manager/cloud-init'
);
const renderUserData = (vars: Record<string, unknown>) =>
  realCloudInit.generateCloudInit(vars as Parameters<typeof realCloudInit.generateCloudInit>[0]);

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

  applySqliteMigration(
    sqlite,
    new URL('../../../src/selfhost/migrations/0255_node_reverse_tunnel_leases.sql', import.meta.url)
  );
  installReverseTunnelTransport(generateCloudInit);
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
    expect(vars?.cloudflaredVersion).toBeUndefined();
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

  it('boots a deployment node on the tunnel: lease, no Origin CA, no public app ingress, no DNS', async () => {
    const node = await freshNode({ nodeRole: 'deployment' });
    await expect(
      provisionNode(node.id, env, undefined, undefined, { environmentId: 'env-1' })
    ).resolves.toEqual({ allocationConfirmed: true });

    expect(readNode(node.id)).toMatchObject({ status: 'running', transport: 'reverse-tunnel' });
    const [lease] = leases(node.id);
    expect(lease).toMatchObject({ status: 'active' });
    expect(mocks.createARecord).not.toHaveBeenCalled();
    expect(cf.calls).toEqual([]);

    const [vars] = mocks.cloudInitVars;
    expect(vars).toMatchObject({
      role: 'deployment',
      reverseTunnelRemotePort: String(lease?.port),
      originCaCertificateUrl: undefined,
    });
    const userData = renderUserData(vars!);
    expect(userData).not.toContain('origin_ca_bootstrap');
    expect(userData).not.toContain('origin-ca-certificate');
    expect(userData).toContain('Environment=DEPLOY_APP_INGRESS=tunnel');
    expect(userData).toContain('"$VM_AGENT_PORT" "$TUNNEL_PORT" 80 443');
    // No public 80/443 at the provider either (GCP's app-route network tag keys on this label).
    const [config] = mocks.createVM.mock.calls[0] ?? [];
    expect((config as { labels: Record<string, string> }).labels).toMatchObject({
      role: 'deployment',
      'app-ingress': 'tunnel',
    });
  });

  it.each([undefined, 'vm-public-dns'])(
    'control: with VM_AGENT_TRANSPORT=%j a deployment node keeps public ingress and its Origin CA',
    async (transport) => {
      setEnv(reverseEnv({ VM_AGENT_TRANSPORT: transport }));
      const node = await freshNode({ nodeRole: 'deployment' });
      await provisionNode(node.id, env, undefined, undefined, { environmentId: 'env-1' });
      expect(readNode(node.id)?.transport).toBe('vm-public-dns');
      expect(leases(node.id)).toEqual([]);
      expect(mocks.createARecord).toHaveBeenCalled();
      const [vars] = mocks.cloudInitVars;
      expect(vars?.originCaCertificateUrl).toContain('/origin-ca-certificate');
      expect(renderUserData(vars!)).not.toContain('DEPLOY_APP_INGRESS');
      const [config] = mocks.createVM.mock.calls[0] ?? [];
      expect((config as { labels: Record<string, string> }).labels['app-ingress']).toBeUndefined();
    }
  );

  it.each([undefined, 'vm-public-dns', 'cloudflare-tunnel'])(
    'durable resume recovers its original reverse lease after transport changes to %j',
    async (transport) => {
      const node = await freshNode();
      const durable = { createdAt: Date.now(), initialIncarnationId: readNode(node.id)!.incarnation!, incarnationId: crypto.randomUUID() };
      mocks.createVM.mockRejectedValueOnce(new ProviderError('hetzner', undefined, 'socket hang up'));
      await expect(provisionNode(node.id, env, undefined, { durableAllocation: durable })).rejects.toThrow();
      const before = leases(node.id);
      const firstCredential = mocks.cloudInitVars[0]?.reverseTunnelCredential;
      expect(typeof firstCredential).toBe('string');
      const listVMs = vi.fn().mockImplementation(async (labels) => [{ ...vmFor(), labels }]);
      mocks.createProvider.mockResolvedValue({ ...provider, provider: { ...provider.provider, listVMs } });
      setEnv(reverseEnv({ VM_AGENT_TRANSPORT: transport }));
      const statements = vi.spyOn(env.DATABASE, 'prepare');
      await expect(provisionNode(node.id, env, undefined, { durableAllocation: durable })).resolves.toEqual({ allocationConfirmed: true });
      expect(listVMs).toHaveBeenCalledOnce();
      expect(mocks.createVM).toHaveBeenCalledOnce();
      expect(readNode(node.id)?.transport).toBe('reverse-tunnel');
      expect(leases(node.id)).toEqual(before);
      expect(mocks.cloudInitVars).toHaveLength(2);
      expect(mocks.cloudInitVars[1]?.reverseTunnelCredential).toBe(firstCredential);
      expect(statements.mock.calls.some(([sql]) => /(?:INSERT INTO|UPDATE) node_reverse_tunnel_leases/i.test(sql))).toBe(false);
      await deleteNodeResourcesStrict(node.id, USER, env);
      expect(leases(node.id)).toMatchObject([{ status: 'released', releaseReason: 'runtime_terminated' }]);
    }
  );

  it('disabled reverse admission cannot create a missing lease on a stored reverse node', async () => {
    const node = await freshNode();
    const incarnation = readNode(node.id)!.incarnation!;
    sqlite.prepare("UPDATE nodes SET transport='reverse-tunnel' WHERE id=?").run(node.id);
    setEnv(reverseEnv({ VM_AGENT_TRANSPORT: 'vm-public-dns' }));
    const statements = vi.spyOn(env.DATABASE, 'prepare');
    await expect(ensureReverseTunnelLease(env, { nodeId: node.id, userId: USER, runtimeIncarnationId: incarnation })).rejects.toThrow('Reverse tunnel is disabled');
    expect(leases(node.id)).toEqual([]);
    expect(statements.mock.calls.some(([sql]) => /(?:INSERT INTO|UPDATE) node_reverse_tunnel_leases/i.test(sql))).toBe(false);
  });

  it.each([
    ["user_id='another-owner'", 'incarnation_not_live'],
    ["runtime_incarnation_id='another-incarnation'", 'incarnation_not_live'],
    ["runtime_termination_confirmed_at='2026-01-01T00:00:00.000Z'", 'incarnation_not_live'],
    ["status='destroying'", 'incarnation_not_live'],
    ["transport='vm-public-dns'", 'incarnation_not_live'],
    ["node_class='user-owned'", 'incarnation_not_live'],
    ["runtime='cf-container'", 'incarnation_not_live'],
  ])('existing lease adoption refuses changed live owner: %s', async (mutation, code) => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    const incarnation = readNode(node.id)!.incarnation!;
    sqlite.prepare(`UPDATE nodes SET ${mutation} WHERE id=?`).run(node.id);
    setEnv(reverseEnv({ VM_AGENT_TRANSPORT: 'vm-public-dns' }));
    await expect(ensureReverseTunnelLease(env, { nodeId: node.id, userId: USER, runtimeIncarnationId: incarnation })).rejects.toMatchObject({ code });
    expect(leases(node.id)).toMatchObject([{ status: 'active' }]);
  });

  it('released lease cannot be adopted when reverse admission is disabled', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    const incarnation = readNode(node.id)!.incarnation!;
    sqlite.prepare("UPDATE node_reverse_tunnel_leases SET status='released' WHERE node_id=?").run(node.id);
    setEnv(reverseEnv({ VM_AGENT_TRANSPORT: 'vm-public-dns' }));
    await expect(ensureReverseTunnelLease(env, { nodeId: node.id, userId: USER, runtimeIncarnationId: incarnation })).rejects.toMatchObject({ code: 'lease_released' });
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

  it('strict deletion releases it, and the port is reissued only after the minimum reuse age', async () => {
    setEnv(
      reverseEnv({
        REVERSE_TUNNEL_PORT_RANGE_START: '20600',
        REVERSE_TUNNEL_PORT_RANGE_END: '20600',
      })
    );
    const start = Date.parse('2026-11-10T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    try {
      const node = await freshNode();
      await provisionNode(node.id, env);
      await deleteNodeResourcesStrict(node.id, USER, env);
      expect(mocks.deleteVM).toHaveBeenCalled();
      expect(leases(node.id)).toMatchObject([
        { status: 'released', releaseReason: 'runtime_terminated', port: 20600 },
      ]);

      // The incident: the only port was just released, and the previous holder's frpc may still
      // be connected. A new node must NOT get it; the failure names the cooling-down reason.
      vi.setSystemTime(start + 179_000);
      const tooSoon = await freshNode();
      await provisionNode(tooSoon.id, env);
      expect(leases(tooSoon.id)).toEqual([]);
      expect(mocks.createVM).toHaveBeenCalledTimes(1);
      expect(
        sqlite.prepare('SELECT status, error_message AS e FROM nodes WHERE id = ?').get(tooSoon.id)
      ).toMatchObject({
        status: 'error',
        e: expect.stringContaining('released less than 180s ago'),
      });

      // Once the release is older than 2 x the 90 s frps heartbeat timeout, it is reissued.
      vi.setSystemTime(start + 181_000);
      const next = await freshNode();
      await provisionNode(next.id, env);
      expect(leases(next.id)).toMatchObject([{ status: 'active', port: 20600 }]);
    } finally {
      vi.useRealTimers();
    }
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

describe('the installed reverse driver owns cleanup across admission changes', () => {
  it.each([undefined, 'vm-public-dns', 'cloudflare-tunnel'])(
    'sweep after selection changes to %j releases all nonlive owners and preserves live ones',
    async (transport) => {
      const gone = await freshNode(); const replaced = await freshNode();
      const terminated = await freshNode(); const live = await freshNode();
      const labelledDeleted = await freshNode();
      for (const node of [gone, replaced, terminated, live, labelledDeleted]) await provisionNode(node.id, env);
      sqlite.prepare('DELETE FROM nodes WHERE id=?').run(gone.id);
      sqlite.prepare("UPDATE nodes SET runtime_incarnation_id='replacement' WHERE id=?").run(replaced.id);
      sqlite.prepare("UPDATE nodes SET runtime_termination_confirmed_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(terminated.id);
      sqlite.prepare("UPDATE nodes SET status='deleted' WHERE id=?").run(labelledDeleted.id);
      setEnv(reverseEnv({ VM_AGENT_TRANSPORT: transport }));
      expect(await runReverseTunnelLeaseSweep(env)).toEqual({ released: 3 });
      expect(await runReverseTunnelLeaseSweep(env)).toEqual({ released: 0 });
      for (const node of [gone, replaced, terminated]) expect(leases(node.id)).toMatchObject([{ status: 'released' }]);
      for (const node of [live, labelledDeleted]) expect(leases(node.id)).toMatchObject([{ status: 'active' }]);
    }
  );
});

describe('F19 release paths', () => {
  it.each([undefined, 'vm-public-dns', 'cloudflare-tunnel'])('a confirmed direct provider delete releases only its exact incarnation after selection changes to %j', async (transport) => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    const sibling = await freshNode(); await provisionNode(sibling.id, env);
    const current = readNode(node.id)!;
    setEnv(reverseEnv({ VM_AGENT_TRANSPORT: transport }));
    await deleteCreatedProviderVmDirectly({ env, provider: provider.provider,
      providerInstanceId: current.providerInstanceId!, nodeId: node.id,
      runtimeIncarnationId: current.incarnation });
    expect(mocks.deleteVM).toHaveBeenCalledWith(current.providerInstanceId);
    expect(leases(node.id)).toMatchObject([{ status: 'released', releaseReason: 'provider_vm_deleted_directly' }]);
    expect(leases(sibling.id)).toMatchObject([{ status: 'active' }]);
  });
  it('a failed direct provider delete does not release a possibly live lease', async () => {
    const node = await freshNode(); await provisionNode(node.id, env);
    mocks.deleteVM.mockRejectedValueOnce(new Error('provider unreachable'));
    const current = readNode(node.id)!;
    await deleteCreatedProviderVmDirectly({ env, provider: provider.provider,
      providerInstanceId: current.providerInstanceId!, nodeId: node.id, runtimeIncarnationId: current.incarnation });
    expect(leases(node.id)).toMatchObject([{ status: 'active' }]);
  });
  it('the backstop recovers a failed teardown release, then is idempotent and preserves a live sibling', async () => {
    const node = await freshNode(); const live = await freshNode();
    await provisionNode(node.id, env); await provisionNode(live.id, env);
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    let failed = false;
    vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql) => {
      if (!failed && /UPDATE node_reverse_tunnel_leases/.test(sql)) {
        failed = true; throw new Error('one failed lease release');
      }
      return prepare(sql);
    });
    await deleteNodeResourcesStrict(node.id, USER, env);
    expect(failed).toBe(true); expect(readNode(node.id)?.proof).toBeTruthy();
    expect(leases(node.id)).toMatchObject([{ status: 'active' }]);
    expect(await runReverseTunnelLeaseSweep(env)).toEqual({ released: 1 });
    expect(await runReverseTunnelLeaseSweep(env)).toEqual({ released: 0 });
    expect(leases(node.id)).toMatchObject([{ status: 'released' }]);
    expect(leases(live.id)).toMatchObject([{ status: 'active' }]);
  });
  it.each([true, false])('providerless destroying inventory found=%s releases only on confirmed deletion', async (found) => {
    const node = await freshNode(); await provisionNode(node.id, env);
    const current = readNode(node.id)!;
    const nodeCreatedAt = new Date(Date.now() - 7200000).toISOString();
    const vm = { ...vmFor(), id: current.providerInstanceId!,
      labels: buildNodeProviderLabels({ nodeId: node.id, isDeploymentNode: false,
        runtimeIncarnationId: current.incarnation!, environmentLabel: 'test',
        installationId: env.SAM_INSTALLATION_ID! }),
      createdAt: new Date(Date.now() - 3600000).toISOString() };
    sqlite.prepare(`UPDATE nodes SET status='destroying', provider_instance_id=NULL,
      created_at=?, workload_role='workspace', capacity_source_id='source-1',
      placement_credential_source='user', placement_credential_reference='cred-1',
      placement_credential_version=1, placement_credential_fingerprint='fingerprint-1',
      capacity_pool_scope='user', capacity_pool_revision=1, capacity_source_generation=1,
      capacity_pool_id='pool-1', capacity_pool_candidate_id='candidate-1',
      provider_instance_vcpu_count=4, provider_instance_memory_mb=8192 WHERE id=?`).run(nodeCreatedAt, node.id);
    mocks.createProvider.mockResolvedValueOnce({ ...provider, provider: { ...provider.provider,
      listVMs: vi.fn().mockResolvedValue(found ? [vm] : []), getVM: vi.fn().mockResolvedValue(vm) } });
    const deletion = deleteNodeResourcesStrict(node.id, USER, env);
    if (found) {
      await expect(deletion).resolves.toMatchObject({ runtimeTerminationConfirmedAt: expect.any(String) });
      expect(mocks.deleteVM).toHaveBeenCalled();
      expect(leases(node.id)).toMatchObject([{ status: 'released' }]);
    } else {
      await expect(deletion).rejects.toThrow();
      expect(mocks.deleteVM).not.toHaveBeenCalled();
      expect(leases(node.id)).toMatchObject([{ status: 'active' }]);
    }
  });
});

describe('lease allocation bounds and C18', () => {
  it('distinguishes full, cooling, reusable and unknown release time at a 20k-port outer bound', async () => {
    env.REVERSE_TUNNEL_PORT_RANGE_START = '20000'; env.REVERSE_TUNNEL_PORT_RANGE_END = '39999';
    const node = await freshNode();
    sqlite.prepare("UPDATE nodes SET runtime_incarnation_id='new-incarnation', runtime_termination_confirmed_at=NULL, transport='reverse-tunnel' WHERE id=?").run(node.id);
    // More historical rows than the maximum candidate range, with production indexes.
    sqlite.exec(`WITH RECURSIVE ports(p) AS (SELECT 20000 UNION ALL SELECT p+1 FROM ports WHERE p<39999)
      INSERT INTO node_reverse_tunnel_leases(id,node_id,user_id,runtime_incarnation_id,port,credential_hash,status,created_at,updated_at)
      SELECT 'lease-'||p,'node-'||p,'user','incarnation',p,'hash','active','now','now' FROM ports;
      WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<20001)
      INSERT INTO node_reverse_tunnel_leases(id,node_id,user_id,runtime_incarnation_id,port,credential_hash,status,created_at,updated_at,released_at)
      SELECT 'history-'||n,'old-node-'||n,'user','incarnation',20000,'hash','released','old','old','2000-01-01T00:00:00.000Z' FROM history;`);
    const input = { nodeId: node.id, userId: USER, runtimeIncarnationId: 'new-incarnation' };
    await expect(ensureReverseTunnelLease(env, input)).rejects.toMatchObject({ code: 'port_range_exhausted' });
    const now = Date.now();
    sqlite.prepare("UPDATE node_reverse_tunnel_leases SET status='released', released_at=? WHERE id='lease-20000'").run(new Date(now).toISOString());
    await expect(ensureReverseTunnelLease(env, input)).rejects.toMatchObject({ code: 'port_range_cooling_down' });
    sqlite.exec("UPDATE node_reverse_tunnel_leases SET released_at=NULL WHERE id='lease-20000'");
    await expect(ensureReverseTunnelLease(env, input)).rejects.toMatchObject({ code: 'port_range_cooling_down' });
    sqlite.prepare("UPDATE node_reverse_tunnel_leases SET released_at=? WHERE id='lease-20000'").run(new Date(now-181000).toISOString());
    await expect(ensureReverseTunnelLease(env, input)).resolves.toMatchObject({ port: 20000 });
    await expect(ensureReverseTunnelLease(env, { ...input, userId: 'foreign-user' })).rejects.toMatchObject({ code: 'lease_released' });
  });
  it.each([undefined, 'cloudflare-tunnel', 'vm-public-dns', 'reverse-tunnel'])(
    'C18: without an installed reverse driver all releases/sweep issue zero SQL even with selection %j',
    async (transport) => {
      const node = await freshNode(); await provisionNode(node.id, env);
      const incarnation = readNode(node.id)!.incarnation!;
      sqlite.prepare('DELETE FROM nodes WHERE id=?').run(node.id);
      setEnv(reverseEnv({ VM_AGENT_TRANSPORT: transport }));
      const prepare = vi.spyOn(env.DATABASE, 'prepare');
      const installed = vi.spyOn(transportRegistry, 'nodeTransportExtension').mockReturnValue(undefined);
      try {
        expect(await releaseUnallocatedReverseTunnelLease(env, node.id, incarnation, 'control')).toBe(false);
        expect(await releaseNonLiveReverseTunnelLeases(env, 'control')).toBe(0);
        expect(await runReverseTunnelLeaseSweep(env)).toEqual({ released: null, skipReason: 'driver_not_installed' });
        await releaseTerminatedNodeIngress(env, { id: node.id, runtime: 'vm', transport: 'reverse-tunnel' });
        expect(prepare).not.toHaveBeenCalled();
        expect(leases(node.id)).toMatchObject([{ status: 'active' }]);
      } finally { installed.mockRestore(); prepare.mockRestore(); }
      // The same releasable row is cleaned when its owning build driver is installed.
      expect(await runReverseTunnelLeaseSweep(env)).toEqual({ released: 1 });
      expect(leases(node.id)).toMatchObject([{ status: 'released' }]);
    }
  );
});
