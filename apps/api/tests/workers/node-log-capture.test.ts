/**
 * Black box recorder through the real teardown path (rule 62): the cleanup sweep destroys a
 * stopped managed VM via strict deletion, which captures the node's log tails first. Real D1,
 * R2 and NodeLifecycle via Miniflare; only VM-agent and Hetzner HTTP are stubbed at fetch.
 */
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { runNodeCleanupSweep } from '../../src/scheduled/node-cleanup';
import { runOperationsTelemetryRetention } from '../../src/scheduled/operations-telemetry-retention';
import { updateAdminSettings } from '../../src/services/admin-settings-mutations';
import { __resetAdminSettingsCacheForTest } from '../../src/services/admin-settings-resolution';
import { captureNodeLogsOnUnhealthy } from '../../src/services/node-log-capture';
import { listNodeLogCaptures, readNodeLogCapture } from '../../src/services/node-log-capture-read';
import { bindDecryptableProviderCredential, seedRunningPoolNode } from './helpers/managed-vm-node';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const USER_ID = 'user-blackbox';
const INSTALL_ID = 'install-blackbox';
const PROJECT_ID = 'project-blackbox';
const originalFetch = globalThis.fetch;

type LogsBehavior = 'ok' | 'hang' | 'reject' | 'agent-only';
let logsBehavior: LogsBehavior = 'ok';
let providerDeletes: string[] = [];
let logRequests: string[] = [];

function logsResponse(source: string): Response {
  return Response.json({
    entries: [
      {
        timestamp: '2026-11-03T10:00:02Z',
        level: 'error',
        source,
        message: `${source} failed: disk full`,
      },
      { timestamp: '2026-11-03T10:00:01Z', level: 'info', source, message: `${source} started` },
    ],
    nextCursor: null,
    hasMore: false,
  });
}

beforeEach(() => {
  logsBehavior = 'ok';
  providerDeletes = [];
  logRequests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('.vm.test.example.com')) {
        if (url.includes('/logs?')) {
          logRequests.push(url);
          const source = new URL(url).searchParams.get('source') ?? 'all';
          if (logsBehavior === 'hang') return new Promise<Response>(() => {});
          if (logsBehavior === 'reject') throw new TypeError('fetch failed: connection refused');
          if (logsBehavior === 'agent-only' && source !== 'agent') {
            return Response.json({ error: 'unavailable' }, { status: 503 });
          }
          return logsResponse(source);
        }
        if (url.endsWith('/physical-deletion') && init?.method === 'DELETE') {
          return Response.json({
            ...JSON.parse(String(init.body)),
            success: true,
            physicalDeleted: true,
          });
        }
        return new Response(null, { status: 204 });
      }
      if (url.startsWith('https://api.hetzner.cloud/v1/servers/') && init?.method === 'DELETE') {
        providerDeletes.push(url);
        return new Response(null, { status: 204 });
      }
      return originalFetch(input, init);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAdminSettingsCacheForTest();
});

async function seedStoppedManagedNode(
  nodeId: string,
  lastHeartbeatAt: string | null = new Date().toISOString()
): Promise<void> {
  await seedUser(USER_ID);
  await seedInstallation(INSTALL_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALL_ID);
  await seedRunningPoolNode(nodeId, {
    userId: USER_ID,
    createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    lastHeartbeatAt,
  });
  await bindDecryptableProviderCredential(nodeId);
  // NodeLifecycle's warm alarm already handed the node to the cleanup sweep.
  await env.DATABASE.prepare(`UPDATE nodes SET status = 'stopped', warm_since = NULL WHERE id = ?`)
    .bind(nodeId)
    .run();
}

function sweepEnv(): Env {
  return { ...env, TASK_RUN_CLEANUP_DELAY_MS: '0' } as unknown as Env;
}

async function nodeStatus(nodeId: string): Promise<string | undefined> {
  return (
    await env.DATABASE.prepare('SELECT status FROM nodes WHERE id = ?')
      .bind(nodeId)
      .first<{ status: string }>()
  )?.status;
}

