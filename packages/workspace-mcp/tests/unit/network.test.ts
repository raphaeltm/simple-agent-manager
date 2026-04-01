import { describe, expect,it } from 'vitest';

import type { ApiClient } from '../../src/api-client.js';
import type { WorkspaceMcpConfig } from '../../src/config.js';
import { checkDnsStatus,exposePort, getNetworkInfo } from '../../src/tools/network.js';

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

describe('checkDnsStatus', () => {
  it('returns error when workspace URL is empty', async () => {
    const config = makeConfig({ workspaceUrl: '' });
    const result = await checkDnsStatus(config, mockApiClient);
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('not available');
  });

  it('returns error for invalid workspace URL', async () => {
    const config = makeConfig({ workspaceUrl: 'not-a-url' });
    const result = await checkDnsStatus(config, mockApiClient);
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Invalid');
  });

  it('returns dns_not_resolved for non-existent hostname', async () => {
    const config = makeConfig({
      workspaceUrl: 'https://definitely-not-a-real-host-12345.example.invalid',
    });
    const result = await checkDnsStatus(config, mockApiClient);
    expect(result.dnsResolved).toBe(false);
    expect(result.status).toBe('dns_not_resolved');
    expect(result.hint).toContain('not propagated');
  });

  it('returns structured result with all expected fields', async () => {
    const config = makeConfig({
      workspaceUrl: 'https://definitely-not-a-real-host-12345.example.invalid',
    });
    const result = await checkDnsStatus(config, mockApiClient);
    expect(result).toHaveProperty('hostname');
    expect(result).toHaveProperty('dnsResolved');
    expect(result).toHaveProperty('ipAddresses');
    expect(result).toHaveProperty('tlsValid');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('hint');
  });
});
