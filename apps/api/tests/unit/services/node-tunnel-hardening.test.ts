// Register shared boundary mocks before importing production services.
import './node-tunnel-fixture';

import { markProviderCreateNotDispatched, ProviderError } from '@simple-agent-manager/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeAllocationUncertainError } from '../../../src/services/node-allocation-recovery';
import { releaseDurableTunnelBeforeVm } from '../../../src/services/node-provisioning-predicates';
import {
  pendingCreateSettled,
  runNodeTunnelCleanupSweep,
} from '../../../src/services/node-tunnel-cleanup';
import { durableAttemptTunnelBudgetMs } from '../../../src/services/node-tunnel-config';
import { describeProvisioningFailure } from '../../../src/services/node-tunnel-provisioning-failure';
import { provisionNode } from '../../../src/services/nodes';
import {
  cf,
  env,
  freshNode,
  journal,
  logged,
  mocks,
  provider,
  readNode,
  sqlite,
  tunnelEnv,
  vmFor,
} from './node-tunnel-fixture';

afterEach(() => {
  vi.useRealTimers();
});

/** A tunnel whose create POST is sent but whose commit never arrives (lost forever). */
async function strandedPendingCreate() {
  const node = await freshNode();
  cf.inject('tunnel.create', { kind: 'commit-later' });
  await provisionNode(node.id, env);
  expect(journal(node.id)).toMatchObject([
    { status: 'cleanup_pending', pendingCreateCount: 1, tunnelId: null },
  ]);
  return node;
}

describe('a row released inside a sweep is due in that same sweep', () => {
  it('cleans a just-released row even when the sweep clock was captured before the release', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
    // Controlled ordering (rule 62): the sweep's `now` is strictly earlier than the release
    // write. Pre-fix the release stamped cleanup_next_attempt_at = wall clock > now, so the
    // row was not due and the sweep did nothing (the CI flake, idea 01M73MNS3QD04CTD4P0GH7C8RC).
    const result = await runNodeTunnelCleanupSweep(env, new Date(Date.now() - 60_000));
    expect(result).toMatchObject({ released: 1, attempted: 1, cleaned: 1 });
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned' }]);
    expect(cf.liveTunnels()).toEqual([]);
  });

  it('still skips a row whose real backoff is in the future (control)', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
    await runNodeTunnelCleanupSweep(env);
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned' }]);
    const other = await freshNode();
    await provisionNode(other.id, env);
    sqlite
      .prepare(
        `UPDATE node_cloudflare_tunnels SET status = 'cleanup_pending',
           cleanup_next_attempt_at = ? WHERE node_id = ?`
      )
      .run(new Date(Date.now() + 60 * 60_000).toISOString(), other.id);
    const result = await runNodeTunnelCleanupSweep(env);
    expect(result.attempted).toBe(0);
    expect(journal(other.id)).toMatchObject([{ status: 'cleanup_pending' }]);
  });

  it('writes NULL (due now) rather than a clock stamp on release', async () => {
    const node = await freshNode();
    await provisionNode(node.id, env);
    sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
    const { releaseNonLiveNodeTunnels } = await import('../../../src/services/node-tunnel-journal');
    expect(await releaseNonLiveNodeTunnels(env, 'test', node.id)).toBe(1);
    expect(journal(node.id)).toMatchObject([
      { status: 'cleanup_pending', cleanupNextAttemptAt: null },
    ]);
  });
});

