/**
 * Insights · Agent setups counts nudges on the real ProjectData Durable Object (workerd SQLite and
 * its migrations, including the partial user-message index the read names), through the service
 * wrapper the operation port calls. Messages are written by the production writers: a person's
 * follow-up and a comment directive arrive through `acceptPromptDelivery` (as send-chat and the
 * comment directive path do), the task's first prompt through `persistMessage`.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { countRunNudges } from '../../src/services/project-data';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

function delivery(sessionId: string, deliveryId: string, sourceKind: string, human: boolean) {
  return {
    deliveryId,
    targetSessionId: sessionId,
    displayContent: `message ${deliveryId}`,
    deliveryContent: `message ${deliveryId}`,
    sourceTaskId: null,
    senderType: (human ? 'human' : 'agent') as 'human',
    senderId: 'user-1',
    messageClass: 'deliver' as const,
    sourceKind: sourceKind as 'user_followup',
    ttlMs: 60_000,
    metadata: { userId: 'user-1' },
  };
}

describe('countRunNudges', () => {
  it('counts only a person’s follow-ups inside the run window', async () => {
    const projectId = `run-nudges-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const sessionId = await stub.createSession(null, 'Nudged run');
    const quietSession = await stub.createSession(null, 'Quiet run');
    const before = Date.now() - 1;

    // The task's own first prompt: a user message with no delivery source.
    await stub.persistMessage(sessionId, 'user', 'Implement the feature', null);
    await stub.acceptPromptDelivery(delivery(sessionId, 'f-1', 'user_followup', true));
    await stub.acceptPromptDelivery(delivery(sessionId, 'f-2', 'user_followup', true));
    await stub.acceptPromptDelivery(delivery(sessionId, 'c-1', 'comment_directive', true));
    // Controls: an agent's message and a SAM wake prompt are not nudges.
    await stub.acceptPromptDelivery(delivery(sessionId, 'a-1', 'agent_mailbox', false));
    await stub.acceptPromptDelivery(delivery(sessionId, 'w-1', 'parent_wakeup', false));
    // A user row whose metadata is not JSON costs only itself.
    await stub.persistMessage(sessionId, 'user', 'odd row', '{not json');
    // A follow-up in another chat.
    await stub.acceptPromptDelivery(delivery(quietSession, 'q-1', 'agent_mailbox', false));
    const after = Date.now() + 1;

    const result = await countRunNudges(
      env as unknown as Env,
      projectId,
      [
        { sessionId, fromMs: before, toMs: after },
        { sessionId: quietSession, fromMs: before, toMs: after },
        { sessionId: 'no-such-chat', fromMs: before, toMs: after },
        // A window that ended before any message was sent.
        { sessionId, fromMs: before - 10_000, toMs: before },
      ],
      10
    );
    expect(result.counts).toEqual([3, 0, null, 0]);

    // The caller's cap bounds the probes.
    const capped = await countRunNudges(
      env as unknown as Env,
      projectId,
      [
        { sessionId, fromMs: before, toMs: after },
        { sessionId: quietSession, fromMs: before, toMs: after },
      ],
      1
    );
    expect(capped.counts).toEqual([3]);
  });
});
