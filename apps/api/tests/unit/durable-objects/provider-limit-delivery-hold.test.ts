/**
 * The provider-limit delivery hold against ProjectData's real migrated SQLite
 * (`packages/project-data/src/do/provider-limit-delivery-hold.ts`). The hold itself lives in D1;
 * here D1 is a controllable fake so the test owns the ordering of the awaited read
 * (`.claude/rules/62`, "Asynchronous ordering defects need controlled ordering"). The full
 * callback -> sleep -> alarm path is `tests/integration/provider-limit-lifecycle.test.ts`.
 */
import { enqueueMessage } from '@simple-agent-manager/project-data/internal/do/mailbox';
import { runMigrations } from '@simple-agent-manager/project-data/internal/do/migrations';
import {
  applyProviderLimitDeliveryHold,
  isProviderLimitHoldExpiry,
} from '@simple-agent-manager/project-data/internal/do/provider-limit-delivery-hold';
import { PROVIDER_LIMIT_POLICY } from '@simple-agent-manager/scheduler-core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqlStorage } from './sql-storage-test-utils';

const PROJECT = 'project-1';
const CHAT = 'chat-1';
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TTL = HOUR;

let doDb: Database.Database;
let sql: SqlStorage;

function chat(status: string) {
  sql.exec(
    `INSERT INTO chat_sessions (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
     VALUES (?, 'workspace-1', 'Held chat', ?, 0, ?, ?, ?)`,
    CHAT,
    status,
    NOW,
    NOW,
    NOW
  );
}

function deliver(id: string, senderType: 'human' | 'agent') {
  enqueueMessage(sql, {
    id,
    targetSessionId: CHAT,
    sourceTaskId: null,
    senderType,
    senderId: senderType === 'human' ? 'user-1' : 'task-child',
    messageClass: 'deliver',
    content: id,
    metadata: null,
    ttlMs: TTL,
    sourceKind: senderType === 'human' ? 'user_followup' : 'parent_wakeup',
    promptMessageId: `msg-${id}`,
    now: NOW,
    ackRequired: false,
    durableDelivery: true,
    deliveryIntent: 'queue',
  });
}

function row(id: string) {
  return doDb
    .prepare(
      'SELECT expires_at AS expiresAt, next_attempt_at AS nextAttemptAt FROM session_inbox WHERE id = ?'
    )
    .get(id) as { expiresAt: number; nextAttemptAt: number | null };
}

function waitJson(phase: 'waiting' | 'blocked', nextRetryAt: number) {
  return JSON.stringify({
    version: 1,
    phase,
    origin: 'callback',
    attempts: 1,
    credentialKey: 'sha256:credential',
    incidentId: 'incident-1',
    observedAt: NOW,
    resetsAt: nextRetryAt,
    nextRetryAt,
    deadlineAt: nextRetryAt + PROVIDER_LIMIT_POLICY.deadlineGraceMs,
    scheduleKey: 'provider-limit:task-1:key',
    reason: 'Waiting for provider limit reset',
  });
}

