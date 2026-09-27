import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  sweepDestroyingHandoffNodes,
  sweepStoppedHandoffNodes,
} from '../../../src/scheduled/node-cleanup/node-phases';
import {
  claimNodeForCleanup,
  emptyResult,
  resolveCleanupConfig,
} from '../../../src/scheduled/node-cleanup/shared';
import { clearCapacityCatalogCache } from '../../../src/services/default-capacity-source-credentials';
import { encrypt } from '../../../src/services/encryption';
import { provisionNode } from '../../../src/services/node-provisioning';
import { fingerprintEncryptedProviderCredential } from '../../../src/services/provider-credential-exact';
import { findRestorableOrInFlightSleepSnapshot } from '../../../src/services/session-snapshot-sleep-predicate';
import { fixture, seedHost } from '../routes/node-pool-upgrade-test-helpers';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const OLD = '2026-09-08T10:00:00.000Z';
vi.mock('../../../src/services/jwt', () => ({ signNodeCallbackToken: async () => 'test-token' }));

const updateNodeField = (column: string, value: string) => `UPDATE nodes SET ${column} = ${value}`;
const protectedHandoffMutations = [
  ['future cleanup backoff', updateNodeField('cleanup_backoff_until', "'2026-09-08T13:00:00.000Z'")],
  ['missing native CPU', updateNodeField('provider_instance_vcpu_count', 'NULL')],
  ['missing native memory', updateNodeField('provider_instance_memory_mb', 'NULL')],
  ['missing workload role', updateNodeField('workload_role', 'NULL')],
  ['missing pool', updateNodeField('capacity_pool_id', 'NULL')],
  ['missing source', updateNodeField('capacity_source_id', 'NULL')],
  ['missing generation', updateNodeField('capacity_source_generation', 'NULL')],
  ['invalid revision', updateNodeField('capacity_pool_revision', '0')],
  ['missing candidate', updateNodeField('capacity_pool_candidate_id', "''")],
  ['missing credential fingerprint', updateNodeField('placement_credential_fingerprint', 'NULL')],
  ['missing credential reference', updateNodeField('placement_credential_reference', 'NULL')],
  ['untrusted credential source', updateNodeField('placement_credential_source', "'client'")],
  ['invalid credential version', updateNodeField('placement_credential_version', '0')],
  ['invalid scope', updateNodeField('capacity_pool_scope', "'client'")],
  [
    'project scope without project',
    "UPDATE nodes SET capacity_pool_scope = 'project', capacity_pool_project_id = NULL",
  ],
  ['user-owned', updateNodeField('node_class', "'user-owned'")],
  ['deployment', updateNodeField('node_role', "'deployment'")],
  ['container', updateNodeField('runtime', "'cf-container'")],
  ['active workspace', "UPDATE workspaces SET status = 'running'"],
  ['recent workspace activity', "UPDATE workspaces SET updated_at = '2026-09-08T11:59:00.000Z'"],
  [
    'live warm claim',
    "UPDATE tasks SET status = 'in_progress', claimed_warm_node_id = 'host', claimed_warm_node_at = '2026-09-08T11:59:00.000Z'",
  ],
] as const;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCapacityCatalogCache();
});

// Real pool resolution, SQL selection/claim, strict provider deletion and lifecycle
// finalization. Only provider HTTP and ProjectData transport are replaced.
async function handoffFixture(scope: 'user' | 'installation' = 'user') {
  const f = fixture(scope);
  f.env.ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  const token = await encrypt('test-provider-token', f.env.ENCRYPTION_KEY);
  const credentialTable = scope === 'installation' ? 'platform_credentials' : 'credentials';
  f.sqlite
    .prepare(`UPDATE ${credentialTable} SET encrypted_token = ?, iv = ?`)
    .run(token.ciphertext, token.iv);
  const providerDeletes: string[] = [];
  const rejectedProviderIds = new Set<string>();
  const hangingProviderIds = new Set<string>();
  const providerSignals: AbortSignal[] = [];
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
      if (url.includes('/servers/provider-') && init?.method === 'DELETE') {
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
    dnsRequests,
    setHangDns: (mode: 'request' | 'error-body') => {
      hangDns = mode;
    },
    rejectCreateDuringDestroy: () => {
      rejectCreateDuringDestroy = true;
    },
    rejectedProviderIds,
    providerDeletes,
    stopSession,
    cleanupWorkspaceActivity,
    result,
    sweep,
    sweepDestroying,
  };
}

