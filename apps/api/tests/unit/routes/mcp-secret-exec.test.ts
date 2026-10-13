import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ context: vi.fn(), secrets: vi.fn(), proxy: vi.fn() }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('../../../src/services/workspace-runtime-assets', () => ({
  resolveWorkspaceRuntimeAssetContext: mocks.context,
  getSecretExecutionEnv: mocks.secrets,
}));
vi.mock('../../../src/routes/mcp/workspace-tools', () => ({ proxySecretExecOnVm: mocks.proxy }));
import type { Env } from '../../../src/env';
import { handleSecretExec } from '../../../src/routes/mcp/secret-exec-tools';
import type { McpTokenData } from '../../../src/services/mcp-token';

const token: McpTokenData = {
  taskId: 'task',
  workspaceId: 'ws',
  agentSessionId: 'session',
  projectId: 'project',
  userId: 'user',
  createdAt: 'now',
};
const env = { DATABASE: {}, ENCRYPTION_KEY: 'key' } as unknown as Env;
describe('secret execution MCP authorization and contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ userId: 'user', projectId: 'project' });
    mocks.secrets.mockResolvedValue({
      envVars: [{ key: 'SENTINEL', value: 'synthetic', isSecret: true }],
    });
    mocks.proxy.mockResolvedValue({
      jobId: 'job',
      status: 'running',
      stdout: '',
      stderr: '',
      exitCode: -1,
      timedOut: false,
      redacted: false,
      truncated: false,
      execution: {
        containerId: 'container',
        user: 'node',
        cwd: '/workspaces/repo',
        environmentMode: 'placeholder',
      },
    });
  });
  it('forwards selected env privately with a stable idempotent job identity', async () => {
    const args = {
      argv: ['printf', '%s', 'literal $HOME'],
      secretNames: ['SENTINEL'],
      idempotencyKey: 'retry',
    };
    await handleSecretExec(1, args, token, env, 'start');
    await handleSecretExec(2, args, token, env, 'start');
    expect(mocks.proxy).toHaveBeenCalledTimes(2);
    const first = mocks.proxy.mock.calls[0]!;
    const second = mocks.proxy.mock.calls[1]!;
    expect(first[3]).toEqual(second[3]);
    expect(first[4]).toMatchObject({
      argv: args.argv,
      agentSessionId: 'session',
      managedEnv: [{ key: 'SENTINEL', value: 'synthetic', isSecret: true }],
    });
  });
  it.each([
    { argv: ['true'], command: 'true', shell: 'sh', secretNames: [] },
    { command: 'true', secretNames: [] },
    { argv: ['true'], shell: 'sh', secretNames: [] },
    { argv: ['true'], secretNames: [], containerId: 'other' },
    { argv: ['true'], secretNames: [], cwd: 'relative' },
    { argv: ['true'], secretNames: [], env: { BAD: '\0' } },
  ])('rejects malformed or caller-selected execution scope', async (args) => {
    const response = await handleSecretExec(1, args, token, env, 'start');
    expect(response.error?.code).toBe(-32602);
    expect(mocks.secrets).not.toHaveBeenCalled();
    expect(mocks.proxy).not.toHaveBeenCalled();
  });
  it('denies cross-project context before decrypting', async () => {
    mocks.context.mockResolvedValue({ userId: 'user', projectId: 'other' });
    const response = await handleSecretExec(
      1,
      { argv: ['true'], secretNames: ['SENTINEL'] },
      token,
      env,
      'start'
    );
    expect(response.error).toBeDefined();
    expect(mocks.secrets).not.toHaveBeenCalled();
    expect(mocks.proxy).not.toHaveBeenCalled();
  });
  it('does not allow overriding a managed secret through env', async () => {
    const response = await handleSecretExec(
      1,
      { argv: ['true'], secretNames: [], env: { SENTINEL: 'replacement' } },
      token,
      env,
      'start'
    );
    expect(response.error?.code).toBe(-32602);
    expect(mocks.proxy).not.toHaveBeenCalled();
  });
  it('never echoes upstream error bodies or decrypted values', async () => {
    mocks.proxy.mockRejectedValue(new Error('synthetic-private-body'));
    const response = await handleSecretExec(
      1,
      { argv: ['true'], secretNames: ['SENTINEL'] },
      token,
      env,
      'start'
    );
    expect(response.error).toBeDefined();
    expect(JSON.stringify(response)).not.toContain('synthetic-private-body');
  });
  it('status and cancel remain session scoped and do not resolve secrets', async () => {
    const jobId = `sx-${'a'.repeat(64)}`;
    await handleSecretExec(1, { jobId }, token, env, 'status');
    await handleSecretExec(2, { jobId }, token, env, 'cancel');
    expect(mocks.secrets).not.toHaveBeenCalled();
    expect(mocks.proxy).toHaveBeenCalledWith(env, token, 'cancel', jobId);
  });
});
