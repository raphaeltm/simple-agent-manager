/**
 * Tests for provider-side orphan reconciliation.
 *
 * This is the only code in SAM that destroys infrastructure because something is
 * ABSENT (no D1 row claims the server) rather than present. Absence is weak
 * evidence, and the blast radius of misreading it is deleting a live production
 * server. SAM's own staging and production share ONE Hetzner project, so a
 * staging-side sweep that trusted absence would see every production server as
 * unclaimed.
 *
 * The tests below are therefore weighted heavily toward proving the sweep does
 * NOTHING when evidence is incomplete. Each skip case is a separate destroy-guard,
 * and each has a positive control proving the sweep would otherwise have destroyed
 * that server — so none of them can pass merely because nothing matched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runProviderOrphanReconciliation } from '../../../src/scheduled/provider-orphan-reconciliation';

const deleteVM = vi.fn().mockResolvedValue(undefined);
const listVMs = vi.fn();

vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformCloudCredential: vi.fn().mockResolvedValue({
    decryptedToken: 'test-token',
    provider: 'hetzner',
  }),
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  buildProviderConfig: vi.fn().mockReturnValue({ provider: 'hetzner', apiToken: 'test-token' }),
}));
vi.mock('@simple-agent-manager/providers', () => ({
  createProvider: vi.fn(() => ({ listVMs, deleteVM })),
}));
vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('key'),
}));
vi.mock('../../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

/** A well-formed ULID — the only shape the `node` label should carry. */
const ORPHAN_NODE_ID = '01kx84mcg1yn1tqvwr60b3g70a';
const CLAIMED_NODE_ID = '01kzb1ehkkwha6pqemn3p9xfmb';

function server(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'srv-1',
    name: `node-${ORPHAN_NODE_ID}`,
    ip: '1.2.3.4',
    status: 'running',
    serverType: 'cx22',
    createdAt: ago(4 * HOUR),
    labels: {
      managed: 'simple-agent-manager',
      node: ORPHAN_NODE_ID,
      role: 'workspace',
      env: 'production',
    },
    ...overrides,
  };
}

/**
 * @param claimRows rows the `nodes` lookup should return, or 'throw' to simulate a
 *                  failed D1 read.
 */
function makeEnv(
  claimRows: Array<{ id: string; status: string }> | 'throw' = [],
  overrides: Partial<Env> = {}
): Env {
  return {
    ENVIRONMENT: 'production',
    KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    DATABASE: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => {
            if (claimRows === 'throw') throw new Error('D1_ERROR: read failed');
            return { results: claimRows };
          }),
        })),
      })),
    },
    OBSERVABILITY_DATABASE: {},
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => {
  deleteVM.mockClear();
  deleteVM.mockResolvedValue(undefined);
  listVMs.mockReset();
});

describe('provider orphan reconciliation — destroys genuine orphans', () => {
  it('destroys a server whose node row does not exist', async () => {
    listVMs.mockResolvedValue([server()]);
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).toHaveBeenCalledWith('srv-1');
    expect(result.destroyed).toBe(1);
    expect(result.scanned).toBe(1);
  });

  it('destroys a server whose node row is terminally deleted', async () => {
    listVMs.mockResolvedValue([server()]);
    const result = await runProviderOrphanReconciliation(
      makeEnv([{ id: ORPHAN_NODE_ID, status: 'deleted' }])
    );

    expect(deleteVM).toHaveBeenCalledWith('srv-1');
    expect(result.destroyed).toBe(1);
  });

  it('scopes the provider query to this environment', async () => {
    listVMs.mockResolvedValue([]);
    await runProviderOrphanReconciliation(makeEnv([]));

    // Filtering server-side keeps a sibling deployment's servers out of the
    // candidate set entirely rather than relying on us to filter correctly.
    expect(listVMs).toHaveBeenCalledWith({
      managed: 'simple-agent-manager',
      env: 'production',
    });
  });
});