describe('direct managed pool VM stopped handoff cleanup', () => {
  it.each(['user', 'installation'] as const)(
    'deletes a %s pool VM without task provenance and preserves the restorable workspace/session',
    async (scope) => {
      const f = await handoffFixture(scope);
      const snapshot = f.sqlite.prepare('SELECT * FROM session_snapshots').get();
      await f.sweep();
      expect(f.result).toMatchObject({ lifetimeDestroyed: 1, errors: 0 });
      expect(f.providerDeletes).toHaveLength(1);
      expect(
        f.sqlite.prepare('SELECT status, runtime_termination_confirmed_at FROM nodes').get()
      ).toEqual({ status: 'deleted', runtime_termination_confirmed_at: expect.any(String) });
      expect(
        f.sqlite
          .prepare('SELECT id, chat_session_id, runtime_deletion_confirmed_at FROM workspaces')
          .get()
      ).toEqual({
        id: 'sleeping-workspace',
        chat_session_id: 'chat-1',
        runtime_deletion_confirmed_at: expect.any(String),
      });
      expect(f.sqlite.prepare('SELECT * FROM session_snapshots').get()).toEqual(snapshot);
      expect(
        await findRestorableOrInFlightSleepSnapshot(f.env.DATABASE, f.env, {
          projectId: 'project-1',
          workspaceId: 'sleeping-workspace',
          chatSessionId: 'chat-1',
          now: NOW,
        })
      ).toMatchObject({ sleep_status: 'sleeping' });
      expect(f.stopSession).not.toHaveBeenCalled();
      expect(f.cleanupWorkspaceActivity).toHaveBeenCalledOnce();
      await f.sweep();
      expect(f.providerDeletes).toHaveLength(1);
    }
  );

  it('terminalizes a destroying pool VM row that never received a provider instance ID', async () => {
    const f = await handoffFixture();
    const snapshot = f.sqlite.prepare('SELECT * FROM session_snapshots').get();
    f.env.CF_ZONE_ID = 'test-zone';
    f.env.CF_API_TOKEN = 'test-dns-token';
    f.sqlite
      .prepare(
        `UPDATE nodes
      SET status = 'destroying',
          provider_instance_id = NULL,
          runtime_termination_confirmed_at = ?,
          backend_dns_record_id = 'dns-host',
          cleanup_backoff_until = NULL
      WHERE id = 'host'`
      )
      .run(OLD);

    await f.sweepDestroying();

    expect(f.result).toMatchObject({ lifetimeDestroyed: 1, errors: 0 });
    expect(f.providerDeletes).toHaveLength(0);
    expect(f.dnsRequests).toHaveLength(1);
    expect(
      f.sqlite.prepare('SELECT status, runtime_termination_confirmed_at FROM nodes').get()
    ).toEqual({ status: 'deleted', runtime_termination_confirmed_at: expect.any(String) });
    expect(
      f.sqlite
        .prepare('SELECT id, chat_session_id, runtime_deletion_confirmed_at FROM workspaces')
        .get()
    ).toEqual({
      id: 'sleeping-workspace',
      chat_session_id: 'chat-1',
      runtime_deletion_confirmed_at: expect.any(String),
    });
    expect(f.sqlite.prepare('SELECT * FROM session_snapshots').get()).toEqual(snapshot);
    expect(f.stopSession).not.toHaveBeenCalled();
    expect(f.cleanupWorkspaceActivity).toHaveBeenCalledOnce();
  });

  it('carries a rejected provider create through a concurrent destroy claim and cleanup', async () => {
    const f = await handoffFixture();
    f.sqlite
      .prepare(
        `UPDATE nodes SET status = 'creating', provider_instance_id = NULL,
          runtime_termination_confirmed_at = NULL WHERE id = 'host'`
      )
      .run();
    f.rejectCreateDuringDestroy();

    await provisionNode('host', f.env);
    expect(
      f.sqlite
        .prepare(
          "SELECT status, provider_instance_id, runtime_termination_confirmed_at FROM nodes WHERE id = 'host'"
        )
        .get()
    ).toEqual({
      status: 'destroying',
      provider_instance_id: null,
      runtime_termination_confirmed_at: expect.any(String),
    });

    await f.sweepDestroying();

    expect(f.result).toMatchObject({ lifetimeDestroyed: 1, errors: 0 });
    expect(f.providerDeletes).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT status FROM nodes WHERE id = 'host'").get()).toEqual({
      status: 'deleted',
    });
    expect(f.sqlite.prepare('SELECT runtime_deletion_confirmed_at FROM workspaces').get()).toEqual({
      runtime_deletion_confirmed_at: expect.any(String),
    });
  });

  it('keeps a destroying provider-ID row retryable when provider deletion is ambiguous', async () => {
    const f = await handoffFixture();
    f.sqlite
      .prepare(
        `UPDATE nodes
      SET status = 'destroying',
          cleanup_backoff_until = NULL
      WHERE id = 'host'`
      )
      .run();
    f.rejectedProviderIds.add('provider-host');

    await f.sweepDestroying();

    expect(f.result).toMatchObject({ lifetimeDestroyed: 0, errors: 1 });
    expect(f.providerDeletes).toHaveLength(1);
    expect(
      f.sqlite
        .prepare(
          `SELECT status, runtime_termination_confirmed_at, cleanup_backoff_until FROM nodes WHERE id = 'host'`
        )
        .get()
    ).toEqual({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
      cleanup_backoff_until: expect.any(String),
    });
    expect(f.stopSession).not.toHaveBeenCalled();
    expect(f.cleanupWorkspaceActivity).not.toHaveBeenCalled();
  });

  it('excludes old active rows before the bounded page so eligible destroying work advances', async () => {
    const f = await handoffFixture();
    f.env.NODE_CLEANUP_SWEEP_LIMIT = '1';
    f.sqlite
      .prepare(
        `UPDATE nodes SET status = 'destroying', provider_instance_id = NULL,
          runtime_termination_confirmed_at = ? WHERE id = 'host'`
      )
      .run(OLD);
    await seedHost(f, f.starts[0]!, 'active-blocker');
    f.sqlite
      .prepare(
        `UPDATE nodes SET status = 'destroying', created_at = ?, updated_at = ?,
          placement_credential_fingerprint =
            (SELECT placement_credential_fingerprint FROM nodes WHERE id = 'host')
        WHERE id = 'active-blocker'`
      )
      .run('2026-09-08T08:00:00.000Z', OLD);
    f.sqlite
      .prepare(
        `INSERT INTO workspaces
          (id, node_id, user_id, project_id, status, created_at, updated_at)
        VALUES ('active-workspace', 'active-blocker', 'user-1', 'project-1',
          'running', '2026-09-08T08:00:00.000Z', '2026-09-08T08:00:00.000Z')`
      )
      .run();

    await f.sweepDestroying();

    expect(f.result).toMatchObject({ lifetimeDestroyed: 1, errors: 0 });
    expect(f.sqlite.prepare("SELECT status FROM nodes WHERE id = 'host'").get()).toEqual({
      status: 'deleted',
    });
    expect(f.sqlite.prepare("SELECT status FROM nodes WHERE id = 'active-blocker'").get()).toEqual({
      status: 'destroying',
    });
  });

  it.each([
    ...protectedHandoffMutations,
    [
      'missing provider rejection proof',
      'UPDATE nodes SET runtime_termination_confirmed_at = NULL',
    ],
  ] as const)('keeps %s protected during destroying handoff cleanup', async (_label, mutation) => {
    const f = await handoffFixture();
    f.sqlite
      .prepare(
        `UPDATE nodes
      SET status = 'destroying',
          provider_instance_id = NULL,
          runtime_termination_confirmed_at = ?,
          cleanup_backoff_until = NULL
      WHERE id = 'host'`
      )
      .run(OLD);
    f.sqlite.exec(mutation);

    await f.sweepDestroying();

    expect(f.providerDeletes).toEqual([]);
    expect(f.result).toMatchObject({ lifetimeDestroyed: 0, errors: 0 });
    expect(
      f.sqlite.prepare('SELECT status, runtime_termination_confirmed_at FROM nodes').get()
    ).toEqual({
      status: 'destroying',
      runtime_termination_confirmed_at: mutation.includes('runtime_termination_confirmed_at')
        ? null
        : OLD,
    });
    expect(f.cleanupWorkspaceActivity).not.toHaveBeenCalled();
  });

  it('aborts dead provider requests within the phase budget and reaches deferred work next tick', async () => {
    const f = await handoffFixture();
    f.env.NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS = '600';
    f.env.NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS = '500';
    for (const id of ['dead-a', 'dead-b']) {
      await seedHost(f, f.starts[0]!, id);
      f.sqlite
        .prepare(
          `UPDATE nodes SET status = 'stopped', created_at = ?, updated_at = ?,
        placement_credential_fingerprint = (SELECT placement_credential_fingerprint FROM nodes WHERE id = 'host')
        WHERE id = ?`
        )
        .run('2026-09-08T09:00:00.000Z', OLD, id);
      f.hangingProviderIds.add(`provider-${id}`);
    }
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const pending = f.sweep();
    await vi.waitFor(() => expect(f.providerDeletes.length).toBeGreaterThan(0), { interval: 1 });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(f.providerDeletes.length % 2).toBe(0), { interval: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(f.result).toMatchObject({ errors: 2, lifetimeDestroyed: 0 });
    expect(f.providerDeletes).toHaveLength(2);
    expect(f.providerSignals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - NOW.getTime()).toBeLessThan(1000);
    expect(
      f.sqlite.prepare("SELECT status, cleanup_backoff_until FROM nodes WHERE id = 'host'").get()
    ).toEqual({ status: 'stopped', cleanup_backoff_until: null });
    await f.sweep();
    expect(f.result).toMatchObject({ errors: 2, lifetimeDestroyed: 1 });
    expect(f.providerDeletes).toHaveLength(3);
    const afterBackoff = new Date(NOW.getTime() + resolveCleanupConfig(f.env).failureBackoffMs + 1);
    vi.setSystemTime(afterBackoff);
    const retry = f.sweep(afterBackoff);
    await vi.waitFor(() => expect(f.providerDeletes).toHaveLength(4), { interval: 1 });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(f.providerDeletes).toHaveLength(5), { interval: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await retry;
    expect(f.providerDeletes).toHaveLength(5);
    expect(f.result.errors).toBe(4);
  });

  it.each(['request', 'error-body'] as const)(
    'bounds a stalled DNS %s after provider termination without closing the recoverable session',
    async (mode) => {
      const f = await handoffFixture();
      f.env.NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS = '500';
      f.env.CF_ZONE_ID = 'test-zone';
      f.env.CF_API_TOKEN = 'test-dns-token';
      f.env.CF_API_TIMEOUT_MS = '30000';
      f.sqlite.exec("UPDATE nodes SET backend_dns_record_id = 'dns-host'");
      f.setHangDns(mode);
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const pending = f.sweep();
      await vi.waitFor(() => expect(f.dnsRequests).toHaveLength(1), { interval: 1 });
      await vi.advanceTimersByTimeAsync(500);
      await pending;
      expect(Date.now() - NOW.getTime()).toBeLessThan(1000);
      expect(f.result).toMatchObject({ lifetimeDestroyed: 1, errors: 0 });
      expect(f.providerDeletes).toHaveLength(1);
      expect(f.stopSession).not.toHaveBeenCalled();
      expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM session_snapshots').get()).toEqual({
        count: 1,
      });
    }
  );

  it('backs off a saturated failing batch and reaches valid work on the next sweep', async () => {
    const f = await handoffFixture();
    f.env.NODE_CLEANUP_SWEEP_LIMIT = '2';
    for (const id of ['failed-null-deadline', 'failed-expired-deadline']) {
      await seedHost(f, f.starts[0]!, id);
      f.sqlite
        .prepare(
          `UPDATE nodes SET status = 'stopped', created_at = ?, updated_at = ?,
        placement_credential_fingerprint = (SELECT placement_credential_fingerprint FROM nodes WHERE id = 'host'),
        cleanup_backoff_until = ? WHERE id = ?`
        )
        .run('2026-09-08T09:00:00.000Z', OLD, id === 'failed-null-deadline' ? null : OLD, id);
      f.rejectedProviderIds.add(`provider-${id}`);
    }
    await f.sweep();
    expect(f.result).toMatchObject({ errors: 2, lifetimeDestroyed: 0 });
    expect(f.providerDeletes).toHaveLength(2);
    const failures = f.sqlite
      .prepare(
        `SELECT id, status, cleanup_backoff_until FROM nodes
      WHERE id != 'host' ORDER BY id`
      )
      .all() as Array<{ id: string; status: string; cleanup_backoff_until: string }>;
    expect(failures).toHaveLength(2);
    for (const node of failures) {
      expect(node.status).toBe('stopped');
      expect(node.cleanup_backoff_until > NOW.toISOString()).toBe(true);
      expect(
        await claimNodeForCleanup(
          f.env,
          {
            id: node.id,
            user_id: 'user-1',
            status: 'stopped',
          },
          NOW.toISOString()
        )
      ).toBe(false);
    }
    await f.sweep();
    expect(f.result).toMatchObject({ errors: 2, lifetimeDestroyed: 1 });
    expect(f.providerDeletes).toHaveLength(3);
    expect(f.providerDeletes[2]).toMatch(/provider-host$/);
    await f.sweep();
    expect(f.providerDeletes).toHaveLength(3);
  });

  it.each([
    ...protectedHandoffMutations,
    ['missing provider identity', 'UPDATE nodes SET provider_instance_id = NULL'],
    ['running', "UPDATE nodes SET status = 'running'"],
  ] as const)(
    'keeps %s protected in both candidate selection and the atomic claim',
    async (_label, mutation) => {
      const f = await handoffFixture();
      f.sqlite.exec(mutation);
      await f.sweep();
      expect(f.providerDeletes).toEqual([]);
      expect(f.result).toMatchObject({ lifetimeDestroyed: 0, errors: 0 });
      expect(
        await claimNodeForCleanup(
          f.env,
          {
            id: 'host',
            user_id: 'user-1',
            status: 'stopped',
          },
          NOW.toISOString()
        )
      ).toBe(false);
      expect(f.sqlite.prepare('SELECT runtime_termination_confirmed_at FROM nodes').get()).toEqual({
        runtime_termination_confirmed_at: null,
      });
    }
  );
});
