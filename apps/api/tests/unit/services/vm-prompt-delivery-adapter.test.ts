import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  DefaultVmPromptDeliveryAdapter,
  type VmPromptDeliveryAdapterInput,
} from '../../../src/services/vm-prompt-delivery-adapter';

const mocks = vi.hoisted(() => ({
  nodeAgentRequest: vi.fn(),
  sendPromptToAgentOnNode: vi.fn(),
}));

vi.mock('../../../src/services/node-agent', () => ({
  nodeAgentRequest: mocks.nodeAgentRequest,
  sendPromptToAgentOnNode: mocks.sendPromptToAgentOnNode,
}));

const targetRow = {
  workspace_id: 'workspace-1',
  user_id: 'user-1',
  workspace_status: 'running',
  node_id: 'node-1',
  node_status: 'running',
  node_health_status: 'healthy',
  agent_version: 'v1',
  agent_session_id: 'acp-1',
  agent_session_status: 'running',
  agent_session_updated_at: '2026-08-09T00:00:00Z',
};

function envWithTarget(row: typeof targetRow | null = targetRow): Env {
  return {
    DATABASE: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => row),
        })),
      })),
    } as unknown as D1Database,
  } as Env;
}

function input(allowLegacyVm: boolean): VmPromptDeliveryAdapterInput {
  return {
    projectId: 'project-1',
    allowLegacyVm,
    requestTimeoutMs: 1_234,
    claim: {
      attemptId: 'attempt-1',
      mode: 'submit',
      message: {
        id: 'delivery-1',
        targetSessionId: 'chat-1',
        sourceTaskId: null,
        senderType: 'human',
        senderId: 'user-1',
        messageClass: 'deliver',
        deliveryState: 'delivering',
        content: 'hello',
        metadata: null,
        ackRequired: false,
        ackTimeoutMs: null,
        deliveryAttempts: 1,
        lastDeliveryAt: 1,
        expiresAt: 99,
        createdAt: 1,
        deliveredAt: null,
        ackedAt: null,
        sourceKind: 'user_followup',
        promptMessageId: 'delivery-1',
        nextAttemptAt: 1,
        lastError: null,
        terminalReason: null,
        attemptId: 'attempt-1',
        attemptStartedAt: 1,
        runtimeIdentity: null,
        receiptState: null,
        receiptRuntimeIdentity: null,
        receiptCheckedAt: null,
        acceptedAt: null,
        adapterProtocolVersion: null,
        receiptSupported: null,
      },
    },
  };
}

describe('VM prompt delivery adapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails closed for an old VM unless compatibility is explicitly enabled', async () => {
    mocks.nodeAgentRequest.mockRejectedValue(new Error('Node Agent request failed: 404'));
    const adapter = new DefaultVmPromptDeliveryAdapter(envWithTarget());

    const result = await adapter.submit(input(false));

    expect(result).toMatchObject({ kind: 'failed', reason: 'unsupported_capability' });
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('retries a transient capability probe before submitting and never guesses acceptance', async () => {
    mocks.nodeAgentRequest.mockRejectedValue(new Error('connection timeout'));
    const adapter = new DefaultVmPromptDeliveryAdapter(envWithTarget());

    const result = await adapter.submit(input(false));

    expect(result).toMatchObject({ kind: 'retry', reason: 'not_ready' });
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('marks a transient capability failure during reconciliation ambiguous', async () => {
    mocks.nodeAgentRequest.mockRejectedValue(new Error('connection timeout'));
    const adapter = new DefaultVmPromptDeliveryAdapter(envWithTarget());

    const result = await adapter.reconcile(input(false));

    expect(result).toMatchObject({ kind: 'ambiguous', reason: 'receipt_unavailable' });
    expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('preserves the old VM submit path only behind its explicit compatibility flag', async () => {
    mocks.nodeAgentRequest.mockRejectedValue(new Error('Node Agent request failed: 404'));
    mocks.sendPromptToAgentOnNode.mockResolvedValue({ status: 'accepted', sessionId: 'acp-1' });
    const adapter = new DefaultVmPromptDeliveryAdapter(envWithTarget());

    const result = await adapter.submit(input(true));

    expect(result.kind).toBe('accepted');
    expect(mocks.sendPromptToAgentOnNode).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'acp-1',
      'hello',
      expect.anything(),
      'user-1',
      'delivery-1',
      { requestTimeoutMs: 1_234 },
    );
  });

  it('reconciles a lost submit response through the stable receipt endpoint', async () => {
    mocks.nodeAgentRequest
      .mockResolvedValueOnce({
        protocolVersion: 1,
        stableReceipts: true,
        receiptLookup: true,
        runtimeIdentity: 'node-1:acp-1:v1:2026-08-09T00:00:00Z',
      })
      .mockResolvedValueOnce({
        deliveryId: 'delivery-1',
        state: 'accepted',
        runtimeIdentity: 'node-1:acp-1:v1:2026-08-09T00:00:00Z',
        acceptedAt: 500,
        completedAt: null,
      });
    mocks.sendPromptToAgentOnNode.mockRejectedValue(new Error('connection reset'));
    const adapter = new DefaultVmPromptDeliveryAdapter(envWithTarget());

    const result = await adapter.submit(input(false));

    expect(result).toMatchObject({ kind: 'accepted', promptEpoch: 500 });
    expect(mocks.nodeAgentRequest).toHaveBeenLastCalledWith(
      'node-1',
      expect.anything(),
      '/workspaces/workspace-1/agent-sessions/acp-1/prompt-receipts/delivery-1',
      expect.objectContaining({ requestTimeoutMs: 1_234 }),
    );
  });
});