describe('provider orphan reconciliation — fails closed', () => {
  it('destroys NOTHING when a live node row claims the server', async () => {
    listVMs.mockResolvedValue([server({ labels: { ...server().labels, node: CLAIMED_NODE_ID } })]);
    const result = await runProviderOrphanReconciliation(
      makeEnv([{ id: CLAIMED_NODE_ID, status: 'running' }])
    );

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedClaimed).toBe(1);
  });

  it('preserves a server whose claiming row is in an unrecognised state', async () => {
    // Only 'deleted'/'destroyed' authorise a destroy. Any other value — including a
    // status added in the future — must count as a live claim.
    listVMs.mockResolvedValue([server()]);
    const result = await runProviderOrphanReconciliation(
      makeEnv([{ id: ORPHAN_NODE_ID, status: 'some-future-status' }])
    );

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedClaimed).toBe(1);
  });

  it('destroys NOTHING when the D1 claim lookup fails', async () => {
    // A failed or partial read makes live nodes look unclaimed — the most dangerous
    // possible misreading. The run must abort rather than act on it.
    listVMs.mockResolvedValue([server()]);
    const result = await runProviderOrphanReconciliation(makeEnv('throw'));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('claim-lookup-failed');
  });

  it('skips a server with no environment label', async () => {
    // Servers created before the env label existed. Absence of a label must never
    // authorise a destroy — those servers may belong to another deployment.
    const labelsWithoutEnv = { ...server().labels };
    delete (labelsWithoutEnv as Record<string, unknown>).env;
    listVMs.mockResolvedValue([server({ labels: labelsWithoutEnv })]);
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedUnlabeled).toBe(1);
  });

  it("skips a server labelled for a different environment", async () => {
    listVMs.mockResolvedValue([server({ labels: { ...server().labels, env: 'staging' } })]);
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedForeignEnv).toBe(1);
  });

  it('skips a server younger than the minimum age', async () => {
    // provider_instance_id is written only AFTER createVM returns, so a very new
    // server can legitimately have no claiming value yet.
    listVMs.mockResolvedValue([server({ createdAt: ago(5 * 60 * 1000) })]);
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedYoung).toBe(1);
  });

  it('skips a server with an unparseable creation time', async () => {
    listVMs.mockResolvedValue([server({ createdAt: 'not-a-date' })]);
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedYoung).toBe(1);
  });

  it('skips a server whose node label is missing or malformed', async () => {
    listVMs.mockResolvedValue([
      server({ id: 'srv-a', labels: { ...server().labels, node: undefined } }),
      server({ id: 'srv-b', labels: { ...server().labels, node: 'not-a-ulid' } }),
    ]);
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedUnlabeled).toBe(2);
  });

  it('skips the whole run when ENVIRONMENT is unset', async () => {
    // Without a trustworthy identity we cannot tell our servers from a sibling
    // deployment's, so nothing may be listed OR destroyed.
    listVMs.mockResolvedValue([server()]);
    const result = await runProviderOrphanReconciliation(makeEnv([], { ENVIRONMENT: undefined }));

    expect(listVMs).not.toHaveBeenCalled();
    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skipReason).toBe('no-environment-identity');
  });

  it('destroys NOTHING when the provider list call fails', async () => {
    listVMs.mockRejectedValue(new Error('provider 500'));
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skipReason).toBe('provider-list-failed');
  });

  it('destroys NOTHING when no platform credential exists', async () => {
    const { getPlatformCloudCredential } = await import(
      '../../../src/services/platform-credentials'
    );
    vi.mocked(getPlatformCloudCredential).mockResolvedValueOnce(null);
    listVMs.mockResolvedValue([server()]);

    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skipReason).toBe('no-platform-credential');
  });

  it('can be disabled entirely', async () => {
    listVMs.mockResolvedValue([server()]);
    const result = await runProviderOrphanReconciliation(
      makeEnv([], { PROVIDER_ORPHAN_RECONCILIATION_ENABLED: 'false' } as Partial<Env>)
    );

    expect(listVMs).not.toHaveBeenCalled();
    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
  });
});

describe('provider orphan reconciliation — bounded (rule 47)', () => {
  it('never destroys more than the configured limit in one run', async () => {
    listVMs.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => {
        // Distinct valid ULIDs so each is an independent candidate.
        const nodeId = `01kx84mcg1yn1tqvwr60b3g7${String(i).padStart(2, '0')}`;
        return server({ id: `srv-${i}`, labels: { ...server().labels, node: nodeId } });
      })
    );

    const result = await runProviderOrphanReconciliation(
      makeEnv([], { PROVIDER_ORPHAN_DESTROY_LIMIT: '3' } as Partial<Env>)
    );

    expect(deleteVM).toHaveBeenCalledTimes(3);
    expect(result.destroyed).toBe(3);
    expect(result.scanned).toBe(12);
  });

  it('skips the run when the interval has not elapsed', async () => {
    listVMs.mockResolvedValue([server()]);
    const env = makeEnv([]);
    (env.KV.get as ReturnType<typeof vi.fn>).mockResolvedValue(new Date().toISOString());

    const result = await runProviderOrphanReconciliation(env);

    expect(listVMs).not.toHaveBeenCalled();
    expect(result.skipReason).toBe('interval-not-elapsed');
  });

  it('does not advance the interval marker when the run aborted', async () => {
    // An aborted run must be retried on the next tick, not suppressed for an hour.
    listVMs.mockRejectedValue(new Error('provider 500'));
    const env = makeEnv([]);

    await runProviderOrphanReconciliation(env);

    expect(env.KV.put).not.toHaveBeenCalled();
  });

  it('continues past an individual destroy failure', async () => {
    listVMs.mockResolvedValue([
      server({ id: 'srv-1', labels: { ...server().labels, node: '01kx84mcg1yn1tqvwr60b3g701' } }),
      server({ id: 'srv-2', labels: { ...server().labels, node: '01kx84mcg1yn1tqvwr60b3g702' } }),
    ]);
    deleteVM.mockRejectedValueOnce(new Error('provider conflict'));

    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).toHaveBeenCalledTimes(2);
    expect(result.destroyed).toBe(1);
    expect(result.errors).toBe(1);
  });
});
