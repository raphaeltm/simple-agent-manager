import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  DefaultVmPromptDeliveryAdapter,
  type VmPromptDeliveryAdapterInput,
} from '../../../src/services/vm-prompt-delivery-adapter';

const mocks = vi.hoisted(() => ({
  nodeAgentRequest: vi.fn(),
  sendPromptToAgentOnNode: vi.fn(),
  NodeAgentHttpError: class NodeAgentHttpError extends Error {
    constructor(
      public readonly statusCode: number,
      public readonly responseBody: string
    ) {
      super(`Node Agent request failed: ${statusCode} ${responseBody}`);
    }
  },
}));

vi.mock('../../../src/services/node-agent', () => ({
  nodeAgentRequest: mocks.nodeAgentRequest,
  sendPromptToAgentOnNode: mocks.sendPromptToAgentOnNode,
  NodeAgentHttpError: mocks.NodeAgentHttpError,
}));

const protocolFixture = JSON.parse(
  readFileSync(
    new URL('../../../../../tests/fixtures/durable-execution-protocol-v1.json', import.meta.url),
    'utf8'
  )
) as {
  capabilities: Record<string, unknown>;
  ambiguousReceipt: Record<string, unknown>;
  conflictPrompt: Record<string, unknown>;
  newPrompt: Record<string, unknown>;
  notFoundReceipt: Record<string, unknown>;
};

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
      { requestTimeoutMs: 1_234 }
    );
  });

  it('reconciles a lost submit response through the stable receipt endpoint', async () => {
    mocks.nodeAgentRequest
      .mockResolvedValueOnce(protocolFixture.capabilities)
      .mockResolvedValueOnce({
        deliveryId: 'delivery-1',
        state: 'accepted',
        runtimeIdentity: 'runtime-vm-01',
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
      expect.objectContaining({ requestTimeoutMs: 1_234 })
    );
  });

  it('serializes protocolVersion and deliveryId in the real versioned request body', async () => {
    mocks.nodeAgentRequest.mockResolvedValue(protocolFixture.capabilities);
    mocks.sendPromptToAgentOnNode.mockResolvedValue({
      ...protocolFixture.newPrompt,
      sessionId: 'acp-1',
      receipt: {
        ...(protocolFixture.newPrompt.receipt as Record<string, unknown>),
        deliveryId: 'delivery-1',
      },
    });
    const adapter = new DefaultVmPromptDeliveryAdapter(envWithTarget());

    const result = await adapter.submit(input(false));

    expect(result).toMatchObject({ kind: 'accepted', runtimeIdentity: 'runtime-vm-01' });
    expect(mocks.nodeAgentRequest).toHaveBeenCalledWith(
      'node-1',
      expect.anything(),
      '/workspaces/workspace-1/agent-capabilities',
      expect.anything()
    );
    expect(mocks.sendPromptToAgentOnNode).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'acp-1',
      'hello',
      expect.anything(),
      'user-1',
      'delivery-1',
      { requestTimeoutMs: 1_234, protocolVersion: 1, deliveryId: 'delivery-1' }
    );
  });

  it('replays only after a positive same-runtime 404 not_found receipt', async () => {
    mocks.nodeAgentRequest
      .mockResolvedValueOnce(protocolFixture.capabilities)
      .mockRejectedValueOnce(
        new mocks.NodeAgentHttpError(404, JSON.stringify(protocolFixture.notFoundReceipt))
      );
    const adapter = new DefaultVmPromptDeliveryAdapter(envWithTarget());

    const result = await adapter.reconcile(input(false));

    expect(result).toMatchObject({ kind: 'retry', reason: 'receipt_not_found' });
  });

  it('fails a canonical delivery conflict without retrying', async () => {
    mocks.nodeAgentRequest.mockResolvedValue(protocolFixture.capabilities);
    mocks.sendPromptToAgentOnNode.mockRejectedValue(
      new mocks.NodeAgentHttpError(409, JSON.stringify(protocolFixture.conflictPrompt))
    );
    const adapter = new DefaultVmPromptDeliveryAdapter(envWithTarget());

    const result = await adapter.submit(input(false));

    expect(result).toMatchObject({ kind: 'failed', reason: 'delivery_conflict' });
    expect(mocks.nodeAgentRequest).toHaveBeenCalledTimes(1);
  });

  it('preserves a canonical ambiguous receipt as terminal ambiguity', async () => {
    mocks.nodeAgentRequest
      .mockResolvedValueOnce(protocolFixture.capabilities)
      .mockResolvedValueOnce(protocolFixture.ambiguousReceipt);
    const adapter = new DefaultVmPromptDeliveryAdapter(envWithTarget());

    const result = await adapter.reconcile(input(false));

    expect(result).toMatchObject({
      kind: 'ambiguous',
      reason: 'lost_response',
      receipt: protocolFixture.ambiguousReceipt,
    });
  });

  it('treats changed or unproven runtime receipt absence as terminal ambiguity', async () => {
    const changedRuntime = {
      ...protocolFixture.capabilities,
      runtimeIdentity: 'runtime-vm-02',
    };
    const claim = input(false);
    claim.claim.message.runtimeIdentity = 'runtime-vm-01';
    mocks.nodeAgentRequest.mockResolvedValueOnce(changedRuntime);
    const adapter = new DefaultVmPromptDeliveryAdapter(envWithTarget());

    const changed = await adapter.reconcile(claim);
    expect(changed).toMatchObject({ kind: 'ambiguous', reason: 'runtime_changed' });

    vi.clearAllMocks();
    mocks.nodeAgentRequest
      .mockResolvedValueOnce(protocolFixture.capabilities)
      .mockRejectedValueOnce(
        new mocks.NodeAgentHttpError(
          404,
          JSON.stringify({
            ...protocolFixture.notFoundReceipt,
            runtimeIdentity: 'runtime-vm-02',
          })
        )
      );
    const unproven = await adapter.reconcile(input(false));
    expect(unproven).toMatchObject({ kind: 'ambiguous', reason: 'receipt_unavailable' });
  });
});
