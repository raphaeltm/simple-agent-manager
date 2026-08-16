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
const getVM = vi.fn();
let listedServers: ReturnType<typeof server>[] = [];

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
  hasAmbiguousLabel: (labels: Record<string, string>, key: string) =>
    labels[`__sam_internal_ambiguous_label__${key}`] === 'true',
  createProvider: vi.fn(() => ({
    listVMs: async (labels: Record<string, string>) => {
      listedServers = await listVMs(labels);
      return listedServers;
    },
    getVM,
    deleteVM,
  })),
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
const INSTALLATION_ID = '0123456789abcdef0123456789abcdef';
const FOREIGN_INSTALLATION_ID = 'fedcba9876543210fedcba9876543210';

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
      installation: INSTALLATION_ID,
    },
    ...overrides,
  };
}

/**
 * @param claimRows rows the `nodes` lookup should return, or 'throw' to simulate a
 *                  failed D1 read.
 */
function makeEnv(
  claimRows:
    | Array<{ id: unknown; status: unknown; provider_instance_id?: unknown }>
    | 'throw'
    | 'malformed-result' = [],
  overrides: Partial<Env> = {}
): Env {
  return {
    ENVIRONMENT: 'production',
    SAM_INSTALLATION_ID: INSTALLATION_ID,
    KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    DATABASE: {
      prepare: vi.fn(() => ({
        bind: vi.fn((...requestedIds: string[]) => ({
          all: vi.fn(async () => {
            if (claimRows === 'throw') throw new Error('D1_ERROR: read failed');
            if (claimRows === 'malformed-result') return { success: true, results: null };
            const results = claimRows.map((row, index) => ({
              requested_id:
                typeof row.id === 'string' && requestedIds.includes(row.id.toLowerCase())
                  ? row.id.toLowerCase()
                  : (requestedIds[index] ?? requestedIds[0]),
              ...row,
            }));
            for (const requestedId of requestedIds) {
              const matched = claimRows.some(
                (row) => typeof row.id === 'string' && row.id.toLowerCase() === requestedId
              );
              if (!matched) {
                results.push({
                  requested_id: requestedId,
                  id: null,
                  status: null,
                  provider_instance_id: null,
                });
              }
            }
            return { success: true, results };
          }),
        })),
      })),
    },
    OBSERVABILITY_DATABASE: {},
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteVM.mockResolvedValue(undefined);
  listVMs.mockReset();
  listedServers = [];
  getVM.mockReset();
  getVM.mockImplementation(
    async (id: string) => listedServers.find((item) => item.id === id) ?? null
  );
});

describe('provider orphan reconciliation — destroys genuine orphans', () => {
  it('destroys a server whose node row does not exist', async () => {
    listVMs.mockResolvedValue([server()]);
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).toHaveBeenCalledWith('srv-1');
    expect(result.destroyed).toBe(1);
    expect(result.scanned).toBe(1);
  });

  it.each(['deleted', 'destroyed'])(
    'destroys a server whose node row is terminally %s',
    async (status) => {
      listVMs.mockResolvedValue([server()]);
      const result = await runProviderOrphanReconciliation(
        makeEnv([{ id: ORPHAN_NODE_ID, status, provider_instance_id: 'srv-1' }])
      );

      expect(deleteVM).toHaveBeenCalledWith('srv-1');
      expect(result.destroyed).toBe(1);
    }
  );

  it('scopes the provider query to this environment', async () => {
    listVMs.mockResolvedValue([]);
    await runProviderOrphanReconciliation(makeEnv([]));

    // Filtering server-side keeps a sibling deployment's servers out of the
    // candidate set entirely rather than relying on us to filter correctly.
    expect(listVMs).toHaveBeenCalledWith({
      managed: 'simple-agent-manager',
      env: 'production',
      installation: INSTALLATION_ID,
    });
  });
});