describe('an unobserved create settles after the settle window', () => {
  it('keeps the row pending inside the window and cleans it within settle + one backoff', async () => {
    const node = await strandedPendingCreate();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    // Drive the real sweep at each time the row becomes due, the way the cron reaches it.
    let now = start;
    let sweeps = 0;
    while (journal(node.id)[0]!.status !== 'cleaned' && sweeps < 20) {
      const next = journal(node.id)[0]!.cleanupNextAttemptAt;
      now = Math.max(now, next ? Date.parse(next) : now) + 1;
      vi.setSystemTime(now);
      const listsBefore = cf.callCount('tunnel.list');
      const result = await runNodeTunnelCleanupSweep(env, new Date(now));
      // Liveness: every sweep really attempted the row and re-read the inventory.
      expect(result.attempted).toBe(1);
      expect(cf.callCount('tunnel.list')).toBeGreaterThan(listsBefore);
      if (now - start < 15 * 60_000) {
        expect(journal(node.id)[0]).toMatchObject({
          status: 'cleanup_pending',
          pendingCreateCount: 1,
        });
      }
      sweeps++;
    }
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned', pendingCreateCount: 0 }]);
    // Rule 81: worst case is the settle window plus the backoff interval that spans its end.
    // Backoff doubles from 1 min, so that interval is at most the time already elapsed:
    // completion <= 2 x settle (30 min at the defaults).
    expect(now - start).toBeLessThanOrEqual(2 * 15 * 60_000 + 60_000);
    expect(logged.join('\n')).toContain('node_tunnel.pending_create_settled_by_age');
  });

  it('settles exactly at the window boundary, not before', () => {
    const since = '2026-11-10T00:00:00.000Z';
    const row = { pendingCreateCount: 1, pendingCreateSince: since };
    const at = Date.parse(since) + 900_000;
    expect(pendingCreateSettled(row, 900_000, at - 1)).toBe(false);
    expect(pendingCreateSettled(row, 900_000, at)).toBe(true);
    expect(
      pendingCreateSettled({ ...row, pendingCreateSince: 'not-a-date' }, 900_000, at * 2)
    ).toBe(false);
    expect(pendingCreateSettled({ ...row, pendingCreateCount: 0 }, 900_000, 0)).toBe(true);
  });

  it('still deletes a late-committed tunnel that appears inside the window', async () => {
    const node = await strandedPendingCreate();
    cf.commitDelayed();
    expect(cf.liveTunnels()).toHaveLength(1);
    const due = Date.parse(journal(node.id)[0]!.cleanupNextAttemptAt ?? new Date().toISOString());
    await runNodeTunnelCleanupSweep(env, new Date(due + 1));
    expect(cf.liveTunnels()).toEqual([]);
    expect(journal(node.id)).toMatchObject([{ status: 'cleanup_pending' }]);
  });

  it('anchors a row stranded before migration 0233 on created_at', async () => {
    const node = await strandedPendingCreate();
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    sqlite
      .prepare(
        `UPDATE node_cloudflare_tunnels SET pending_create_last_at = NULL, created_at = ?,
           cleanup_next_attempt_at = NULL WHERE node_id = ?`
      )
      .run(old, node.id);
    await runNodeTunnelCleanupSweep(env);
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned', pendingCreateCount: 0 }]);
  });

  it('does not settle when a newer create was claimed after cleanup read the row', async () => {
    const node = await strandedPendingCreate();
    sqlite
      .prepare(
        `UPDATE node_cloudflare_tunnels SET pending_create_last_at = ?, cleanup_next_attempt_at = NULL
          WHERE node_id = ?`
      )
      .run(new Date(Date.now() - 2 * 60 * 60_000).toISOString(), node.id);
    // While cleanup is deleting, a claim moves the stamp (as withJournaledTunnelCreate does).
    cf.inject('tunnel.list', {
      kind: 'hook',
      run: () => {
        sqlite
          .prepare(
            `UPDATE node_cloudflare_tunnels SET pending_create_last_at = ?,
               pending_create_count = pending_create_count + 1 WHERE node_id = ?`
          )
          .run(new Date().toISOString(), node.id);
      },
    });
    await runNodeTunnelCleanupSweep(env);
    expect(journal(node.id)).toMatchObject([{ status: 'cleanup_pending', pendingCreateCount: 2 }]);
  });
});

