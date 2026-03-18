import { describe, it, expect } from 'vitest';
import { getNetworkInfo, exposePort } from '../../src/tools/network.js';
import type { WorkspaceMcpConfig } from '../../src/config.js';
import type { ApiClient } from '../../src/api-client.js';

function makeConfig(overrides: Partial<WorkspaceMcpConfig> = {}): WorkspaceMcpConfig {
  return {
    workspaceId: 'abc123',
    nodeId: 'node-test',
    projectId: 'proj-test',
    repository: 'owner/repo',
    branch: 'main',
    chatSessionId: '',
    taskId: '',
    workspaceUrl: 'https://ws-abc123.example.com',
    // Note: workspaceId is the raw ID (e.g. 'abc123'), workspace URL includes 'ws-' prefix
    apiUrl: 'https://api.example.com',
    baseDomain: 'example.com',
    mcpToken: 'token',
    ghToken: 'ghp_test',
    ...overrides,
  };
}

const mockApiClient = {} as ApiClient;

describe('getNetworkInfo', () => {
  it('returns base domain and workspace URL', async () => {
    const config = makeConfig();
    const result = await getNetworkInfo(config, mockApiClient);

    expect(result.baseDomain).toBe('example.com');
    expect(result.workspaceUrl).toBe('https://ws-abc123.example.com');
    expect(result.workspaceId).toBe('abc123');
    expect(result.portUrlPattern).toBe(
      'https://ws-abc123--{PORT}.example.com',
      // The URL pattern is ws-${workspaceId}--{PORT}.${baseDomain}
    );
  });

  it('reports unavailable when workspace ID is missing', async () => {
    const config = makeConfig({ workspaceId: '', baseDomain: '' });
    const result = await getNetworkInfo(config, mockApiClient);
    expect(result.portUrlPattern).toContain('unavailable');
  });
});

describe('exposePort', () => {
  it('returns external URL for valid port', async () => {
    const config = makeConfig();
    const result = await exposePort(config, mockApiClient, { port: 3000 });

    expect(result).toHaveProperty('externalUrl');
    if ('externalUrl' in result) {
      expect(result.externalUrl).toBe(
        'https://ws-abc123--3000.example.com',
        // ws-${workspaceId}--${port}.${baseDomain}
      );
    }
  });

  it('accepts optional label', async () => {
    const config = makeConfig();
    const result = await exposePort(config, mockApiClient, {
      port: 8080,
      label: 'dev server',
    });

    expect(result).toHaveProperty('label', 'dev server');
  });

  it('rejects invalid port numbers', async () => {
    const config = makeConfig();
    const result = await exposePort(config, mockApiClient, { port: 0 });
    expect(result).toHaveProperty('error');
  });

  it('rejects port > 65535', async () => {
    const config = makeConfig();
    const result = await exposePort(config, mockApiClient, { port: 70000 });
    expect(result).toHaveProperty('error');
  });

  it('errors when workspace ID is missing', async () => {
    const config = makeConfig({ workspaceId: '' });
    const result = await exposePort(config, mockApiClient, { port: 3000 });
    expect(result).toHaveProperty('error');
  });
});
