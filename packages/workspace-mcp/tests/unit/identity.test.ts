import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getWorkspaceInfo, getCredentialStatus } from '../../src/tools/identity.js';
import type { WorkspaceMcpConfig } from '../../src/config.js';
import type { ApiClient } from '../../src/api-client.js';

function makeConfig(overrides: Partial<WorkspaceMcpConfig> = {}): WorkspaceMcpConfig {
  return {
    workspaceId: 'ws-test',
    nodeId: 'node-test',
    projectId: 'proj-test',
    repository: 'owner/repo',
    branch: 'main',
    chatSessionId: 'session-test',
    taskId: 'task-test',
    workspaceUrl: 'https://ws-test.example.com',
    apiUrl: 'https://api.example.com',
    baseDomain: 'example.com',
    mcpToken: 'token-test',
    ghToken: 'ghp_test',
    ...overrides,
  };
}

const mockApiClient = {} as ApiClient;

describe('getWorkspaceInfo', () => {
  it('returns workspace metadata from config', async () => {
    const config = makeConfig();
    const result = await getWorkspaceInfo(config, mockApiClient);

    expect(result.workspaceId).toBe('ws-test');
    expect(result.nodeId).toBe('node-test');
    expect(result.projectId).toBe('proj-test');
    expect(result.repository).toBe('owner/repo');
    expect(result.branch).toBe('main');
    expect(result.mode).toBe('task');
    expect(result.taskId).toBe('task-test');
    expect(result.workspaceUrl).toBe('https://ws-test.example.com');
  });

  it('reports conversation mode when no task ID', async () => {
    const config = makeConfig({ taskId: '' });
    const result = await getWorkspaceInfo(config, mockApiClient);
    expect(result.mode).toBe('conversation');
    expect(result.taskId).toBeNull();
  });
});

describe('getCredentialStatus', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reports available credentials', async () => {
    process.env['GH_TOKEN'] = 'ghp_test123';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];

    const config = makeConfig();
    const result = await getCredentialStatus(config, mockApiClient);

    expect(result.credentials).toHaveLength(4);

    const gh = result.credentials.find((c) => c.name === 'GH_TOKEN');
    expect(gh?.available).toBe(true);

    const apiKey = result.credentials.find((c) => c.name === 'ANTHROPIC_API_KEY');
    expect(apiKey?.available).toBe(true);

    const oauth = result.credentials.find((c) => c.name === 'CLAUDE_CODE_OAUTH_TOKEN');
    expect(oauth?.available).toBe(false);

    const mcp = result.credentials.find((c) => c.name === 'SAM_MCP_TOKEN');
    expect(mcp?.available).toBe(true);

    expect(result.agentAuthMethod).toBe('api-key');
  });

  it('reports oauth auth method when only OAuth token is set', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'oauth-test';

    const config = makeConfig();
    const result = await getCredentialStatus(config, mockApiClient);
    expect(result.agentAuthMethod).toBe('oauth-token');
  });
});
