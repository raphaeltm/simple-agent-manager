import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { VmPromptDeliveryAdapterInput } from '../../../src/services/vm-prompt-delivery-adapter';
import {
  reconcileSteerDelivery,
  submitSteerDelivery,
} from '../../../src/services/vm-steer-delivery-adapter';

const mocks = vi.hoisted(() => ({
  nodeAgentRequest: vi.fn(),
  ensureSessionRecovery: vi.fn(),
  reportSessionRecoveryRefusal: vi.fn(),
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
  sendPromptToAgentOnNode: vi.fn(),
  NodeAgentHttpError: mocks.NodeAgentHttpError,
}));

vi.mock('../../../src/services/session-recovery', () => ({
  ensureSessionRecovery: mocks.ensureSessionRecovery,
  reportSessionRecoveryRefusal: mocks.reportSessionRecoveryRefusal,
}));

// The same fixture the Go VM agent's handler tests pin (cross-boundary contract).
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../tests/fixtures/durable-execution-protocol-v1.json', import.meta.url),
    'utf8'
  )
) as {
  capabilities: Record<string, unknown> & { runtimeIdentity: string };
  injectedSteer: { receipt: { promptEpoch: number } } & Record<string, unknown>;
  notConsumedSteer: Record<string, unknown>;
  ambiguousSteer: Record<string, unknown>;
};

const runningRow = {
  workspace_id: 'workspace-01',
  user_id: 'user-1',
  workspace_status: 'running',
  node_id: 'node-1',
  node_status: 'running',
  node_health_status: 'healthy',
  agent_version: 'v1',
  node_runtime: 'vm',
  agent_session_id: 'session-01',
  agent_session_status: 'running',
  agent_session_updated_at: '2026-11-05T00:00:00Z',
  snapshot_sleep_status: null as string | null,
  snapshot_runtime: null as string | null,
};

function envWithTarget(row: Record<string, unknown> | null): Env {
  return {
    DATABASE: {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: vi.fn(async () => row) })) })),
    } as unknown as D1Database,
  } as Env;
}

function steerInput(mode: 'submit' | 'reconcile' = 'submit', beforeSubmit = vi.fn(() => true)) {
  return {
    projectId: 'project-1',
    allowLegacyVm: false,
    requestTimeoutMs: 1_000,
    beforeSubmit,
    claim: {
      attemptId: 'attempt-1',
      mode,
      message: {
        id: 'delivery-01',
        targetSessionId: 'chat-1',
        content: 'use tabs, not spaces',
        promptMessageId: 'transcript-1',
        deliveryIntent: 'steer',
        messageClass: 'deliver',
        runtimeIdentity: null,
      },
    },
  } as unknown as VmPromptDeliveryAdapterInput & { beforeSubmit: ReturnType<typeof vi.fn> };
}

/** Routes the node-agent transport by path, like the real VM agent's mux. */
function vm(handlers: { capabilities?: unknown; steer?: () => unknown; receipt?: () => unknown }) {
  mocks.nodeAgentRequest.mockImplementation(async (_node: string, _env: Env, path: string) => {
    if (path.endsWith('/agent-capabilities')) return handlers.capabilities ?? fixture.capabilities;
    if (path.endsWith('/steer')) return handlers.steer!();
    if (path.includes('/steer-receipts/')) return handlers.receipt!();
    throw new Error(`unexpected path ${path}`);
  });
}

const steerCalls = () =>
  mocks.nodeAgentRequest.mock.calls.filter(([, , path]) => String(path).endsWith('/steer'));

