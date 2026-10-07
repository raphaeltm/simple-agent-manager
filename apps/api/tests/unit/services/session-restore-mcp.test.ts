import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { buildAcpInteractionRuntimeConfig } from '../../../src/services/acp-interaction-runtime-config';
import type { SessionRuntimeContract } from '../../../src/services/session-runtime-contract';
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  store: vi.fn(),
  revoke: vi.fn(),
  servers: vi.fn(),
}));
vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: mocks.generate,
  storeMcpToken: mocks.store,
  revokeMcpToken: mocks.revoke,
}));
vi.mock('../../../src/services/mcp-connection-resolution', () => ({
  buildSessionMcpServers: mocks.servers,
}));
import { prepareSessionRestoreMcp } from '../../../src/services/session-restore-mcp';
const env = {
  KV: { put: vi.fn(), delete: vi.fn() },
  DATABASE: {},
  BASE_DOMAIN: 'example.test',
  ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
} as unknown as Env;
function input(mode: 'task' | 'conversation', withTask = true) {
  const runtimeContract: SessionRuntimeContract = {
    version: 1,
    agentType: 'codex',
    settingsResolved: true,
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    permissionMode: 'default',
    opencodeProvider: null,
    opencodeBaseUrl: null,
    promptKind: mode,
    taskContext: withTask
      ? { projectId: 'project-1', taskId: 'original-task', taskMode: mode }
      : null,
    acpInteractions: buildAcpInteractionRuntimeConfig(env, mode),
  };
  return {
    userId: 'user-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    chatSessionId: 'chat-1',
    agentSessionId: 'agent-1',
    runtimeContract,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.generate.mockReturnValue('fresh-scoped-token');
  mocks.store.mockResolvedValue(undefined);
  mocks.revoke.mockResolvedValue(undefined);
  mocks.servers.mockResolvedValue([
    { name: 'sam-mcp', url: 'https://api.example.test/mcp', token: 'fresh-scoped-token' },
    {
      name: 'current-project-server',
      url: 'https://project.example.test/mcp',
      token: 'project-token',
    },
  ]);
});
describe('fresh MCP bootstrap for restored session', () => {
  it.each(['task', 'conversation'] as const)(
    'stores original %s scope and resolves current MCP server policy',
    async (mode) => {
      const prepared = await prepareSessionRestoreMcp(env, input(mode));
      expect(mocks.store).toHaveBeenCalledWith(
        env.KV,
        'fresh-scoped-token',
        expect.objectContaining({
          taskId: 'original-task',
          taskMode: mode,
          contextType: mode,
          userId: 'user-1',
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          chatSessionId: 'chat-1',
          agentSessionId: 'agent-1',
        }),
        env
      );
      expect(mocks.servers).toHaveBeenCalledWith(
        expect.anything(),
        { baseDomain: 'example.test', encryptionKey: env.ENCRYPTION_KEY },
        { userId: 'user-1', projectId: 'project-1' },
        'fresh-scoped-token'
      );
      expect(prepared.mcpServers).toEqual(await mocks.servers.mock.results[0]?.value);
      expect(mocks.revoke).not.toHaveBeenCalled();
      await prepared.revoke();
      expect(mocks.revoke).toHaveBeenCalledWith(env.KV, 'fresh-scoped-token');
    }
  );
  it('scopes a chat without a task rather than inventing task identity', async () => {
    await prepareSessionRestoreMcp(env, input('conversation', false));
    expect(mocks.store).toHaveBeenCalledWith(
      env.KV,
      'fresh-scoped-token',
      expect.objectContaining({
        taskId: '',
        taskMode: 'conversation',
        contextType: 'conversation',
      }),
      env
    );
  });
  it('rejects a task contract from a different project before minting credentials', async () => {
    const foreign = input('task');
    foreign.runtimeContract.taskContext!.projectId = 'other-project';
    await expect(prepareSessionRestoreMcp(env, foreign)).rejects.toThrow('project mismatch');
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.servers).not.toHaveBeenCalled();
  });
  it('revokes minted token if current MCP policy resolution fails', async () => {
    mocks.servers.mockRejectedValueOnce(new Error('policy read failed'));
    await expect(prepareSessionRestoreMcp(env, input('task'))).rejects.toThrow(
      'policy read failed'
    );
    expect(mocks.revoke).toHaveBeenCalledWith(env.KV, 'fresh-scoped-token');
  });
  it('revokes minted token if scoped token persistence fails', async () => {
    mocks.store.mockRejectedValueOnce(new Error('KV failed'));
    await expect(prepareSessionRestoreMcp(env, input('task'))).rejects.toThrow('KV failed');
    expect(mocks.revoke).toHaveBeenCalledWith(env.KV, 'fresh-scoped-token');
    expect(mocks.servers).not.toHaveBeenCalled();
  });
});
