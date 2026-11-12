/**
 * The secret-request claim + value write on real D1 (workerd, full migration chain), not a
 * re-implementation of its SQL. Two submits by the same person at the same millisecond share
 * actor and timestamp, so the claim must be owned by something unique to the attempt: the batch's
 * own ciphertext. These tests run the exact statements `fulfillRuntimeSecretRequest` batches.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { claimAndStoreValueStatements } from '../../src/services/runtime-secret-request-claim';

const PROJECT = 'proj-claim';
const USER = 'user-claim';
const REQUEST = 'req-claim';
const KEY = 'STRIPE_API_KEY';
const NOW = Date.parse('2026-11-12T10:00:00Z');

async function seed() {
  await env.DATABASE.prepare('DELETE FROM project_runtime_env_vars WHERE project_id = ?')
    .bind(PROJECT)
    .run();
  await env.DATABASE.prepare('DELETE FROM runtime_secret_requests WHERE project_id = ?')
    .bind(PROJECT)
    .run();
  await env.DATABASE.prepare(
    "INSERT OR IGNORE INTO users(id,email,name,status) VALUES(?,?,?,'active')"
  )
    .bind(USER, `${USER}@example.test`, 'Claim user')
    .run();
  await env.DATABASE.prepare(
    "INSERT OR IGNORE INTO projects(id,user_id,name,normalized_name,installation_id,repository,created_by) VALUES(?,?,'Claim project','claim project','system_anonymous_trials_installation','test/claim',?)"
  )
    .bind(PROJECT, USER, USER)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO runtime_secret_requests
       (id, project_id, env_key, reason, status, requester_user_id, requesting_task_id,
        requesting_authority_task_id, requesting_chat_session_id, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'test', 'pending', ?, 'task-1', 'task-1', 'chat-1', ?, ?, ?)`
  )
    .bind(REQUEST, PROJECT, KEY, USER, NOW + 600_000, NOW, NOW)
    .run();
}

const MANUAL_ROW = {
  updatedAt: '2026-11-12T00:00:00Z',
  valueIv: null,
  storedValue: 'manual-value',
};

/** `replaceTarget` is the exact existing row the server read before the write (null: none). */
function attempt(ciphertext: string, replaceTarget: typeof MANUAL_ROW | null = null) {
  return claimAndStoreValueStatements(
    env.DATABASE,
    { id: REQUEST, projectId: PROJECT, envKey: KEY },
    { actorUserId: USER, replaceTarget },
    { ciphertext, iv: `iv-${ciphertext}` },
    { resolvedAt: NOW, secretExpiresAt: null, replacedExisting: replaceTarget !== null }
  );
}

async function seedManual(storedValue = 'manual-value') {
  await env.DATABASE.prepare(
    `INSERT INTO project_runtime_env_vars
       (id, project_id, user_id, env_key, stored_value, value_iv, is_secret, created_at, updated_at)
     VALUES ('manual', ?, ?, ?, ?, NULL, 0, '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z')`
  )
    .bind(PROJECT, USER, KEY, storedValue)
    .run();
}

async function stored() {
  return env.DATABASE.prepare(
    'SELECT stored_value, secret_request_id FROM project_runtime_env_vars WHERE project_id = ? AND env_key = ?'
  )
    .bind(PROJECT, KEY)
    .first<{ stored_value: string; secret_request_id: string | null }>();
}

async function requestStatus() {
  return env.DATABASE.prepare('SELECT status FROM runtime_secret_requests WHERE id = ?')
    .bind(REQUEST)
    .first<string>('status');
}

describe('secret request claim on real D1', () => {
  beforeEach(seed);

  it('same actor, same millisecond: the second batch writes nothing and the first value stays', async () => {
    const [winnerInsert, winnerClaim] = await env.DATABASE.batch(attempt('cipher-A'));
    const [loserInsert, loserClaim] = await env.DATABASE.batch(attempt('cipher-B'));
    expect(winnerInsert.meta.changes).toBe(1);
    expect(winnerClaim.meta.changes).toBe(1);
    expect(loserInsert.meta.changes).toBe(0);
    expect(loserClaim.meta.changes).toBe(0);
    expect(await stored()).toEqual({ stored_value: 'cipher-A', secret_request_id: REQUEST });
    expect(await requestStatus()).toBe('fulfilled');
  });

  it('concurrent batches: exactly one claims, and its ciphertext is the stored value', async () => {
    const results = await Promise.all([
      env.DATABASE.batch(attempt('cipher-A')),
      env.DATABASE.batch(attempt('cipher-B')),
    ]);
    const claims = results.map(([, claim]) => claim.meta.changes);
    expect(claims.sort()).toEqual([0, 1]);
    const winner = results[0][1].meta.changes === 1 ? 'cipher-A' : 'cipher-B';
    expect((await stored())?.stored_value).toBe(winner);
  });

  it('without confirmation, an existing value is neither replaced nor claimed', async () => {
    await seedManual();
    const [insert, claim] = await env.DATABASE.batch(attempt('cipher-A'));
    expect(insert.meta.changes).toBe(0);
    expect(claim.meta.changes).toBe(0);
    expect(await stored()).toEqual({ stored_value: 'manual-value', secret_request_id: null });
    expect(await requestStatus()).toBe('pending');
  });

  it('with confirmation, the existing value is replaced and the request claimed (owner control)', async () => {
    await seedManual();
    const [, claim] = await env.DATABASE.batch(attempt('cipher-A', MANUAL_ROW));
    expect(claim.meta.changes).toBe(1);
    expect(await stored()).toEqual({ stored_value: 'cipher-A', secret_request_id: REQUEST });
    expect(await requestStatus()).toBe('fulfilled');
  });

  it('a confirmed replace of a row that changed since it was read writes nothing', async () => {
    // Same timestamp, different bytes: the row the server read is no longer the stored one.
    await seedManual('changed-in-between');
    const [insert, claim] = await env.DATABASE.batch(attempt('cipher-A', MANUAL_ROW));
    expect(insert.meta.changes).toBe(0);
    expect(claim.meta.changes).toBe(0);
    expect(await stored()).toEqual({ stored_value: 'changed-in-between', secret_request_id: null });
    expect(await requestStatus()).toBe('pending');
  });
});
