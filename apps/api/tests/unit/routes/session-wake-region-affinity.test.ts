/**
 * A wake prefers the region it slept in; it does not require it — the 2026-09-25 incident.
 *
 * A wake used to pass the sleeping workspace's location as an EXPLICIT placement location, so
 * placement dropped every offering elsewhere, and a healthy host elsewhere was "outside the current
 * pool allocation authority". In production that pin (fsn1) rejected a hel1 cx53 in the same pool,
 * revision and source at 17.2% projected utilisation; the wake fell through to a fresh cx53 that
 * hit the account's shared-core quota, three times in a row.
 *
 * Real wake (`ensureSessionRecovery`) → real placement resolution → real reusable-host selection
 * and atomic reservation, on SQLite. Only auth, repository access and DO transport are replaced
 * (`node-pool-upgrade-test-helpers.ts`).
 */
import { describe, expect, it } from 'vitest';

import type { StartTaskInput } from '../../../src/durable-objects/task-runner';
import { ensureSessionRecovery } from '../../../src/services/session-recovery';
import { type Fixture, fixture, reserve, seedHost, select } from './node-pool-upgrade-test-helpers';

function offeringIn(start: StartTaskInput, location: string) {
  const candidate = start.config.capacityPoolSelection!.candidates.find(
    (entry) => entry.location === location && entry.providerInstanceType === 'cx23'
  );
  expect(candidate, `the default pool offers cx23 in ${location}`).toBeDefined();
  return candidate!;
}

/**
 * Run the saved task, then put its conversation to sleep on a host in `sleptIn`: workspace
 * sleeping, host stopped, snapshot available. Returns the original run's start input.
 */
async function sleepingConversation(f: Fixture, sleptIn: string, rootExplicit = false) {
  const original = await f.run();
  const snapshot = await seedHost(
    f,
    original,
    'sleeping-host',
    'user-1',
    offeringIn(original, sleptIn)
  );
  expect(await reserve(f, original, snapshot, 'sleeping-host', 'sleeping-workspace')).toBe(true);
  f.sqlite
    .exec(`UPDATE workspaces SET status = 'sleeping', chat_session_id = 'chat-1', vm_location = '${sleptIn}',
      runtime_deletion_confirmed_at = '2026-09-07T00:00:00Z' WHERE id = 'sleeping-workspace';
    UPDATE nodes SET status = 'stopped', runtime_termination_confirmed_at = '2026-09-07T00:00:00Z' WHERE id = 'sleeping-host';
    UPDATE tasks SET status = 'awaiting_followup', workspace_id = 'sleeping-workspace', chat_session_id = 'chat-1',
      placement_explanation_json = json_set(COALESCE(placement_explanation_json, '{}'), '$.explicitVmLocation', json('${rootExplicit}'))
      WHERE id = 'task-1';
    INSERT INTO session_snapshots (id, workspace_id, node_id, project_id, user_id, chat_session_id,
      agent_session_id, runtime, status, degradation, manifest_r2_key, manifest_json,
      snapshot_generation, expires_at, sleep_status, sleeping_at, recovery_attempts, updated_at)
    VALUES ('snapshot-1', 'sleeping-workspace', 'sleeping-host', 'project-1', 'user-1', 'chat-1',
      'old-agent-session', 'vm', 'available', 'none', 'snapshots/chat-1/final/manifest.json',
      '{"status":"available","agentType":"claude-code"}', 'final', '2099-09-07T00:00:00Z',
      'sleeping', '2026-09-07T00:00:00Z', 0, '2026-09-07T00:00:00Z')`);
  return original;
}

async function wake(f: Fixture) {
  await expect(ensureSessionRecovery(f.env, 'project-1', 'chat-1')).resolves.toMatchObject({
    status: 'waking',
  });
  expect(f.starts).toHaveLength(2);
  return f.starts[1]!;
}

function locations(start: StartTaskInput) {
  return [
    ...new Set(start.config.capacityPoolSelection!.candidates.map((entry) => entry.location)),
  ];
}

describe('waking a sleeping session under regional capacity pressure', () => {
  it('reuses a healthy host in another region (the 2026-09-25 incident shape)', async () => {
    const f = fixture();
    const original = await sleepingConversation(f, 'nbg1');
    // The only running host with room is in hel1, in the same pool/revision/source.
    const hel1 = await seedHost(f, original, 'hel1-host', 'user-1', offeringIn(original, 'hel1'));

    const woken = await wake(f);

    // Every permitted region stays eligible; the old one only leads.
    expect(locations(woken)).toEqual(expect.arrayContaining(['nbg1', 'fsn1', 'hel1']));
    expect(woken.config.vmLocation).toBe('nbg1');
    expect(await select(f, woken)).toMatchObject({ nodeId: 'hel1-host' });
    // ...and the final atomic reservation admits it on that host.
    expect(await reserve(f, woken, hel1, 'hel1-host')).toBe(true);
    expect(
      f.sqlite.prepare("SELECT node_id FROM workspaces WHERE id = 'new-workspace'").get()
    ).toEqual({ node_id: 'hel1-host' });
  });

  it('still prefers a host in the region it slept in when one has room', async () => {
    const f = fixture();
    // hel1 is NOT the pool's first region (nbg1 is), so this only passes if the wake's own region
    // leads the candidate order that the TaskRunner ranks reusable hosts by.
    const original = await sleepingConversation(f, 'hel1');
    await seedHost(f, original, 'nbg1-host', 'user-1', offeringIn(original, 'nbg1'));
    await seedHost(f, original, 'hel1-host', 'user-1', offeringIn(original, 'hel1'));

    const woken = await wake(f);

    expect(woken.config.vmLocation).toBe('hel1');
    expect(locations(woken)[0]).toBe('hel1');
    expect(await select(f, woken)).toMatchObject({ nodeId: 'hel1-host' });
  });

  it('control: a location the first run explicitly asked for stays a hard constraint', async () => {
    const f = fixture();
    const original = await sleepingConversation(f, 'nbg1', true);
    await seedHost(f, original, 'hel1-host', 'user-1', offeringIn(original, 'hel1'));

    const woken = await wake(f);

    expect(locations(woken)).toEqual(['nbg1']);
    // The hel1 host is outside this wake's allocation authority — the pre-fix outcome, now only
    // for a conversation that asked for its region.
    expect(await select(f, woken)).toBeNull();
  });
});