describe('live steer delivery adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('steers a running turn and reports the attached prompt epoch', async () => {
    vm({ steer: () => fixture.injectedSteer });
    const input = steerInput();
    const result = await submitSteerDelivery(envWithTarget(runningRow), input);
    expect(result).toMatchObject({
      kind: 'steered',
      promptEpoch: fixture.injectedSteer.receipt.promptEpoch,
      runtimeIdentity: fixture.capabilities.runtimeIdentity,
    });
    const [, , path, options] = steerCalls()[0]!;
    expect(path).toBe('/workspaces/workspace-01/agent-sessions/session-01/steer');
    expect(options).toMatchObject({ method: 'POST', noWakeContainer: true });
    expect(JSON.parse(options.body)).toEqual({
      protocolVersion: 1,
      deliveryId: 'delivery-01',
      messageId: 'transcript-1',
      prompt: 'use tabs, not spaces',
    });
    expect(input.beforeSubmit).toHaveBeenCalledTimes(1);
    expect(mocks.nodeAgentRequest.mock.calls[0]?.[3]).toMatchObject({
      noWakeContainer: true,
      recoverContainerOnTimeout: false,
    });
  });

  it.each(['submit', 'reconcile'] as const)(
    'never wakes a stopped runtime for a steer %s capability probe',
    async (mode) => {
      mocks.nodeAgentRequest.mockRejectedValue(
        new mocks.NodeAgentHttpError(410, 'RUNTIME_STOPPED')
      );
      const result =
        mode === 'submit'
          ? await submitSteerDelivery(envWithTarget(runningRow), steerInput(mode))
          : await reconcileSteerDelivery(envWithTarget(runningRow), steerInput(mode));
      expect(result.kind).toBe(mode === 'submit' ? 'steer_fallback' : 'ambiguous');
      expect(mocks.nodeAgentRequest).toHaveBeenCalledExactlyOnceWith(
        'node-1',
        expect.anything(),
        '/workspaces/workspace-01/agent-capabilities',
        expect.objectContaining({ noWakeContainer: true, recoverContainerOnTimeout: false })
      );
      expect(steerCalls()).toHaveLength(0);
      expect(mocks.ensureSessionRecovery).not.toHaveBeenCalled();
    }
  );

  it('falls back to the queue when the runtime did not take the steer', async () => {
    vm({ steer: () => fixture.notConsumedSteer });
    expect(await submitSteerDelivery(envWithTarget(runningRow), steerInput())).toMatchObject({
      kind: 'steer_fallback',
      reason: 'no_running_turn',
    });
  });

  it('surfaces an unconfirmed steer as ambiguous', async () => {
    vm({ steer: () => fixture.ambiguousSteer });
    expect(await submitSteerDelivery(envWithTarget(runningRow), steerInput())).toMatchObject({
      kind: 'ambiguous',
      reason: 'runtime_changed',
    });
  });

  it('gives an old VM agent the queue without sending anything', async () => {
    const oldCapabilities: Record<string, unknown> = { ...fixture.capabilities };
    delete oldCapabilities.steering;
    vm({ capabilities: oldCapabilities, steer: () => fixture.injectedSteer });
    const input = steerInput();
    expect(await submitSteerDelivery(envWithTarget(runningRow), input)).toMatchObject({
      kind: 'steer_fallback',
      reason: 'runtime_steering_unsupported',
    });
    expect(steerCalls()).toHaveLength(0);
    expect(input.beforeSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ['an older protocol version', 0],
    ['a newer protocol version', 2],
  ])(
    'gives a VM agent advertising %s the queue without sending anything',
    async (_name, version) => {
      const capabilities = {
        ...fixture.capabilities,
        steering: { ...(fixture.capabilities.steering as Record<string, unknown>), version },
      };
      vm({ capabilities, steer: () => fixture.injectedSteer });
      const input = steerInput();
      expect(await submitSteerDelivery(envWithTarget(runningRow), input)).toMatchObject({
        kind: 'steer_fallback',
        reason: 'runtime_steering_unsupported',
      });
      expect(steerCalls()).toHaveLength(0);
      expect(input.beforeSubmit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['sleeping VM workspace', { ...runningRow, workspace_status: 'sleeping' }],
    [
      'slept Instant container',
      {
        ...runningRow,
        workspace_status: 'sleeping',
        node_runtime: 'cf-container',
        snapshot_sleep_status: 'sleeping',
        snapshot_runtime: 'cf-container',
      },
    ],
    ['missing workspace', null],
  ])('never wakes a %s to steer it', async (_name, row) => {
    vm({ steer: () => fixture.injectedSteer });
    expect(await submitSteerDelivery(envWithTarget(row), steerInput())).toMatchObject({
      kind: 'steer_fallback',
      reason: 'session_not_awake',
    });
    expect(mocks.ensureSessionRecovery).not.toHaveBeenCalled();
    expect(mocks.reportSessionRecoveryRefusal).not.toHaveBeenCalled();
    expect(mocks.nodeAgentRequest).not.toHaveBeenCalled();
  });

  it('rejects a reused delivery id with other content', async () => {
    vm({
      steer: () => {
        throw new mocks.NodeAgentHttpError(
          409,
          JSON.stringify({ ...fixture.injectedSteer, status: 'conflict' })
        );
      },
    });
    expect(await submitSteerDelivery(envWithTarget(runningRow), steerInput())).toMatchObject({
      kind: 'failed',
      reason: 'delivery_conflict',
    });
  });

  it('recovers a lost response from the receipt instead of steering again', async () => {
    vm({
      steer: () => {
        throw new Error('Request timed out after 1000ms');
      },
      receipt: () => fixture.injectedSteer.receipt,
    });
    expect(await submitSteerDelivery(envWithTarget(runningRow), steerInput())).toMatchObject({
      kind: 'steered',
    });
    expect(steerCalls()).toHaveLength(1);
  });

  it('keeps a lost steer pending while the VM has no receipt yet, then lets reconcile decide', async () => {
    const notFound = () => {
      throw new mocks.NodeAgentHttpError(
        404,
        JSON.stringify({
          deliveryId: 'delivery-01',
          state: 'not_found',
          runtimeIdentity: fixture.capabilities.runtimeIdentity,
          acceptedAt: null,
          completedAt: null,
        })
      );
    };
    vm({
      steer: () => {
        throw new Error('connection reset');
      },
      receipt: notFound,
    });
    // The request may still be in transit: concluding "never received" now could
    // let the queue deliver it while the steer also lands.
    expect(await submitSteerDelivery(envWithTarget(runningRow), steerInput())).toMatchObject({
      kind: 'steer_pending',
    });
    expect(
      await reconcileSteerDelivery(envWithTarget(runningRow), steerInput('reconcile'))
    ).toMatchObject({
      kind: 'steer_fallback',
      reason: 'steer_not_recorded',
    });
  });

  it('gives up visibly when a reconcile still finds the steer undecided or unreachable', async () => {
    vm({ receipt: () => ({ ...fixture.injectedSteer.receipt, state: 'in_flight' }) });
    expect(
      await reconcileSteerDelivery(envWithTarget(runningRow), steerInput('reconcile'))
    ).toMatchObject({
      kind: 'ambiguous',
    });
    vm({
      receipt: () => {
        throw new Error('node unreachable');
      },
    });
    expect(
      await reconcileSteerDelivery(envWithTarget(runningRow), steerInput('reconcile'))
    ).toMatchObject({
      kind: 'ambiguous',
      reason: 'receipt_unavailable',
    });
    expect(
      await reconcileSteerDelivery(
        envWithTarget({ ...runningRow, workspace_status: 'sleeping' }),
        steerInput('reconcile')
      )
    ).toMatchObject({ kind: 'ambiguous', reason: 'receipt_unavailable' });
    expect(mocks.ensureSessionRecovery).not.toHaveBeenCalled();
  });
});
