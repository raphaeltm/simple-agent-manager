/**
 * The stale-heartbeat node-health probe (`probeNodeHealthForTaskLiveness`) must make exactly
 * the calls it made before the reverse-tunnel transport existed for every other transport:
 * one public `/health` fetch, no D1 read. Only a reverse-tunnel node reads its lease, and that
 * read sits inside the probe's own time budget. Real SQLite for the snapshot and lease reads.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { loadRuntimeWorkspaceSnapshot } from '../../../src/services/task-runtime-liveness-loaders';
import { probeNodeHealthForTaskLiveness } from '../../../src/services/task-runtime-liveness-node-probe';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NODE = 'NODE01KRRTPROBE';
const INCARNATION = 'incarnation-1';
const BASE = 'example.test';

let sqlite: Database.Database;
let database: D1Database;
let fetchMock: ReturnType<typeof vi.fn>;

function seed(transport: string | null, leasePort: number | null = null) {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, status, runtime, node_class, transport,
         runtime_incarnation_id, health_status, last_heartbeat_at)
       VALUES (?, 'user-1', 'running', 'vm', 'managed', ?, ?, 'stale', '2026-11-10T00:00:00Z')`
    )
    .run(NODE, transport, INCARNATION);
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, project_id, node_id, user_id, status, created_at)
       VALUES ('ws-1', 'project-1', ?, 'user-1', 'running', '2026-11-10T00:00:00Z')`
    )
    .run(NODE);
  if (leasePort !== null) {
    sqlite
      .prepare(
        `INSERT INTO node_reverse_tunnel_leases (id, node_id, user_id, runtime_incarnation_id,
           port, credential_hash, status, created_at, updated_at)
         VALUES ('lease-1', ?, 'user-1', ?, ?, 'hash', 'active', 'now', 'now')`
      )
      .run(NODE, INCARNATION, leasePort);
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.nodes, schema.workspaces, schema.nodeReverseTunnelLeases]);
  database = createSqliteD1(sqlite);
  fetchMock = vi.fn(async () => new Response('ok'));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function probeFromSnapshot(env: Record<string, unknown> = {}) {
  // Same path as both adapters: the snapshot query, then the probe with its transport.
  const snapshot = await loadRuntimeWorkspaceSnapshot(database, 'project-1', 'ws-1');
  const prepare = vi.spyOn(database, 'prepare');
  const result = await probeNodeHealthForTaskLiveness(
    { DATABASE: database, BASE_DOMAIN: BASE, ...env },
    NODE,
    snapshot?.nodeTransport
  );
  return { result, prepare, snapshot };
}

describe('node-health probe on existing transports', () => {
  it.each([
    ['vm-public-dns', 'vm-public-dns'],
    ['cloudflare-tunnel', 'cloudflare-tunnel'],
    ['legacy NULL transport', null],
  ] as const)('%s: one public fetch, no D1 read', async (_name, transport) => {
    seed(transport);
    const { result, prepare, snapshot } = await probeFromSnapshot();
    expect(snapshot?.nodeTransport).toBe(transport);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://${NODE.toLowerCase()}.vm.${BASE}:8443/health`
    );
    expect(result).toMatchObject({ outcome: 'ok', status: 200 });
  });
});

describe('node-health probe on a reverse-tunnel node', () => {
  it('reaches the current lease on loopback without following redirects', async () => {
    seed('reverse-tunnel', 20017);
    const { result } = await probeFromSnapshot();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:20017/health');
    expect(init.redirect).toBe('manual');
    expect(result).toMatchObject({ outcome: 'ok', url: 'http://127.0.0.1:20017/health' });
  });

  it('is inconclusive with no fetch when the node has no live lease', async () => {
    seed('reverse-tunnel');
    const { result } = await probeFromSnapshot();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.outcome).toBe('error');
  });

  it('bounds a hung lease read by the probe timeout', async () => {
    seed('reverse-tunnel', 20017);
    // Every statement method drizzle may call (raw/all/first/run) never settles.
    const statement: Record<string, unknown> = new Proxy(
      {},
      { get: (_t, prop) => (prop === 'bind' ? () => statement : () => new Promise(() => {})) }
    );
    const hung = { prepare: () => statement } as unknown as D1Database;
    const started = Date.now();
    const result = await probeNodeHealthForTaskLiveness(
      { DATABASE: hung, BASE_DOMAIN: BASE, TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS: '50' },
      NODE,
      'reverse-tunnel'
    );
    expect(result.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
