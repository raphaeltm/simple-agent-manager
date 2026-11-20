/**
 * Idea 01M7GVRC956Q8JMGCRP1PQ4R5B. Production rows that failed provisioning before any provider
 * create ("Node allocation plan is no longer current") kept their insert-time absence proof but
 * had no placement credential fingerprint, so strict teardown refused them forever
 * ("Providerless VM termination proof lacks managed placement"), and every failure retried within
 * five minutes despite recording a one-hour backoff.
 *
 * Everything below runs the real scheduled entry point (`runNodeCleanupSweep`) against a real SQL
 * engine; only provider and Cloudflare HTTP and ProjectData transport are replaced.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runNodeCleanupSweep } from '../../../src/scheduled/node-cleanup';
import { clearCapacityCatalogCache } from '../../../src/services/default-capacity-source-credentials';
import { handoffFixture } from './node-cleanup-handoff-fixture';

vi.mock('../../../src/services/jwt', () => ({
  signNodeCallbackToken: async () => 'test-token',
  signCurrentNodeCallbackToken: async () => 'test-token',
}));

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const CREATED = '2026-09-03T10:37:12.772Z';
const LATER_PROOF = '2026-09-03T10:37:20.000Z';
const HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCapacityCatalogCache();
});

type Fixture = Awaited<ReturnType<typeof handoffFixture>>;

/** The production row shape: never claimed for a provider create, no placement fingerprint. */
async function placeholderFixture(options: {
  status: string;
  taskLinked: boolean;
  keepFingerprint?: boolean;
}) {
  const f = await handoffFixture();
  f.sqlite.exec('DELETE FROM session_snapshots; DELETE FROM workspaces;');
  f.sqlite
    .prepare(
      `UPDATE nodes SET status = ?, provider_instance_id = NULL, transport = NULL,
         placement_credential_fingerprint = CASE WHEN ? THEN placement_credential_fingerprint END,
         ip_address = NULL,
         created_at = ?, updated_at = ?, runtime_termination_confirmed_at = ?,
         cleanup_backoff_until = NULL, error_message = 'Node allocation plan is no longer current'
       WHERE id = 'host'`
    )
    .run(options.status, options.keepFingerprint ? 1 : 0, CREATED, CREATED, CREATED);
  if (options.taskLinked) {
    f.sqlite.prepare("UPDATE tasks SET status = 'failed', auto_provisioned_node_id = 'host'").run();
  }
  // Max lifetime is 4h by default; the rows in production were five days old.
  f.env.MAX_AUTO_NODE_LIFETIME_MS = String(HOUR_MS);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  return f;
}

function hostRow(f: Fixture) {
  return f.sqlite
    .prepare(
      `SELECT status, runtime_termination_confirmed_at, cleanup_backoff_until, cleanup_blocked_reason
       FROM nodes WHERE id = 'host'`
    )
    .get() as {
    status: string;
    runtime_termination_confirmed_at: string | null;
    cleanup_backoff_until: string | null;
    cleanup_blocked_reason: string | null;
  };
}

function noProviderTraffic(f: Fixture) {
  expect(f.providerDeletes).toEqual([]);
  expect(f.providerGets).toEqual([]);
  expect(f.inventorySelectors).toEqual([]);
}

