/**
 * The cleanup cron finishes tearing down a node whose provider delete outlasts one attempt.
 *
 * Incident (idea 01M7C4MS211R0Y73CWPHK47B9K): the stopped-node sweep gave each GCP candidate 5 s,
 * GCP's delete is an operation that runs 20 s to minutes, and GCP's "not found" lookup alone (8
 * zone GETs plus an aggregated list) did not fit either. Production reaped late; on the
 * changed-credential path staging never sent a DELETE.
 *
 * Real: the cron entry point (`runNodeCleanupSweep`), SQLite schema and migrations' columns,
 * credential encryption and resolution, the Hetzner adapter's HTTP shape, strict teardown,
 * ownership proof, refusal recording and the operator alert. Faked: only the provider account
 * (`fetch`) plus a provider wrapper that behaves like GCP: the delete is an operation that finishes
 * minutes after it is sent, and a lookup that finds nothing takes longer than an attempt.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as observabilitySchema from '../../../src/db/observability-schema';
import { runNodeCleanupSweep } from '../../../src/scheduled/node-cleanup';
import { invalidateAdminSettings } from '../../../src/services/admin-settings-resolution';
import { encrypt } from '../../../src/services/encryption';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { seedHost } from '../routes/node-pool-upgrade-test-helpers';
import { handoffFixture } from './node-cleanup-handoff-fixture';

/** Provider-side state, shared with the mocked provider factory. */
const cloud = vi.hoisted(() => ({
  /** `operation`: GCP-shaped two-phase provider. `sync`: the plain adapter (Hetzner). */
  mode: 'operation' as 'operation' | 'sync',
  /** How long a sent delete runs before the provider records it finished. */
  operationMs: 2 * 60_000,
  neverConfirms: false,
  /** API token -> server id -> labels. */
  accounts: new Map<string, Map<string, Record<string, string>>>(),
  /** Started deletes: server id -> { account, sentAt }. */
  operations: new Map<string, { account: string; sentAt: number }>(),
  deletes: [] as string[],
  lookups: [] as string[],
  statusReads: [] as string[],
}));

vi.mock('@simple-agent-manager/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/providers')>();
  type Context = { signal?: AbortSignal } | undefined;

  /** A lookup that finds nothing walks every zone and the aggregated list: longer than an attempt. */
  function outlastAttempt(context: Context): Promise<never> {
    return new Promise((_resolve, reject) => {
      const signal = context?.signal;
      if (!signal) return reject(new Error('test provider: unbounded wait without a deadline'));
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  /** The provider finishes deletes on its own clock, whether or not anyone asks. */
  function settle() {
    for (const [id, op] of cloud.operations) {
      if (!cloud.neverConfirms && Date.now() >= op.sentAt + cloud.operationMs) {
        cloud.accounts.get(op.account)?.delete(id);
      }
    }
  }
  function send(account: string, id: string) {
    cloud.deletes.push(`${account}:${id}`);
    if (!cloud.operations.has(id)) cloud.operations.set(id, { account, sentAt: Date.now() });
  }

  return {
    ...actual,
    createProvider: (config: Parameters<typeof actual.createProvider>[0]) => {
      const base = actual.createProvider(config);
      if (cloud.mode === 'sync') return base;
      const account = (config as { apiToken?: string }).apiToken ?? '';
      const present = (id: string) => cloud.accounts.get(account)?.has(id) ?? false;
      const provider = Object.create(base) as typeof base;
      Object.assign(provider, {
        async getVM(id: string, context?: Context) {
          settle();
          return base.getVM.call(provider, id, context);
        },
        // GCP's synchronous delete: lookup, DELETE, then wait for the operation.
        async deleteVM(id: string, context?: Context) {
          settle();
          cloud.lookups.push(`${account}:${id}`);
          if (!present(id)) return outlastAttempt(context);
          send(account, id);
          return outlastAttempt(context);
        },
        async requestVMDeletion(
          id: string,
          context?: Context,
          options?: { beforeSend?: (ticket: string) => Promise<void> }
        ) {
          settle();
          cloud.lookups.push(`${account}:${id}`);
          if (!present(id)) return outlastAttempt(context);
          const ticket = JSON.stringify({ account, id });
          await options?.beforeSend?.(ticket);
          if (context?.signal?.aborted) throw context.signal.reason;
          send(account, id);
          return { state: 'requested', ticket };
        },
        async getVMDeletionStatus(ticket: string) {
          settle();
          const parsed = JSON.parse(ticket) as { account: string; id: string };
          cloud.statusReads.push(`${account}:${parsed.id}`);
          if (parsed.account !== account) return { state: 'wrong_scope' };
          const op = cloud.operations.get(parsed.id);
          if (!op) return { state: 'not_requested' };
          return present(parsed.id) ? { state: 'in_progress' } : { state: 'deleted' };
        },
      });
      return provider;
    },
  };
});

vi.mock('../../../src/services/jwt', () => ({ signNodeCallbackToken: async () => 'test-token' }));

const NOW = new Date('2026-09-08T12:00:00.000Z');
const TICK_MS = 5 * 60_000;
const TOKEN = 'test-provider-token';
const INSTANCE = '777';
const INCARNATION = 'inc-host';
const INSTALLATION = '0123456789abcdef0123456789abcdef';
const databases: Database.Database[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
  cloud.mode = 'operation';
  cloud.operationMs = 2 * 60_000;
  cloud.neverConfirms = false;
  cloud.accounts.clear();
  cloud.operations.clear();
  cloud.deletes.length = 0;
  cloud.lookups.length = 0;
  cloud.statusReads.length = 0;
});