/** A D1 fake: the hold read resolves when the test says so; ask closes are recorded. */
function fakeD1(task: Record<string, unknown> | null | Error) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const closes: unknown[][] = [];
  const database = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          await gate;
          if (task instanceof Error) throw task;
          return task;
        },
        run: async () => {
          if (/UPDATE asks/.test(query)) closes.push(args);
          return { meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { database, release, closes };
}

const heldTask = (phase: 'waiting' | 'blocked', snapshotExpiresAt: string | null = null) => ({
  id: 'task-1',
  provider_limit_wait_json: waitJson(phase, NOW + 3 * DAY),
  snapshot_expires_at: snapshotExpiresAt,
});

beforeEach(() => {
  doDb = new Database(':memory:');
  sql = createSqlStorage(doDb);
  runMigrations(sql);
});

afterEach(() => doDb.close());

describe('applyProviderLimitDeliveryHold', () => {
  it('keeps a person’s message for a waiting hold, parks every delivery, and closes the wake item', async () => {
    chat('sleeping');
    deliver('person', 'human');
    deliver('parent', 'agent');
    const { database, release, closes } = fakeD1(heldTask('waiting'));
    const applying = applyProviderLimitDeliveryHold(sql, database, {
      projectId: PROJECT,
      sessionId: CHAT,
      ttlMs: TTL,
      now: NOW,
    });
    release();
    const held = await applying;

    const retryAt = NOW + 3 * DAY;
    expect(held).toMatchObject({ hold: { phase: 'waiting' }, closedWakeAsks: 1 });
    expect(row('person')).toEqual({ expiresAt: retryAt + TTL, nextAttemptAt: retryAt });
    // A non-human delivery is parked but keeps its own deadline.
    expect(row('parent')).toEqual({ expiresAt: NOW + TTL, nextAttemptAt: retryAt });
    expect(closes).toHaveLength(1);
  });

  it('keeps a person’s message for a blocked hold until the snapshot expires, capped', async () => {
    chat('sleeping');
    deliver('person', 'human');
    const snapshotExpiry = NOW + 5 * DAY;
    const { database, release } = fakeD1(
      heldTask('blocked', new Date(snapshotExpiry).toISOString())
    );
    const applying = applyProviderLimitDeliveryHold(sql, database, {
      projectId: PROJECT,
      sessionId: CHAT,
      ttlMs: TTL,
      now: NOW,
    });
    release();
    await applying;
    // No automatic wake: nothing retries before the message's own (kept) expiry.
    expect(row('person')).toEqual({ expiresAt: snapshotExpiry, nextAttemptAt: snapshotExpiry });

    // Without a known snapshot expiry the message keeps only its ordinary TTL.
    sql.exec('DELETE FROM session_inbox');
    deliver('person-2', 'human');
    const unknown = fakeD1(heldTask('blocked', null));
    const second = applyProviderLimitDeliveryHold(sql, unknown.database, {
      projectId: PROJECT,
      sessionId: CHAT,
      ttlMs: TTL,
      now: NOW,
    });
    unknown.release();
    await second;
    expect(row('person-2')).toEqual({ expiresAt: NOW + TTL, nextAttemptAt: NOW + TTL });

    // A far snapshot expiry is capped by the longest reset a hold may wait for.
    sql.exec('DELETE FROM session_inbox');
    deliver('person-3', 'human');
    const far = fakeD1(heldTask('blocked', new Date(NOW + 30 * DAY).toISOString()));
    const third = applyProviderLimitDeliveryHold(sql, far.database, {
      projectId: PROJECT,
      sessionId: CHAT,
      ttlMs: TTL,
      now: NOW,
    });
    far.release();
    await third;
    expect(row('person-3').expiresAt).toBe(NOW + PROVIDER_LIMIT_POLICY.maxResetDelayMs);
  });

  it('does not park deliveries a VM wake released while the hold was being read', async () => {
    chat('sleeping');
    deliver('person', 'human');
    const { database, release, closes } = fakeD1(heldTask('waiting'));
    const applying = applyProviderLimitDeliveryHold(sql, database, {
      projectId: PROJECT,
      sessionId: CHAT,
      ttlMs: TTL,
      now: NOW,
    });
    // Midpoint: the wake commits (chat active) and readiness nudges the delivery.
    sql.exec("UPDATE chat_sessions SET status = 'active' WHERE id = ?", CHAT);
    sql.exec('UPDATE session_inbox SET next_attempt_at = ? WHERE id = ?', NOW, 'person');
    release();

    expect(await applying).toBeNull();
    expect(row('person')).toEqual({ expiresAt: NOW + TTL, nextAttemptAt: NOW });
    expect(closes).toEqual([]);
  });

  it('does not park deliveries an Instant wake released while the hold was being read', async () => {
    // An Instant chat stays `sleeping` through its wake; only its readiness fence changes.
    chat('sleeping');
    deliver('person', 'human');
    const { database, release, closes } = fakeD1(heldTask('waiting'));
    const applying = applyProviderLimitDeliveryHold(sql, database, {
      projectId: PROJECT,
      sessionId: CHAT,
      ttlMs: TTL,
      now: NOW,
    });
    sql.exec(
      'INSERT INTO session_wake_readiness (session_id, fence, ready_at) VALUES (?, ?, ?)',
      CHAT,
      '{"runtime":"cf-container"}',
      NOW
    );
    sql.exec('UPDATE session_inbox SET next_attempt_at = ? WHERE id = ?', NOW, 'person');
    release();

    expect(await applying).toBeNull();
    expect(row('person')).toEqual({ expiresAt: NOW + TTL, nextAttemptAt: NOW });
    expect(closes).toEqual([]);
  });

  it('control: with nothing changing during the read, the same Instant chat is held', async () => {
    chat('sleeping');
    sql.exec(
      'INSERT INTO session_wake_readiness (session_id, fence, ready_at) VALUES (?, ?, ?)',
      CHAT,
      '{"runtime":"cf-container"}',
      NOW - HOUR
    );
    deliver('person', 'human');
    const { database, release } = fakeD1(heldTask('waiting'));
    const applying = applyProviderLimitDeliveryHold(sql, database, {
      projectId: PROJECT,
      sessionId: CHAT,
      ttlMs: TTL,
      now: NOW,
    });
    release();
    expect(await applying).not.toBeNull();
    expect(row('person').nextAttemptAt).toBe(NOW + 3 * DAY);
  });

  it('reads nothing for an awake chat, and keeps ordinary backoff when the read fails', async () => {
    chat('active');
    deliver('person', 'human');
    const awake = fakeD1(heldTask('waiting'));
    awake.release();
    expect(
      await applyProviderLimitDeliveryHold(sql, awake.database, {
        projectId: PROJECT,
        sessionId: CHAT,
        ttlMs: TTL,
        now: NOW,
      })
    ).toBeNull();

    sql.exec("UPDATE chat_sessions SET status = 'sleeping' WHERE id = ?", CHAT);
    const failing = fakeD1(new Error('D1 unavailable'));
    failing.release();
    expect(
      await applyProviderLimitDeliveryHold(sql, failing.database, {
        projectId: PROJECT,
        sessionId: CHAT,
        ttlMs: TTL,
        now: NOW,
      })
    ).toBeNull();
    expect(row('person')).toEqual({ expiresAt: NOW + TTL, nextAttemptAt: NOW });
  });
});

describe('isProviderLimitHoldExpiry', () => {
  it('names a held chat’s expiry, and files the failure when the hold cannot be read', async () => {
    const held = fakeD1(heldTask('waiting'));
    held.release();
    expect(await isProviderLimitHoldExpiry(held.database, PROJECT, CHAT)).toBe(true);

    const none = fakeD1(null);
    none.release();
    expect(await isProviderLimitHoldExpiry(none.database, PROJECT, CHAT)).toBe(false);

    const failing = fakeD1(new Error('D1 unavailable'));
    failing.release();
    expect(await isProviderLimitHoldExpiry(failing.database, PROJECT, CHAT)).toBe(false);
  });
});
