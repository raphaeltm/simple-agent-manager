import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import { resolveDurableExecutionConfig } from '../../src/durable-objects/project-data/durable-execution-config';
import {
  acceptPromptDelivery,
  applyPromptDeliveryResult,
  claimDuePromptDeliveries,
  markPromptDeliverySubmitting,
} from '../../src/durable-objects/project-data/prompt-delivery';
import { versionedPromptCapabilities } from '../helpers/vm-prompt-delivery-fixtures';

const config = resolveDurableExecutionConfig({});
const capabilities = versionedPromptCapabilities('runtime-before-reset');

async function createDelivery() {
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.newUniqueId()
  ) as DurableObjectStub<ProjectData>;
  const sessionId = await stub.createSession(null, 'Interrupted prompt preparation');
  const now = Date.now();
  const original = await runInDurableObject(stub, (_instance, state) => {
    acceptPromptDelivery(
      state.storage.sql,
      {},
      {
        deliveryId: 'delivery-1',
        targetSessionId: sessionId,
        displayContent: 'Resume the existing work',
        senderType: 'human',
        sourceKind: 'user_followup',
        ttlMs: config.ttlMs,
      },
      now
    );
    return claimDuePromptDeliveries(state.storage.sql, config, now)[0]!;
  });
  return { stub, original, now };
}

describe('prompt preparation checkpoints in Workers SQLite', () => {
  it('reclaims abandoned preparation across invocations, fences old work and accepts once', async () => {
    const { stub, original, now } = await createDelivery();
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const replacement = claimDuePromptDeliveries(sql, config, now + config.receiptTimeoutMs)[0]!;
      expect(replacement.mode).toBe('submit');
      expect(markPromptDeliverySubmitting(sql, original, capabilities)).toBe(false);
      expect(markPromptDeliverySubmitting(sql, replacement, capabilities)).toBe(true);
      expect(markPromptDeliverySubmitting(sql, replacement, capabilities)).toBe(false);
      const accepted = {
        kind: 'accepted' as const,
        acpSessionId: 'acp-1',
        promptEpoch: now,
        runtimeIdentity: capabilities.runtimeIdentity,
        capabilities,
        receipt: null,
      };
      expect(applyPromptDeliveryResult(sql, original, accepted, config, now)).toBe(false);
      expect(applyPromptDeliveryResult(sql, replacement, accepted, config, now)).toBe(true);
      expect(claimDuePromptDeliveries(sql, config, now + config.receiptTimeoutMs * 2)).toEqual([]);
      expect(sql.exec('SELECT COUNT(*) AS count FROM chat_messages').one().count).toBe(1);
      expect(
        sql.exec('SELECT delivery_state FROM session_inbox WHERE id = ?', 'delivery-1').one()
      ).toMatchObject({ delivery_state: 'acked' });
    });
  });

  it.each(['submitting', null])(
    'reconciles a persisted %s phase without blind replay',
    async (phase) => {
      const { stub, original, now } = await createDelivery();
      await runInDurableObject(stub, (_instance, state) => {
        if (phase === 'submitting') {
          expect(markPromptDeliverySubmitting(state.storage.sql, original, capabilities)).toBe(
            true
          );
        } else {
          // Claims created before the additive migration cannot prove no send occurred.
          state.storage.sql.exec(
            'UPDATE session_inbox SET prompt_delivery_phase = NULL WHERE id = ?',
            'delivery-1'
          );
        }
      });
      await runInDurableObject(stub, (_instance, state) => {
        const claim = claimDuePromptDeliveries(
          state.storage.sql,
          config,
          now + config.receiptTimeoutMs
        )[0]!;
        expect(claim.mode).toBe('reconcile');
        expect(markPromptDeliverySubmitting(state.storage.sql, claim, capabilities)).toBe(false);
        if (phase === 'submitting') {
          expect(claim.message.runtimeIdentity).toBe(capabilities.runtimeIdentity);
        }
      });
    }
  );
});
