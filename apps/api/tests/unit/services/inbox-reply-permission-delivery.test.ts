import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({ answer: vi.fn(), probe: vi.fn(), send: vi.fn() }));
vi.mock('../../../src/routes/chat-acp-interactions', () => ({
  answerAgentInteraction: edge.answer,
}));
vi.mock('../../../src/services/node-agent', () => ({
  nodeAgentRequest: edge.probe,
  sendPromptToAgentOnNode: edge.send,
  NodeAgentHttpError: class extends Error {},
}));
vi.mock('../../../src/services/project-data', () => ({ wakeSession: vi.fn() }));

import type { Env } from '../../../src/env';
import {
  DefaultVmPromptDeliveryAdapter,
  type VmPromptDeliveryAdapterInput,
} from '../../../src/services/vm-prompt-delivery-adapter';

const protocol = JSON.parse(
  readFileSync(
    new URL('../../../../../tests/fixtures/durable-execution-protocol-v1.json', import.meta.url),
    'utf8'
  )
);
const permission = {
  interactionId: '11111111-1111-4111-8111-111111111111',
  answer: {
    answerKey: 'stable-rejection-key',
    decision: {
      kind: 'selected_option',
      optionId: 'reject-once',
      answerHash: 'a'.repeat(64),
    },
  },
};

function harness() {
  const first = vi.fn().mockResolvedValue({
    workspace_id: 'workspace-1',
    user_id: 'user-1',
    workspace_status: 'running',
    node_id: 'node-1',
    node_status: 'running',
    node_health_status: 'healthy',
    agent_version: 'v1',
    node_runtime: 'vm',
    agent_session_id: 'acp-1',
    agent_session_status: 'running',
    agent_session_updated_at: '2026-11-20T00:00:00Z',
    snapshot_sleep_status: null,
    snapshot_runtime: null,
  });
  const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first })) }));
  const env = { DATABASE: { prepare } } as unknown as Env;
  const input: VmPromptDeliveryAdapterInput = {
    projectId: 'project-1',
    allowLegacyVm: false,
    requestTimeoutMs: 1234,
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
        content: 'Here is why I declined',
        metadata: { inboxReplyPermission: permission },
        sourceKind: 'inbox_reply',
        ackRequired: false,
        ackTimeoutMs: null,
        deliveryAttempts: 1,
        lastDeliveryAt: 1,
        expiresAt: 99,
        createdAt: 1,
        deliveredAt: null,
        ackedAt: null,
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
  return { prepare, input, env, adapter: new DefaultVmPromptDeliveryAdapter(env) };
}

beforeEach(() => {
  vi.clearAllMocks();
  edge.answer.mockReset().mockResolvedValue({ accepted: true, state: 'answered' });
  edge.probe.mockResolvedValue(protocol.capabilities);
  edge.send.mockResolvedValue({
    ...protocol.newPrompt,
    sessionId: 'acp-1',
    receipt: { ...protocol.newPrompt.receipt, deliveryId: 'delivery-1' },
  });
});

describe('permission rejection owned by a durable inbox reply', () => {
  it('retries before resolving or sending, replays the same answer key, then delivers after acceptance', async () => {
    const { adapter, input, prepare, env } = harness();
    edge.answer.mockRejectedValueOnce(new Error('private upstream payload'));
    const failed = await adapter.submit(input);
    expect(failed).toMatchObject({ kind: 'retry', reason: 'not_ready' });
    expect(JSON.stringify(failed)).not.toContain('private upstream payload');
    expect(prepare).not.toHaveBeenCalled();
    expect(edge.probe).not.toHaveBeenCalled();
    expect(edge.send).not.toHaveBeenCalled();
    expect(await adapter.submit(input)).toMatchObject({ kind: 'accepted' });
    expect(edge.answer).toHaveBeenCalledTimes(2);
    for (const call of edge.answer.mock.calls)
      expect(call).toEqual([
        env,
        'user-1',
        'project-1',
        'chat-1',
        permission.interactionId,
        permission.answer,
      ]);
    expect(prepare).toHaveBeenCalled();
    expect(edge.send).toHaveBeenCalledOnce();
    expect(edge.answer.mock.invocationCallOrder[1]).toBeLessThan(
      edge.send.mock.invocationCallOrder[0]!
    );
  });

  it('withholds permission rejection and send when the side-effect fence refuses', async () => {
    const { adapter, input, prepare } = harness();
    input.beforeSideEffect = vi
      .fn()
      .mockResolvedValue({
        kind: 'retry',
        reason: 'not_ready',
        error: 'Authority changed',
        runtimeIdentity: null,
        capabilities: null,
      });
    expect(await adapter.submit(input)).toMatchObject({
      kind: 'retry',
      error: 'Authority changed',
    });
    expect(input.beforeSideEffect).toHaveBeenCalledOnce();
    expect(edge.answer).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(edge.send).not.toHaveBeenCalled();
  });

  it('ignores permission-shaped metadata on an ordinary chat message and still sends it', async () => {
    const { adapter, input } = harness();
    input.claim.message.sourceKind = 'user_followup';
    expect(await adapter.submit(input)).toMatchObject({ kind: 'accepted' });
    expect(edge.answer).not.toHaveBeenCalled();
    expect(edge.send).toHaveBeenCalledOnce();
  });

  it.each(['agent_sender', 'malformed_answer'])(
    'fails closed for %s without resolving a target',
    async (variant) => {
      const { adapter, input, prepare } = harness();
      if (variant === 'agent_sender') input.claim.message.senderType = 'agent';
      else
        input.claim.message.metadata = {
          inboxReplyPermission: { interactionId: permission.interactionId },
        };
      expect(await adapter.submit(input)).toMatchObject({ kind: 'retry', reason: 'not_ready' });
      expect(edge.answer).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(edge.send).not.toHaveBeenCalled();
    }
  );
});