function samLabels(nodeId = 'host', overrides: Record<string, string> = {}) {
  return {
    managed: 'simple-agent-manager',
    node: nodeId,
    role: 'workspace',
    env: 'staging',
    installation: INSTALLATION,
    incarnation: `inc-${nodeId}`,
    ...overrides,
  };
}

async function twoPhaseFixture(options: { requestTimeoutMs?: number; confirmMaxMs?: number } = {}) {
  const f = await handoffFixture();
  const obs = new Database(':memory:');
  databases.push(obs);
  createAllSchemaTables(obs, observabilitySchema);
  f.env.OBSERVABILITY_DATABASE = createSqliteD1(obs);
  // Both the old knob (read on main) and the admin setting (read now) bound an attempt at 1 s.
  f.env.NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS = '1000';
  const setting = f.sqlite.prepare(
    'INSERT INTO platform_settings(key,value,updated_at) VALUES (?,?,?)'
  );
  setting.run(
    'operations.nodeProviderDeletionRequestTimeoutMs',
    String(options.requestTimeoutMs ?? 1000),
    NOW.toISOString()
  );
  if (options.confirmMaxMs !== undefined) {
    setting.run(
      'operations.nodeProviderDeletionConfirmMaxMs',
      String(options.confirmMaxMs),
      NOW.toISOString()
    );
  }
  invalidateAdminSettings(f.env);
  f.sqlite
    .prepare(
      "UPDATE nodes SET provider_instance_id = ?, runtime_incarnation_id = ? WHERE id = 'host'"
    )
    .run(INSTANCE, INCARNATION);
  cloud.accounts.set(TOKEN, new Map([[INSTANCE, samLabels()]]));

  // The provider account behind Hetzner-shaped GETs (ownership reads). DELETEs reach the account
  // only in `sync` mode; the GCP-shaped wrapper records its own.
  const gets: string[] = [];
  const base = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const match = /api\.hetzner\.cloud\/v1\/servers\/(\d+)$/.exec(String(input));
      if (!match) return base(input, init);
      const id = match[1]!;
      const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      const account = cloud.accounts.get(token);
      const labels = account?.get(id);
      if (init?.method === 'DELETE') {
        cloud.deletes.push(`${token}:${id}`);
        account?.delete(id);
        return labels
          ? new Response(null, { status: 204 })
          : Response.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 });
      }
      gets.push(`${token}:${id}`);
      if (!labels) {
        return Response.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 });
      }
      return Response.json({
        server: {
          id: Number(id),
          name: `node-${id}`,
          status: 'running',
          public_net: { ipv4: { ip: '192.0.2.77' } },
          server_type: { name: 'cx23', cores: 2, memory: 4, disk: 40 },
          location: { name: 'fsn1' },
          created: '2026-09-08T10:30:00.000Z',
          labels,
        },
      });
    })
  );

  /** The user saves the cloud connection again: same account, new credential row (#2715 path). */
  async function resave() {
    f.sqlite.exec(`DELETE FROM cc_attachments; DELETE FROM cc_configurations;
      DELETE FROM cc_credentials; DELETE FROM credentials WHERE credential_type = 'cloud-provider';`);
    const sealed = await encrypt(TOKEN, f.env.ENCRYPTION_KEY as string);
    f.sqlite
      .prepare(
        `INSERT INTO credentials (id, user_id, project_id, provider, credential_type,
          credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
        VALUES ('cloud-resaved', 'user-1', NULL, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, ?, ?)`
      )
      .run(sealed.ciphertext, sealed.iv, NOW.toISOString(), NOW.toISOString());
  }
  const node = (id = 'host') =>
    f.sqlite
      .prepare(
        `SELECT status, runtime_termination_confirmed_at AS proof,
          runtime_termination_attested_at AS attested, cleanup_blocked_reason AS reason,
          cleanup_backoff_until AS backoff, provider_deletion_requested_at AS requestedAt
        FROM nodes WHERE id = ?`
      )
      .get(id) as {
      status: string;
      proof: string | null;
      attested: string | null;
      reason: string | null;
      backoff: string | null;
      requestedAt: string | null;
    };
  const decisions = (id = 'host') =>
    (
      f.sqlite
        .prepare(
          `SELECT decision, reason FROM node_lifecycle_decisions
          WHERE node_id = ? AND source = 'cleanup_sweep' ORDER BY created_at, rowid`
        )
        .all(id) as Array<{ decision: string; reason: string | null }>
    ).filter((row) => row.decision !== 'skipped');
  const errorRows = () =>
    obs
      .prepare("SELECT message FROM platform_errors WHERE node_id = 'host' AND level = 'error'")
      .all() as Array<{ message: string }>;
  /** One cron tick at `NOW + n` ticks. Only Date is faked: attempt deadlines are real timers. */
  const tick = async (n: number) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW.getTime() + n * TICK_MS));
    const started = performance.now();
    const result = await runNodeCleanupSweep(f.env);
    return { result, wallMs: performance.now() - started };
  };
  /**
   * One cron tick with Date AND timers faked, so the sweep's own wall-time checks and the
   * per-attempt deadlines run on one clock. Returns the tick's duration on that clock.
   */
  const timedTick = async (n: number) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const start = NOW.getTime() + n * TICK_MS;
    vi.setSystemTime(new Date(start));
    let done = false;
    const run = runNodeCleanupSweep(f.env).finally(() => {
      done = true;
    });
    for (let i = 0; i < 1000 && !done; i++) await vi.advanceTimersByTimeAsync(50);
    const result = await run;
    return { result, wallMs: Date.now() - start };
  };
  return { ...f, gets, resave, node, decisions, errorRows, tick, timedTick };
}