describe('never-requested providerless placeholder rows', () => {
  it.each([
    ['task-linked error row (production 01M7FCGMP496…)', 'error', true],
    ['error row without a task link', 'error', false],
    ['destroying row without a task link (production 01M7GQ1N72…)', 'destroying', false],
  ] as const)(
    'retires a %s on the first sweep without a provider call',
    async (_l, status, linked) => {
      const f = await placeholderFixture({ status, taskLinked: linked });

      const first = await runNodeCleanupSweep(f.env);

      expect(first.errors).toBe(0);
      expect(first.lifetimeDestroyed).toBe(1);
      expect(hostRow(f)).toEqual({
        status: 'deleted',
        // The insert-time absence proof is the termination proof: nothing was ever created.
        runtime_termination_confirmed_at: CREATED,
        cleanup_backoff_until: null,
        cleanup_blocked_reason: null,
      });
      noProviderTraffic(f);

      // The terminal row leaves every candidate set (rule 47).
      vi.setSystemTime(NOW + 2 * HOUR_MS);
      const second = await runNodeCleanupSweep(f.env);
      expect(second).toMatchObject({ lifetimeDestroyed: 0, errors: 0 });
      noProviderTraffic(f);
    }
  );

  it.each([
    // The provider identity claim stamps `transport` before any create, in the same write that
    // clears the insert-time proof. A stamped transport means a create may have been sent.
    ['transport stamped by the provider identity claim', "transport = 'vm-public-dns'"],
    // Every later proof writer stamps its own time; a proof that is not the insert-time one came
    // from a create attempt and needs its managed placement, which this row lacks.
    ['proof written after the insert', `runtime_termination_confirmed_at = '${LATER_PROOF}'`],
    ['owner-attested proof', `runtime_termination_attested_at = '${CREATED}'`],
    ['no absence proof at all', 'runtime_termination_confirmed_at = NULL'],
  ] as const)(
    'does not retire a row whose create may have happened: %s',
    async (_label, mutation) => {
      const f = await placeholderFixture({ status: 'error', taskLinked: true });
      f.sqlite.exec(`UPDATE nodes SET ${mutation} WHERE id = 'host'`);
      const before = hostRow(f).runtime_termination_confirmed_at;

      await runNodeCleanupSweep(f.env);

      const after = hostRow(f);
      expect(after.status).not.toBe('deleted');
      expect(after.runtime_termination_confirmed_at).toBe(before);
      expect(f.providerDeletes).toEqual([]);
      // Bounded escape: the uncertain providerless row is handed to the destroying state machine
      // (blocked clock, stranded-node deadline and alert, `node_destroying_too_long` anomaly)
      // instead of returning to `error` for the max-lifetime sweep. Its failure waits for that
      // 30-minute deadline, not the 5-minute refusal re-check.
      expect(after.status).toBe('destroying');
      expect(after.cleanup_backoff_until).toBe(new Date(NOW + 30 * 60 * 1000).toISOString());
      expect(after.cleanup_blocked_reason).toEqual(expect.any(String));

      // Two-sweep zombie check: nothing is re-attempted before the backoff.
      const deletesBefore = f.providerDeletes.length;
      const inventoryBefore = f.inventorySelectors.length;
      vi.setSystemTime(NOW + 6 * 60 * 1000);
      const second = await runNodeCleanupSweep(f.env);
      expect(second.errors).toBe(0);
      expect(f.providerDeletes).toHaveLength(deletesBefore);
      expect(f.inventorySelectors).toHaveLength(inventoryBefore);
      expect(hostRow(f).status).toBe('destroying');
    }
  );

  it('names an empty Hetzner inventory for an uncertain create as an operator refusal', async () => {
    const f = await placeholderFixture({
      status: 'error',
      taskLinked: true,
      keepFingerprint: true,
    });
    // Claimed for a create (proof cleared, transport stamped); exact placement present.
    f.sqlite.exec(`UPDATE nodes SET runtime_termination_confirmed_at = NULL,
      transport = 'vm-public-dns', runtime_incarnation_id = 'incarnation-host' WHERE id = 'host'`);

    await runNodeCleanupSweep(f.env);

    expect(f.inventorySelectors).toHaveLength(1);
    expect(hostRow(f)).toMatchObject({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
      cleanup_blocked_reason: expect.stringContaining('teardown_allocation_unresolved'),
    });
    expect(Date.parse(hostRow(f).cleanup_backoff_until!)).toBeGreaterThanOrEqual(NOW + HOUR_MS);
    expect(f.providerDeletes).toEqual([]);
  });
});

describe('uncertain creates on providers without complete inventory', () => {
  it('records a named operator refusal with the full backoff, not a retry within minutes', async () => {
    const f = await placeholderFixture({
      status: 'error',
      taskLinked: true,
      keepFingerprint: true,
    });
    // A GCP create that may have been sent: claimed (proof cleared, transport stamped).
    f.sqlite.exec(`UPDATE nodes SET cloud_provider = 'gcp', runtime_termination_confirmed_at = NULL,
      transport = 'vm-public-dns', runtime_incarnation_id = 'incarnation-host' WHERE id = 'host'`);

    const first = await runNodeCleanupSweep(f.env);

    expect(first.errors).toBe(1);
    noProviderTraffic(f);
    const row = hostRow(f);
    expect(row).toMatchObject({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
      cleanup_blocked_reason: expect.stringContaining('teardown_allocation_unresolved'),
    });
    expect(row.cleanup_backoff_until).toBe(new Date(NOW + HOUR_MS).toISOString());

    vi.setSystemTime(NOW + 6 * 60 * 1000);
    const second = await runNodeCleanupSweep(f.env);
    expect(second.errors).toBe(0);
    expect(hostRow(f).status).toBe('destroying');
  });
});

describe('max-lifetime cleanup honours its own failure backoff', () => {
  it('does not re-attempt a failing candidate before the backoff it recorded', async () => {
    const f = await handoffFixture();
    // A provisioned host the provider cannot delete right now (503: not a named refusal).
    f.sqlite
      .prepare("UPDATE nodes SET status = 'error', cleanup_backoff_until = NULL WHERE id = 'host'")
      .run();
    f.sqlite.prepare("UPDATE tasks SET status = 'failed', auto_provisioned_node_id = 'host'").run();
    f.unavailableProviderIds.add('provider-host');
    f.env.MAX_AUTO_NODE_LIFETIME_MS = String(HOUR_MS);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);

    const first = await runNodeCleanupSweep(f.env);
    expect(first.errors).toBe(1);
    const attempts = f.providerDeletes.length;
    expect(attempts).toBeGreaterThan(0);
    const row = hostRow(f);
    expect(row.status).toBe('error');
    expect(row.cleanup_backoff_until).toBe(new Date(NOW + HOUR_MS).toISOString());

    // Production retried every 5-10 minutes; the refusal cap had rewritten the backoff to +5 min.
    for (const minutes of [6, 11, 30, 59]) {
      vi.setSystemTime(NOW + minutes * 60 * 1000);
      const result = await runNodeCleanupSweep(f.env);
      expect(result.errors).toBe(0);
      expect(f.providerDeletes).toHaveLength(attempts);
    }

    // Once the backoff has passed the candidate is due again (it has an escape, not a ban).
    vi.setSystemTime(NOW + HOUR_MS + 1);
    const due = await runNodeCleanupSweep(f.env);
    expect(due.errors).toBe(1);
    expect(f.providerDeletes.length).toBeGreaterThan(attempts);
  });
});
