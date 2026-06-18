/**
 * Tests for the get_registry_credentials MCP tool handler.
 *
 * These tests exercise the policy gate, rate limit, minting, and error
 * behavior through the real handler and deployment-control service logic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the registry-credentials service
vi.mock('../../../src/services/registry-credentials', () => ({
  getRegistryCredentialRateLimit: vi.fn(),
  mintProjectRegistryCredential: vi.fn(),
}));

const mockSelect = vi.fn();
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    select: mockSelect,
  })),
}));

import type { Env } from '../../../src/env';
import { handleGetRegistryCredentials } from '../../../src/routes/mcp/registry-credential-tools';
import {
  getRegistryCredentialRateLimit,
  mintProjectRegistryCredential,
} from '../../../src/services/registry-credentials';

const mockGetRateLimit = vi.mocked(getRegistryCredentialRateLimit);
const mockMintCredential = vi.mocked(mintProjectRegistryCredential);

function makeTokenData(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    ...overrides,
  };
}

function makeKV(currentCount: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(currentCount),
    put: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    KV: makeKV(),
    DATABASE: {},
    CF_ACCOUNT_ID: 'acct-123',
    CF_API_TOKEN: 'tok-secret',
    ...overrides,
  } as unknown as Env;
}

function enabledEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'env-1',
    agentDeployEnabled: true,
    agentDeployEnabledBy: 'user-1',
    agentDeployEnabledAt: '2026-06-18T00:00:00.000Z',
    agentDeployDisabledAt: null,
    allowedDeployProfileIdsJson: null,
    ...overrides,
  };
}

function setupDrizzleResults(resultSets: Array<Array<Record<string, unknown>>>) {
  mockSelect.mockImplementation(() => {
    const rows = resultSets.shift() ?? [];
    const limitFn = vi.fn().mockResolvedValue(rows);
    const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    return { from: fromFn };
  });
}

function setupSuccessfulMint() {
  mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });
  mockMintCredential.mockResolvedValue({
    registry: 'registry.cloudflare.com',
    username: 'cf-user',
    password: 'cf-pass',
    namespace: 'acct-123/sam-proj-1',
    expiresAt: '2026-06-18T12:00:00.000Z',
  });
}

describe('handleGetRegistryCredentials', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requires an environment before policy, KV, rate-limit, or minting work', async () => {
    const kv = makeKV();
    const env = makeEnv({ KV: kv });

    const result = await handleGetRegistryCredentials('req-1', {}, makeTokenData(), env);

    expect(result).toHaveProperty('error');
    const error = (result as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(-32602);
    expect(error.message).toContain('deployment environment name is required');
    expect(mockSelect).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(mockGetRateLimit).not.toHaveBeenCalled();
    expect(mockMintCredential).not.toHaveBeenCalled();
  });

  it('denies a disabled environment before KV, rate-limit, or minting work', async () => {
    const kv = makeKV();
    const env = makeEnv({ KV: kv });
    setupDrizzleResults([
      [enabledEnvironment({ agentDeployEnabled: false })],
    ]);

    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: 'production' },
      makeTokenData(),
      env,
    );

    expect(result).toHaveProperty('error');
    const error = (result as { error: { message: string } }).error;
    expect(error.message).toContain("Agent deployment is disabled for environment 'production'");
    expect(kv.get).not.toHaveBeenCalled();
    expect(mockGetRateLimit).not.toHaveBeenCalled();
    expect(mockMintCredential).not.toHaveBeenCalled();
  });

  it('allows an enabled environment without a profile allowlist to mint credentials', async () => {
    setupDrizzleResults([[enabledEnvironment()]]);
    setupSuccessfulMint();

    const env = makeEnv();
    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: 'staging' },
      makeTokenData(),
      env,
    );

    expect(result).toHaveProperty('result');
    const content = (result as { result: { content: Array<{ text: string }> } }).result.content;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.registry).toBe('registry.cloudflare.com');
    expect(parsed.username).toBe('cf-user');
    expect(parsed.password).toBe('cf-pass');
    expect(parsed.namespace).toBe('acct-123/sam-proj-1');
    expect(parsed.instructions).toBeInstanceOf(Array);

    const loginInstruction = (parsed.instructions as string[]).find((line) =>
      line.includes('docker login'),
    );
    expect(loginInstruction).toBeDefined();
    expect(loginInstruction).toContain('--password-stdin');
    expect(loginInstruction).not.toMatch(/-p\s+<password>/);
    expect(loginInstruction).not.toMatch(/--password\s+<password>/);
    expect(mockMintCredential).toHaveBeenCalledWith(
      env,
      'proj-1',
      'user-1',
      'task-1',
      'staging',
    );
  });

  it('denies an enabled environment when the task profile is not in the allowlist', async () => {
    const kv = makeKV();
    const env = makeEnv({ KV: kv });
    setupDrizzleResults([
      [enabledEnvironment({ allowedDeployProfileIdsJson: JSON.stringify(['profile-allowed']) })],
      [{ agentProfileHint: 'profile-other' }],
    ]);

    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: 'production' },
      makeTokenData(),
      env,
    );

    expect(result).toHaveProperty('error');
    const error = (result as { error: { message: string } }).error;
    expect(error.message).toContain("This agent profile is not allowed to deploy to environment 'production'");
    expect(kv.get).not.toHaveBeenCalled();
    expect(mockMintCredential).not.toHaveBeenCalled();
  });

  it('allows an enabled environment when the task profile is in the allowlist', async () => {
    setupDrizzleResults([
      [enabledEnvironment({ allowedDeployProfileIdsJson: JSON.stringify(['profile-allowed']) })],
      [{ agentProfileHint: 'profile-allowed' }],
    ]);
    setupSuccessfulMint();

    const env = makeEnv();
    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: 'production' },
      makeTokenData(),
      env,
    );

    expect(result).toHaveProperty('result');
    expect(mockMintCredential).toHaveBeenCalledWith(
      env,
      'proj-1',
      'user-1',
      'task-1',
      'production',
    );
  });

  it('enforces rate limiting after the environment policy passes', async () => {
    const kv = makeKV('10');
    const env = makeEnv({ KV: kv });
    setupDrizzleResults([[enabledEnvironment()]]);
    mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });

    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: 'staging' },
      makeTokenData(),
      env,
    );

    expect(result).toHaveProperty('error');
    const error = (result as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(-32000);
    expect(error.message).toContain('rate limit exceeded');
    expect(kv.get).toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(mockMintCredential).not.toHaveBeenCalled();
  });

  it('increments the rate limit counter before minting after policy passes', async () => {
    const kv = makeKV('3');
    const env = makeEnv({ KV: kv });
    setupDrizzleResults([[enabledEnvironment()]]);
    setupSuccessfulMint();

    await handleGetRegistryCredentials(
      'req-1',
      { environment: 'staging' },
      makeTokenData(),
      env,
    );

    const putCall = kv.put.mock.calls[0];
    expect(putCall[0]).toMatch(/^registry-cred-rate:proj-1:\d+$/);
    expect(putCall[1]).toBe('4');
    expect(putCall[2]).toEqual({ expirationTtl: 360 });
  });

  it('returns a generic error when mint fails and does not leak internals', async () => {
    const kv = makeKV('5');
    const env = makeEnv({ KV: kv });
    setupDrizzleResults([[enabledEnvironment()]]);
    mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });
    mockMintCredential.mockRejectedValue(new Error('CF API timeout with account acct-secret'));

    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: 'staging' },
      makeTokenData(),
      env,
    );

    expect(result).toHaveProperty('error');
    const error = (result as { error: { message: string } }).error;
    expect(error.message).toContain('temporarily unavailable');
    expect(error.message).not.toContain('CF API timeout');
    expect(error.message).not.toContain('acct-secret');

    const putCall = kv.put.mock.calls[0];
    expect(putCall[1]).toBe('6');
  });

  it('trims whitespace from the required environment parameter', async () => {
    setupDrizzleResults([[enabledEnvironment()]]);
    setupSuccessfulMint();

    const env = makeEnv();
    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: '  staging  ' },
      makeTokenData(),
      env,
    );

    expect(result).toHaveProperty('result');
    expect(mockMintCredential).toHaveBeenCalledWith(
      env,
      'proj-1',
      'user-1',
      'task-1',
      'staging',
    );
  });

  it('returns a policy error when the environment is not active for the project', async () => {
    setupDrizzleResults([[]]);

    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: 'missing' },
      makeTokenData(),
      makeEnv(),
    );

    expect(result).toHaveProperty('error');
    const error = (result as { error: { message: string } }).error;
    expect(error.message).toContain("'missing' not found or inactive");
    expect(mockMintCredential).not.toHaveBeenCalled();
  });
});
