import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  secrets: vi.fn(),
  proxy: vi.fn(),
  identity: vi.fn(),
  sign: vi.fn(),
}));
vi.mock('../../../src/services/workload-identity-context', () => ({
  getWorkloadIdentityMetadata: mocks.identity,
}));
vi.mock('../../../src/services/workload-identity-token', async () => ({
  ...(await vi.importActual<typeof import('../../../src/services/workload-identity-token')>(
    '../../../src/services/workload-identity-token'
  )),
  signWorkloadIdentityToken: mocks.sign,
}));
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
  chatSessionId: 'chat',
  taskId: 'task',
  workspaceId: 'ws',
  agentSessionId: 'session',
  projectId: 'project',
  userId: 'user',
  createdAt: 'now',
};
const env = { DATABASE: {}, ENCRYPTION_KEY: 'key' } as unknown as Env;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockResolvedValue({ claims: { project_id: 'project' } });
  mocks.sign.mockResolvedValue('private-oidc-canary');
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
describe('secret execution MCP authorization and contract', () => {
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
    { argv: ['true'], secretNames: ['BASH_ENV'] },
    { argv: ['true'], secretNames: [], env: { ENV: 'synthetic' } },
    ...['UID', 'EUID', 'PPID', 'SHELLOPTS', 'BASHOPTS', 'BASH_VERSINFO'].flatMap((name) => [
      { argv: ['true'], secretNames: [name] },
      { argv: ['true'], secretNames: [], env: { [name]: 'synthetic' } },
    ]),
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

describe('OIDC execution injection', () => {
  it('injects privately, permits no stored secrets and keeps retries stable while audience changes conflict', async () => {
    mocks.secrets.mockImplementation(async () => ({ envVars: [] }));
    const args = {
      argv: ['true'],
      secretNames: [],
      oidc: { audience: 'vault' },
      idempotencyKey: 'oidc-retry',
    };
    await handleSecretExec(1, args, token, env, 'start');
    mocks.sign.mockResolvedValueOnce('different-fresh-jwt');
    await handleSecretExec(2, args, token, env, 'start');
    await handleSecretExec(3, { ...args, oidc: { audience: 'other' } }, token, env, 'start');
    const calls = mocks.proxy.mock.calls.slice(-3);
    expect(calls[0]![4]).toMatchObject({
      secretNames: ['SAM_OIDC_TOKEN'],
      managedEnv: [{ key: 'SAM_OIDC_TOKEN', value: 'private-oidc-canary', isSecret: true }],
    });
    expect(calls[0]![4].fingerprint).toBe(calls[1]![4].fingerprint);
    expect(calls[0]![4].fingerprint).not.toBe(calls[2]![4].fingerprint);
    expect(calls[0]![3]).toBe(calls[2]![3]);
  });
  it.each([
    { env: { SAM_OIDC_TOKEN: 'override' } },
    { secretNames: ['SAM_OIDC_TOKEN'] },
    { oidc: { audience: 'workspace-terminal' } },
    { oidc: { audience: 'vault', user_id: 'other' } },
  ])('rejects reserved token overrides and caller claims', async (extra) => {
    mocks.proxy.mockClear();
    const response = await handleSecretExec(
      1,
      { argv: ['true'], secretNames: [], ...extra },
      token,
      env,
      'start'
    );
    expect(response.error).toBeDefined();
    expect(mocks.proxy).not.toHaveBeenCalled();
  });
  it('rejects a managed-env collision before signing', async () => {
    mocks.sign.mockClear();
    mocks.secrets.mockResolvedValueOnce({
      envVars: [{ key: 'SAM_OIDC_TOKEN', value: 'stored', isSecret: true }],
    });
    const response = await handleSecretExec(
      1,
      { argv: ['true'], secretNames: [], oidc: { audience: 'vault' } },
      token,
      env,
      'start'
    );
    expect(response.error).toBeDefined();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
