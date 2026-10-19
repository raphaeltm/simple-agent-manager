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
  createSessionAccessGrant,
  listActiveSessionAccessGrants,
  resolveSessionAccess,
  revokeSessionAccessForDepartedMember,
  revokeSessionAccessGrant,
  SENDER_ACCESS_REVOKED_REASON,
} from '../../../src/durable-objects/project-data/session-access';
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

  function share(granteeUserId: string, grantedByUserId: string, sessionId = 'chat-1') {
    return createSessionAccessGrant(sql, {
      sessionId,
      granteeUserId,
      grantedByUserId,
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
    it('records a root grant from the owner and is idempotent for the same person', () => {
      const first = share('grantee-1', 'owner-1');
      const second = share('grantee-1', 'owner-1');

      expect(first).toMatchObject({
        status: 'created',
        grant: { granteeUserId: 'grantee-1', grantedByUserId: 'owner-1', parentGrantId: null },
      });
      expect(second.status).toBe('existing');
      expect(second.status === 'existing' && first.status === 'created').toBe(true);
      if (first.status === 'created' && second.status === 'existing') {
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
