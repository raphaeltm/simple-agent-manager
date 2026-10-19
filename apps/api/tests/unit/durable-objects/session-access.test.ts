import type { PromptDeliverySource } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import type { DurableExecutionConfig } from '../../../src/durable-objects/project-data/durable-execution-config';
import * as mailbox from '../../../src/durable-objects/project-data/mailbox';
import {
  acceptPromptDelivery,
  claimDuePromptDeliveries,
  nudgePromptDeliveriesForTarget,
} from '../../../src/durable-objects/project-data/prompt-delivery';
import { runPromptDeliveryClaim } from '../../../src/durable-objects/project-data/prompt-delivery-runner';
import {
  computeSessionAccessExpiryAlarmTime,
  createSessionAccessGrant,
  listActiveSessionAccessGrants,
  processExpiredSessionAccessGrants,
  resolveSessionAccess,
  revokeSessionAccessForDepartedMember,
  revokeSessionAccessGrant,
  SENDER_ACCESS_EXPIRED_REASON,
  SENDER_ACCESS_REVOKED_REASON,
} from '../../../src/durable-objects/project-data/session-access';
import { handleExpiredGrants } from '../../../src/durable-objects/project-data/session-access-expiry';
import type { VmPromptDeliveryAdapter } from '../../../src/services/vm-prompt-delivery-adapter';
import { createSqlStorage } from './sql-storage-test-utils';

/**
 * Shared session access against real SQLite and the real migrations: every guard here is a
 * SQL predicate, so a `.where()`-ignoring mock could not prove it (.claude/rules/28).
 */

const config: DurableExecutionConfig = {
  deliveryEnabled: true,
  legacyVmCompatEnabled: false,
  supervisorEnabled: false,
  checkpointThresholdMs: 18_000_000,
  preemptGraceMs: 30_000,
  maxCandidatesPerAlarm: 5,
  maxAttempts: 3,
  retryBaseMs: 5_000,
  retryMaxMs: 20_000,
  ttlMs: 60_000,
  receiptTimeoutMs: 10_000,
  backgroundTimeoutMs: 5_000,
  minAlarmDelayMs: 1_000,
};

const capabilities = {
  protocolVersion: 1,
  runtimeIdentity: 'runtime-1',
  promptReceipts: {
    supported: true,
    lookup: true,
    states: ['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous'] as const,
  },
  checkpointRollover: {
    supported: true,
    automatic: true,
    states: ['requested', 'stopping', 'resuming', 'completed', 'failed'] as const,
    defaultGraceMs: 30_000,
    maxGraceMs: 120_000,
    operationTimeoutMs: 300_000,
  },
};

