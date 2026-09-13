import { afterEach, describe, expect, it, vi } from 'vitest';

import { sweepStoppedHandoffNodes } from '../../../src/scheduled/node-cleanup/node-phases';
import {
  claimNodeForCleanup,
  emptyResult,
  resolveCleanupConfig,
} from '../../../src/scheduled/node-cleanup/shared';
import { clearCapacityCatalogCache } from '../../../src/services/default-capacity-source-credentials';
import { encrypt } from '../../../src/services/encryption';
import { fingerprintEncryptedProviderCredential } from '../../../src/services/provider-credential-exact';
import { findRestorableOrInFlightSleepSnapshot } from '../../../src/services/session-snapshot-sleep-predicate';
import { fixture, seedHost } from '../routes/node-pool-upgrade-test-helpers';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const OLD = '2026-09-08T10:00:00.000Z';
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
  f.sqlite.prepare(`UPDATE ${credentialTable} SET encrypted_token = ?, iv = ?`)
    .run(token.ciphertext, token.iv);
  const providerDeletes: string[] = [];
  const rejectedProviderIds = new Set<string>();
  const hangingProviderIds = new Set<string>();
  const providerSignals: AbortSignal[] = [];
  const dnsRequests: string[] = [];
  let hangDns: 'request' | 'error-body' | undefined;
  function waitForAbort(signal: AbortSignal) {
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.hetzner.cloud/v1/server_types')) {
      return Response.json({ server_types: [{
        id: 1, name: 'cx23', description: 'CX23', cores: 2, memory: 4, disk: 40,
        architecture: 'x86', cpu_type: 'shared', deprecated: false,
        prices: [{ location: 'fsn1', price_hourly: { net: '0.0048', gross: '0.0048' },
          price_monthly: { net: '3.99', gross: '3.99' } }],
      }], meta: { pagination: { next_page: null } } });
    }
    if (url.includes('/servers/provider-') && init?.method === 'DELETE') {
      providerDeletes.push(url);
      if (hangingProviderIds.has(url.split('/').at(-1)!)) {
        providerSignals.push(init.signal!);
        return waitForAbort(init.signal!);
      }
      if (rejectedProviderIds.has(url.split('/').at(-1)!)) {
        return Response.json({ error: { code: 'forbidden', message: 'Provider refused deletion' } }, { status: 403 });
      }
      return new Response(null, { status: 204 });
    }
    if (url.includes('api.cloudflare.com/client/v4/zones/')) {
      dnsRequests.push(url);
      if (hangDns === 'request') return waitForAbort(init!.signal!);
      if (hangDns === 'error-body') return new Response(new ReadableStream(), { status: 503 });
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected provider HTTP: ${init?.method ?? 'GET'} ${url}`);
  }));
  clearCapacityCatalogCache();
  await seedHost(f, await f.run());
  // Provisioning stamps this server-owned exact binding after resolving the provider.
  f.sqlite.prepare('UPDATE nodes SET placement_credential_fingerprint = ?').run(
    await fingerprintEncryptedProviderCredential(token.ciphertext, token.iv)
  );
  f.sqlite.prepare("UPDATE nodes SET status = 'stopped', created_at = ?, updated_at = ?").run(OLD, OLD);
  f.sqlite.prepare(`INSERT INTO workspaces
    (id, node_id, user_id, project_id, chat_session_id, status, created_at, updated_at)
    VALUES ('sleeping-workspace', 'host', 'user-1', 'project-1', 'chat-1', 'sleeping', ?, ?)`)
    .run(OLD, OLD);
  f.sqlite.prepare(`INSERT INTO session_snapshots
    (id, workspace_id, node_id, user_id, project_id, chat_session_id, runtime, status, degradation,
     manifest_r2_key, expires_at, sleeping_at, sleep_status, recovery_attempts, created_at, updated_at)
    VALUES ('snapshot-1', 'sleeping-workspace', 'host', 'user-1', 'project-1', 'chat-1', 'vm',
      'available', 'none', 'manifest-key', '2026-09-09T12:00:00.000Z', ?, 'sleeping', 0, ?, ?)`)
    .run(OLD, OLD, OLD);
  const projectStub = f.env.PROJECT_DATA.get(f.env.PROJECT_DATA.idFromName('project-1'));
  const stopSession = vi.fn(async () => undefined);
  const cleanupWorkspaceActivity = vi.fn(async () => undefined);
  Object.assign(projectStub, { stopSession, cleanupWorkspaceActivity });
  expect(f.sqlite.prepare('SELECT auto_provisioned_node_id FROM tasks').all())
    .toEqual([{ auto_provisioned_node_id: null }]);
  const result = emptyResult();
  const sweep = (now = NOW) => sweepStoppedHandoffNodes(f.db, f.env, now, resolveCleanupConfig(f.env), result);
  return { ...f, hangingProviderIds, providerSignals, dnsRequests, setHangDns: (mode: 'request' | 'error-body') => { hangDns = mode; }, rejectedProviderIds, providerDeletes, stopSession, cleanupWorkspaceActivity, result, sweep };
}

describe('direct managed pool VM stopped handoff cleanup', () => {
  it.each(['user', 'installation'] as const)('deletes a %s pool VM without task provenance and preserves the restorable workspace/session', async (scope) => {
    const f = await handoffFixture(scope);
    const snapshot = f.sqlite.prepare('SELECT * FROM session_snapshots').get();
    await f.sweep();
    expect(f.result).toMatchObject({ lifetimeDestroyed: 1, errors: 0 });
    expect(f.providerDeletes).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT status, runtime_termination_confirmed_at FROM nodes').get())
      .toEqual({ status: 'deleted', runtime_termination_confirmed_at: expect.any(String) });
    expect(f.sqlite.prepare('SELECT id, chat_session_id, runtime_deletion_confirmed_at FROM workspaces').get())
      .toEqual({ id: 'sleeping-workspace', chat_session_id: 'chat-1', runtime_deletion_confirmed_at: expect.any(String) });
    expect(f.sqlite.prepare('SELECT * FROM session_snapshots').get()).toEqual(snapshot);
    expect(await findRestorableOrInFlightSleepSnapshot(f.env.DATABASE, f.env, {
      projectId: 'project-1', workspaceId: 'sleeping-workspace', chatSessionId: 'chat-1', now: NOW,
    })).toMatchObject({ sleep_status: 'sleeping' });
    expect(f.stopSession).not.toHaveBeenCalled();
    expect(f.cleanupWorkspaceActivity).toHaveBeenCalledOnce();
    await f.sweep();
    expect(f.providerDeletes).toHaveLength(1);
  });

  it('aborts dead provider requests within the phase budget and reaches deferred work next tick', async () => {
    const f = await handoffFixture();
    f.env.NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS = '600';
    f.env.NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS = '500';
    for (const id of ['dead-a', 'dead-b']) {
      await seedHost(f, f.starts[0]!, id);
      f.sqlite.prepare(`UPDATE nodes SET status = 'stopped', created_at = ?, updated_at = ?,
        placement_credential_fingerprint = (SELECT placement_credential_fingerprint FROM nodes WHERE id = 'host')
        WHERE id = ?`).run('2026-09-08T09:00:00.000Z', OLD, id);
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
    expect(f.sqlite.prepare("SELECT status, cleanup_backoff_until FROM nodes WHERE id = 'host'").get())
      .toEqual({ status: 'stopped', cleanup_backoff_until: null });
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

  it.each(['request', 'error-body'] as const)('bounds a stalled DNS %s after provider termination without closing the recoverable session', async (mode) => {
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
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM session_snapshots').get()).toEqual({ count: 1 });
  });

  it('backs off a saturated failing batch and reaches valid work on the next sweep', async () => {
    const f = await handoffFixture();
    f.env.NODE_CLEANUP_SWEEP_LIMIT = '2';
    for (const id of ['failed-null-deadline', 'failed-expired-deadline']) {
      await seedHost(f, f.starts[0]!, id);
      f.sqlite.prepare(`UPDATE nodes SET status = 'stopped', created_at = ?, updated_at = ?,
        placement_credential_fingerprint = (SELECT placement_credential_fingerprint FROM nodes WHERE id = 'host'),
        cleanup_backoff_until = ? WHERE id = ?`)
        .run('2026-09-08T09:00:00.000Z', OLD, id === 'failed-null-deadline' ? null : OLD, id);
      f.rejectedProviderIds.add(`provider-${id}`);
    }
    await f.sweep();
    expect(f.result).toMatchObject({ errors: 2, lifetimeDestroyed: 0 });
    expect(f.providerDeletes).toHaveLength(2);
    const failures = f.sqlite.prepare(`SELECT id, status, cleanup_backoff_until FROM nodes
      WHERE id != 'host' ORDER BY id`).all() as Array<{ id: string; status: string; cleanup_backoff_until: string }>;
    expect(failures).toHaveLength(2);
    for (const node of failures) {
      expect(node.status).toBe('stopped');
      expect(node.cleanup_backoff_until > NOW.toISOString()).toBe(true);
      expect(await claimNodeForCleanup(f.env, {
        id: node.id, user_id: 'user-1', status: 'stopped',
      }, NOW.toISOString())).toBe(false);
    }
    await f.sweep();
    expect(f.result).toMatchObject({ errors: 2, lifetimeDestroyed: 1 });
    expect(f.providerDeletes).toHaveLength(3);
    expect(f.providerDeletes[2]).toMatch(/provider-host$/);
    await f.sweep();
    expect(f.providerDeletes).toHaveLength(3);
  });

  it.each([
    ['future cleanup backoff', "UPDATE nodes SET cleanup_backoff_until = '2026-09-08T13:00:00.000Z'"],
    ['missing native CPU', "UPDATE nodes SET provider_instance_vcpu_count = NULL"],
    ['missing native memory', "UPDATE nodes SET provider_instance_memory_mb = NULL"],
    ['missing provider identity', "UPDATE nodes SET provider_instance_id = NULL"],
    ['missing workload role', "UPDATE nodes SET workload_role = NULL"],
    ['missing pool', "UPDATE nodes SET capacity_pool_id = NULL"],
    ['missing source', "UPDATE nodes SET capacity_source_id = NULL"],
    ['missing generation', "UPDATE nodes SET capacity_source_generation = NULL"],
    ['invalid revision', "UPDATE nodes SET capacity_pool_revision = 0"],
    ['missing candidate', "UPDATE nodes SET capacity_pool_candidate_id = ''"],
    ['missing credential fingerprint', "UPDATE nodes SET placement_credential_fingerprint = NULL"],
    ['missing credential reference', "UPDATE nodes SET placement_credential_reference = NULL"],
    ['untrusted credential source', "UPDATE nodes SET placement_credential_source = 'client'"],
    ['invalid credential version', "UPDATE nodes SET placement_credential_version = 0"],
    ['invalid scope', "UPDATE nodes SET capacity_pool_scope = 'client'"],
    ['project scope without project', "UPDATE nodes SET capacity_pool_scope = 'project', capacity_pool_project_id = NULL"],
    ['user-owned', "UPDATE nodes SET node_class = 'user-owned'"],
    ['running', "UPDATE nodes SET status = 'running'"],
    ['deployment', "UPDATE nodes SET node_role = 'deployment'"],
    ['container', "UPDATE nodes SET runtime = 'cf-container'"],
    ['active workspace', "UPDATE workspaces SET status = 'running'"],
    ['recent workspace activity', "UPDATE workspaces SET updated_at = '2026-09-08T11:59:00.000Z'"],
    ['live warm claim', "UPDATE tasks SET status = 'in_progress', claimed_warm_node_id = 'host', claimed_warm_node_at = '2026-09-08T11:59:00.000Z'"],
  ])('keeps %s protected in both candidate selection and the atomic claim', async (_label, mutation) => {
    const f = await handoffFixture();
    f.sqlite.exec(mutation);
    await f.sweep();
    expect(f.providerDeletes).toEqual([]);
    expect(f.result).toMatchObject({ lifetimeDestroyed: 0, errors: 0 });
    expect(await claimNodeForCleanup(f.env, {
      id: 'host', user_id: 'user-1', status: 'stopped',
    }, NOW.toISOString())).toBe(false);
    expect(f.sqlite.prepare('SELECT runtime_termination_confirmed_at FROM nodes').get())
      .toEqual({ runtime_termination_confirmed_at: null });
  });
});
