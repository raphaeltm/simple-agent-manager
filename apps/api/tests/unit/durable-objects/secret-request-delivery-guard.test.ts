/**
 * A secret request outcome is delivered only while the requesting task (or its own recovery
 * successor) is live, like an Operations decision: the guard must exist for the new source kind.
 */
import { sourceTaskGuardForClaim } from '@simple-agent-manager/project-data/internal/do/prompt-delivery-source-guards';
import { describe, expect, it } from 'vitest';

import type { PromptDeliveryClaim } from '../../../src/durable-objects/project-data/prompt-delivery';

function claim(sourceKind: string): PromptDeliveryClaim {
  return {
    mode: 'submit',
    attemptId: 'attempt',
    message: {
      id: 'secret-request:req-1',
      targetSessionId: 'chat-1',
      sourceTaskId: 'task-1',
      sourceKind,
      runtimeIdentity: null,
      metadata: { secretRequestId: 'req-1', creatorUserId: 'user-1' },
    },
  } as unknown as PromptDeliveryClaim;
}

describe('sourceTaskGuardForClaim — secret_request', () => {
  it('guards the wake on the requesting task and an active requester membership', () => {
    expect(sourceTaskGuardForClaim(claim('secret_request'), 'proj-1')).toEqual({
      taskId: 'task-1',
      projectId: 'proj-1',
      chatSessionId: 'chat-1',
      requiredProjectMemberId: 'user-1',
    });
  });

  it('leaves an ordinary agent mailbox message unguarded (control)', () => {
    expect(sourceTaskGuardForClaim(claim('agent_mailbox'), 'proj-1')).toBeUndefined();
  });
});

describe('invalidProjectEventWakeSourceTaskResult — secret_request', () => {
  it('fails closed when the notice carries no requester', async () => {
    const { invalidProjectEventWakeSourceTaskResult } =
      await import('@simple-agent-manager/project-data/internal/do/prompt-delivery-source-guards');
    const noRequester = claim('secret_request');
    noRequester.message.metadata = { secretRequestId: 'req-1' };
    const result = await invalidProjectEventWakeSourceTaskResult(
      {} as never,
      'proj-1',
      noRequester
    );
    expect(result).toMatchObject({ kind: 'failed', reason: 'terminal_target' });
    // Control: with the requester present this check passes it on to the guard.
    expect(
      await invalidProjectEventWakeSourceTaskResult({} as never, 'proj-1', claim('secret_request'))
    ).toBeNull();
  });
});