describe('every failed tunnel attempt records its cause', () => {
  it.each([
    ['tunnel.create', { kind: 'status', status: 400, code: 1000 }, 'tunnel'],
    ['tunnel.configure', { kind: 'status', status: 400, code: 1055 }, 'ingress'],
    ['dns.create', { kind: 'status', status: 400, code: 9000 }, 'dns'],
    ['tunnel.token', { kind: 'status', status: 403, code: 10000 }, 'token'],
  ] as const)('%s failure is logged with its phase', async (op, fault, phase) => {
    const node = await freshNode();
    cf.inject(op, fault);
    await provisionNode(node.id, env);
    expect(mocks.createVM).not.toHaveBeenCalled();
    const line = logged.find((entry) => entry.includes('node_provisioning.attempt_failed'));
    expect(line).toContain(`"phase":"${phase}"`);
    expect(line).toContain('"durable":false');
    // A non-durable pre-VM failure is released and cleaned at once (clean clears last_error).
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned' }]);
  });

  it('keeps the recorded cause on a row whose unobserved create is still settling', async () => {
    const node = await strandedPendingCreate();
    const before = journal(node.id)[0]!.lastError;
    expect(before).toMatch(/^failed during tunnel: /);
    const due = Date.parse(journal(node.id)[0]!.cleanupNextAttemptAt ?? new Date().toISOString());
    await runNodeTunnelCleanupSweep(env, new Date(due + 1));
    expect(journal(node.id)).toMatchObject([{ status: 'cleanup_pending', lastError: before }]);
  });
});

