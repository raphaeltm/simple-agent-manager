import { afterEach,beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads all SAM_* env vars into config', () => {
    process.env['SAM_WORKSPACE_ID'] = 'ws-123';
    process.env['SAM_NODE_ID'] = 'node-456';
    process.env['SAM_PROJECT_ID'] = 'proj-789';
    process.env['SAM_REPOSITORY'] = 'owner/repo';
    process.env['SAM_BRANCH'] = 'feature-branch';
    process.env['SAM_CHAT_SESSION_ID'] = 'session-abc';
    process.env['SAM_TASK_ID'] = 'task-def';
    process.env['SAM_WORKSPACE_URL'] = 'https://ws-123.example.com';
    process.env['SAM_API_URL'] = 'https://api.example.com';
    process.env['SAM_MCP_TOKEN'] = 'token-xyz';
    process.env['GH_TOKEN'] = 'ghp_test';

    const config = loadConfig();

    expect(config.workspaceId).toBe('ws-123');
    expect(config.nodeId).toBe('node-456');
    expect(config.projectId).toBe('proj-789');
    expect(config.repository).toBe('owner/repo');
    expect(config.branch).toBe('feature-branch');
    expect(config.chatSessionId).toBe('session-abc');
    expect(config.taskId).toBe('task-def');
    expect(config.workspaceUrl).toBe('https://ws-123.example.com');
    expect(config.apiUrl).toBe('https://api.example.com');
    expect(config.mcpToken).toBe('token-xyz');
    expect(config.ghToken).toBe('ghp_test');
  });

  it('derives baseDomain from SAM_API_URL', () => {
    process.env['SAM_API_URL'] = 'https://api.sammy.party';
    const config = loadConfig();
    expect(config.baseDomain).toBe('sammy.party');
  });

  it('handles non-api hostname', () => {
    process.env['SAM_API_URL'] = 'https://example.com';
    const config = loadConfig();
    expect(config.baseDomain).toBe('example.com');
  });

  it('returns empty strings when env vars are missing', () => {
    // Clear all SAM env vars
    delete process.env['SAM_WORKSPACE_ID'];
    delete process.env['SAM_API_URL'];
    delete process.env['SAM_MCP_TOKEN'];

    const config = loadConfig();

    expect(config.workspaceId).toBe('');
    expect(config.apiUrl).toBe('');
    expect(config.baseDomain).toBe('');
    expect(config.mcpToken).toBe('');
  });

  it('handles invalid SAM_API_URL gracefully', () => {
    process.env['SAM_API_URL'] = 'not-a-url';
    const config = loadConfig();
    expect(config.baseDomain).toBe('');
  });
});