describe('two-phase provider deletion at the cleanup cron entry point', () => {
  it('reaps a node whose delete outlasts one attempt: one DELETE, proof only once the provider records it done', async () => {
    const f = await twoPhaseFixture();

    const first = await f.tick(0);
    expect(cloud.deletes).toEqual([`${TOKEN}:${INSTANCE}`]);
    expect(first.result).toMatchObject({ providerDeletionsRequested: 1, errors: 0 });
    // Sent is not done: no proof, the node stays claimed, and it is due again next tick.
    expect(f.node()).toMatchObject({
      status: 'destroying',
      proof: null,
      backoff: null,
      requestedAt: NOW.toISOString(),
    });
    expect(f.errorRows()).toEqual([]);

    const second = await f.tick(1);
    expect(second.result).toMatchObject({ lifetimeDestroyed: 1, errors: 0 });
    expect(cloud.deletes).toEqual([`${TOKEN}:${INSTANCE}`]);
    expect(cloud.statusReads).toEqual([`${TOKEN}:${INSTANCE}`]);
    expect(cloud.accounts.get(TOKEN)!.has(INSTANCE)).toBe(false);
    expect(f.node()).toMatchObject({
      status: 'deleted',
      proof: new Date(NOW.getTime() + TICK_MS).toISOString(),
      attested: null,
      requestedAt: null,
    });
    expect(f.decisions()).toEqual([
      { decision: 'destroy_attempted', reason: 'stopped_node_handoff_cleanup' },
      { decision: 'destroy_pending', reason: 'provider_deletion_requested' },
      { decision: 'destroy_attempted', reason: 'provider_deletion_confirm' },
      { decision: 'destroyed', reason: 'provider_deleted' },
    ]);
    expect(f.errorRows()).toEqual([]);
  });

  it('keeps the node pending, without an error row, while the provider is still deleting', async () => {
    cloud.operationMs = 7 * 60_000;
    const f = await twoPhaseFixture();

    await f.tick(0);
    const stillRunning = await f.tick(1);
    expect(stillRunning.result).toMatchObject({ providerDeletionsPending: 1, errors: 0 });
    expect(f.node()).toMatchObject({ status: 'destroying', proof: null });
    await f.tick(2);
    expect(f.node()).toMatchObject({ status: 'deleted', proof: expect.any(String) });
    expect(cloud.deletes).toHaveLength(1);
    expect(f.errorRows()).toEqual([]);
  });

  it('does the same after the cloud credential is saved again: ownership re-read, then one DELETE', async () => {
    const f = await twoPhaseFixture();
    await f.resave();

    await f.tick(0);
    // The current credential re-read the instance to prove ownership before the DELETE.
    expect(f.gets).toEqual([`${TOKEN}:${INSTANCE}`]);
    expect(cloud.deletes).toEqual([`${TOKEN}:${INSTANCE}`]);
    expect(f.node()).toMatchObject({ status: 'destroying', proof: null });

    await f.tick(1);
    expect(cloud.deletes).toEqual([`${TOKEN}:${INSTANCE}`]);
    // Confirmed from the provider's record, never from "not found" through a fallback credential.
    expect(cloud.statusReads).toEqual([`${TOKEN}:${INSTANCE}`]);
    expect(f.gets).toEqual([`${TOKEN}:${INSTANCE}`]);
    expect(f.node()).toMatchObject({
      status: 'deleted',
      proof: expect.any(String),
      attested: null,
    });
  });

  it('control: an instance that does not prove ownership is still refused, with nothing sent or recorded', async () => {
    const f = await twoPhaseFixture();
    cloud.accounts.get(TOKEN)!.set(INSTANCE, samLabels('host', { installation: 'f'.repeat(32) }));
    await f.resave();

    await f.tick(0);

    expect(cloud.deletes).toEqual([]);
    expect(cloud.lookups).toEqual([]);
    expect(f.node()).toMatchObject({
      proof: null,
      requestedAt: null,
      reason: expect.stringMatching(/^teardown_instance_ownership_mismatch/),
    });
  });

  it('control: a provider whose delete returns on acceptance (Hetzner) completes in one tick', async () => {
    cloud.mode = 'sync';
    const f = await twoPhaseFixture();

    const only = await f.tick(0);

    expect(only.result).toMatchObject({ lifetimeDestroyed: 1, errors: 0 });
    expect(cloud.deletes).toEqual([`${TOKEN}:${INSTANCE}`]);
    expect(f.node()).toMatchObject({
      status: 'deleted',
      proof: expect.any(String),
      requestedAt: null,
    });
  });

  it('a provider that never confirms: pending is bounded, then named, alerted and out of the hot set', async () => {
    cloud.neverConfirms = true;
    const f = await twoPhaseFixture({ confirmMaxMs: 2 * TICK_MS });

    await f.tick(0);
    await f.tick(1);
    expect(f.node()).toMatchObject({ status: 'destroying', proof: null, reason: null });
    expect(f.errorRows()).toEqual([]);

    // Two ticks after the request the bound is reached: a named reason and one operator alert.
    await f.tick(2);
    const blocked = f.node();
    expect(blocked).toMatchObject({
      status: 'destroying',
      proof: null,
      reason: expect.stringMatching(/^teardown_deletion_unconfirmed/),
    });
    expect(Date.parse(blocked.backoff!)).toBeGreaterThanOrEqual(
      NOW.getTime() + 2 * TICK_MS + 59 * 60_000
    );
    const alerts = f.errorRows().filter((row) => row.message.startsWith('VM may still exist'));
    expect(alerts).toHaveLength(1);
    const reads = cloud.statusReads.length;

    // Out of the hot set: the next ticks inside the backoff read nothing and send nothing.
    await f.tick(3);
    await f.tick(4);
    expect(cloud.statusReads).toHaveLength(reads);
    expect(cloud.deletes).toEqual([`${TOKEN}:${INSTANCE}`]);
    expect(f.node()).toMatchObject({
      reason: expect.stringMatching(/^teardown_deletion_unconfirmed/),
      requestedAt: NOW.toISOString(),
    });

    // Once the provider does finish, the next bounded check proves it.
    cloud.neverConfirms = false;
    await f.tick(15);
    expect(f.node()).toMatchObject({ status: 'deleted', proof: expect.any(String) });
    expect(cloud.deletes).toHaveLength(1);
  });

  it('a page of slow candidates cannot starve valid work, and every tick stays inside its budget', async () => {
    const f = await twoPhaseFixture();
    // Phase budget 2.5 s with 1 s attempts: at most three attempts a tick in this phase.
    f.env.NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS = '2500';
    for (const id of ['slow-a', 'slow-b', 'slow-c', 'slow-d']) {
      await seedHost(f, f.starts[0]!, id);
      f.sqlite
        .prepare(
          `UPDATE nodes SET status = 'stopped', created_at = ?, updated_at = ?,
            provider_instance_id = ?, runtime_incarnation_id = ?,
            placement_credential_fingerprint = (SELECT placement_credential_fingerprint FROM nodes WHERE id = 'host')
          WHERE id = ?`
        )
        .run(
          '2026-09-08T09:00:00.000Z',
          '2026-09-08T09:00:00.000Z',
          `9${id.length}${id.at(-1)!.charCodeAt(0)}`,
          `inc-${id}`,
          id
        );
      // No instance in the account: each lookup finds nothing and outlasts its attempt.
    }

    let reachedAt: number | null = null;
    const attemptedPerTick: number[] = [];
    for (let n = 0; n < 5 && reachedAt === null; n++) {
      const before = cloud.lookups.length;
      const { wallMs } = await f.timedTick(n);
      attemptedPerTick.push(cloud.lookups.length - before);
      // The stopped-handoff phase stops starting attempts at its 2.5 s budget; the one in flight
      // ends at its deadline, which is capped by the same budget.
      expect(wallMs).toBeLessThanOrEqual(2500 + 100);
      if (f.node().requestedAt !== null) reachedAt = n;
    }
    // The budget admits three slow attempts per tick (1 s + 1 s + the 0.5 s left). Without
    // rotation the slow nodes, all blocked since the first tick, hold the head of every tick and
    // the valid node is never reached. With it, five candidates at three a tick are all attempted
    // by the second tick; the valid node is reached by the third because the stranded sweep's
    // refusal bookkeeping gives the never-attempted nodes the same retry time as the failed ones.
    expect(attemptedPerTick[0]).toBe(3);
    expect(reachedAt).not.toBeNull();
    expect(reachedAt!).toBeLessThanOrEqual(2);
    expect(cloud.deletes).toEqual([`${TOKEN}:${INSTANCE}`]);
  });
});