describe('deadline cuts on each side of the create POST', () => {
  function durableHarness(initial: string) {
    const store = { providerCreateRequested: false };
    const allocation = (incarnationId: string, onMark?: () => void) => ({
      createdAt: Date.now(),
      initialIncarnationId: initial,
      incarnationId,
      providerCreateRequested: store.providerCreateRequested,
      markProviderCreateRequested: async () => {
        store.providerCreateRequested = true;
        onMark?.();
      },
      clearProviderCreateRequested: async () => {
        store.providerCreateRequested = false;
      },
    });
    return { store, allocation };
  }

  it('a non-durable attempt cut mid tunnel setup releases its tunnel at once (control)', async () => {
    const node = await freshNode();
    const controller = new AbortController();
    const reason = new Error('caller deadline');
    cf.inject('tunnel.create', { kind: 'hook', run: () => controller.abort(reason) });
    await expect(
      provisionNode(node.id, env, undefined, { signal: controller.signal })
    ).rejects.toBe(reason);
    expect(journal(node.id)).toMatchObject([
      { status: 'cleanup_pending', cleanupReason: 'provisioning_failed_before_vm' },
    ]);
    expect(journal(node.id)[0]!.lastError).toMatch(
      /^aborted during tunnel: Error: caller deadline/
    );
    await runNodeTunnelCleanupSweep(env);
    expect(cf.liveTunnels()).toEqual([]);
  });

  it('a durable attempt cut after the tunnel is active but before the POST creates on resume', async () => {
    const node = await freshNode();
    const { store, allocation } = durableHarness(readNode(node.id)!.incarnation!);
    const incarnationId = crypto.randomUUID();
    const first = new AbortController();
    await expect(
      provisionNode(node.id, env, undefined, {
        signal: first.signal,
        durableAllocation: allocation(incarnationId),
        assertExternalMutationAuthority: async () => {
          first.abort(new NodeAllocationUncertainError('Provisioning request deadline elapsed'));
          throw first.signal.reason;
        },
      })
    ).rejects.toBeInstanceOf(NodeAllocationUncertainError);
    expect(store.providerCreateRequested).toBe(false);
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(journal(node.id)).toMatchObject([{ status: 'active' }]);

    const configures = cf.callCount('tunnel.configure');
    await provisionNode(node.id, env, undefined, {
      signal: new AbortController().signal,
      durableAllocation: allocation(incarnationId),
    });
    expect(store.providerCreateRequested).toBe(true);
    expect(mocks.createVM).toHaveBeenCalledTimes(1);
    expect(readNode(node.id)).toMatchObject({ status: 'running', transport: 'cloudflare-tunnel' });
    // Resume fast path: no second ingress write, one tunnel.
    expect(cf.callCount('tunnel.configure')).toBe(configures);
    expect(cf.callCount('tunnel.create')).toBe(1);
  });

  it('a deadline that fires while the create is being marked does not strand the mark', async () => {
    const node = await freshNode();
    const { store, allocation } = durableHarness(readNode(node.id)!.incarnation!);
    const first = new AbortController();
    // The deadline elapses during the mark's storage write. Pre-fix an abort check after the
    // mark threw here: a recorded create that was never sent, which no attempt could reconcile.
    await expect(
      provisionNode(node.id, env, undefined, {
        signal: first.signal,
        durableAllocation: allocation(crypto.randomUUID(), () =>
          first.abort(new NodeAllocationUncertainError('Provisioning request deadline elapsed'))
        ),
      })
    ).resolves.toEqual({ allocationConfirmed: true });
    expect(store.providerCreateRequested).toBe(true);
    expect(mocks.createVM).toHaveBeenCalledTimes(1);
    expect(readNode(node.id)).toMatchObject({ status: 'running' });
  });

  it('a provider failure proven unsent withdraws the mark, keeps its cause, and the resume creates', async () => {
    const node = await freshNode();
    const { store, allocation } = durableHarness(readNode(node.id)!.incarnation!);
    const incarnationId = crypto.randomUUID();
    // GCP: the token exchange failed before the insert (gcp-create-dispatch.test.ts).
    const unsent = markProviderCreateNotDispatched(
      new ProviderError('gcp', 503, 'GCP token exchange failed')
    );
    mocks.createVM.mockRejectedValueOnce(unsent);
    const err = await provisionNode(node.id, env, undefined, {
      signal: new AbortController().signal,
      durableAllocation: allocation(incarnationId),
    }).catch((e: unknown) => e);
    // A retryable attempt failure (the node is not marked error), carrying the real cause.
    expect(err).toBeInstanceOf(NodeAllocationUncertainError);
    expect(String((err as Error).message)).toContain('GCP token exchange failed');
    expect(readNode(node.id)).toMatchObject({ status: 'creating' });
    expect(store.providerCreateRequested).toBe(false);
    // The tunnel is kept for the resume: the durable owner, not this attempt, releases it.
    expect(journal(node.id)).toMatchObject([{ status: 'active' }]);

    await provisionNode(node.id, env, undefined, {
      signal: new AbortController().signal,
      durableAllocation: allocation(incarnationId),
    });
    expect(mocks.createVM).toHaveBeenCalledTimes(2);
    expect(store.providerCreateRequested).toBe(true);
    expect(readNode(node.id)).toMatchObject({ status: 'running', transport: 'cloudflare-tunnel' });
  });

  it('an unproven provider failure keeps the mark and names its cause (control)', async () => {
    const node = await freshNode();
    const { store, allocation } = durableHarness(readNode(node.id)!.incarnation!);
    mocks.createVM.mockRejectedValueOnce(new ProviderError('gcp', 503, 'insert failed'));
    const err = await provisionNode(node.id, env, undefined, {
      signal: new AbortController().signal,
      durableAllocation: allocation(crypto.randomUUID()),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeAllocationUncertainError);
    expect(String((err as Error).message)).toContain('insert failed');
    // The insert may have committed: only reconciliation may proceed.
    expect(store.providerCreateRequested).toBe(true);
  });

  it('a deadline that fires during a marked durable create never cancels the provider create', async () => {
    const node = await freshNode();
    const { store, allocation } = durableHarness(readNode(node.id)!.incarnation!);
    const first = new AbortController();
    let completed = false;
    mocks.createVM.mockImplementationOnce(
      async (_config: unknown, context?: { signal?: AbortSignal }) => {
        // The attempt deadline fires mid-request (staging: inside GCP's token exchange).
        first.abort(new NodeAllocationUncertainError('Provisioning request deadline elapsed'));
        // The provider was not handed the attempt's signal, so its create runs to completion.
        expect(context?.signal).toBeUndefined();
        completed = true;
        return vmFor();
      }
    );
    // The attempt also publishes what it created: one durable attempt, one VM, running node.
    await expect(
      provisionNode(node.id, env, undefined, {
        signal: first.signal,
        durableAllocation: allocation(crypto.randomUUID()),
      })
    ).resolves.toEqual({ allocationConfirmed: true });
    expect(store.providerCreateRequested).toBe(true);
    expect(completed).toBe(true);
    expect(mocks.createVM).toHaveBeenCalledTimes(1);
    expect(readNode(node.id)).toMatchObject({ status: 'running', transport: 'cloudflare-tunnel' });
  });

  it('a deadline that fires during recovery still records the adopted VM, so the next attempt finishes', async () => {
    const node = await freshNode();
    const { buildNodeProviderLabels } = await import('../../../src/services/node-provider-labels');
    const incarnationId = crypto.randomUUID();
    const durable = {
      createdAt: Date.now() - 1000,
      initialIncarnationId: readNode(node.id)!.incarnation!,
      incarnationId,
      providerCreateRequested: true,
      markProviderCreateRequested: async () => undefined,
    };
    // Attempt 1 claims the incarnation, finishes the tunnel and is cut before the create.
    const first = new AbortController();
    await expect(
      provisionNode(node.id, env, undefined, {
        signal: first.signal,
        durableAllocation: { ...durable, providerCreateRequested: false },
        assertExternalMutationAuthority: async () => {
          first.abort(new NodeAllocationUncertainError('deadline'));
          throw first.signal.reason;
        },
      })
    ).rejects.toBeInstanceOf(NodeAllocationUncertainError);
    // Staging GCP: the VM exists, and the deadline fires while recovery reads the inventory.
    const vm = {
      ...vmFor(),
      location: 'nbg1',
      createdAt: new Date().toISOString(),
      labels: buildNodeProviderLabels({
        nodeId: node.id,
        isDeploymentNode: false,
        installationId: env.SAM_INSTALLATION_ID!,
        environmentLabel: 'test',
        runtimeIncarnationId: incarnationId,
      }),
    };
    const second = new AbortController();
    const listVMs = vi.fn(async (_labels: unknown, context?: { signal?: AbortSignal }) => {
      second.abort(new NodeAllocationUncertainError('Provisioning request deadline elapsed'));
      // Recovery is read-only and not cancelled by the attempt deadline.
      expect(context?.signal).toBeUndefined();
      return [vm];
    });
    mocks.createProvider.mockResolvedValue({
      ...provider,
      provider: { ...provider.provider, listVMs },
    });
    await provisionNode(node.id, env, undefined, {
      signal: second.signal,
      durableAllocation: durable,
    }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(NodeAllocationUncertainError);
    });
    // Progress persisted despite the cut: the adopted identity is on the node row.
    expect(readNode(node.id)?.providerInstanceId).toBe(vm.id);
    expect(mocks.createVM).not.toHaveBeenCalled();

    await provisionNode(node.id, env, undefined, {
      signal: new AbortController().signal,
      durableAllocation: durable,
    });
    expect(readNode(node.id)).toMatchObject({ status: 'running', providerInstanceId: vm.id });
    expect(mocks.createVM).not.toHaveBeenCalled();
  });

  it('a durable attempt cut during the POST never creates a second VM on resume', async () => {
    const node = await freshNode();
    const { store, allocation } = durableHarness(readNode(node.id)!.incarnation!);
    const incarnationId = crypto.randomUUID();
    const first = new AbortController();
    mocks.createVM.mockImplementationOnce(async () => {
      first.abort(new NodeAllocationUncertainError('Provisioning request deadline elapsed'));
      throw first.signal.reason;
    });
    await expect(
      provisionNode(node.id, env, undefined, {
        signal: first.signal,
        durableAllocation: allocation(incarnationId),
      })
    ).rejects.toBeInstanceOf(NodeAllocationUncertainError);
    expect(store.providerCreateRequested).toBe(true);

    const listVMs = vi.fn().mockResolvedValue([]);
    mocks.createProvider.mockResolvedValue({
      ...provider,
      provider: { ...provider.provider, listVMs },
    });
    await expect(
      provisionNode(node.id, env, undefined, {
        signal: new AbortController().signal,
        durableAllocation: allocation(incarnationId),
      })
    ).rejects.toThrow(/second create is forbidden/);
    expect(listVMs).toHaveBeenCalled();
    expect(mocks.createVM).toHaveBeenCalledTimes(1);
    // The possibly-created VM keeps its tunnel.
    expect(journal(node.id)).toMatchObject([{ status: 'active' }]);
  });
});

