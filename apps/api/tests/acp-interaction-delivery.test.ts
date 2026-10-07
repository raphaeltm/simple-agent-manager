import { beforeEach, describe, expect, it, vi } from 'vitest';

const nodeAgentRequest = vi.fn();

vi.mock('../src/services/node-agent', () => ({
  getNodeAgentBackgroundRequestTimeoutMs: () => 5_000,
  NodeAgentRequestError: class NodeAgentRequestError extends Error {
    constructor(
      public readonly statusCode: number,
      public readonly error: string,
      message: string
    ) {
      super(message);
      this.name = 'NodeAgentRequestError';
    }
  },
  NodeAgentHttpError: class NodeAgentHttpError extends Error {
    constructor(
      public readonly statusCode: number,
      public readonly responseBody: string
    ) {
      super(`Node Agent request failed: ${statusCode} ${responseBody}`);
      this.name = 'NodeAgentHttpError';
    }
  },
  nodeAgentRequest,
}));

const { deliverAcpInteractionAnswer } = await import('../src/services/acp-interaction-delivery');
const { NodeAgentHttpError, NodeAgentRequestError } = await import('../src/services/node-agent');

describe('ACP interaction answer delivery', () => {
  const target = {
    projectId: 'project-1',
    chatSessionId: 'chat-1',
    workspaceId: 'workspace-1',
    nodeId: 'node-1',
    userId: 'user-1',
    agentSessionId: 'agent-session-1',
    runtime: 'vm',
  };
  const input = {
    interactionId: '11111111-1111-4111-8111-111111111111',
    generation: '22222222-2222-4222-8222-222222222222',
    runtimeIdentity: 'runtime-1',
    decision: { kind: 'accepted' as const, answerHash: 'a'.repeat(64) },
  };

  beforeEach(() => nodeAgentRequest.mockReset());

  const capabilities = (runtimeIdentity = input.runtimeIdentity) => ({
    protocolVersion: 1,
    runtimeIdentity,
    promptReceipts: {
      supported: true,
      lookup: true,
      states: ['accepted', 'in_flight', 'completed', 'not_found', 'ambiguous'],
    },
    interactions: {
      supported: true,
      version: 1,
      answerEndpoint: true,
      permissionBridge: true,
    },
    checkpointRollover: {
      supported: true,
      automatic: false,
      states: [],
      defaultGraceMs: 30_000,
      maxGraceMs: 120_000,
      operationTimeoutMs: 120_000,
    },
  });

  it.each([
    ['vm', 'consumed'],
    ['vm', 'duplicate'],
    ['cf-container', 'consumed'],
    ['cf-container', 'duplicate'],
  ] as const)('confirms %s %s runtime receipts without recovery', async (runtime, status) => {
    nodeAgentRequest.mockResolvedValueOnce(capabilities()).mockResolvedValueOnce({
      status,
      interactionId: input.interactionId,
      generation: input.generation,
      runtimeIdentity: input.runtimeIdentity,
    });

    await expect(
      deliverAcpInteractionAnswer({} as never, { ...target, runtime }, input)
    ).resolves.toMatchObject({ outcome: 'confirmed', runtimeStatus: status });
    expect(nodeAgentRequest).toHaveBeenCalledWith(
      'node-1',
      expect.anything(),
      '/workspaces/workspace-1/agent-sessions/agent-session-1/interactions/11111111-1111-4111-8111-111111111111/answer',
      expect.objectContaining({
        recoverContainerOnTimeout: false,
        noWakeContainer: true,
        method: 'POST',
        requestTimeoutMs: 5_000,
      })
    );
  });

  it.each(['stale_generation', 'no_waiter', 'conflict'] as const)(
    'interrupts on %s runtime receipts',
    async (status) => {
      nodeAgentRequest.mockResolvedValueOnce(capabilities()).mockResolvedValueOnce({
        status,
        interactionId: input.interactionId,
        generation: input.generation,
        runtimeIdentity: input.runtimeIdentity,
      });

      await expect(deliverAcpInteractionAnswer({} as never, target, input)).resolves.toMatchObject({
        outcome: 'interrupted',
        reason: status,
      });
    }
  );

  it.each(['vm', 'cf-container'] as const)('delivers URL consent to live %s only with URL bridge and no wake', async (runtime) => {
    nodeAgentRequest.mockResolvedValueOnce({ ...capabilities(), interactions: {
      ...capabilities().interactions, urlBridge: true,
    } }).mockResolvedValueOnce({ status: 'consumed', interactionId: input.interactionId,
      generation: input.generation, runtimeIdentity: input.runtimeIdentity });
    await expect(deliverAcpInteractionAnswer({} as never, { ...target, runtime }, { ...input, kind: 'url' }))
      .resolves.toMatchObject({ outcome: 'confirmed' });
    expect(nodeAgentRequest).toHaveBeenNthCalledWith(2, 'node-1', expect.anything(),
      expect.stringContaining('/interactions/'), expect.objectContaining({
        method: 'POST', noWakeContainer: true, recoverContainerOnTimeout: false,
      }));

    nodeAgentRequest.mockResolvedValueOnce(capabilities());
    await expect(deliverAcpInteractionAnswer({} as never, { ...target, runtime }, { ...input, kind: 'url' }))
      .resolves.toMatchObject({ outcome: 'interrupted', reason: 'runtime URL bridge unsupported' });
  });

  it.each(['vm', 'cf-container'] as const)(
    'interrupts a dead %s runtime generation without recovery',
    async (runtime) => {
      nodeAgentRequest.mockResolvedValueOnce(capabilities('runtime-2'));
      await expect(
        deliverAcpInteractionAnswer(
          {} as never,
          { ...target, runtime },
          { ...input, runtimeIdentity: 'old-runtime' }
        )
      ).resolves.toMatchObject({
        outcome: 'interrupted',
        reason: 'runtime identity changed before delivery',
      });
      expect(nodeAgentRequest).toHaveBeenCalledTimes(1);
      expect(nodeAgentRequest).toHaveBeenCalledWith(
        'node-1',
        expect.anything(),
        '/workspaces/workspace-1/agent-capabilities',
        expect.objectContaining({
          recoverContainerOnTimeout: false,
          noWakeContainer: true,
          method: 'GET',
          requestTimeoutMs: 5_000,
        })
      );
    }
  );

  it('fails closed when the runtime does not advertise the permission bridge', async () => {
    const unsupported: Partial<ReturnType<typeof capabilities>> = capabilities();
    delete unsupported.interactions;
    nodeAgentRequest.mockResolvedValueOnce(unsupported);

    await expect(deliverAcpInteractionAnswer({} as never, target, input)).resolves.toEqual({
      outcome: 'interrupted',
      reason: 'runtime permission bridge unsupported',
    });
    expect(nodeAgentRequest).toHaveBeenCalledTimes(1);
  });

  it('marks 404 as interrupted and ambiguous transport loss as unconfirmed', async () => {
    nodeAgentRequest
      .mockResolvedValueOnce(capabilities())
      .mockRejectedValueOnce(new NodeAgentHttpError(404, 'missing'));
    await expect(deliverAcpInteractionAnswer({} as never, target, input)).resolves.toMatchObject({
      outcome: 'interrupted',
      reason: 'runtime waiter missing',
    });

    nodeAgentRequest
      .mockResolvedValueOnce(capabilities())
      .mockRejectedValueOnce(new Error('connection reset after write'));
    await expect(deliverAcpInteractionAnswer({} as never, target, input)).resolves.toMatchObject({
      outcome: 'unconfirmed',
      reason: 'transport outcome unknown',
    });
  });

  it.each(['vm', 'cf-container'] as const)(
    'interrupts a stopped %s runtime without retrying or waking it',
    async (runtime) => {
      nodeAgentRequest.mockRejectedValueOnce(
        new NodeAgentRequestError(410, 'RUNTIME_STOPPED', 'runtime stopped')
      );

      await expect(
        deliverAcpInteractionAnswer({} as never, { ...target, runtime }, input)
      ).resolves.toEqual({
        outcome: 'interrupted',
        reason: 'runtime stopped',
      });
      expect(nodeAgentRequest).toHaveBeenCalledTimes(1);
      expect(nodeAgentRequest).toHaveBeenCalledWith(
        'node-1',
        expect.anything(),
        '/workspaces/workspace-1/agent-capabilities',
        expect.objectContaining({
          recoverContainerOnTimeout: false,
          noWakeContainer: true,
        })
      );
    }
  );

  it('classifies a generation conflict returned after the capability probe', async () => {
    nodeAgentRequest.mockResolvedValueOnce(capabilities()).mockRejectedValueOnce(
      new NodeAgentHttpError(
        409,
        JSON.stringify({
          status: 'stale_generation',
          interactionId: input.interactionId,
          generation: input.generation,
          runtimeIdentity: 'runtime-2',
        })
      )
    );

    await expect(deliverAcpInteractionAnswer({} as never, target, input)).resolves.toEqual({
      outcome: 'interrupted',
      reason: 'stale_generation',
    });
  });
});
