import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { buildAcpInteractionRuntimeConfig } from '../../../src/services/acp-interaction-runtime-config';
import type { SessionRuntimeContract } from '../../../src/services/session-runtime-contract';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../src/services/node-agent', () => ({
  nodeAgentRequest: request,
  getNodeAgentBackgroundRequestTimeoutMs: () => 90000,
}));
import { restoreAgentSessionOnNode } from '../../../src/services/node-agent-session-snapshots';

const env = { SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS: '45678' } as Env;
const contract: SessionRuntimeContract = {
  version: 1,
  agentType: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'xhigh',
  permissionMode: 'default',
  opencodeProvider: null,
  opencodeBaseUrl: null,
  settingsResolved: true,
  acpInteractions: buildAcpInteractionRuntimeConfig(env, 'task'),
  promptKind: 'task',
  taskContext: { projectId: 'project-1', taskId: 'task-1', taskMode: 'task' },
};
const input = {
  chatSessionId: 'chat-1',
  runtime: 'vm',
  agentType: 'codex',
  runtimeContract: contract,
};
beforeEach(() => request.mockReset());

describe('snapshot restore checks runtime contract capability before mutation', () => {
  it('uses authenticated bounded capability GET, then forwards contract and guarded options on POST', async () => {
    request
      .mockResolvedValueOnce({ sessionRuntimeContract: { supported: true, version: 1 } })
      .mockResolvedValueOnce({ status: 'restored' });
    const beforeExternalMutation = vi.fn(async () => undefined);
    const sourceTaskGuard = { taskId: 'task-1', projectId: 'project-1', chatSessionId: 'chat-1' };
    const result = await restoreAgentSessionOnNode(
      'node-1',
      'workspace-1',
      'agent-1',
      env,
      'user-1',
      input,
      { beforeExternalMutation, sourceTaskGuard }
    );
    expect(result).toEqual({ status: 'restored' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual([
      'node-1',
      env,
      '/workspaces/workspace-1/agent-capabilities',
      expect.objectContaining({
        method: 'GET',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        noWakeContainer: true,
        sourceTaskGuard,
        recoverContainerOnTimeout: false,
        requestTimeoutMs: 45678,
      }),
    ]);
    expect(request.mock.calls[1]).toEqual([
      'node-1',
      env,
      '/workspaces/workspace-1/agent-sessions/agent-1/restore',
      expect.objectContaining({
        method: 'POST',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        requestTimeoutMs: 45678,
        sourceTaskGuard,
        beforeExternalMutation,
        body: JSON.stringify(input),
      }),
    ]);
  });
  it('retains compatibility for legacy callers without a runtime contract', async () => {
    request.mockResolvedValueOnce({ status: 'restored' });
    const legacy = { chatSessionId: 'chat-legacy', runtime: 'vm', agentType: 'codex' };
    await restoreAgentSessionOnNode('node-1', 'workspace-1', 'agent-1', env, 'user-1', legacy);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[2]).toBe(
      '/workspaces/workspace-1/agent-sessions/agent-1/restore'
    );
    expect(request.mock.calls[0]?.[3]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(legacy),
    });
  });
  it('fails before restore if the capability transport fails', async () => {
    request.mockRejectedValueOnce(new Error('unreachable runtime'));
    await expect(
      restoreAgentSessionOnNode('node-1', 'workspace-1', 'agent-1', env, 'user-1', input)
    ).rejects.toThrow('unreachable runtime');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[3]).toMatchObject({ method: 'GET' });
  });
  it.each([
    ['missing', {}],
    ['malformed', { sessionRuntimeContract: 'yes' }],
    ['future', { sessionRuntimeContract: { supported: true, version: 2 } }],
    ['disabled', { sessionRuntimeContract: { supported: false, version: 1 } }],
  ])('refuses %s capability before any restore POST', async (_name, payload) => {
    request.mockResolvedValueOnce(payload);
    await expect(
      restoreAgentSessionOnNode('node-1', 'workspace-1', 'agent-1', env, 'user-1', input)
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[3]).toMatchObject({
      method: 'GET',
      noWakeContainer: true,
      recoverContainerOnTimeout: false,
    });
  });
});
