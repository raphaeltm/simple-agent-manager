import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const { getPlatformCloudCredentialMock, getTokenUsageMock } = vi.hoisted(() => ({
  getPlatformCloudCredentialMock: vi.fn(),
  getTokenUsageMock: vi.fn(),
}));

vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformCloudCredential: getPlatformCloudCredentialMock,
}));

vi.mock('../../../src/services/ai-token-budget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/ai-token-budget')>();
  return {
    ...actual,
    getTokenUsage: getTokenUsageMock,
  };
});

const { getPlatformOpencodeAvailability, getTrialStatus } =
  await import('../../../src/services/platform-trial');

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENCRYPTION_KEY: 'test-encryption-key',
    DATABASE: {} as D1Database,
    KV: {} as KVNamespace,
    ...overrides,
  } as Env;
}

describe('getPlatformOpencodeAvailability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is available when platform infra credential decrypts and AI proxy is enabled', async () => {
    getPlatformCloudCredentialMock.mockResolvedValue({
      decryptedToken: 'cloud-token',
      provider: 'scaleway',
    });

    await expect(getPlatformOpencodeAvailability({} as never, makeEnv())).resolves.toEqual({
      available: true,
      hasInfraCredential: true,
      hasAgentCredential: true,
    });
  });

  it('is unavailable when no platform infra credential exists', async () => {
    getPlatformCloudCredentialMock.mockResolvedValue(null);

    await expect(getPlatformOpencodeAvailability({} as never, makeEnv())).resolves.toEqual({
      available: false,
      hasInfraCredential: false,
      hasAgentCredential: true,
    });
  });

  it('is unavailable when the AI proxy is disabled', async () => {
    getPlatformCloudCredentialMock.mockResolvedValue({
      decryptedToken: 'cloud-token',
      provider: 'scaleway',
    });

    await expect(
      getPlatformOpencodeAvailability({} as never, makeEnv({ AI_PROXY_ENABLED: 'false' }))
    ).resolves.toEqual({
      available: false,
      hasInfraCredential: true,
      hasAgentCredential: false,
    });
  });

  it('fails closed when the platform infra credential cannot be decrypted', async () => {
    getPlatformCloudCredentialMock.mockRejectedValue(
      new DOMException('decrypt failed', 'OperationError')
    );

    await expect(getPlatformOpencodeAvailability({} as never, makeEnv())).resolves.toEqual({
      available: false,
      hasInfraCredential: false,
      hasAgentCredential: true,
    });
  });

  it('propagates non-DOM credential lookup errors', async () => {
    getPlatformCloudCredentialMock.mockRejectedValue(new Error('database unavailable'));

    await expect(getPlatformOpencodeAvailability({} as never, makeEnv())).rejects.toThrow(
      'database unavailable'
    );
  });
});

describe('getTrialStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no budget or usage when platform OpenCode is unavailable', async () => {
    getPlatformCloudCredentialMock.mockResolvedValue(null);

    await expect(getTrialStatus({} as never, 'user-1', makeEnv())).resolves.toEqual({
      available: false,
      agentType: null,
      hasInfraCredential: false,
      hasAgentCredential: true,
      dailyTokenBudget: null,
      dailyTokenUsage: null,
    });
    expect(getTokenUsageMock).not.toHaveBeenCalled();
  });

  it('uses shared daily token defaults and propagates current usage', async () => {
    getPlatformCloudCredentialMock.mockResolvedValue({
      decryptedToken: 'cloud-token',
      provider: 'scaleway',
    });
    getTokenUsageMock.mockResolvedValue({ inputTokens: 123, outputTokens: 45 });
    const env = makeEnv();

    await expect(getTrialStatus({} as never, 'user-1', env)).resolves.toEqual({
      available: true,
      agentType: 'opencode',
      hasInfraCredential: true,
      hasAgentCredential: true,
      dailyTokenBudget: { input: 500_000, output: 200_000 },
      dailyTokenUsage: { input: 123, output: 45 },
    });
    expect(getTokenUsageMock).toHaveBeenCalledWith(env.KV, 'user-1', env);
  });

  it('uses configured daily token limits when they are valid positive integers', async () => {
    getPlatformCloudCredentialMock.mockResolvedValue({
      decryptedToken: 'cloud-token',
      provider: 'scaleway',
    });
    getTokenUsageMock.mockResolvedValue({ inputTokens: 0, outputTokens: 0 });

    await expect(
      getTrialStatus(
        {} as never,
        'user-1',
        makeEnv({
          AI_PROXY_DAILY_INPUT_TOKEN_LIMIT: '250000',
          AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT: '100000',
        })
      )
    ).resolves.toMatchObject({
      dailyTokenBudget: { input: 250_000, output: 100_000 },
    });
  });

  it.each([
    ['invalid', 'abc'],
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-1'],
  ])('rejects %s configured daily input token limit', async (_name, value) => {
    getPlatformCloudCredentialMock.mockResolvedValue({
      decryptedToken: 'cloud-token',
      provider: 'scaleway',
    });
    getTokenUsageMock.mockResolvedValue({ inputTokens: 0, outputTokens: 0 });

    await expect(
      getTrialStatus({} as never, 'user-1', makeEnv({ AI_PROXY_DAILY_INPUT_TOKEN_LIMIT: value }))
    ).rejects.toThrow('AI_PROXY_DAILY_INPUT_TOKEN_LIMIT must be a positive integer');
  });

  it('rejects invalid configured daily output token limit', async () => {
    getPlatformCloudCredentialMock.mockResolvedValue({
      decryptedToken: 'cloud-token',
      provider: 'scaleway',
    });
    getTokenUsageMock.mockResolvedValue({ inputTokens: 0, outputTokens: 0 });

    await expect(
      getTrialStatus({} as never, 'user-1', makeEnv({ AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT: 'nope' }))
    ).rejects.toThrow('AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT must be a positive integer');
  });
});
