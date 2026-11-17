import { resolveDurableExecutionConfig } from '@simple-agent-manager/project-data/internal/do/durable-execution-config';
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import {
  acceptPromptDelivery,
  applyPromptDeliveryResult,
  claimDuePromptDeliveries,
  markPromptDeliverySubmitting,
} from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { runPromptDeliveryClaim } from '@simple-agent-manager/project-data/internal/do/prompt-delivery-runner';
import { env, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { cancelTask } from '../../src/services/cancel-task';
import { versionedPromptCapabilities } from '../helpers/vm-prompt-delivery-fixtures';
import { seedInstallation, seedProject, seedTask, seedUser } from './helpers/seed-d1';

const config = resolveDurableExecutionConfig({});
const capabilities = versionedPromptCapabilities('cancel-runtime');

async function fixture() {
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.newUniqueId()
  ) as DurableObjectStub<ProjectData>;
  const session = await stub.createSession(
    null,
    'Cancellation while waking',
    'cancel-task',
    'owner'
  );
  const now = Date.now();
  const accept = (id: string) =>
    runInDurableObject(stub, (_instance, state) =>
      acceptPromptDelivery(
        state.storage.sql,
        {},
        {
          deliveryId: id,
          targetSessionId: session,
          displayContent: `Prompt ${id}`,
          senderType: 'human',
          senderId: 'owner',
          sourceKind: 'user_followup',
          ttlMs: config.ttlMs,
        },
        now
      )
    );
  return { stub, session, now, accept };
}

const accepted = {
  kind: 'accepted' as const,
  acpSessionId: 'acp',
  promptEpoch: 1,
  runtimeIdentity: capabilities.runtimeIdentity,
  capabilities,
  receipt: null,
};

