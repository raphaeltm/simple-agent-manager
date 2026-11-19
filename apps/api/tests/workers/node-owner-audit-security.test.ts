import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { recordOwnerNodeDeletionAudit } from '../../src/services/owner-node-deletion-audit';
import { seedNode, seedUser } from './helpers/seed-d1';

const strict = 'owner_requested_node_deletion';
const attested = 'owner_attested_manual_deletion';
const proof = '2026-11-03T00:00:00.000Z';

async function fixture() {
  const id = crypto.randomUUID();
  const userId = 'audit-user-' + id;
  await seedUser(userId);
  await seedNode(id, userId, { status: 'destroying', createdAt: '2026-11-01T00:00:00.000Z' });
  await env.DATABASE.prepare(
    'UPDATE nodes SET runtime_termination_confirmed_at=?,runtime_incarnation_id=? WHERE id=?'
  )
    .bind(proof, 'incarnation-' + id, id)
    .run();
  const node = {
    id,
    nodeClass: 'managed',
    lastHeartbeatAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  const cleanup = {
    nodeFound: true,
    runtimeTerminationConfirmed: true,
    providerVmDeleted: false,
    providerVmDeleteSkippedReason: null,
    backendDnsDeleted: true,
    runtimeTerminationConfirmedAt: proof,
    runtimeIncarnationId: 'incarnation-' + id,
    errors: [],
  };
  const write = (reason: string) =>
    recordOwnerNodeDeletionAudit(env as unknown as Env, node, userId, cleanup, reason);
  const rows = () =>
    env.DATABASE.prepare('SELECT id,reason,created_at FROM node_health_events WHERE node_id=?')
      .bind(id)
      .all();
  return { id, userId, node, cleanup, write, rows };
}

describe('atomic owner audit provenance under stale route decisions', () => {
  it.each(['missing', 'proof', 'incarnation'])(
    'does not create a strict audit when consumed node identity becomes %s',
    async (change) => {
      const f = await fixture();
      if (change === 'missing')
        await env.DATABASE.prepare('DELETE FROM nodes WHERE id=?').bind(f.id).run();
      if (change === 'proof')
        await env.DATABASE.prepare('UPDATE nodes SET runtime_termination_confirmed_at=? WHERE id=?')
          .bind('later-proof', f.id)
          .run();
      if (change === 'incarnation')
        await env.DATABASE.prepare('UPDATE nodes SET runtime_incarnation_id=? WHERE id=?')
          .bind('later-incarnation', f.id)
          .run();
      await expect(f.write(strict)).rejects.toThrow(
        'Node incarnation changed before deletion audit'
      );
      expect((await f.rows()).results).toEqual([]);
    }
  );

  it('rejects a stale strict reason after provenance changes to attested, even with an existing strict event', async () => {
    const f = await fixture();
    await f.write(strict);
    const before = (await f.rows()).results;
    await env.DATABASE.prepare(
      'UPDATE nodes SET runtime_termination_attested_at=runtime_termination_confirmed_at WHERE id=?'
    )
      .bind(f.id)
      .run();
    await expect(f.write(strict)).rejects.toThrow('Node incarnation changed before deletion audit');
    expect((await f.rows()).results).toEqual(before);
    await f.write(attested);
    expect((await f.rows()).results.map((row) => row.reason).sort()).toEqual(
      [attested, strict].sort()
    );
  });

  it('never upgrades an interrupted manual proof through a stale strict fallback reason', async () => {
    const f = await fixture();
    await env.DATABASE.prepare(
      'UPDATE nodes SET runtime_termination_attested_at=runtime_termination_confirmed_at WHERE id=?'
    )
      .bind(f.id)
      .run();
    await expect(f.write(strict)).rejects.toThrow('Node incarnation changed before deletion audit');
    expect((await f.rows()).results).toEqual([]);
    await f.write(attested);
    expect((await f.rows()).results.map((row) => row.reason)).toEqual([attested]);
  });

  it('rejects a stale manual reason after a strict proof clears attestation', async () => {
    const f = await fixture();
    await expect(f.write(attested)).rejects.toThrow(
      'Node incarnation changed before deletion audit'
    );
    expect((await f.rows()).results).toEqual([]);
    await f.write(strict);
    expect((await f.rows()).results.map((row) => row.reason)).toEqual([strict]);
  });
});
