// Register shared boundary mocks before importing production services.
import './node-tunnel-fixture';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runNodeTunnelCleanupSweep } from '../../../src/services/node-tunnel-cleanup';
import { provisionNode } from '../../../src/services/nodes';
import { cf, env, freshNode, journal, logged, mocks, sqlite } from './node-tunnel-fixture';

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
  it('keeps the row pending inside the window and cleans it once the window has passed', async () => {
    const node = await strandedPendingCreate();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start + 60_000);
    await runNodeTunnelCleanupSweep(env, new Date(start + 60_000));
    expect(journal(node.id)).toMatchObject([{ status: 'cleanup_pending', pendingCreateCount: 1 }]);

    // Default vmTunnels.pendingCreateSettleMs is 15 minutes.
    const later = start + 16 * 60_000;
    vi.setSystemTime(later);
    const due = Date.parse(journal(node.id)[0]!.cleanupNextAttemptAt!);
    await runNodeTunnelCleanupSweep(env, new Date(Math.max(later, due + 1)));
    expect(journal(node.id)).toMatchObject([{ status: 'cleaned', pendingCreateCount: 0 }]);
    expect(logged.join('\n')).toContain('node_tunnel.pending_create_settled_by_age');
    // Liveness: cleanup really inspected the inventory for the exact name before settling.
    expect(cf.callCount('tunnel.list')).toBeGreaterThan(1);
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
