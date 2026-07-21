import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behavioral coverage for the cf-container create-workspace timeout plumbing.
 *
 * Regression context (2026-07-18 instant-container outage): the standalone
 * vm-agent clones the repository synchronously inside POST /workspaces, so the
 * control-plane request must run under the configurable cf-container create
 * budget. These tests prove the `requestTimeoutMs` option actually bounds the
 * container fetch race in both directions (short budget times out, sufficient
 * budget succeeds) and that the interactive 30s default still applies when no
 * override is passed.
 */

const mocks = vi.hoisted(() => ({
  jwt: {
    signNodeManagementToken: vi.fn(),
    signTerminalToken: vi.fn(),
  },
  telemetry: {
    recordNodeRoutingMetric: vi.fn(),
  },
  container: {
    fetchVmAgentContainer: vi.fn(),
    getVmAgentContainerConfig: vi.fn(),
    markVmAgentContainerActiveWorkEndedBestEffort: vi.fn(),
    markVmAgentContainerActiveWorkStarted: vi.fn(),
    markVmAgentContainerRequestInterrupted: vi.fn(),
  },
  drizzle: vi.fn(),
}));

vi.mock('../../../src/services/jwt', () => mocks.jwt);
vi.mock('../../../src/services/telemetry', () => mocks.telemetry);
vi.mock('../../../src/services/vm-agent-container', () => mocks.container);
vi.mock('drizzle-orm/d1', () => ({ drizzle: mocks.drizzle }));

import {
  createWorkspaceOnNode,
  getCfContainerCreateWorkspaceTimeoutMs,
  NodeAgentRequestError,
  sendPromptToAgentOnNode,
} from '../../../src/services/node-agent';

const cfContainerEnv = {
  BASE_DOMAIN: 'example.com',
  CF_CONTAINER_ENABLED: 'true',
  VM_AGENT_CONTAINER: {},
  DATABASE: { prepare: () => ({}) },
} as never;

const workspacePayload = {
  workspaceId: 'ws-1',
  repository: 'owner/repo',
  branch: 'main',
  callbackToken: 'callback-token',
  lightweight: true,
};

function pendingResponse(delayMs: number): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(new Response('{"workspaceId":"ws-1"}', { status: 200 })), delayMs);
  });
}

describe('getCfContainerCreateWorkspaceTimeoutMs', () => {
  it('defaults to 120s and honors env overrides with safe fallbacks', () => {
    expect(getCfContainerCreateWorkspaceTimeoutMs({})).toBe(120_000);
    expect(
      getCfContainerCreateWorkspaceTimeoutMs({ CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS: '45000' })
    ).toBe(45_000);
    expect(
      getCfContainerCreateWorkspaceTimeoutMs({ CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS: '0' })
    ).toBe(120_000);
    expect(
      getCfContainerCreateWorkspaceTimeoutMs({ CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS: 'nope' })
    ).toBe(120_000);
  });
});

describe('createWorkspaceOnNode cf-container timeout plumbing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.jwt.signNodeManagementToken.mockResolvedValue({ token: 'mgmt-token' });
    mocks.container.getVmAgentContainerConfig.mockReturnValue({
      enabled: true,
      vmAgentPort: 8080,
      sleepAfter: '10m',
    });
    mocks.container.markVmAgentContainerRequestInterrupted.mockResolvedValue(null);
    mocks.drizzle.mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            get: () => Promise.resolve({ runtime: 'cf-container' }),
          }),
        }),
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('times out with the provided budget when the container request stalls', async () => {
    mocks.container.fetchVmAgentContainer.mockImplementation(() => pendingResponse(60_000));

    const createPromise = createWorkspaceOnNode(
      'node-1',
      cfContainerEnv,
      'user-1',
      workspacePayload,
      {
        requestTimeoutMs: 50,
      }
    );
    const rejection = expect(createPromise).rejects.toThrow('Request timed out after 50ms');
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
  });

  it('completes when the container responds within the provided budget', async () => {
    mocks.container.fetchVmAgentContainer.mockImplementation(() => pendingResponse(40_000));

    const createPromise = createWorkspaceOnNode(
      'node-1',
      cfContainerEnv,
      'user-1',
      workspacePayload,
      {
        requestTimeoutMs: 120_000,
      }
    );
    await vi.advanceTimersByTimeAsync(40_500);
    await expect(createPromise).resolves.toEqual({ workspaceId: 'ws-1' });
  });

  it('keeps the interactive 30s default when no override is provided', async () => {
    mocks.container.fetchVmAgentContainer.mockImplementation(() => pendingResponse(60_000));

    const createPromise = createWorkspaceOnNode(
      'node-1',
      cfContainerEnv,
      'user-1',
      workspacePayload
    );
    const rejection = expect(createPromise).rejects.toThrow('Request timed out after 30000ms');
    await vi.advanceTimersByTimeAsync(30_100);
    await rejection;
  });
  it('classifies a timed-out prompt before returning and never replays it', async () => {
    mocks.container.fetchVmAgentContainer.mockImplementation(() => pendingResponse(60_000));
    mocks.container.markVmAgentContainerRequestInterrupted.mockResolvedValue({
      ok: false,
      status: 'recovering',
      code: 'RUNTIME_REQUEST_INTERRUPTED',
      message: 'internal transport detail: bearer should-not-leak',
    });

    const promptPromise = sendPromptToAgentOnNode(
      'node-1',
      'ws-1',
      'agent-1',
      'continue',
      cfContainerEnv,
      'user-1',
      'message-1',
      { requestTimeoutMs: 50 }
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(60);
    const error = await promptPromise;

    expect(error).toBeInstanceOf(NodeAgentRequestError);
    expect(error).toMatchObject({
      statusCode: 409,
      error: 'RUNTIME_REQUEST_INTERRUPTED',
      message: expect.stringContaining('execution outcome is unknown'),
    });
    expect(mocks.container.fetchVmAgentContainer).toHaveBeenCalledTimes(1);
    expect(mocks.container.markVmAgentContainerRequestInterrupted).toHaveBeenCalledWith(
      cfContainerEnv,
      'node-1',
      { method: 'POST', errorName: 'request_timeout' }
    );
  });

  it('preserves a stable interruption response returned directly by the Durable Object', async () => {
    mocks.container.fetchVmAgentContainer.mockResolvedValue(
      Response.json(
        {
          error: 'RUNTIME_REQUEST_INTERRUPTED',
          message: 'internal transport detail: bearer should-not-leak',
        },
        { status: 500 }
      )
    );

    const error = await sendPromptToAgentOnNode(
      'node-1',
      'ws-1',
      'agent-1',
      'continue',
      cfContainerEnv,
      'user-1'
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(NodeAgentRequestError);
    expect(error).toMatchObject({
      statusCode: 409,
      error: 'RUNTIME_REQUEST_INTERRUPTED',
      message: expect.stringContaining('execution outcome is unknown'),
    });
    expect(error.message).not.toContain('bearer should-not-leak');
    expect(mocks.container.fetchVmAgentContainer).toHaveBeenCalledTimes(1);
    expect(mocks.container.markVmAgentContainerRequestInterrupted).not.toHaveBeenCalled();
  });
});