describe('black box recorder on teardown', () => {
  it('stores a gzipped capture in R2 before destroying a reachable node', async () => {
    const nodeId = 'node-blackbox-reachable';
    await seedStoppedManagedNode(nodeId);

    const result = await runNodeCleanupSweep(sweepEnv());

    expect(result.errors).toBe(0);
    expect(providerDeletes).toEqual([`https://api.hetzner.cloud/v1/servers/${nodeId}-server`]);
    expect(await nodeStatus(nodeId)).toBe('deleted');
    expect(logRequests.map((url) => new URL(url).searchParams.get('source')).sort()).toEqual([
      'agent',
      'cloud-init',
      'systemd',
    ]);

    const [capture] = await listNodeLogCaptures(env.DATABASE, nodeId);
    expect(capture).toMatchObject({ trigger: 'teardown', status: 'captured', entryCount: 6 });
    expect(capture!.hasContent).toBe(true);
    const stored = await env.R2.head(`node-log-captures/${nodeId}/${capture!.id}.json.gz`);
    expect(stored?.httpMetadata?.contentType).toBe('application/gzip');

    const read = await readNodeLogCapture(env as Env, capture!.id, { contains: 'DISK FULL' });
    expect(read?.matched).toBe(3);
    expect(read?.entries.map((entry) => entry.source).sort()).toEqual([
      'agent',
      'cloud-init',
      'systemd',
    ]);
    const agentOnly = await readNodeLogCapture(env as Env, capture!.id, { source: 'agent' });
    expect(agentOnly?.entries).toHaveLength(2);
  });

  it('records a partial capture when only some sources answer', async () => {
    const nodeId = 'node-blackbox-partial';
    await seedStoppedManagedNode(nodeId);
    logsBehavior = 'agent-only';

    await runNodeCleanupSweep(sweepEnv());

    expect(await nodeStatus(nodeId)).toBe('deleted');
    const [capture] = await listNodeLogCaptures(env.DATABASE, nodeId);
    expect(capture).toMatchObject({ status: 'partial', entryCount: 2 });
    expect(capture!.sources?.systemd?.error).toBeTruthy();
  });

  it('still tears the node down when the VM refuses the connection', async () => {
    const nodeId = 'node-blackbox-unreachable';
    await seedStoppedManagedNode(nodeId);
    logsBehavior = 'reject';

    const result = await runNodeCleanupSweep(sweepEnv());

    expect(result.errors).toBe(0);
    expect(providerDeletes).toEqual([`https://api.hetzner.cloud/v1/servers/${nodeId}-server`]);
    expect(await nodeStatus(nodeId)).toBe('deleted');
    const [capture] = await listNodeLogCaptures(env.DATABASE, nodeId);
    expect(capture).toMatchObject({ status: 'unreachable', hasContent: false });
  });

  it('stops waiting at the capture timeout and still tears the slow node down', async () => {
    const nodeId = 'node-blackbox-slow';
    await seedStoppedManagedNode(nodeId);
    await updateAdminSettings(env as Env, {
      changes: [{ name: 'operations.nodeLogCaptureTimeoutMs', value: 500 }],
      actorUserId: USER_ID,
    });
    __resetAdminSettingsCacheForTest();
    logsBehavior = 'hang';

    const started = Date.now();
    const result = await runNodeCleanupSweep(sweepEnv());

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.errors).toBe(0);
    expect(providerDeletes).toEqual([`https://api.hetzner.cloud/v1/servers/${nodeId}-server`]);
    expect(await nodeStatus(nodeId)).toBe('deleted');
    const [capture] = await listNodeLogCaptures(env.DATABASE, nodeId);
    expect(capture).toMatchObject({ status: 'timed_out', hasContent: false });
    expect(capture!.durationMs).toBeGreaterThanOrEqual(450);
  });

  it('skips the capture without contacting a node whose heartbeat is already stale', async () => {
    const nodeId = 'node-blackbox-stale';
    await seedStoppedManagedNode(nodeId, new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());

    await runNodeCleanupSweep(sweepEnv());

    expect(await nodeStatus(nodeId)).toBe('deleted');
    expect(logRequests).toEqual([]);
    const [capture] = await listNodeLogCaptures(env.DATABASE, nodeId);
    expect(capture).toMatchObject({ status: 'skipped_stale_heartbeat', hasContent: false });
  });
});

describe('black box recorder on unhealthy transition and retention', () => {
  it('captures unhealthy nodes concurrently and the daily purge deletes expired captures', async () => {
    await seedUser(USER_ID);
    await seedInstallation(INSTALL_ID, USER_ID);
    await seedProject(PROJECT_ID, USER_ID, INSTALL_ID);
    for (const nodeId of ['node-blackbox-unhealthy-a', 'node-blackbox-unhealthy-b']) {
      await seedRunningPoolNode(nodeId, { userId: USER_ID });
    }
    await captureNodeLogsOnUnhealthy(env as Env, [
      { id: 'node-blackbox-unhealthy-a', userId: USER_ID },
      { id: 'node-blackbox-unhealthy-b', userId: USER_ID },
    ]);
    const [a] = await listNodeLogCaptures(env.DATABASE, 'node-blackbox-unhealthy-a');
    expect(a).toMatchObject({ trigger: 'unhealthy', status: 'captured' });
    const key = `node-log-captures/node-blackbox-unhealthy-a/${a!.id}.json.gz`;
    expect(await env.R2.head(key)).not.toBeNull();

    // Not yet expired: retention keeps it.
    await env.KV.delete('cleanup:operations-telemetry:last-run');
    await runOperationsTelemetryRetention(env as Env);
    expect(await listNodeLogCaptures(env.DATABASE, 'node-blackbox-unhealthy-a')).toHaveLength(1);

    // Past expiry: the next daily run deletes the R2 object, then the index row.
    await env.KV.delete('cleanup:operations-telemetry:last-run');
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const purge = await runOperationsTelemetryRetention(env as Env, later);
    expect(purge.capturesDeleted).toBeGreaterThanOrEqual(2);
    expect(await env.R2.head(key)).toBeNull();
    expect(await listNodeLogCaptures(env.DATABASE, 'node-blackbox-unhealthy-a')).toEqual([]);

    // The interval gate holds a second run on the same day.
    const gated = await runOperationsTelemetryRetention(env as Env, later);
    expect(gated).toMatchObject({ skipped: true, skipReason: 'interval-not-elapsed' });
  });
});
