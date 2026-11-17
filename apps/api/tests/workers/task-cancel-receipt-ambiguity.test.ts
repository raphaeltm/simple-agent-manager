import { resolveDurableExecutionConfig } from '@simple-agent-manager/project-data/internal/do/durable-execution-config';
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import {
  acceptPromptDelivery,
  applyPromptDeliveryResult,
  claimDuePromptDeliveries,
  markPromptDeliverySubmitting,
} from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { runPromptDeliveryClaim } from '@simple-agent-manager/project-data/internal/do/prompt-delivery-runner';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { versionedPromptCapabilities } from '../helpers/vm-prompt-delivery-fixtures';

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

describe('cancellation does not erase possible-send receipt evidence', () => {
  it.each(['preparing', 'submitting'] as const)(
    'handles an actual source guard read failure in %s phase',
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
        try {
          const result = await runPromptDeliveryClaim(
            state.storage.sql,
            env,
            config,
            f.claim,
            {
              submit: async (input) => {
                if (phase === 'submitting') expect(input.beforeSubmit?.(capabilities)).toBe(true);
                failRead = true;
                const denied = await input.beforeSideEffect?.();
                expect(denied).not.toBeNull();
                return denied!;
              },
              reconcile: async () => {
                throw new Error('Unexpected receipt lookup');
              },
            },
            hooks
          );
          expect(sourceGuard).toHaveBeenCalled();
          expect(result).toMatchObject(
            phase === 'submitting'
              ? {
                  kind: 'ambiguous',
                  reason: 'receipt_unavailable',
                  runtimeIdentity: capabilities.runtimeIdentity,
                }
              : { kind: 'retry', reason: 'not_ready' }
          );
          expect(
            state.storage.sql
              .exec('SELECT delivery_state,runtime_identity,receipt_supported FROM session_inbox')
              .one()
          ).toMatchObject(
            phase === 'submitting'
              ? {
                  delivery_state: 'ambiguous',
                  runtime_identity: capabilities.runtimeIdentity,
                  receipt_supported: 1,
                }
              : { delivery_state: 'retry_wait' }
          );
        } finally {
          sourceGuard.mockRestore();
        }
      });
      expect(await f.stub.cancelUnissuedSessionPrompts(f.sessionId, 'task')).toBe(
        phase === 'preparing' ? 1 : 0
      );
    }
  );

  it.each(['preparing', 'submitting'] as const)(
    'preserves truthful sender revocation facts in %s phase',
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
        let transportCalled = false;
        const result = await runPromptDeliveryClaim(
          state.storage.sql,
          env,
          config,
          f.claim,
          {
            submit: async (input) => {
              if (phase === 'submitting') expect(input.beforeSubmit?.(capabilities)).toBe(true);
              const revoked = instance.revokeSessionAccessGrant({
                sessionId: f.sessionId,
                granteeUserId: 'grantee',
                actorUserId: 'owner',
              });
              expect(revoked.result.status).toBe('revoked');
              const denied = await input.beforeSideEffect?.();
              if (!denied) transportCalled = true;
              return (
                denied ?? {
                  kind: 'retry',
                  reason: 'not_ready',
                  error: 'Unexpected send allowed',
                  runtimeIdentity: null,
                  capabilities: null,
                }
              );
            },
            reconcile: async () => {
              throw new Error('Unexpected reconcile');
            },
          },
          hooks
        );
        expect(transportCalled).toBe(false);
        expect(result.kind).toBe(phase === 'submitting' ? 'ambiguous' : 'failed');
        const marker = state.storage.sql
          .exec(
            "SELECT json_extract(tool_metadata,'$.deliveryCancelled') AS reason FROM chat_messages"
          )
          .one().reason;
        expect(marker).toBe(phase === 'submitting' ? null : 'sender_access_revoked');
        if (phase === 'submitting')
          expect(
            state.storage.sql
              .exec('SELECT delivery_state,runtime_identity FROM session_inbox')
              .one()
          ).toMatchObject({
            delivery_state: 'ambiguous',
            runtime_identity: capabilities.runtimeIdentity,
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
      });
      expect(await f.stub.cancelUnissuedSessionPrompts(f.sessionId, 'task')).toBe(0);
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
      expect(await f.stub.cancelUnissuedSessionPrompts(f.sessionId, 'task')).toBe(1);
    }
  );
});