describe('durable attempt tunnel budget through the real resolver', () => {
  const node = (transport: string | null, runtimeIncarnationId: string | null) => ({
    runtime: 'vm',
    nodeClass: 'managed',
    transport,
    runtimeIncarnationId,
  });

  it('adds the default 20 s only when the attempt provisions with tunnel transport', async () => {
    expect(await durableAttemptTunnelBudgetMs(env, node('vm-public-dns', 'old'), 'new')).toBe(
      20_000
    );
    expect(
      await durableAttemptTunnelBudgetMs(env, node('cloudflare-tunnel', 'resumed'), 'resumed')
    ).toBe(20_000);
    // A resumed incarnation keeps its recorded transport, whatever the setting says now.
    expect(
      await durableAttemptTunnelBudgetMs(env, node('vm-public-dns', 'resumed'), 'resumed')
    ).toBe(0);
    const publicEnv = tunnelEnv({ VM_AGENT_TRANSPORT: undefined });
    expect(await durableAttemptTunnelBudgetMs(publicEnv, node(null, 'old'), 'new')).toBe(0);
    const badEnv = tunnelEnv({ VM_AGENT_TRANSPORT: 'cloudflare-tunnle' });
    expect(await durableAttemptTunnelBudgetMs(badEnv, node(null, 'old'), 'new')).toBe(0);
  });
});