describe('provider orphan reconciliation — fails closed', () => {
  it('deletes only the exact-install orphan in a mixed adversarial provider response', async () => {
    const owned = server({ id: 'owned-orphan' });
    const foreign = server({
      id: 'foreign-live',
      name: owned.name,
      labels: { ...server().labels, installation: FOREIGN_INSTALLATION_ID },
    });
    const legacyLabels = { ...server().labels };
    delete (legacyLabels as Record<string, unknown>).installation;
    listVMs.mockResolvedValue([
      foreign,
      server({ id: 'legacy', name: owned.name, labels: legacyLabels }),
      owned,
    ]);

    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).toHaveBeenCalledTimes(1);
    expect(deleteVM).toHaveBeenCalledWith('owned-orphan');
    expect(deleteVM).not.toHaveBeenCalledWith('foreign-live');
    expect(deleteVM).not.toHaveBeenCalledWith('legacy');
    expect(result.destroyed).toBe(1);
  });

  it('isolates two control planes sharing account, env, name, node label, and prefix', async () => {
    const installationA = INSTALLATION_ID;
    const installationB = FOREIGN_INSTALLATION_ID;
    const sharedServers = [
      server({ id: 'server-a', labels: { ...server().labels, installation: installationA } }),
      server({ id: 'server-b', labels: { ...server().labels, installation: installationB } }),
    ];
    listVMs.mockImplementation(async (filters: Record<string, string>) =>
      sharedServers.filter((item) =>
        Object.entries(filters).every(([key, value]) => item.labels[key] === value)
      )
    );

    const resultA = await runProviderOrphanReconciliation(makeEnv([]));
    const resultB = await runProviderOrphanReconciliation(
      makeEnv([{ id: ORPHAN_NODE_ID, status: 'running', provider_instance_id: 'server-b' }], {
        SAM_INSTALLATION_ID: installationB,
      })
    );

    expect(resultA.destroyed).toBe(1);
    expect(resultB.destroyed).toBe(0);
    expect(deleteVM).toHaveBeenCalledTimes(1);
    expect(deleteVM).toHaveBeenCalledWith('server-a');
    expect(deleteVM).not.toHaveBeenCalledWith('server-b');
  });

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

  it('never deletes a sibling installation server sharing account, env, and colliding name', async () => {
    listVMs.mockResolvedValue([
      server({
        name: `node-${ORPHAN_NODE_ID}`,
        labels: {
          ...server().labels,
          installation: FOREIGN_INSTALLATION_ID,
          resource_prefix: 'same-prefix',
        },
      }),
    ]);

    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedForeignInstallation).toBe(1);
    const { log } = await import('../../../src/lib/logger');
    const serializedLog = JSON.stringify(vi.mocked(log.warn).mock.calls);
    expect(serializedLog).toContain('provider_orphan.ownership_skipped');
    expect(serializedLog).toContain('foreign');
    expect(serializedLog).not.toContain('srv-1');
    expect(serializedLog).not.toContain('test-token');
  });

  it('never deletes a sibling installation server when prefixes differ', async () => {
    listVMs.mockResolvedValue([
      server({
        name: 'sam-production-node-collision',
        labels: {
          ...server().labels,
          installation: FOREIGN_INSTALLATION_ID,
          resource_prefix: 'different-prefix',
        },
      }),
    ]);

    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedForeignInstallation).toBe(1);
  });

  it('preserves legacy env-labelled servers without an installation marker after grace expiry', async () => {
    const legacyLabels = { ...server().labels };
    delete (legacyLabels as Record<string, unknown>).installation;
    listVMs.mockResolvedValue([server({ createdAt: ago(30 * HOUR), labels: legacyLabels })]);

    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedUnattributedInstallation).toBe(1);
  });

  it('skips a server labelled for a different environment', async () => {
    listVMs.mockResolvedValue([server({ labels: { ...server().labels, env: 'staging' } })]);
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedForeignEnv).toBe(1);
  });

  it('skips provider over-return that lacks the exact managed scope', async () => {
    listVMs.mockResolvedValue([
      server({ labels: { ...server().labels, managed: 'lookalike-manager' } }),
    ]);
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedForeignManaged).toBe(1);
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

  it('skips before provider discovery when installation identity is missing or malformed', async () => {
    for (const installationId of [undefined, 's123abc', 'not-hex'.repeat(8)]) {
      const result = await runProviderOrphanReconciliation(
        makeEnv([], { SAM_INSTALLATION_ID: installationId })
      );
      expect(result.skipReason).toBe('no-installation-identity');
    }

    expect(listVMs).not.toHaveBeenCalled();
    expect(deleteVM).not.toHaveBeenCalled();
    const { log } = await import('../../../src/lib/logger');
    expect(log.warn).toHaveBeenCalledWith(
      'provider_orphan.skipped_no_installation',
      expect.objectContaining({ action: expect.stringContaining('Pulumi') })
    );
  });

  it.each(['abc', ' '.repeat(32), INSTALLATION_ID.toUpperCase(), `${INSTALLATION_ID}0`])(
    'treats malformed or noncanonical provider installation label %j as foreign',
    async (installation) => {
      listVMs.mockResolvedValue([server({ labels: { ...server().labels, installation } })]);
      const result = await runProviderOrphanReconciliation(makeEnv([]));

      expect(deleteVM).not.toHaveBeenCalled();
      expect(result.skippedForeignInstallation).toBe(1);
    }
  );

  it('aborts on a malformed D1 result instead of treating it as absence', async () => {
    listVMs.mockResolvedValue([server()]);
    const result = await runProviderOrphanReconciliation(makeEnv('malformed-result'));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skipReason).toBe('claim-lookup-failed');
  });

  it('aborts on malformed or case-colliding duplicate D1 rows', async () => {
    listVMs.mockResolvedValue([server()]);
    const malformed = await runProviderOrphanReconciliation(
      makeEnv([{ id: null, status: 'deleted', provider_instance_id: 'srv-1' }])
    );
    expect(malformed.skipReason).toBe('claim-lookup-failed');
    expect(deleteVM).not.toHaveBeenCalled();

    const duplicate = await runProviderOrphanReconciliation(
      makeEnv([
        { id: ORPHAN_NODE_ID, status: 'running', provider_instance_id: 'srv-1' },
        { id: ORPHAN_NODE_ID.toUpperCase(), status: 'deleted', provider_instance_id: 'srv-1' },
      ])
    );
    expect(duplicate.skipReason).toBe('claim-lookup-failed');
    expect(deleteVM).not.toHaveBeenCalled();
  });

  it('preserves a terminal row whose provider instance conflicts with discovery', async () => {
    listVMs.mockResolvedValue([server()]);
    const result = await runProviderOrphanReconciliation(
      makeEnv([{ id: ORPHAN_NODE_ID, status: 'deleted', provider_instance_id: 'different-server' }])
    );

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedAmbiguousClaim).toBe(1);
  });

  it('preserves a terminal row with no provider instance ownership evidence', async () => {
    listVMs.mockResolvedValue([server()]);
    const result = await runProviderOrphanReconciliation(
      makeEnv([{ id: ORPHAN_NODE_ID, status: 'deleted', provider_instance_id: null }])
    );

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedAmbiguousClaim).toBe(1);
  });

  it('aborts on unsuccessful or unexpected D1 inventory results', async () => {
    const env = makeEnv([]);
    const all = vi.fn().mockResolvedValue({ success: false, results: [] });
    env.DATABASE.prepare = vi.fn(() => ({ bind: vi.fn(() => ({ all })) })) as never;
    listVMs.mockResolvedValue([server()]);
    const unsuccessful = await runProviderOrphanReconciliation(env);
    expect(unsuccessful.skipReason).toBe('claim-lookup-failed');
    expect(deleteVM).not.toHaveBeenCalled();

    const unexpected = await runProviderOrphanReconciliation(
      makeEnv([{ id: CLAIMED_NODE_ID, status: 'deleted', provider_instance_id: 'srv-1' }])
    );
    expect(unexpected.skipReason).toBe('claim-lookup-failed');
    expect(deleteVM).not.toHaveBeenCalled();
  });

  it('aborts when D1 omits explicit success metadata', async () => {
    const env = makeEnv([]);
    const all = vi.fn().mockResolvedValue({ results: [] });
    env.DATABASE.prepare = vi.fn(() => ({ bind: vi.fn(() => ({ all })) })) as never;
    listVMs.mockResolvedValue([server()]);

    const result = await runProviderOrphanReconciliation(env);

    expect(result.skipReason).toBe('claim-lookup-failed');
    expect(getVM).not.toHaveBeenCalled();
    expect(deleteVM).not.toHaveBeenCalled();
  });

  it('aborts when a successful D1 response omits a requested inventory result', async () => {
    const secondNode = '01kx84mcg1yn1tqvwr60b3g701';
    listVMs.mockResolvedValue([
      server(),
      server({ id: 'srv-2', labels: { ...server().labels, node: secondNode } }),
    ]);
    const partialEnv = makeEnv([]);
    partialEnv.DATABASE.prepare = vi.fn(() => ({
      bind: vi.fn((firstRequestedId: string) => ({
        all: vi.fn().mockResolvedValue({
          success: true,
          results: [
            {
              requested_id: firstRequestedId,
              id: null,
              status: null,
              provider_instance_id: null,
            },
          ],
        }),
      })),
    })) as never;

    const result = await runProviderOrphanReconciliation(partialEnv);

    expect(result.skipReason).toBe('claim-lookup-failed');
    expect(getVM).not.toHaveBeenCalled();
    expect(deleteVM).not.toHaveBeenCalled();
  });

  it('revalidates exact ownership immediately before the delete boundary', async () => {
    listVMs.mockResolvedValue([server()]);
    getVM.mockResolvedValue(
      server({ labels: { ...server().labels, installation: FOREIGN_INSTALLATION_ID } })
    );

    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(getVM).toHaveBeenCalledWith('srv-1');
    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedForeignInstallation).toBe(1);
  });

  it('fails closed when final provider ownership cannot be re-read', async () => {
    listVMs.mockResolvedValue([server()]);
    getVM.mockRejectedValue(new Error('provider timeout'));

    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.errors).toBe(1);
  });

  it.each([
    {
      name: 'resource is absent',
      current: null,
      counter: 'skippedAmbiguousOwnership',
    },
    {
      name: 'managed scope changed',
      current: server({ labels: { ...server().labels, managed: 'foreign-manager' } }),
      counter: 'skippedForeignManaged',
    },
    {
      name: 'environment scope changed',
      current: server({ labels: { ...server().labels, env: 'staging' } }),
      counter: 'skippedForeignEnv',
    },
    {
      name: 'installation ownership became ambiguous',
      current: server({
        labels: {
          ...server().labels,
          __sam_internal_ambiguous_label__installation: 'true',
        },
      }),
      counter: 'skippedAmbiguousOwnership',
    },
    {
      name: 'provider id changed',
      current: server({ id: 'different-provider-id' }),
      counter: 'skippedAmbiguousOwnership',
    },
    {
      name: 'node identity changed',
      current: server({ labels: { ...server().labels, node: CLAIMED_NODE_ID } }),
      counter: 'skippedAmbiguousOwnership',
    },
    {
      name: 'creation identity changed',
      current: server({ createdAt: ago(5 * HOUR) }),
      counter: 'skippedAmbiguousOwnership',
    },
  ])('fails closed when final $name', async ({ current, counter }) => {
    listVMs.mockResolvedValue([server()]);
    getVM.mockResolvedValue(current);

    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result[counter as keyof typeof result]).toBe(1);
    const { log } = await import('../../../src/lib/logger');
    expect(log.warn).toHaveBeenCalledWith(
      'provider_orphan.final_ownership_skipped',
      expect.objectContaining({ action: expect.stringContaining('delete boundary') })
    );
  });

  it('destroys NOTHING when the provider list call fails', async () => {
    listVMs.mockRejectedValue(new Error('provider 500'));
    const result = await runProviderOrphanReconciliation(makeEnv([]));

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skipReason).toBe('provider-list-failed');
  });

  it('destroys NOTHING when no platform credential exists', async () => {
    const { getPlatformCloudCredential } =
      await import('../../../src/services/platform-credentials');
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
  it('enforces the configured grace boundary exactly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T12:00:00.000Z'));
    try {
      listVMs.mockResolvedValue([
        server({ id: 'before', createdAt: '2026-08-12T11:00:00.001Z' }),
        server({ id: 'at', createdAt: '2026-08-12T11:00:00.000Z' }),
        server({ id: 'after', createdAt: '2026-08-12T10:59:59.999Z' }),
      ]);
      const result = await runProviderOrphanReconciliation(
        makeEnv([], { PROVIDER_ORPHAN_MIN_AGE_MS: String(HOUR) })
      );

      expect(deleteVM).toHaveBeenCalledTimes(2);
      expect(deleteVM).toHaveBeenCalledWith('at');
      expect(deleteVM).toHaveBeenCalledWith('after');
      expect(deleteVM).not.toHaveBeenCalledWith('before');
      expect(result.skippedYoung).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('retries an owned orphan after a transient delete failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T12:00:00.000Z'));
    try {
      listVMs.mockResolvedValue([server()]);
      deleteVM
        .mockRejectedValueOnce(new Error('provider timeout'))
        .mockResolvedValueOnce(undefined);
      const retryEnv = makeEnv([], { PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS: String(HOUR) });
      let lastRun: string | null = null;
      retryEnv.KV.get = vi.fn(async () => lastRun);
      retryEnv.KV.put = vi.fn(async (_key: string, value: string) => {
        lastRun = value;
      });

      const first = await runProviderOrphanReconciliation(retryEnv);
      const gated = await runProviderOrphanReconciliation(retryEnv);
      vi.advanceTimersByTime(HOUR);
      const second = await runProviderOrphanReconciliation(retryEnv);

      expect(first.destroyed).toBe(0);
      expect(first.errors).toBe(1);
      expect(gated.skipReason).toBe('interval-not-elapsed');
      expect(second.destroyed).toBe(1);
      expect(deleteVM).toHaveBeenCalledTimes(2);
      expect(deleteVM).toHaveBeenNthCalledWith(1, 'srv-1');
      expect(deleteVM).toHaveBeenNthCalledWith(2, 'srv-1');
    } finally {
      vi.useRealTimers();
    }
  });
});
