/**
 * A GCP node whose create response was cut can reach `destroying` with no
 * `provider_instance_id` (self-host box, 2026-11-11, idea 01M74287JQTW56PJK28Q0DFRV3).
 * Strict deletion refused every non-Hetzner providerless node outright, so the VM kept
 * billing and the row never left `destroying`.
 *
 * Real SQL engine and real node-cleanup sweep; the real GcpProvider is resolved for the
 * node, and only Google's Compute API is faked at the fetch boundary.
 */
import { GcpProvider } from '@simple-agent-manager/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildNodeProviderLabels } from '../../../src/services/node-provider-labels';
import { handoffFixture } from './node-cleanup-handoff-fixture';

vi.mock('../../../src/services/jwt', () => ({
  signNodeCallbackToken: async () => 'test-token',
  signCurrentNodeCallbackToken: async () => 'test-token',
}));

const gcp = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock('../../../src/services/provider-credentials', async (load) => {
  const actual = await load<typeof import('../../../src/services/provider-credentials')>();
  return {
    ...actual,
    createProviderForUser: async (...args: Parameters<typeof actual.createProviderForUser>) =>
      gcp.provider
        ? { provider: gcp.provider, providerName: 'gcp', credentialSource: 'user' }
        : actual.createProviderForUser(...args),
  };
});

const PROJECT = 'sam-gcp';
const ZONE = 'europe-west1-b';
const API = `https://compute.googleapis.com/compute/v1/projects/${PROJECT}`;

afterEach(() => {
  gcp.provider = null;
  vi.unstubAllGlobals();
});

async function gcpProviderlessNode(inventory: 'exact' | 'empty' | 'foreign-installation') {
  const f = await handoffFixture();
  f.sqlite.exec(`DELETE FROM session_snapshots; DELETE FROM workspaces;`);
  f.sqlite
    .prepare(
      `UPDATE nodes
          SET status = 'destroying', provider_instance_id = NULL, cloud_provider = 'gcp',
              runtime_incarnation_id = 'incarnation-host', vm_location = ?,
              provider_instance_type = 'e2-standard-2',
              runtime_termination_confirmed_at = NULL, cleanup_backoff_until = NULL
        WHERE id = 'host'`
    )
    .run(ZONE);
  f.sqlite.prepare("UPDATE tasks SET status = 'failed', auto_provisioned_node_id = NULL").run();
  const node = f.sqlite.prepare("SELECT node_role FROM nodes WHERE id = 'host'").get() as {
    node_role: string;
  };
  const labels = buildNodeProviderLabels({
    nodeId: 'host',
    isDeploymentNode: node.node_role === 'deployment',
    environmentLabel: 'staging',
    installationId:
      inventory === 'foreign-installation'
        ? 'ffffffffffffffffffffffffffffffff'
        : '0123456789abcdef0123456789abcdef',
    runtimeIncarnationId: 'incarnation-host',
  });
  const instance = {
    id: '1861759100528809252',
    name: 'sam-node-host',
    status: 'RUNNING',
    zone: `${API}/zones/${ZONE}`,
    machineType: `${API}/zones/${ZONE}/machineTypes/e2-standard-2`,
    creationTimestamp: '2026-09-08T10:30:00.000Z',
    networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.7' }] }],
    disks: [{ boot: true, diskSizeGb: '50' }],
    labels: { 'sam-managed': 'true', ...labels },
  };
  const deletes: string[] = [];
  const lists: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.startsWith(`${API}/aggregated/instances`)) {
        lists.push(url);
        const live = inventory !== 'empty' && deletes.length === 0;
        // Google reports an empty zone with a NO_RESULTS_ON_PAGE warning, not an empty object.
        return Response.json({
          items: {
            [`zones/${ZONE}`]: live
              ? { instances: [instance] }
              : { warning: { code: 'NO_RESULTS_ON_PAGE', message: 'empty' } },
          },
        });
      }
      if (url === `${API}/zones/${ZONE}/instances/${instance.id}` && method === 'GET')
        return deletes.length === 0
          ? Response.json(instance)
          : Response.json({ error: { code: 404 } }, { status: 404 });
      if (url === `${API}/zones/${ZONE}/instances/${instance.name}` && method === 'DELETE') {
        deletes.push(url);
        return Response.json({ name: 'op-delete', status: 'PENDING' });
      }
      // The id lookup probes the provider's known zones; Google answers 404 where it is absent.
      if (url.includes('/zones/') && url.includes('/instances/') && method === 'GET')
        return Response.json({ error: { code: 404, message: 'not found' } }, { status: 404 });
      if (url.includes('/operations/')) return Response.json({ name: 'op-delete', status: 'DONE' });
      if (url.includes('api.cloudflare.com/client/v4/zones/'))
        return Response.json({ success: true });
      throw new Error(`Unexpected external boundary: ${method} ${url}`);
    })
  );
  gcp.provider = new GcpProvider(PROJECT, vi.fn().mockResolvedValue('gcp-token'), ZONE);
  return { ...f, deletes, lists };
}

function hostRow(f: Awaited<ReturnType<typeof gcpProviderlessNode>>) {
  return f.sqlite
    .prepare(
      "SELECT status, runtime_termination_confirmed_at, cleanup_blocked_reason, error_message FROM nodes WHERE id = 'host'"
    )
    .get() as Record<string, string | null>;
}

describe('a GCP node whose create was never confirmed (no provider_instance_id)', () => {
  it('finds its VM by exact ownership labels and deletes exactly that VM', async () => {
    const f = await gcpProviderlessNode('exact');
    await f.sweepDestroying();
    expect(f.deletes).toEqual([`${API}/zones/${ZONE}/instances/sam-node-host`]);
    expect(f.lists.length).toBeGreaterThan(0);
    expect(hostRow(f).runtime_termination_confirmed_at).toEqual(expect.any(String));
    expect(f.result).toMatchObject({ errors: 0 });
  });

  it('never deletes a VM labelled for another installation', async () => {
    const f = await gcpProviderlessNode('foreign-installation');
    await f.sweepDestroying();
    expect(f.deletes).toEqual([]);
    expect(f.result).toMatchObject({ errors: 1 });
    expect(hostRow(f)).toMatchObject({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
    });
  });

  it('with no VM left, refuses with a reason that names the manual-deletion escape', async () => {
    const f = await gcpProviderlessNode('empty');
    const warn = vi.spyOn(console, 'error');
    await f.sweepDestroying();
    expect(f.deletes).toEqual([]);
    expect(f.lists.length).toBeGreaterThan(0);
    expect(hostRow(f)).toMatchObject({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
    });
    const recorded = [
      ...warn.mock.calls.flat().map(String),
      ...Object.values(hostRow(f)).map(String),
    ].join('\n');
    expect(recorded).toMatch(/allocation remains unresolved despite empty inventory/);
    expect(recorded).toMatch(/I already deleted this server.*\/api\/nodes\/host\/manual-deletion/);
  });
});