describe('persisted causes never carry token-shaped values', () => {
  it('redacts JWTs and long opaque tokens', () => {
    // Joined at runtime so the source holds no JWT-shaped literal for secret scanners.
    const jwt = ['eyJhbGciOiJFUzI1NiJ9', 'eyJzdWIiOiJub2RlLTEifQ', 'c2lnbmF0dXJlLXZhbHVlLWhlcmU'].join('.');
    const opaque = 'A'.repeat(80);
    const text = describeProvisioningFailure(new Error(`bad ${jwt} and ${opaque} end`));
    expect(text).toBe('Error: bad [redacted] and [redacted] end');
  });
});

describe('a durable allocation that ends before any create POST releases its tunnel', () => {
  async function cutBeforePost() {
    const node = await freshNode();
    const incarnationId = crypto.randomUUID();
    const controller = new AbortController();
    await expect(
      provisionNode(node.id, env, undefined, {
        signal: controller.signal,
        durableAllocation: {
          createdAt: Date.now(),
          initialIncarnationId: readNode(node.id)!.incarnation!,
          incarnationId,
          providerCreateRequested: false,
          markProviderCreateRequested: async () => undefined,
        },
        assertExternalMutationAuthority: async () => {
          controller.abort(new NodeAllocationUncertainError('deadline'));
          throw controller.signal.reason;
        },
      })
    ).rejects.toBeInstanceOf(NodeAllocationUncertainError);
    expect(journal(node.id)).toMatchObject([{ status: 'active' }]);
    return { node, incarnationId };
  }

  it('releases and then cleans on positive no-create evidence', async () => {
    const { node, incarnationId } = await cutBeforePost();
    await releaseDurableTunnelBeforeVm(env, {
      input: { nodeId: node.id },
      incarnationId,
      providerCreateRequested: false,
    });
    expect(journal(node.id)).toMatchObject([
      { status: 'cleanup_pending', cleanupReason: 'durable_provisioning_ended_before_vm' },
    ]);
    await runNodeTunnelCleanupSweep(env);
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned' }]);
    expect(cf.liveTunnels()).toEqual([]);
    expect(cf.records()).toEqual([]);
  });

  it.each([
    ['a create may have been sent', true],
    ['an intent from before the field existed', undefined],
  ])('keeps the tunnel when %s', async (_name, providerCreateRequested) => {
    const { node, incarnationId } = await cutBeforePost();
    await releaseDurableTunnelBeforeVm(env, {
      input: { nodeId: node.id },
      incarnationId,
      providerCreateRequested,
    });
    expect(journal(node.id)).toMatchObject([{ status: 'active' }]);
    expect(cf.liveTunnels()).toHaveLength(1);
  });
});
