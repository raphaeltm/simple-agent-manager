import { resolveDurableExecutionConfig } from '@simple-agent-manager/project-data/internal/do/durable-execution-config';
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import {
  acceptPromptDelivery,
  applyPromptDeliveryResult,
  claimDuePromptDeliveries,
  markPromptDeliverySubmitting,
} from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { quarantineUncertainPromptRetries } from '@simple-agent-manager/project-data/internal/do/prompt-delivery-cancellation';
import { runPromptDeliveryClaim } from '@simple-agent-manager/project-data/internal/do/prompt-delivery-runner';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import * as nodeAgent from '../../src/services/node-agent';
import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import * as runtimeQueries from '../../src/services/vm-prompt-delivery-runtime-queries';
import { versionedPromptCapabilities } from '../helpers/vm-prompt-delivery-fixtures';
import {
  type ChannelReceipt,
  okBody,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';
import {
  materialize,
  onlyWake,
  wakeBatches,
  wakeDueAt,
  withQuietAlarms,
} from './helpers/event-wake-harness';

const config = resolveDurableExecutionConfig({});
const capabilities = versionedPromptCapabilities('uncertain-cancel-runtime');
async function fixture(
  sourceKind: 'user_followup' | 'checkpoint_continuation' = 'user_followup',
  senderId = 'owner'
) {
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.newUniqueId()
  ) as DurableObjectStub<ProjectData>;
  const sessionId = await stub.createSession(
    null,
    'Cancellation receipt evidence',
    'task',
    'owner'
  );
  const now = Date.now();
  const claim = await runInDurableObject(stub, (_instance, state) => {
    acceptPromptDelivery(
      state.storage.sql,
      {},
      {
        deliveryId: 'delivery',
        targetSessionId: sessionId,
        displayContent: 'Continue',
        senderType: 'human',
        senderId,
        sourceTaskId: 'source',
        sourceKind,
        ttlMs: config.ttlMs,
      },
      now
    );
    return claimDuePromptDeliveries(state.storage.sql, config, now)[0]!;
  });
  return { stub, sessionId, now, claim };
}
const hooks = {
  projectId: 'guard-project',
  recalculateAlarm: async () => {},
  broadcastEvent: () => {},
  armIdleCleanup: () => {},
  nudgeDeliveries: () => 0,
  scheduleSummarySync: () => {},
};

/** Real adapter and runner; the controlled node transport owns the pre-fetch/after-fetch barrier. */
function actualAdapter(
  f: Awaited<ReturnType<typeof fixture>>,
  beforeFetch: () => void,
  afterFetch: () => void
) {
  let sends = 0;
  const probe = vi.spyOn(runtimeQueries, 'getDeliveryCapabilities').mockResolvedValue(capabilities);
  const send = vi
    .spyOn(nodeAgent, 'sendPromptToAgentOnNode')
    .mockImplementation(async (...args) => {
      beforeFetch();
      await args[7]?.beforeExternalMutation?.();
      sends++;
      afterFetch();
      throw new Error('Injected lost prompt response after fetch');
    });
  const real = new DefaultVmPromptDeliveryAdapter(env as unknown as Env);
  return {
    adapter: {
      submit: (input: Parameters<typeof real.submit>[0]) =>
        real.submit({
          ...input,
          resolvedTarget: {
            projectId: hooks.projectId,
            chatSessionId: f.sessionId,
            workspaceId: 'workspace',
            nodeId: 'node',
            agentSessionId: 'acp',
            userId: 'owner',
            runtimeIdentity: capabilities.runtimeIdentity,
            runtime: 'vm',
          },
        }),
      reconcile: (input: Parameters<typeof real.reconcile>[0]) => real.reconcile(input),
    },
    sends: () => sends,
    restore: () => {
      send.mockRestore();
      probe.mockRestore();
    },
  };
}

