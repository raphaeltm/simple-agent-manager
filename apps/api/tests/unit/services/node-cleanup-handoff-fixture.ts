import { expect, vi } from 'vitest';

import {
  sweepDestroyingHandoffNodes,
  sweepStoppedHandoffNodes,
} from '../../../src/scheduled/node-cleanup/node-phases';
import { emptyResult, resolveCleanupConfig } from '../../../src/scheduled/node-cleanup/shared';
import { clearCapacityCatalogCache } from '../../../src/services/default-capacity-source-credentials';
import { encrypt } from '../../../src/services/encryption';
import { fingerprintEncryptedProviderCredential } from '../../../src/services/provider-credential-exact';
import { fixture, seedHost } from '../routes/node-pool-upgrade-test-helpers';
const NOW = new Date('2026-09-08T12:00:00.000Z');
const OLD = '2026-09-08T10:00:00.000Z';
export async function handoffFixture(scope: 'user' | 'installation' = 'user') {
  const f = fixture(scope);
  f.env.ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  f.env.ENVIRONMENT = 'staging';
  f.env.SAM_INSTALLATION_ID = '0123456789abcdef0123456789abcdef';
  const token = await encrypt('test-provider-token', f.env.ENCRYPTION_KEY);
  const credentialTable = scope === 'installation' ? 'platform_credentials' : 'credentials';
  f.sqlite
    .prepare(`UPDATE ${credentialTable} SET encrypted_token = ?, iv = ?`)
    .run(token.ciphertext, token.iv);
  const providerDeletes: string[] = [];
  const rejectedProviderIds = new Set<string>();
  const rejectedInventoryNodeIds = new Set<string>();
  const inventoryModeByNodeId = new Map<
    string,
    | 'exact'
    | 'foreign-installation'
    | 'foreign-environment'
    | 'ambiguous'
    | 'duplicate'
    | 'malformed'
    | 'changed-identity'
  >();
  const inventoryServerById = new Map<string, Record<string, unknown>>();
  const hangingProviderIds = new Set<string>();
  const providerSignals: AbortSignal[] = [];
  const inventorySignals: AbortSignal[] = [];
  const inventorySelectors: Array<Record<string, string>> = [];
  const providerGets: string[] = [];
  const dnsRequests: string[] = [];
  let hangDns: 'request' | 'error-body' | undefined;
  let rejectCreateDuringDestroy = false;
  function waitForAbort(signal: AbortSignal) {
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.hetzner.cloud/v1/server_types')) {
        return Response.json({
          server_types: [
            {
              id: 1,
              name: 'cx23',
              description: 'CX23',
              cores: 2,
              memory: 4,
              disk: 40,
              architecture: 'x86',
              cpu_type: 'shared',
              deprecated: false,
              prices: [
                {
                  location: 'fsn1',
                  price_hourly: { net: '0.0048', gross: '0.0048' },
                  price_monthly: { net: '3.99', gross: '3.99' },
                },
              ],
            },
          ],
          meta: { pagination: { next_page: null } },
        });
      }
      if (url.includes('/servers/') && init?.method === 'DELETE') {
        providerDeletes.push(url);
        if (hangingProviderIds.has(url.split('/').at(-1)!)) {
          providerSignals.push(init.signal!);
          return waitForAbort(init.signal!);
        }
        if (rejectedProviderIds.has(url.split('/').at(-1)!)) {
          return Response.json(
            { error: { code: 'forbidden', message: 'Provider refused deletion' } },
            { status: 403 }
          );
        }
        return new Response(null, { status: 204 });
      }
      if (url.includes('api.hetzner.cloud/v1/servers?') && !init?.method) {
        if (init?.signal) inventorySignals.push(init.signal);
        const selector = new URL(url).searchParams.get('label_selector') ?? '';
        const nodeId = selector
          .split(',')
          .find((part) => part.startsWith('node='))
          ?.slice('node='.length);
        const labels = Object.fromEntries(
          selector.split(',').map((part) => {
            const separator = part.indexOf('=');
            return [part.slice(0, separator), part.slice(separator + 1)];
          })
        );
        inventorySelectors.push({ ...labels });
        if (nodeId && rejectedInventoryNodeIds.has(nodeId)) {
          return Response.json(
            { error: { code: 'service_error', message: 'Inventory unavailable' } },
            { status: 503 }
          );
        }
        const mode = nodeId ? inventoryModeByNodeId.get(nodeId) : undefined;
        const inventoryLabels: Record<string, string> = nodeId
          ? {
              node: nodeId,
              managed: 'simple-agent-manager',
              role: 'workspace',
              env: 'staging',
              installation: '0123456789abcdef0123456789abcdef',
              incarnation: `incarnation-${nodeId}`,
            }
          : {};
        if (mode === 'foreign-installation')
          inventoryLabels.installation = 'fedcba9876543210fedcba9876543210';
        if (mode === 'foreign-environment') inventoryLabels.env = 'production';
        if (mode === 'ambiguous')
          inventoryLabels.__sam_internal_ambiguous_label__installation = 'true';
        const inventory = mode
          ? [
              {
                id: 123,
                name: `node-${nodeId}`,
                status: 'running',
                public_net: { ipv4: { ip: '192.0.2.123' } },
                server_type: { name: 'cx23', cores: 2, memory: 4, disk: 40 },
                location: { name: 'fsn1' },
                created:
                  mode === 'malformed' ? 'not-a-provider-timestamp' : '2026-09-08T10:30:00.000Z',
                labels: inventoryLabels,
              },
              ...(mode === 'duplicate'
                ? [
                    {
                      id: 124,
                      name: `node-${nodeId}-duplicate`,
                      status: 'running',
                      public_net: { ipv4: { ip: '192.0.2.124' } },
                      server_type: { name: 'cx23', cores: 2, memory: 4, disk: 40 },
                      location: { name: 'fsn1' },
                      created: '2026-09-08T10:31:00.000Z',
                      labels: inventoryLabels,
                    },
                  ]
                : []),
            ]
          : [];
        for (const server of inventory) inventoryServerById.set(String(server.id), server);
        return Response.json({
          servers: inventory,
          meta: { pagination: { next_page: null } },
        });
      }
      if (url.includes('api.hetzner.cloud/v1/servers/') && !init?.method) {
        providerGets.push(url);
        const server = inventoryServerById.get(url.split('/').at(-1)!);
        if (server) {
          const nodeId = String(server.name).replace(/^node-/, '');
          if (inventoryModeByNodeId.get(nodeId) === 'changed-identity') {
            return Response.json({
              server: { ...server, location: { name: 'nbg1' } },
            });
          }
          return Response.json({ server });
        }
        return Response.json(
          { error: { code: 'not_found', message: 'Server not found' } },
          { status: 404 }
        );
      }
      if (url.includes('api.hetzner.cloud/v1/servers') && init?.method === 'POST') {
        if (!rejectCreateDuringDestroy) throw new Error('Unexpected provider create');
        f.sqlite.prepare("UPDATE nodes SET status = 'destroying' WHERE id = 'host'").run();
        return Response.json(
          { error: { code: 'placement_error', message: 'Placement unavailable' } },
          { status: 412 }
        );
      }
      if (url.includes('api.cloudflare.com/client/v4/zones/')) {
        dnsRequests.push(url);
        if (hangDns === 'request') return waitForAbort(init!.signal!);
        if (hangDns === 'error-body') return new Response(new ReadableStream(), { status: 503 });
        return Response.json({ success: true });
      }
      throw new Error(`Unexpected provider HTTP: ${init?.method ?? 'GET'} ${url}`);
    })
  );
  clearCapacityCatalogCache();
  await seedHost(f, await f.run());
  // Provisioning stamps this server-owned exact binding after resolving the provider.
  f.sqlite
    .prepare('UPDATE nodes SET placement_credential_fingerprint = ?')
    .run(await fingerprintEncryptedProviderCredential(token.ciphertext, token.iv));
  f.sqlite
    .prepare("UPDATE nodes SET status = 'stopped', created_at = ?, updated_at = ?")
    .run(OLD, OLD);
  f.sqlite
    .prepare(
      `INSERT INTO workspaces
    (id, node_id, user_id, project_id, chat_session_id, status, created_at, updated_at)
    VALUES ('sleeping-workspace', 'host', 'user-1', 'project-1', 'chat-1', 'sleeping', ?, ?)`
    )
    .run(OLD, OLD);
  f.sqlite
    .prepare(
      `INSERT INTO session_snapshots
    (id, workspace_id, node_id, user_id, project_id, chat_session_id, runtime, status, degradation,
     manifest_r2_key, expires_at, sleeping_at, sleep_status, recovery_attempts, created_at, updated_at)
    VALUES ('snapshot-1', 'sleeping-workspace', 'host', 'user-1', 'project-1', 'chat-1', 'vm',
      'available', 'none', 'manifest-key', '2026-09-09T12:00:00.000Z', ?, 'sleeping', 0, ?, ?)`
    )
    .run(OLD, OLD, OLD);
  // Whole-node retirement is allowed only after the durable workspace deletion
  // operation confirmed the source bytes are gone; a restorable snapshot alone is insufficient.
  f.sqlite
    .prepare(
      `UPDATE workspaces SET status = 'deleted',
    runtime_deletion_confirmed_at = ?, runtime_deletion_proof = 'vm_agent_confirmed'`
    )
    .run(OLD);
  const projectStub = f.env.PROJECT_DATA.get(f.env.PROJECT_DATA.idFromName('project-1'));
  const stopSession = vi.fn(async () => undefined);
  const cleanupWorkspaceActivity = vi.fn(async () => undefined);
  Object.assign(projectStub, { stopSession, cleanupWorkspaceActivity });
  expect(f.sqlite.prepare('SELECT auto_provisioned_node_id FROM tasks').all()).toEqual([
    { auto_provisioned_node_id: null },
  ]);
  const result = emptyResult();
  const sweep = (now = NOW) =>
    sweepStoppedHandoffNodes(f.db, f.env, now, resolveCleanupConfig(f.env), result);
  const sweepDestroying = (now = NOW) =>
    sweepDestroyingHandoffNodes(f.db, f.env, now, resolveCleanupConfig(f.env), result);
  return {
    ...f,
    hangingProviderIds,
    providerSignals,
    inventorySignals,
    inventorySelectors,
    providerGets,
    inventoryModeByNodeId,
    dnsRequests,
    setHangDns: (mode: 'request' | 'error-body') => {
      hangDns = mode;
    },
    rejectCreateDuringDestroy: () => {
      rejectCreateDuringDestroy = true;
    },
    rejectedProviderIds,
    rejectedInventoryNodeIds,
    providerDeletes,
    stopSession,
    cleanupWorkspaceActivity,
    result,
    sweep,
    sweepDestroying,
  };
}