describe('task cancellation of unissued deliveries through ProjectData RPC', () => {
  it('invalidates an in-flight preparation before its stale completion can requeue or submit', async () => {
    const f = await fixture();
    await f.accept('old');
    const claim = await runInDurableObject(
      f.stub,
      (_instance, state) => claimDuePromptDeliveries(state.storage.sql, config, f.now)[0]!
    );
    expect(claim.mode).toBe('submit');
    // The awaited RPC is the controlled barrier between claim and completion.
    expect(await f.stub.cancelUnissuedSessionPrompts(f.session, 'cancel-task')).toBe(1);
    await runInDurableObject(f.stub, (_instance, state) => {
      const sql = state.storage.sql;
      expect(markPromptDeliverySubmitting(sql, claim, capabilities)).toBe(false);
      expect(applyPromptDeliveryResult(sql, claim, accepted, config, f.now)).toBe(false);
      expect(
        applyPromptDeliveryResult(
          sql,
          claim,
          {
            kind: 'retry',
            reason: 'not_ready',
            error: 'wake pending',
            runtimeIdentity: null,
            capabilities: null,
          },
          config,
          f.now
        )
      ).toBe(false);
      expect(claimDuePromptDeliveries(sql, config, f.now + config.receiptTimeoutMs)).toEqual([]);
      expect(
        sql.exec('SELECT delivery_state, terminal_reason, attempt_id FROM session_inbox').one()
      ).toMatchObject({
        delivery_state: 'failed',
        terminal_reason: 'task_cancelled',
        attempt_id: null,
      });
      expect(
        sql
          .exec(
            "SELECT json_extract(tool_metadata, '$.deliveryCancelled') AS reason FROM chat_messages"
          )
          .one().reason
      ).toBe('task_cancelled');
    });
    expect(await f.stub.cancelUnissuedSessionPrompts(f.session, 'cancel-task')).toBe(0);
    await f.accept('fresh');
    await runInDurableObject(f.stub, (_instance, state) => {
      const fresh = claimDuePromptDeliveries(state.storage.sql, config, f.now)[0]!;
      expect(fresh.message.id).toBe('fresh');
      expect(markPromptDeliverySubmitting(state.storage.sql, fresh, capabilities)).toBe(true);
      expect(applyPromptDeliveryResult(state.storage.sql, fresh, accepted, config, f.now)).toBe(
        true
      );
    });
  });

  it('revalidates cancellation at the real runner adapter boundary after awaited preparation', async () => {
    const f = await fixture();
    await f.accept('barrier');
    await runInDurableObject(f.stub, async (instance, state) => {
      const sql = state.storage.sql;
      const claim = claimDuePromptDeliveries(sql, config, f.now)[0]!;
      let adapterReached = false;
      const result = await runPromptDeliveryClaim(
        sql,
        env,
        config,
        claim,
        {
          submit: async (input) => {
            adapterReached = true;
            // Completion of the cancellation RPC is the explicit preparation barrier.
            expect(await instance.cancelUnissuedSessionPrompts(f.session, 'cancel-task')).toBe(1);
            return (await input.beforeSideEffect?.()) ?? accepted;
          },
          reconcile: async () => {
            throw new Error('Unexpected reconciliation');
          },
        },
        {
          projectId: null,
          recalculateAlarm: async () => {},
          broadcastEvent: () => {},
          armIdleCleanup: () => {},
          nudgeDeliveries: () => 0,
          scheduleSummarySync: () => {},
        }
      );
      expect(adapterReached).toBe(true);
      expect(result).toMatchObject({ kind: 'failed', reason: 'terminal_target' });
      expect(
        sql.exec("SELECT delivery_state FROM session_inbox WHERE id='barrier'").one().delivery_state
      ).toBe('failed');
    });
  });

  it('honors a migration intent installed after the client routing check', async () => {
    const f = await fixture();
    await f.accept('fenced');
    await runInDurableObject(f.stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_data_archive_source_intents
          (session_id,project_id,migration_id,source_owner_name,target_owner_name,target_generation,
           source_intent_token,state,terminal_version_sha256,prepared_at,created_at,updated_at)
         VALUES (?,'cancel-project','migration','root','archive',1,'token','copying','hash',1,1,1)`,
        f.session
      );
      let errorMessage = '';
      try {
        await instance.cancelUnissuedSessionPrompts(f.session, 'cancel-task');
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      expect(errorMessage).toContain('fenced by archive source intent copying');
      expect(
        state.storage.sql.exec("SELECT delivery_state FROM session_inbox WHERE id='fenced'").one()
          .delivery_state
      ).toBe('queued');
      state.storage.sql.exec(
        'DELETE FROM project_data_archive_source_intents WHERE session_id=?',
        f.session
      );
    });
    expect(await f.stub.cancelUnissuedSessionPrompts(f.session, 'cancel-task')).toBe(1);
  });

  it('cancels a workspace-less task through the real D1 service, RPC and delivery runner', async () => {
    const suffix = crypto.randomUUID();
    const userId = `cancel-user-${suffix}`;
    const projectId = `cancel-project-${suffix}`;
    const taskId = `cancel-task-${suffix}`;
    await seedUser(userId);
    await seedInstallation(`cancel-installation-${suffix}`, userId);
    await seedProject(projectId, userId, `cancel-installation-${suffix}`);
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectData>;
    await stub.ensureProjectId(projectId);
    const sessionId = await stub.createSession(null, 'Parked cancellation', taskId, userId);
    await seedTask(taskId, projectId, userId, { status: 'queued', chatSessionId: sessionId });
    const now = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      for (const deliveryId of ['issued-real', 'queued-real']) {
        acceptPromptDelivery(
          state.storage.sql,
          {},
          {
            deliveryId,
            targetSessionId: sessionId,
            displayContent: deliveryId,
            senderType: 'human',
            senderId: userId,
            sourceKind: 'user_followup',
            ttlMs: config.ttlMs,
          },
          now
        );
        if (deliveryId === 'issued-real') {
          const claim = claimDuePromptDeliveries(state.storage.sql, config, now)[0]!;
          expect(markPromptDeliverySubmitting(state.storage.sql, claim, capabilities)).toBe(true);
        }
      }
    });
    const db = drizzle(env.DATABASE, { schema });
    const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.workspaceId).toBeNull();
    const cancelled = await cancelTask(env as unknown as Env, db, task!, userId);
    expect(cancelled.status).toBe('cancelled');
    expect((await stub.getSession(sessionId))?.status).toBe('stopped');
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      expect(
        sql
          .exec("SELECT delivery_state,terminal_reason FROM session_inbox WHERE id='queued-real'")
          .one()
      ).toMatchObject({ delivery_state: 'failed', terminal_reason: 'task_cancelled' });
      expect(
        sql
          .exec(
            "SELECT delivery_state,prompt_delivery_phase FROM session_inbox WHERE id='issued-real'"
          )
          .one()
      ).toMatchObject({ delivery_state: 'delivering', prompt_delivery_phase: 'submitting' });
      expect(claimDuePromptDeliveries(sql, config, now)).toEqual([]);
      const issued = claimDuePromptDeliveries(sql, config, now + config.receiptTimeoutMs)[0]!;
      expect(issued.mode).toBe('reconcile');
      let reconciled = false;
      const hooks = {
        projectId,
        recalculateAlarm: async () => {},
        broadcastEvent: () => {},
        armIdleCleanup: () => {},
        nudgeDeliveries: () => 0,
        scheduleSummarySync: () => {},
      };
      const result = await runPromptDeliveryClaim(
        sql,
        env,
        config,
        issued,
        {
          submit: async () => {
            throw new Error('Cancellation must not replay an issued prompt');
          },
          reconcile: async (input) => {
            reconciled = true;
            return (await input.beforeSideEffect?.()) ?? accepted;
          },
        },
        hooks
      );
      expect(reconciled).toBe(true);
      expect(result.kind).toBe('accepted');
      acceptPromptDelivery(
        sql,
        {},
        {
          deliveryId: 'fresh-real',
          targetSessionId: sessionId,
          displayContent: 'Fresh explicit follow-up',
          senderType: 'human',
          senderId: userId,
          sourceKind: 'user_followup',
          ttlMs: config.ttlMs,
        },
        now + config.receiptTimeoutMs + 1
      );
      const fresh = claimDuePromptDeliveries(sql, config, now + config.receiptTimeoutMs + 1)[0]!;
      let submitted = false;
      const freshResult = await runPromptDeliveryClaim(
        sql,
        env,
        config,
        fresh,
        {
          submit: async (input) => {
            submitted = true;
            return (await input.beforeSideEffect?.()) ?? accepted;
          },
          reconcile: async () => {
            throw new Error('Fresh prompt should submit');
          },
        },
        hooks
      );
      expect(submitted).toBe(true);
      expect(freshResult.kind).toBe('accepted');
    });
    expect(
      await env.DATABASE.prepare('SELECT COUNT(*) AS count FROM nodes WHERE user_id=?')
        .bind(userId)
        .first('count')
    ).toBe(0);
  });

  it.each(['submitting', null])(
    'preserves %s issuance ambiguity for receipt reconciliation',
    async (phase) => {
      const f = await fixture();
      await f.accept('issued');
      const claim = await runInDurableObject(f.stub, (_instance, state) => {
        const current = claimDuePromptDeliveries(state.storage.sql, config, f.now)[0]!;
        if (phase === 'submitting')
          expect(markPromptDeliverySubmitting(state.storage.sql, current, capabilities)).toBe(true);
        else
          state.storage.sql.exec(
            'UPDATE session_inbox SET prompt_delivery_phase = NULL WHERE id = ?',
            'issued'
          );
        return current;
      });
      expect(await f.stub.cancelUnissuedSessionPrompts(f.session, 'cancel-task')).toBe(0);
      await runInDurableObject(f.stub, async (_instance, state) => {
        const reconcile = claimDuePromptDeliveries(
          state.storage.sql,
          config,
          f.now + config.receiptTimeoutMs
        )[0]!;
        expect(reconcile.mode).toBe('reconcile');
        expect(reconcile.message.id).toBe(claim.message.id);
        let reconciled = false;
        const result = await runPromptDeliveryClaim(
          state.storage.sql,
          env,
          config,
          reconcile,
          {
            submit: async () => {
              throw new Error('An issued prompt must not replay');
            },
            reconcile: async (input) => {
              reconciled = true;
              return (await input.beforeSideEffect?.()) ?? accepted;
            },
          },
          {
            projectId: null,
            recalculateAlarm: async () => {},
            broadcastEvent: () => {},
            armIdleCleanup: () => {},
            nudgeDeliveries: () => 0,
            scheduleSummarySync: () => {},
          }
        );
        expect(reconciled).toBe(true);
        expect(result.kind).toBe('accepted');
      });
    }
  );

  it('cancels queued and retry-wait prompts while rejecting another task binding', async () => {
    const f = await fixture();
    await f.accept('retry');
    await runInDurableObject(f.stub, (_instance, state) => {
      const claim = claimDuePromptDeliveries(state.storage.sql, config, f.now)[0]!;
      applyPromptDeliveryResult(
        state.storage.sql,
        claim,
        {
          kind: 'retry',
          reason: 'not_ready',
          error: 'Still preparing',
          runtimeIdentity: null,
          capabilities: null,
        },
        config,
        f.now
      );
    });
    await f.accept('queued');
    const otherSession = await f.stub.createSession(null, 'Other task', 'other-task', 'owner');
    await runInDurableObject(f.stub, (_instance, state) => {
      acceptPromptDelivery(
        state.storage.sql,
        {},
        {
          deliveryId: 'other-session',
          targetSessionId: otherSession,
          displayContent: 'Keep this prompt',
          senderType: 'human',
          senderId: 'owner',
          sourceKind: 'user_followup',
          ttlMs: config.ttlMs,
        },
        f.now
      );
    });

    const rejected = await runInDurableObject(f.stub, async (instance) => {
      try {
        await instance.cancelUnissuedSessionPrompts(f.session, 'different-task');
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes('binding changed');
      }
    });
    expect(rejected).toBe(true);
    expect(await f.stub.cancelUnissuedSessionPrompts(f.session, 'cancel-task')).toBe(2);
    await runInDurableObject(f.stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT delivery_state FROM session_inbox WHERE id='other-session'")
          .one().delivery_state
      ).toBe('queued');
    });
  });
});
