/**
 * A secret request outcome travels to the requesting agent as a durable prompt delivery with source
 * kind `secret_request`. Runs against the real ProjectData Durable Object (workerd SQLite,
 * migrations) so the new kind is proven through the stored row, not a mocked RPC.
 */
import { resolveDurableExecutionConfig } from '@simple-agent-manager/project-data/internal/do/durable-execution-config';
import { expireDuePromptDeliveries } from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectDataTestDouble } from './support/expected-error-doubles';

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

const NOTICE =
  'Secret request req-1 was fulfilled by Raph: STRIPE_API_KEY is now a project runtime secret.';

function delivery(sessionId: string, deliveryId: string, sourceKind: string) {
  return {
    deliveryId,
    targetSessionId: sessionId,
    displayContent: NOTICE,
    deliveryContent: NOTICE,
    sourceTaskId: 'task-1',
    senderType: 'system' as const,
    senderId: 'user-1',
    messageClass: 'deliver' as const,
    sourceKind: sourceKind as 'secret_request',
    ttlMs: 60_000,
    metadata: {
      secretRequestId: 'req-1',
      envKey: 'STRIPE_API_KEY',
      outcome: 'fulfilled',
      creatorUserId: 'user-1',
    },
  };
}

describe('secret_request prompt delivery in ProjectData', () => {
  it('persists the notice with its source kind and metadata, idempotently by delivery id', async () => {
    const stub = getStub(`secret-request-accept-${crypto.randomUUID()}`);
    const sessionId = await stub.createSession('workspace-1', 'Secret request');
    const first = await stub.acceptPromptDelivery(
      delivery(sessionId, 'secret-request:req-1', 'secret_request')
    );
    // The sweep's retry reuses the delivery id: it must not add a second notice.
    const retry = await stub.acceptPromptDelivery(
      delivery(sessionId, 'secret-request:req-1', 'secret_request')
    );
    expect(first.transcriptInserted).toBe(true);
    expect(retry.transcriptInserted).toBe(false);

    const snapshot = await stub.getDurableExecutionSnapshot(sessionId);
    expect(snapshot.deliveries).toContainEqual(
      expect.objectContaining({
        id: 'secret-request:req-1',
        sourceKind: 'secret_request',
        sourceTaskId: 'task-1',
      })
    );
    const { messages } = await stub.getMessages(sessionId, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('STRIPE_API_KEY');
  });

  it('reports an unanswered wake for a sleeping session when the notice expires', async () => {
    const stub = getStub(`secret-request-expiry-${crypto.randomUUID()}`);
    const sessionId = await stub.createSession('workspace-1', 'Sleeping secret request');
    expect(await stub.sleepSession(sessionId)).toBe(true);
    await stub.acceptPromptDelivery(delivery(sessionId, 'secret-request:req-2', 'secret_request'));
    // Control: an ordinary mailbox message is not a wake, so its expiry is not a wake failure.
    await stub.acceptPromptDelivery(delivery(sessionId, 'mailbox-1', 'agent_mailbox'));

    const failures = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE session_inbox SET expires_at = 0`);
      return expireDuePromptDeliveries(state.storage.sql, resolveDurableExecutionConfig(env))
        .expiredWakeFailures;
    });
    expect(failures.map((failure) => failure.deliveryId)).toEqual(['secret-request:req-2']);
  });
});
