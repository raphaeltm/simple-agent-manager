/**
 * Tests for the get_registry_credentials MCP tool handler.
 *
 * These unit tests mock the service layer and drizzle to verify:
 * - Environment validation
 * - Rate limiting behavior
 * - Error handling
 * - Response shape
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the registry-credentials service
vi.mock('../../../src/services/registry-credentials', () => ({
  getRegistryCredentialRateLimit: vi.fn(),
  mintProjectRegistryCredential: vi.fn(),
}));

// Mock drizzle-orm/d1 to avoid needing a real D1 binding
const mockSelect = vi.fn();
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    select: mockSelect,
  })),
}));

import type { Env } from '../../../src/env';
import {
  getRegistryCredentialRateLimit,
  mintProjectRegistryCredential,
} from '../../../src/services/registry-credentials';
import { handleGetRegistryCredentials } from '../../../src/routes/mcp/registry-credential-tools';

const mockGetRateLimit = vi.mocked(getRegistryCredentialRateLimit);
const mockMintCredential = vi.mocked(mintProjectRegistryCredential);

function makeTokenData() {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    taskId: 'task-1',
    workspaceId: 'ws-1',
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

function setupDrizzleResult(rows: Array<Record<string, unknown>>) {
  // Chain: select().from().where().limit()
  const limitFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  mockSelect.mockReturnValue({ from: fromFn });
}

describe('handleGetRegistryCredentials', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mints credentials successfully without environment', async () => {
    mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });
    mockMintCredential.mockResolvedValue({
      registry: 'registry.cloudflare.com',
      username: 'cf-user',
      password: 'cf-pass',
      namespace: 'acct-123/sam-proj-1',
      expiresAt: '2026-06-11T12:00:00.000Z',
    });

    const result = await handleGetRegistryCredentials('req-1', {}, makeTokenData(), makeEnv());

    expect(result).toHaveProperty('result');
    const content = (result as { result: { content: Array<{ text: string }> } }).result.content;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.registry).toBe('registry.cloudflare.com');
    expect(parsed.username).toBe('cf-user');
    expect(parsed.password).toBe('cf-pass');
    expect(parsed.namespace).toBe('acct-123/sam-proj-1');
    expect(parsed.expiresAt).toBe('2026-06-11T12:00:00.000Z');
    expect(parsed.instructions).toBeInstanceOf(Array);
    expect(parsed.instructions.length).toBeGreaterThan(0);
  });

  it('returns error when environment does not exist', async () => {
    setupDrizzleResult([]); // No environment rows found

    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: 'production' },
      makeTokenData(),
      makeEnv(),
    );

    expect(result).toHaveProperty('error');
    const error = (result as { error: { message: string } }).error;
    expect(error.message).toContain("'production' not found or inactive");
    // Should NOT have attempted to mint
    expect(mockMintCredential).not.toHaveBeenCalled();
  });

  it('validates environment exists when provided and proceeds to mint', async () => {
    setupDrizzleResult([{ id: 'env-1' }]); // Environment found
    mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });
    mockMintCredential.mockResolvedValue({
      registry: 'registry.cloudflare.com',
      username: 'u',
      password: 'p',
      namespace: 'acct-123/sam-proj-1',
      expiresAt: '2026-06-11T12:00:00.000Z',
    });

    const env = makeEnv();
    const result = await handleGetRegistryCredentials(
      'req-1',
      { environment: 'staging' },
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

  it('enforces rate limiting', async () => {
    const kv = makeKV('10'); // At limit
    const env = makeEnv({ KV: kv });

    mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });

    const result = await handleGetRegistryCredentials('req-1', {}, makeTokenData(), env);

    expect(result).toHaveProperty('error');
    const error = (result as { error: { message: string } }).error;
    expect(error.message).toContain('rate limit exceeded');
    expect(mockMintCredential).not.toHaveBeenCalled();
  });

  it('allows request when under rate limit', async () => {
    const kv = makeKV('9'); // Under limit
    const env = makeEnv({ KV: kv });

    mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });
    mockMintCredential.mockResolvedValue({
      registry: 'r',
      username: 'u',
      password: 'p',
      namespace: 'ns',
      expiresAt: '2026-06-11T12:00:00.000Z',
    });

    const result = await handleGetRegistryCredentials('req-1', {}, makeTokenData(), env);

    expect(result).toHaveProperty('result');
    expect(mockMintCredential).toHaveBeenCalled();
  });

  it('increments rate limit counter after successful mint', async () => {
    const kv = makeKV('3'); // Under limit
    const env = makeEnv({ KV: kv });

    mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });
    mockMintCredential.mockResolvedValue({
      registry: 'r',
      username: 'u',
      password: 'p',
      namespace: 'ns',
      expiresAt: '2026-06-11T12:00:00.000Z',
    });

    await handleGetRegistryCredentials('req-1', {}, makeTokenData(), env);

    expect(kv.put).toHaveBeenCalledWith(
      'registry-cred-rate:proj-1',
      '4',
      { expirationTtl: 300 },
    );
  });

  it('returns error when mint fails', async () => {
    const kv = makeKV(null);
    const env = makeEnv({ KV: kv });

    mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });
    mockMintCredential.mockRejectedValue(new Error('CF API timeout'));

    const result = await handleGetRegistryCredentials('req-1', {}, makeTokenData(), env);

    expect(result).toHaveProperty('error');
    const error = (result as { error: { message: string } }).error;
    expect(error.message).toContain('CF API timeout');
  });

  it('trims whitespace from environment parameter', async () => {
    setupDrizzleResult([{ id: 'env-1' }]);
    mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });
    mockMintCredential.mockResolvedValue({
      registry: 'r',
      username: 'u',
      password: 'p',
      namespace: 'ns',
      expiresAt: '2026-06-11T12:00:00.000Z',
    });

    const env = makeEnv();
    await handleGetRegistryCredentials(
      'req-1',
      { environment: '  staging  ' },
      makeTokenData(),
      env,
    );

    expect(mockMintCredential).toHaveBeenCalledWith(
      env,
      'proj-1',
      'user-1',
      'task-1',
      'staging',
    );
  });

  it('skips environment check when no environment provided', async () => {
    mockGetRateLimit.mockReturnValue({ maxRequests: 10, windowSeconds: 300 });
    mockMintCredential.mockResolvedValue({
      registry: 'r',
      username: 'u',
      password: 'p',
      namespace: 'ns',
      expiresAt: '2026-06-11T12:00:00.000Z',
    });

    await handleGetRegistryCredentials('req-1', {}, makeTokenData(), makeEnv());

    // drizzle select should not have been called (no env check)
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockMintCredential).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'user-1',
      'task-1',
      undefined,
    );
  });
});