describe('cancellation does not erase possible-send receipt evidence', () => {
  it.each(['missing', 'task_unbound'] as const)(
    'returns a typed %s miss without changing queued prompts',
    async (reason) => {
      const f = await fixture();
      await runInDurableObject(f.stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE session_inbox SET delivery_state='queued',attempt_id=NULL,attempt_started_at=NULL"
        );
      });
      if (reason === 'task_unbound')
        await runInDurableObject(f.stub, (_instance, state) => {
          state.storage.sql.exec('UPDATE chat_sessions SET task_id=NULL WHERE id=?', f.sessionId);
        });
      expect(
        await f.stub.cancelUnissuedSessionPrompts(
          reason === 'missing' ? 'absent-session' : f.sessionId,
          'task'
        )
      ).toEqual({ matched: false, cancelled: 0, reason });
      await runInDurableObject(f.stub, (_instance, state) => {
        expect(
          state.storage.sql
            .exec("SELECT delivery_state,terminal_reason FROM session_inbox WHERE id='delivery'")
            .one()
        ).toMatchObject({ delivery_state: 'queued', terminal_reason: null });
        expect(
          state.storage.sql
            .exec(
              "SELECT json_extract(tool_metadata,'$.deliveryCancelled') AS cancelled FROM chat_messages"
            )
            .one().cancelled
        ).toBeNull();
      });
    }
  );

  it.each(['before_fetch', 'after_fetch'] as const)(
    'classifies actual adapter authority read failure %s truthfully',
    async (phase) => {
      const f = await fixture('checkpoint_continuation');
      await runInDurableObject(f.stub, async (_instance, state) => {
        let failRead = false;
        const sourceGuard = vi
          .spyOn(projectDataPorts().sessions, 'isSourceTaskGuardValid')
          .mockImplementation(async () => {
            if (failRead) throw new Error('Injected authority read unavailable');
            return true;
          });
        const transport = actualAdapter(
          f,
          () => {
            if (phase === 'before_fetch') failRead = true;
          },
          () => {
            failRead = true;
          }
        );
        try {
          const result = await runPromptDeliveryClaim(
            state.storage.sql,
            env,
            config,
            f.claim,
            transport.adapter,
            hooks
          );
          expect(sourceGuard).toHaveBeenCalled();
          expect(transport.sends()).toBe(phase === 'before_fetch' ? 0 : 1);
          expect(result).toMatchObject(
            phase === 'before_fetch'
              ? { kind: 'retry', reason: 'not_ready' }
              : {
                  kind: 'ambiguous',
                  reason: 'receipt_unavailable',
                  runtimeIdentity: capabilities.runtimeIdentity,
                }
          );
          expect(
            state.storage.sql
              .exec('SELECT delivery_state,prompt_delivery_phase FROM session_inbox')
              .one()
          ).toMatchObject(
            phase === 'before_fetch'
              ? { delivery_state: 'retry_wait', prompt_delivery_phase: 'preparing' }
              : { delivery_state: 'ambiguous', prompt_delivery_phase: 'submitting' }
          );
        } finally {
          transport.restore();
          sourceGuard.mockRestore();
        }
      });
      expect(await f.stub.cancelUnissuedSessionPrompts(f.sessionId, 'task')).toEqual({
        matched: true,
        cancelled: phase === 'before_fetch' ? 1 : 0,
      });
    }
  );

  it.each(['before_fetch', 'after_fetch'] as const)(
    'preserves truthful sender revocation facts in actual adapter %s',
    async (phase) => {
      const f = await fixture('user_followup', 'grantee');
      const grant = await f.stub.createSessionAccessGrant({
        sessionId: f.sessionId,
        granteeUserId: 'grantee',
        grantedByUserId: 'owner',
        durationMinutes: 5,
        maxActiveGrants: 5,
      });
      expect(grant.result.status).toBe('created');
      await runInDurableObject(f.stub, async (instance, state) => {
        const revoke = () => {
          expect(
            instance.revokeSessionAccessGrant({
              sessionId: f.sessionId,
              granteeUserId: 'grantee',
              actorUserId: 'owner',
            }).result.status
          ).toBe('revoked');
        };
        const transport = actualAdapter(
          f,
          () => {
            if (phase === 'before_fetch') revoke();
          },
          () => {
            revoke();
          }
        );
        try {
          const result = await runPromptDeliveryClaim(
            state.storage.sql,
            env,
            config,
            f.claim,
            transport.adapter,
            hooks
          );
          expect(transport.sends()).toBe(phase === 'before_fetch' ? 0 : 1);
          expect(result.kind).toBe(phase === 'before_fetch' ? 'failed' : 'ambiguous');
          const marker = state.storage.sql
            .exec(
              "SELECT json_extract(tool_metadata,'$.deliveryCancelled') AS reason FROM chat_messages"
            )
            .one().reason;
          expect(marker).toBe(phase === 'before_fetch' ? 'sender_access_revoked' : null);
        } finally {
          transport.restore();
        }
      });
    }
  );

  it.each(['queued', 'uncertain_retry'] as const)(
    'retires a %s event wake through the durable batch checkpoint and frees its target',
    async (phase) => {
      const f = await twoAgentProject();
      await withAgentMessageChannels(async () => {
        okBody<ChannelReceipt>(
          await f.b.tool('send_durable_message', {
            targetTaskId: f.a.taskId,
            message: 'Old queued wake',
            messageClass: 'deliver',
          })
        );
        await withQuietAlarms(f, async () => {
          const now = Date.now();
          expect(await materialize(f, now)).toMatchObject({
            status: 'materialized',
            materialized: 1,
          });
          const old = await onlyWake(f, f.a.sessionId);
          expect(old.state).toBe('pending');
          if (phase === 'uncertain_retry')
            await runInDurableObject(f.stub, (_instance, state) => {
              const claim = claimDuePromptDeliveries(state.storage.sql, config, now)[0]!;
              expect(markPromptDeliverySubmitting(state.storage.sql, claim, capabilities)).toBe(
                true
              );
              state.storage.sql.exec(
                "UPDATE session_inbox SET delivery_state='retry_wait' WHERE id=?",
                old.id
              );
            });
          expect(await f.stub.cancelUnissuedSessionPrompts(f.a.sessionId, f.a.taskId)).toEqual({
            matched: true,
            cancelled: phase === 'queued' ? 1 : 0,
          });
          if (phase === 'uncertain_retry')
            await runInDurableObject(f.stub, (_instance, state) => {
              expect(
                state.storage.sql
                  .exec(
                    'SELECT delivery_state,runtime_identity,terminal_reason FROM session_inbox WHERE id=?',
                    old.id
                  )
                  .one()
              ).toMatchObject({
                delivery_state: 'ambiguous',
                runtime_identity: capabilities.runtimeIdentity,
                terminal_reason: 'receipt_unavailable',
              });
            });
          expect(await wakeBatches(f, f.a.sessionId)).toEqual([
            expect.objectContaining({
              id: old.id,
              state: phase === 'queued' ? 'failed' : 'ambiguous',
            }),
          ]);
          await withAgentMessageChannels(
            async () => {
              okBody<ChannelReceipt>(
                await f.b.tool('send_durable_message', {
                  targetTaskId: f.a.taskId,
                  message: 'Fresh independent wake',
                  messageClass: 'deliver',
                })
              );
            },
            { DURABLE_PROMPT_DELIVERY_ENABLED: 'true' }
          );
          const due = await wakeDueAt(f, now + 31_000);
          expect(due).not.toBeNull();
          expect(await materialize(f, Math.max(due!, now + 31_000))).toMatchObject({
            status: 'materialized',
            materialized: 1,
          });
          expect(await wakeBatches(f, f.a.sessionId)).toEqual([
            expect.objectContaining({
              id: old.id,
              state: phase === 'queued' ? 'failed' : 'ambiguous',
            }),
            expect.objectContaining({ state: 'pending' }),
          ]);
        });
      });
    }
  );

  it('retains possible-send evidence when task authority is definitively revoked', async () => {
    const f = await fixture('checkpoint_continuation');
    await runInDurableObject(f.stub, async (_instance, state) => {
      let live = true;
      const guard = vi
        .spyOn(projectDataPorts().sessions, 'isSourceTaskGuardValid')
        .mockImplementation(async () => live);
      try {
        const result = await runPromptDeliveryClaim(
          state.storage.sql,
          env,
          config,
          f.claim,
          {
            submit: async (input) => {
              expect(input.beforeSubmit?.(capabilities)).toBe(true);
              live = false;
              return (await input.beforeSideEffect?.())!;
            },
            reconcile: async () => {
              throw new Error('Unexpected reconcile');
            },
          },
          hooks
        );
        expect(result).toMatchObject({
          kind: 'ambiguous',
          reason: 'receipt_unavailable',
          runtimeIdentity: capabilities.runtimeIdentity,
        });
      } finally {
        guard.mockRestore();
      }
    });
  });

  it.each(['submitting', null])(
    'quarantines a legacy retry with %s checkpoint without a false cancellation label',
    async (phase) => {
      const f = await fixture();
      await runInDurableObject(f.stub, (_instance, state) => {
        expect(markPromptDeliverySubmitting(state.storage.sql, f.claim, capabilities)).toBe(true);
        // This is a persisted unsafe old retry, not evidence of a new definite refusal.
        state.storage.sql.exec(
          "UPDATE session_inbox SET delivery_state='retry_wait',prompt_delivery_phase=?",
          phase
        );
        const sql = state.storage.sql;
        // Sender-scoped revocation cannot quarantine another person's uncertain send.
        quarantineUncertainPromptRetries(sql, f.sessionId, {
          userIds: ['other'],
          humanSources: ['user_followup'],
        });
        expect(sql.exec('SELECT delivery_state FROM session_inbox').one().delivery_state).toBe(
          'retry_wait'
        );
        quarantineUncertainPromptRetries(sql, f.sessionId, {
          userIds: ['owner'],
          humanSources: ['user_followup'],
        });
        expect(sql.exec('SELECT delivery_state FROM session_inbox').one().delivery_state).toBe(
          'ambiguous'
        );
      });
      expect(await f.stub.cancelUnissuedSessionPrompts(f.sessionId, 'task')).toEqual({
        matched: true,
        cancelled: 0,
      });
      await runInDurableObject(f.stub, (_instance, state) => {
        const row = state.storage.sql
          .exec(
            'SELECT id,runtime_identity,delivery_state,terminal_reason,last_error FROM session_inbox'
          )
          .one();
        expect(row).toMatchObject({
          id: 'delivery',
          runtime_identity: capabilities.runtimeIdentity,
          delivery_state: 'ambiguous',
          terminal_reason: 'receipt_unavailable',
        });
        expect(row.last_error).toContain('requires review');
        expect(
          state.storage.sql
            .exec(
              "SELECT json_extract(tool_metadata,'$.deliveryCancelled') AS cancelled FROM chat_messages"
            )
            .one().cancelled
        ).toBeNull();
        // Quarantine preserves evidence but is NOT an automatic receipt reconciliation claim.
        expect(
          claimDuePromptDeliveries(state.storage.sql, config, f.now + config.receiptTimeoutMs)
        ).toEqual([]);
      });
    }
  );

  it.each(['busy', 'receipt_not_found'] as const)(
    'releases a positive %s no-acceptance proof back to cancellable preparation',
    async (reason) => {
      const f = await fixture();
      await runInDurableObject(f.stub, (_instance, state) => {
        expect(markPromptDeliverySubmitting(state.storage.sql, f.claim, capabilities)).toBe(true);
        expect(
          applyPromptDeliveryResult(
            state.storage.sql,
            f.claim,
            {
              kind: 'retry',
              reason,
              error: 'Same-runtime response confirms not accepted',
              runtimeIdentity: capabilities.runtimeIdentity,
              capabilities,
            },
            config,
            f.now
          )
        ).toBe(true);
        expect(
          state.storage.sql
            .exec('SELECT delivery_state,prompt_delivery_phase FROM session_inbox')
            .one()
        ).toMatchObject({ delivery_state: 'retry_wait', prompt_delivery_phase: 'preparing' });
      });
      expect(await f.stub.cancelUnissuedSessionPrompts(f.sessionId, 'task')).toEqual({
        matched: true,
        cancelled: 1,
      });
    }
  );
});
