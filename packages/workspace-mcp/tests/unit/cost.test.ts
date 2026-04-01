import { afterEach,beforeEach, describe, expect, it } from 'vitest';

import type { ApiClient } from '../../src/api-client.js';
import type { WorkspaceMcpConfig } from '../../src/config.js';
import { checkCostEstimate, getRemainingBudget } from '../../src/tools/cost.js';

function makeConfig(overrides: Partial<WorkspaceMcpConfig> = {}): WorkspaceMcpConfig {
  return {
    workspaceId: 'ws-test',
    nodeId: 'node-test',
    projectId: 'proj-test',
    repository: 'owner/repo',
    branch: 'main',
    chatSessionId: '',
    taskId: 'task-test',
    workspaceUrl: 'https://ws-test.example.com',
    apiUrl: 'https://api.example.com',
    baseDomain: 'example.com',
    mcpToken: 'token',
    ghToken: 'ghp_test',
    ...overrides,
  };
}

describe('checkCostEstimate', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses default pricing for known VM sizes', async () => {
    process.env['SAM_VM_SIZE'] = 'medium';
    const mockApi = {} as ApiClient;
    const result = await checkCostEstimate(makeConfig(), mockApi);

    expect(result.vmSize).toBe('medium');
    expect(result.hourlyRate).toBe(0.017);
    expect(result.pricingSource).toBe('default estimates');
  });

  it('uses custom pricing from env var', async () => {
    process.env['SAM_VM_SIZE'] = 'gpu';
    process.env['SAM_VM_PRICING_JSON'] = JSON.stringify({ gpu: 1.5 });
    const mockApi = {} as ApiClient;
    const result = await checkCostEstimate(makeConfig(), mockApi);

    expect(result.vmSize).toBe('gpu');
    expect(result.hourlyRate).toBe(1.5);
    expect(result.pricingSource).toBe('SAM_VM_PRICING_JSON env var');
  });

  it('returns null hourly rate for unknown VM size', async () => {
    process.env['SAM_VM_SIZE'] = 'exotic';
    const mockApi = {} as ApiClient;
    const result = await checkCostEstimate(makeConfig(), mockApi);

    expect(result.vmSize).toBe('exotic');
    expect(result.hourlyRate).toBeNull();
    expect(result.estimatedCostUsd).toBeNull();
    expect(result.note).toContain('exotic');
  });
});

describe('getRemainingBudget', () => {
  it('returns not configured when API is unavailable', async () => {
    const config = makeConfig({ apiUrl: '', mcpToken: '' });
    const mockApi = {} as ApiClient;
    const result = await getRemainingBudget(config, mockApi);

    expect(result).toHaveProperty('note');
    expect(result.budgetUsd).toBeNull();
  });

  it('gracefully handles API errors', async () => {
    const config = makeConfig();
    const mockApi = {
      callApi: async () => {
        throw new Error('Not found');
      },
    } as unknown as ApiClient;
    const result = await getRemainingBudget(config, mockApi);

    expect(result).toHaveProperty('note');
  });
});