describe('ProjectData shared session access', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  function seedSession(id: string, ownerUserId: string | null, status = 'active') {
    sql.exec(
      `INSERT INTO chat_sessions
       (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at,
        created_by_user_id)
       VALUES (?, 'workspace-1', 'Test', ?, 0, 10000, 10000, 10000, ?)`,
      id,
      status,
      ownerUserId
    );
  }

  function share(
    granteeUserId: string,
    grantedByUserId: string,
    sessionId = 'chat-1',
    durationMinutes = 30
  ) {
    return createSessionAccessGrant(sql, {
      sessionId,
      granteeUserId,
      grantedByUserId,
      durationMinutes,
      maxActiveGrants: 10,
    });
  }

  function grantRow(granteeUserId: string, sessionId = 'chat-1') {
    return sql
      .exec(
        `SELECT id, parent_grant_id, granted_by_user_id, revoked_at, revoked_by_user_id,
                revoke_reason
           FROM chat_session_access_grants
          WHERE session_id = ? AND grantee_user_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        sessionId,
        granteeUserId
      )
      .toArray()[0] as
      | {
          id: string;
          parent_grant_id: string | null;
          granted_by_user_id: string;
          revoked_at: number | null;
          revoked_by_user_id: string | null;
          revoke_reason: string | null;
        }
      | undefined;
  }

  function queuePrompt(
    deliveryId: string,
    senderId: string,
    sourceKind: PromptDeliverySource = 'user_followup'
  ) {
    return acceptPromptDelivery(
      sql,
      {},
      {
        deliveryId,
        targetSessionId: 'chat-1',
        displayContent: `Visible ${deliveryId}`,
        deliveryContent: `Delivered ${deliveryId}`,
        senderType: 'human',
        senderId,
        messageClass: 'deliver',
        sourceKind,
        ttlMs: config.ttlMs,
      },
      Date.now()
    );
  }

  function transcriptMetadata(deliveryId: string): Record<string, unknown> {
    const row = sql
      .exec(
        `SELECT m.tool_metadata FROM chat_messages m
           JOIN session_inbox i ON i.prompt_message_id = m.id
          WHERE i.id = ?`,
        deliveryId
      )
      .toArray()[0];
    return JSON.parse(String(row?.tool_metadata ?? '{}')) as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    seedSession('chat-1', 'owner-1');
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  describe('resolveSessionAccess', () => {
    it('distinguishes the owner, an active grantee and everyone else', () => {
      expect(share('grantee-1', 'owner-1')).toMatchObject({ status: 'created' });

      expect(resolveSessionAccess(sql, 'chat-1', 'owner-1')).toMatchObject({
        found: true,
        ownerUserId: 'owner-1',
        role: 'owner',
        grant: null,
      });
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1')).toMatchObject({
        found: true,
        role: 'grantee',
        grant: { granteeUserId: 'grantee-1', grantedByUserId: 'owner-1', parentGrantId: null },
      });
      expect(resolveSessionAccess(sql, 'chat-1', 'reader-1')).toMatchObject({
        found: true,
        role: 'none',
        grant: null,
      });
      expect(resolveSessionAccess(sql, 'missing', 'owner-1')).toMatchObject({
        found: false,
        role: 'none',
      });
    });

    it('scopes a grant to its own session', () => {
      seedSession('chat-2', 'owner-1');
      expect(share('grantee-1', 'owner-1', 'chat-2')).toMatchObject({ status: 'created' });

      expect(resolveSessionAccess(sql, 'chat-2', 'grantee-1').role).toBe('grantee');
      // A grant on another session of the same owner authorizes nothing here.
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1').role).toBe('none');
    });

    it('never treats a grant row on an owner-less session as access', () => {
      seedSession('chat-legacy', null);
      sql.exec(
        `INSERT INTO chat_session_access_grants
           (id, session_id, grantee_user_id, granted_by_user_id, parent_grant_id, created_at)
         VALUES ('grant-legacy', 'chat-legacy', 'grantee-1', 'someone', NULL, 10000)`
      );

      expect(resolveSessionAccess(sql, 'chat-legacy', 'grantee-1')).toMatchObject({
        found: true,
        ownerUserId: null,
        role: 'none',
      });
    });

    it('ignores a revoked grant', () => {
      share('grantee-1', 'owner-1');
      revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });

      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1').role).toBe('none');
    });
  });

  describe('createSessionAccessGrant', () => {
    it('records a root grant from the owner, and the same person keeps one grant', () => {
      const first = share('grantee-1', 'owner-1');
      const second = share('grantee-1', 'owner-1');

      expect(first).toMatchObject({
        status: 'created',
        grant: { granteeUserId: 'grantee-1', grantedByUserId: 'owner-1', parentGrantId: null },
      });
      // The owner sharing again is an explicit renewal of the same grant.
      expect(second.status).toBe('renewed');
      if (first.status === 'created' && second.status === 'renewed') {
        expect(second.grant.id).toBe(first.grant.id);
      }
      expect(listActiveSessionAccessGrants(sql, 'chat-1')).toHaveLength(1);
    });

    it('rejects a project member who does not control the session, and writes nothing', () => {
      expect(share('reader-2', 'reader-1')).toEqual({
        status: 'forbidden',
        reason: 'Only people who control this session can share it',
      });
      expect(listActiveSessionAccessGrants(sql, 'chat-1')).toHaveLength(0);
    });

    it('links a grant made by a grantee to the grant they hold', () => {
      const parent = share('grantee-1', 'owner-1');
      const child = share('grantee-2', 'grantee-1');

      expect(child).toMatchObject({
        status: 'created',
        grant: { grantedByUserId: 'grantee-1' },
      });
      if (parent.status === 'created' && child.status === 'created') {
        expect(child.grant.parentGrantId).toBe(parent.grant.id);
      } else {
        throw new Error('expected both grants to be created');
      }
    });

    it('refuses to share with the owner or with yourself', () => {
      share('grantee-1', 'owner-1');

      expect(share('owner-1', 'grantee-1')).toMatchObject({ status: 'invalid' });
      expect(share('owner-1', 'owner-1')).toMatchObject({ status: 'invalid' });
      expect(share('grantee-1', 'grantee-1')).toMatchObject({ status: 'invalid' });
    });

    it('shares a sleeping chat: it wakes on the next message', () => {
      seedSession('chat-sleeping', 'owner-1', 'sleeping');

      expect(share('grantee-1', 'owner-1', 'chat-sleeping')).toMatchObject({
        status: 'created',
        grant: { sessionId: 'chat-sleeping', granteeUserId: 'grantee-1' },
      });
    });

    it.each(['stopped', 'error'])('does not share a chat that has ended (%s)', (status) => {
      seedSession(`chat-${status}`, 'owner-1', status);

      expect(share('grantee-1', 'owner-1', `chat-${status}`)).toEqual({
        status: 'invalid',
        reason: 'This chat has ended, so it can no longer be shared',
      });
    });

    it('rejects an owner-less session for every caller', () => {
      seedSession('chat-legacy', null);

      expect(share('grantee-1', 'anyone', 'chat-legacy')).toMatchObject({ status: 'forbidden' });
    });

    it('enforces the active grant cap, and frees a slot on revoke', () => {
      const capped = (granteeUserId: string) =>
        createSessionAccessGrant(sql, {
          sessionId: 'chat-1',
          granteeUserId,
          grantedByUserId: 'owner-1',
          durationMinutes: 30,
          maxActiveGrants: 2,
        });
      expect(capped('grantee-1').status).toBe('created');
      expect(capped('grantee-2').status).toBe('created');
      expect(capped('grantee-3')).toEqual({ status: 'limit_exceeded', limit: 2 });

      revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });
      expect(capped('grantee-3').status).toBe('created');
    });

    it('allows re-sharing after a revoke without colliding with the old row', () => {
      share('grantee-1', 'owner-1');
      revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });

      expect(share('grantee-1', 'owner-1').status).toBe('created');
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1').role).toBe('grantee');
    });
  });

  describe('grant expiry', () => {
    const MINUTE = 60_000;
    // The fake clock starts at 10_000 (beforeEach).
    const START = 10_000;

    it.each([undefined, 0, 1, 15, 45, 61, 120, -5, 30.5])(
      'refuses a share without a 5/10/30/60-minute duration (%s), and writes nothing',
      (durationMinutes) => {
        const result = createSessionAccessGrant(sql, {
          sessionId: 'chat-1',
          granteeUserId: 'grantee-1',
          grantedByUserId: 'owner-1',
          durationMinutes: durationMinutes as number,
          maxActiveGrants: 10,
        });

        expect(result).toEqual({
          status: 'invalid',
          reason: 'Choose how long access lasts: 5, 10, 30 or 60 minutes',
        });
        expect(grantRow('grantee-1')).toBeUndefined();
      }
    );

    it.each([5, 10, 30, 60])('a %i-minute grant ends exactly at its expiry', (minutes) => {
      const created = share('grantee-1', 'owner-1', 'chat-1', minutes);
      const expiresAt = START + minutes * MINUTE;

      expect(created).toMatchObject({
        status: 'created',
        grant: { expiresAt, durationMinutes: minutes },
      });
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1', expiresAt - 1).role).toBe('grantee');
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1', expiresAt).role).toBe('none');
      expect(listActiveSessionAccessGrants(sql, 'chat-1', expiresAt - 1)).toHaveLength(1);
      expect(listActiveSessionAccessGrants(sql, 'chat-1', expiresAt)).toHaveLength(0);
    });

    it('reads server time by default, with no sweep needed', () => {
      share('grantee-1', 'owner-1', 'chat-1', 5);
      vi.setSystemTime(START + 5 * MINUTE);

      // Nothing has run since the grant was made; the check alone ends access.
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1').role).toBe('none');
      expect(grantRow('grantee-1')?.revoked_at).toBeNull();
    });

    it('never lets a grant passed on outlast the grant it came from', () => {
      share('grantee-1', 'owner-1', 'chat-1', 5);
      vi.setSystemTime(START + 2 * MINUTE);

      const child = share('grantee-2', 'grantee-1', 'chat-1', 60);

      expect(child).toMatchObject({
        status: 'created',
        grant: { expiresAt: START + 5 * MINUTE, durationMinutes: 60 },
      });
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-2', START + 5 * MINUTE).role).toBe(
        'none'
      );
    });

    it('lets the owner renew access someone still has, from now', () => {
      const first = share('grantee-1', 'owner-1', 'chat-1', 5);
      vi.setSystemTime(START + 3 * MINUTE);

      const renewed = share('grantee-1', 'owner-1', 'chat-1', 10);

      expect(renewed).toMatchObject({
        status: 'renewed',
        grant: { expiresAt: START + 13 * MINUTE, durationMinutes: 10, grantedByUserId: 'owner-1' },
      });
      if (first.status === 'created' && renewed.status === 'renewed') {
        expect(renewed.grant.id).toBe(first.grant.id);
      }
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1', START + 12 * MINUTE).role).toBe(
        'grantee'
      );
    });

    it('does not let a grantee renew anyone, and nobody can renew their own access', () => {
      share('grantee-1', 'owner-1', 'chat-1', 30);
      share('grantee-2', 'owner-1', 'chat-1', 5);

      const reshare = share('grantee-2', 'grantee-1', 'chat-1', 60);
      expect(reshare).toMatchObject({
        status: 'existing',
        grant: { expiresAt: START + 5 * MINUTE },
      });
      expect(share('grantee-1', 'grantee-1', 'chat-1', 60)).toMatchObject({ status: 'invalid' });
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-2', START + 5 * MINUTE).role).toBe(
        'none'
      );
    });

    it('stops an expired grantee from sharing or removing anyone', () => {
      share('grantee-1', 'owner-1', 'chat-1', 5);
      share('grantee-2', 'owner-1', 'chat-1', 30);
      vi.setSystemTime(START + 5 * MINUTE);

      expect(share('grantee-3', 'grantee-1')).toMatchObject({ status: 'forbidden' });
      expect(
        revokeSessionAccessGrant(sql, {
          sessionId: 'chat-1',
          granteeUserId: 'grantee-2',
          actorUserId: 'grantee-1',
        })
      ).toMatchObject({ status: 'forbidden' });
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-2').role).toBe('grantee');
    });

    it('frees a cap slot when a grant expires', () => {
      const capped = (granteeUserId: string, durationMinutes: number) =>
        createSessionAccessGrant(sql, {
          sessionId: 'chat-1',
          granteeUserId,
          grantedByUserId: 'owner-1',
          durationMinutes,
          maxActiveGrants: 1,
        });
      expect(capped('grantee-1', 5).status).toBe('created');
      expect(capped('grantee-2', 5)).toEqual({ status: 'limit_exceeded', limit: 1 });

      vi.setSystemTime(START + 5 * MINUTE);
      expect(capped('grantee-2', 5).status).toBe('created');
    });

    it('cancels and labels an expired grantee’s queued prompts in one sweep, and only once', () => {
      share('grantee-1', 'owner-1', 'chat-1', 5);
      queuePrompt('grantee-prompt', 'grantee-1');
      queuePrompt('grantee-directive', 'grantee-1', 'comment_directive');
      queuePrompt('owner-prompt', 'owner-1');
      expect(computeSessionAccessExpiryAlarmTime(sql)).toBe(START + 5 * MINUTE);

      // Before expiry the sweep has nothing to do.
      expect(processExpiredSessionAccessGrants(sql, START + 5 * MINUTE - 1)).toEqual([]);

      const swept = processExpiredSessionAccessGrants(sql, START + 5 * MINUTE);

      expect(swept).toHaveLength(1);
      expect(swept[0]?.cancelledDeliveryIds.sort()).toEqual([
        'grantee-directive',
        'grantee-prompt',
      ]);
      for (const deliveryId of ['grantee-prompt', 'grantee-directive']) {
        expect(mailbox.getMessage(sql, deliveryId)).toMatchObject({
          deliveryState: 'failed',
          terminalReason: SENDER_ACCESS_EXPIRED_REASON,
        });
        expect(transcriptMetadata(deliveryId).deliveryCancelled).toBe(SENDER_ACCESS_EXPIRED_REASON);
      }
      expect(mailbox.getMessage(sql, 'owner-prompt')?.deliveryState).toBe('queued');
      // Handled rows leave the candidate set: no second pass, no further alarm.
      expect(processExpiredSessionAccessGrants(sql, START + 10 * MINUTE)).toEqual([]);
      expect(computeSessionAccessExpiryAlarmTime(sql)).toBeNull();
    });

    it('fires exactly when each grant ends: the schedule and the sweep agree', () => {
      // Drive the section's scheduler and its sweep together, the way the alarm does
      // (.claude/rules/47): a row the sweep skips while the schedule keeps it due would show up
      // here as an extra fire, and a renewed or revoked grant scheduled at its old time as a
      // wrong one.
      seedSession('chat-2', 'owner-1');
      share('grantee-1', 'owner-1', 'chat-1', 5);
      share('grantee-2', 'owner-1', 'chat-1', 10);
      share('grantee-3', 'owner-1', 'chat-2', 30);
      share('grantee-4', 'owner-1', 'chat-1', 60);
      revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-4',
        actorUserId: 'owner-1',
      });
      vi.setSystemTime(START + 2 * MINUTE);
      expect(share('grantee-2', 'owner-1', 'chat-1', 10).status).toBe('renewed');

      const fired: Array<{ at: number; sessionIds: string[]; grantees: string[] }> = [];
      for (let tick = 0; tick < 10; tick += 1) {
        const at = computeSessionAccessExpiryAlarmTime(sql);
        if (at === null) break;
        vi.setSystemTime(at);
        const swept = processExpiredSessionAccessGrants(sql, at);
        fired.push({
          at,
          sessionIds: swept.map((entry) => entry.sessionId),
          grantees: swept.flatMap((entry) => entry.expiredGrants.map((g) => g.granteeUserId)),
        });
      }

      expect(fired).toEqual([
        { at: START + 5 * MINUTE, sessionIds: ['chat-1'], grantees: ['grantee-1'] },
        { at: START + 12 * MINUTE, sessionIds: ['chat-1'], grantees: ['grantee-2'] },
        { at: START + 30 * MINUTE, sessionIds: ['chat-2'], grantees: ['grantee-3'] },
      ]);
    });

    it('skips a grant row it cannot read, marks it handled, and still handles the rest', () => {
      share('grantee-1', 'owner-1', 'chat-1', 5);
      // `created_at` that is not a number fails the row schema.
      sql.exec(
        `INSERT INTO chat_session_access_grants
           (id, session_id, grantee_user_id, granted_by_user_id, parent_grant_id, created_at,
            expires_at, duration_minutes)
         VALUES ('broken-grant', 'chat-1', 'grantee-2', 'owner-1', NULL, 'not-a-time', ?, 5)`,
        START + MINUTE
      );
      queuePrompt('good-prompt', 'grantee-1');

      const swept = processExpiredSessionAccessGrants(sql, START + 5 * MINUTE);

      expect(swept.map((entry) => entry.expiredGrants.map((g) => g.granteeUserId))).toEqual([
        ['grantee-1'],
      ]);
      expect(swept[0]?.cancelledDeliveryIds).toEqual(['good-prompt']);
      const broken = sql
        .exec(`SELECT expiry_handled_at FROM chat_session_access_grants WHERE id = 'broken-grant'`)
        .toArray()[0];
      expect(broken?.expiry_handled_at).toBe(START + 5 * MINUTE);
      // Both left the candidate set.
      expect(processExpiredSessionAccessGrants(sql, START + 10 * MINUTE)).toEqual([]);
      expect(computeSessionAccessExpiryAlarmTime(sql)).toBeNull();
    });

    it('does not let one session whose cleanup fails hold back the others', () => {
      seedSession('chat-2', 'owner-1');
      share('grantee-1', 'owner-1', 'chat-1', 5);
      share('grantee-2', 'owner-1', 'chat-2', 5);
      queuePrompt('chat-1-prompt', 'grantee-1');
      // Cancelling chat-2's queued prompts fails (fault injection at the SQL boundary).
      const faulty = Object.create(sql) as SqlStorage;
      faulty.exec = ((query: string, ...binds: unknown[]) => {
        if (query.includes('UPDATE session_inbox') && binds.includes('chat-2')) {
          throw new Error('injected failure');
        }
        return sql.exec(query, ...binds);
      }) as SqlStorage['exec'];

      vi.setSystemTime(START + 5 * MINUTE);
      const swept = processExpiredSessionAccessGrants(faulty, START + 5 * MINUTE);

      // Both expire at the same instant, so the order between sessions is not defined.
      expect(
        swept
          .map((entry) => [entry.sessionId, entry.cancelledDeliveryIds])
          .sort(([a], [b]) => String(a).localeCompare(String(b)))
      ).toEqual([
        ['chat-1', ['chat-1-prompt']],
        ['chat-2', []],
      ]);
      expect(mailbox.getMessage(sql, 'chat-1-prompt')?.terminalReason).toBe(
        SENDER_ACCESS_EXPIRED_REASON
      );
      // The failed session's grant still leaves the candidate set, so it cannot re-arm the
      // alarm forever; its access ended at expires_at regardless.
      expect(processExpiredSessionAccessGrants(sql, START + 10 * MINUTE)).toEqual([]);
      expect(computeSessionAccessExpiryAlarmTime(sql)).toBeNull();
      expect(resolveSessionAccess(sql, 'chat-2', 'grantee-2').role).toBe('none');
    });

    it('never marks a grant that has not expired as handled', () => {
      share('grantee-1', 'owner-1', 'chat-1', 30);
      const [active] = listActiveSessionAccessGrants(sql, 'chat-1');

      handleExpiredGrants(sql, 'chat-1', [active!], START);

      // Its expiry is still ahead of the sweep, which handles it when it comes.
      expect(computeSessionAccessExpiryAlarmTime(sql)).toBe(START + 30 * MINUTE);
      expect(processExpiredSessionAccessGrants(sql, START + 30 * MINUTE)).toHaveLength(1);
    });

    it('a regrant after expiry unlinks what the old grant passed on, so a later revoke leaves it alone', () => {
      share('grantee-1', 'owner-1', 'chat-1', 5);
      share('grantee-2', 'grantee-1', 'chat-1', 5);
      vi.setSystemTime(START + 6 * MINUTE);
      expect(share('grantee-1', 'owner-1', 'chat-1', 10).status).toBe('created');

      revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });

      expect(grantRow('grantee-1')).toMatchObject({ revoke_reason: 'revoked' });
      // grantee-2's grant ended with the old one; it is not recorded as cascaded from the new one.
      expect(grantRow('grantee-2')).toMatchObject({
        parent_grant_id: null,
        revoked_at: null,
        revoke_reason: null,
      });
    });

    it('a regrant after expiry starts fresh and does not revive prompts from the old grant', () => {
      const first = share('grantee-1', 'owner-1', 'chat-1', 5);
      queuePrompt('old-prompt', 'grantee-1');
      vi.setSystemTime(START + 6 * MINUTE);

      const regrant = share('grantee-1', 'owner-1', 'chat-1', 10);

      expect(regrant).toMatchObject({
        status: 'created',
        grant: { expiresAt: START + 16 * MINUTE, durationMinutes: 10 },
      });
      if (first.status === 'created' && regrant.status === 'created') {
        expect(regrant.grant.id).toBe(first.grant.id);
      }
      expect(mailbox.getMessage(sql, 'old-prompt')).toMatchObject({
        deliveryState: 'failed',
        terminalReason: SENDER_ACCESS_EXPIRED_REASON,
      });
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1').role).toBe('grantee');
      // The regrant is scheduled again for its own expiry.
      expect(computeSessionAccessExpiryAlarmTime(sql)).toBe(START + 16 * MINUTE);
    });

    it('settles a revoke racing a renewal in whichever order they land', () => {
      share('grantee-1', 'owner-1', 'chat-1', 5);
      // Revoke, then the owner shares again: a new grant.
      revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });
      expect(share('grantee-1', 'owner-1', 'chat-1', 10).status).toBe('created');

      // Renewal, then revoke: access ends and the renewed grant's queued prompts are cancelled.
      expect(share('grantee-1', 'owner-1', 'chat-1', 60).status).toBe('renewed');
      queuePrompt('after-renewal', 'grantee-1');
      expect(
        revokeSessionAccessGrant(sql, {
          sessionId: 'chat-1',
          granteeUserId: 'grantee-1',
          actorUserId: 'owner-1',
        })
      ).toMatchObject({ status: 'revoked', cancelledDeliveryIds: ['after-renewal'] });
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1').role).toBe('none');
    });

    it('treats a grant from before expiry existed as expired, and sweeps it once', () => {
      sql.exec(
        `INSERT INTO chat_session_access_grants
           (id, session_id, grantee_user_id, granted_by_user_id, parent_grant_id, created_at)
         VALUES ('legacy-grant', 'chat-1', 'grantee-1', 'owner-1', NULL, 1000)`
      );
      queuePrompt('legacy-prompt', 'grantee-1');

      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1').role).toBe('none');
      expect(computeSessionAccessExpiryAlarmTime(sql)).toBe(0);
      expect(processExpiredSessionAccessGrants(sql)[0]?.cancelledDeliveryIds).toEqual([
        'legacy-prompt',
      ]);
      expect(computeSessionAccessExpiryAlarmTime(sql)).toBeNull();
      // The owner can share again, with a duration.
      expect(share('grantee-1', 'owner-1', 'chat-1', 5).status).toBe('created');
    });
  });

  describe('revokeSessionAccessGrant', () => {
    it('cascades to every grant issued downstream of the revoked one', () => {
      share('grantee-1', 'owner-1');
      share('grantee-2', 'grantee-1');
      share('grantee-3', 'grantee-2');
      share('grantee-4', 'owner-1');

      const result = revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });

      expect(result.status).toBe('revoked');
      if (result.status !== 'revoked') return;
      expect(result.revokedGrants.map((grant) => grant.granteeUserId).sort()).toEqual([
        'grantee-1',
        'grantee-2',
        'grantee-3',
      ]);
      expect(grantRow('grantee-1')).toMatchObject({
        revoke_reason: 'revoked',
        revoked_by_user_id: 'owner-1',
      });
      expect(grantRow('grantee-2')).toMatchObject({ revoke_reason: 'cascade' });
      expect(grantRow('grantee-3')).toMatchObject({ revoke_reason: 'cascade' });
      for (const userId of ['grantee-1', 'grantee-2', 'grantee-3']) {
        expect(resolveSessionAccess(sql, 'chat-1', userId).role).toBe('none');
      }
      // A sibling grant from the owner is untouched.
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-4').role).toBe('grantee');
    });

    it('rejects a project member without control, and leaves the grant in place', () => {
      share('grantee-1', 'owner-1');

      expect(
        revokeSessionAccessGrant(sql, {
          sessionId: 'chat-1',
          granteeUserId: 'grantee-1',
          actorUserId: 'reader-1',
        })
      ).toMatchObject({ status: 'forbidden' });
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1').role).toBe('grantee');
    });

    it('lets a grantee leave, recorded as leaving', () => {
      share('grantee-1', 'owner-1');

      expect(
        revokeSessionAccessGrant(sql, {
          sessionId: 'chat-1',
          granteeUserId: 'grantee-1',
          actorUserId: 'grantee-1',
        })
      ).toMatchObject({ status: 'revoked' });
      expect(grantRow('grantee-1')).toMatchObject({
        revoke_reason: 'left',
        revoked_by_user_id: 'grantee-1',
      });
    });

    it('reports a person without a grant as not granted', () => {
      expect(
        revokeSessionAccessGrant(sql, {
          sessionId: 'chat-1',
          granteeUserId: 'nobody',
          actorUserId: 'owner-1',
        })
      ).toEqual({ status: 'not_granted' });
      expect(
        revokeSessionAccessGrant(sql, {
          sessionId: 'missing',
          granteeUserId: 'nobody',
          actorUserId: 'owner-1',
        })
      ).toEqual({ status: 'session_not_found' });
    });

    it('fails the revoked senders’ undelivered prompts and labels their transcript rows', () => {
      share('grantee-1', 'owner-1');
      share('grantee-2', 'grantee-1');
      queuePrompt('grantee-prompt', 'grantee-1');
      queuePrompt('downstream-directive', 'grantee-2', 'comment_directive');
      queuePrompt('owner-prompt', 'owner-1');

      const result = revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });

      expect(result.status === 'revoked' && result.cancelledDeliveryIds.sort()).toEqual([
        'downstream-directive',
        'grantee-prompt',
      ]);
      for (const deliveryId of ['grantee-prompt', 'downstream-directive']) {
        expect(mailbox.getMessage(sql, deliveryId)).toMatchObject({
          deliveryState: 'failed',
          terminalReason: SENDER_ACCESS_REVOKED_REASON,
        });
        expect(transcriptMetadata(deliveryId).deliveryCancelled).toBe(SENDER_ACCESS_REVOKED_REASON);
      }
      // The owner's own prompt is still queued and unlabelled.
      expect(mailbox.getMessage(sql, 'owner-prompt')?.deliveryState).toBe('queued');
      expect(transcriptMetadata('owner-prompt').deliveryCancelled).toBeUndefined();
    });

    it('cancels a prompt still preparing, but never one already handed to the agent', () => {
      share('grantee-1', 'owner-1');
      queuePrompt('preparing-prompt', 'grantee-1');
      const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
      expect(claim?.message.id).toBe('preparing-prompt');

      seedSession('chat-2', 'owner-1');
      expect(share('grantee-1', 'owner-1', 'chat-2').status).toBe('created');
      acceptPromptDelivery(
        sql,
        {},
        {
          deliveryId: 'submitting-prompt',
          targetSessionId: 'chat-2',
          displayContent: 'Visible submitting',
          deliveryContent: 'Delivered submitting',
          senderType: 'human',
          senderId: 'grantee-1',
          messageClass: 'deliver',
          sourceKind: 'user_followup',
          ttlMs: config.ttlMs,
        },
        Date.now()
      );
      claimDuePromptDeliveries(sql, config, Date.now());
      sql.exec(
        `UPDATE session_inbox SET prompt_delivery_phase = 'submitting' WHERE id = 'submitting-prompt'`
      );

      revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });
      revokeSessionAccessGrant(sql, {
        sessionId: 'chat-2',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });

      expect(mailbox.getMessage(sql, 'preparing-prompt')).toMatchObject({
        deliveryState: 'failed',
        terminalReason: SENDER_ACCESS_REVOKED_REASON,
      });
      expect(mailbox.getMessage(sql, 'submitting-prompt')?.deliveryState).toBe('delivering');
    });

    it('leaves the same person’s messages from other sources alone', () => {
      // The /sam orchestrator queues mailbox messages as a human sender (agent_mailbox). Only
      // prompts a session writer typed or sent from a comment are fenced and cancelled.
      share('grantee-1', 'owner-1');
      queuePrompt('mailbox-message', 'grantee-1', 'agent_mailbox');

      revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });

      expect(mailbox.getMessage(sql, 'mailbox-message')?.deliveryState).toBe('queued');
    });

    it('leaves system-originated deliveries from the same id alone', () => {
      share('grantee-1', 'owner-1');
      acceptPromptDelivery(
        sql,
        {},
        {
          deliveryId: 'system-wake',
          targetSessionId: 'chat-1',
          displayContent: 'trusted wake',
          sourceTaskId: 'parent-task-1',
          senderType: 'system',
          senderId: 'grantee-1',
          sourceKind: 'parent_wakeup',
          metadata: { waitId: 'wait-1', childTaskIds: ['child-task-1'] },
        },
        Date.now()
      );

      revokeSessionAccessGrant(sql, {
        sessionId: 'chat-1',
        granteeUserId: 'grantee-1',
        actorUserId: 'owner-1',
      });

      expect(mailbox.getMessage(sql, 'system-wake')?.deliveryState).toBe('queued');
    });
  });

  describe('revokeSessionAccessForDepartedMember', () => {
    it('revokes what a departing grantee holds, with its cascade', () => {
      share('grantee-1', 'owner-1');
      share('grantee-2', 'grantee-1');
      share('grantee-3', 'owner-1');

      const results = revokeSessionAccessForDepartedMember(sql, 'grantee-1');

      expect(results).toHaveLength(1);
      expect(grantRow('grantee-1')).toMatchObject({
        revoke_reason: 'member_removed',
        revoked_by_user_id: null,
      });
      expect(grantRow('grantee-2')).toMatchObject({ revoke_reason: 'cascade' });
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-3').role).toBe('grantee');
    });

    it('revokes every grant on the sessions a departing owner owns', () => {
      seedSession('chat-other-owner', 'owner-2');
      share('grantee-1', 'owner-1');
      share('grantee-2', 'grantee-1');
      share('grantee-1', 'owner-2', 'chat-other-owner');
      queuePrompt('grantee-prompt', 'grantee-1');

      const results = revokeSessionAccessForDepartedMember(sql, 'owner-1');

      expect(results.map((result) => result.sessionId)).toEqual(['chat-1']);
      expect(results[0]?.cancelledDeliveryIds).toEqual(['grantee-prompt']);
      expect(grantRow('grantee-1')).toMatchObject({ revoke_reason: 'owner_removed' });
      expect(grantRow('grantee-2')).toMatchObject({ revoke_reason: 'cascade' });
      // Another owner's session is not touched by owner-1 leaving.
      expect(resolveSessionAccess(sql, 'chat-other-owner', 'grantee-1').role).toBe('grantee');
    });

    it('is a no-op for a member with no grants', () => {
      share('grantee-1', 'owner-1');

      expect(revokeSessionAccessForDepartedMember(sql, 'reader-1')).toEqual([]);
      expect(resolveSessionAccess(sql, 'chat-1', 'grantee-1').role).toBe('grantee');
    });
  });

  describe('delivery-time sender fence', () => {
    const hooks = {
      projectId: 'project-1',
      recalculateAlarm: vi.fn(async () => {}),
      broadcastEvent: vi.fn(),
      scheduleSummarySync: vi.fn(),
      armIdleCleanup: vi.fn(),
      nudgeDeliveries: vi.fn((chatSessionId: string) =>
        nudgePromptDeliveriesForTarget(sql, chatSessionId)
      ),
    };

    function acceptingAdapter(): VmPromptDeliveryAdapter & {
      submit: ReturnType<typeof vi.fn>;
    } {
      const submit = vi
        .fn<VmPromptDeliveryAdapter['submit']>()
        .mockImplementation(async (input) => {
          if (input.beforeSideEffect) {
            const blocked = await input.beforeSideEffect();
            if (blocked) return blocked;
          }
          input.beforeSubmit?.(capabilities);
          return {
            kind: 'accepted',
            acpSessionId: 'acp-1',
            promptEpoch: 10_000,
            runtimeIdentity: 'runtime-1',
            capabilities,
            receipt: null,
          };
        });
      return { submit, reconcile: vi.fn() } as never;
    }

    it('fails a human prompt whose sender does not control the session, before any send', async () => {
      // Simulates a prompt that reached the mailbox without the API writer check.
      queuePrompt('forged-prompt', 'reader-1');
      const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
      const adapter = acceptingAdapter();

      await expect(
        runPromptDeliveryClaim(sql, {}, config, claim!, adapter, hooks)
      ).resolves.toMatchObject({ kind: 'failed', reason: 'sender_unauthorized' });
      expect(adapter.submit).not.toHaveBeenCalled();
      expect(mailbox.getMessage(sql, 'forged-prompt')).toMatchObject({
        deliveryState: 'failed',
        terminalReason: 'sender_unauthorized',
      });
    });

    it('delivers the owner’s prompt (control)', async () => {
      queuePrompt('owner-prompt', 'owner-1');
      const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
      const adapter = acceptingAdapter();

      await runPromptDeliveryClaim(sql, {}, config, claim!, adapter, hooks);

      expect(adapter.submit).toHaveBeenCalledTimes(1);
      expect(mailbox.getMessage(sql, 'owner-prompt')?.deliveryState).toBe('acked');
    });

    it('delivers an active grantee’s prompt', async () => {
      share('grantee-1', 'owner-1');
      queuePrompt('grantee-prompt', 'grantee-1', 'comment_directive');
      const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
      const adapter = acceptingAdapter();

      await runPromptDeliveryClaim(sql, {}, config, claim!, adapter, hooks);

      expect(adapter.submit).toHaveBeenCalledTimes(1);
      expect(mailbox.getMessage(sql, 'grantee-prompt')?.deliveryState).toBe('acked');
    });

    it('re-checks access right before the send, after preparation', async () => {
      share('grantee-1', 'owner-1');
      queuePrompt('late-revoke', 'grantee-1');
      const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
      const adapter = acceptingAdapter();
      // Access is removed while the delivery is being prepared, by a path that did not
      // cancel it (the grant row is revoked directly).
      adapter.submit.mockImplementationOnce(async (input) => {
        sql.exec(
          `UPDATE chat_session_access_grants SET revoked_at = 11000, revoke_reason = 'revoked'
            WHERE grantee_user_id = 'grantee-1'`
        );
        const blocked = await input.beforeSideEffect?.();
        if (blocked) return blocked;
        throw new Error('the prompt must not be sent');
      });

      await expect(
        runPromptDeliveryClaim(sql, {}, config, claim!, adapter, hooks)
      ).resolves.toMatchObject({ kind: 'failed', reason: 'sender_unauthorized' });
      expect(mailbox.getMessage(sql, 'late-revoke')?.deliveryState).toBe('failed');
    });

    it('fails an expired grantee’s prompt at delivery even before the expiry sweep runs', async () => {
      share('grantee-1', 'owner-1', 'chat-1', 5);
      // Queued while access is still live (inside the delivery TTL), claimed once it has ended.
      vi.setSystemTime(10_000 + 5 * 60_000 - 30_000);
      queuePrompt('racing-prompt', 'grantee-1');
      vi.setSystemTime(10_000 + 5 * 60_000);
      const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
      expect(claim?.message.id).toBe('racing-prompt');
      const adapter = acceptingAdapter();

      await expect(
        runPromptDeliveryClaim(sql, {}, config, claim!, adapter, hooks)
      ).resolves.toMatchObject({
        kind: 'failed',
        reason: 'sender_unauthorized',
        error: "The sender's access to this session expired",
      });
      // Refused before the adapter is reached, so nothing is sent.
      expect(adapter.submit).not.toHaveBeenCalled();
      expect(mailbox.getMessage(sql, 'racing-prompt')?.deliveryState).toBe('failed');
      expect(transcriptMetadata('racing-prompt').deliveryCancelled).toBe(
        SENDER_ACCESS_EXPIRED_REASON
      );
    });

    it('does not label a never-granted sender’s prompt as access removed', async () => {
      queuePrompt('stranger-prompt', 'reader-1');
      const [claim] = claimDuePromptDeliveries(sql, config, Date.now());

      await runPromptDeliveryClaim(sql, {}, config, claim!, acceptingAdapter(), hooks);

      expect(transcriptMetadata('stranger-prompt').deliveryCancelled).toBeUndefined();
    });

    it('still reconciles a prompt that was already handed to the agent', async () => {
      share('grantee-1', 'owner-1');
      queuePrompt('handed-over', 'grantee-1');
      claimDuePromptDeliveries(sql, config, Date.now());
      // The prompt reached the submit boundary, then the grant went away.
      sql.exec(
        `UPDATE session_inbox SET prompt_delivery_phase = 'submitting' WHERE id = 'handed-over'`
      );
      sql.exec(
        `UPDATE chat_session_access_grants SET revoked_at = 11000, revoke_reason = 'revoked'
          WHERE grantee_user_id = 'grantee-1'`
      );
      vi.setSystemTime(10_000 + config.receiptTimeoutMs + 1);
      const [claim] = claimDuePromptDeliveries(sql, config, Date.now());
      expect(claim?.mode).toBe('reconcile');
      const reconcile = vi.fn<VmPromptDeliveryAdapter['reconcile']>().mockResolvedValue({
        kind: 'accepted',
        acpSessionId: 'acp-1',
        promptEpoch: 10_000,
        runtimeIdentity: 'runtime-1',
        capabilities,
        receipt: null,
      });
      const adapter: VmPromptDeliveryAdapter = { submit: vi.fn(), reconcile };

      await runPromptDeliveryClaim(sql, {}, config, claim!, adapter, hooks);

      // A sent prompt cannot be taken back, so it must not be relabelled as undelivered.
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(mailbox.getMessage(sql, 'handed-over')?.deliveryState).toBe('acked');
    });
  });
});
