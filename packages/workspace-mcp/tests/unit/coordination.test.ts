import { describe, it, expect, vi } from 'vitest';
import {
  listProjectAgents,
  getFileLocks,
  getPeerAgentOutput,
} from '../../src/tools/coordination.js';
import type { WorkspaceMcpConfig } from '../../src/config.js';
import type { ApiClient } from '../../src/api-client.js';

function makeConfig(overrides: Partial<WorkspaceMcpConfig> = {}): WorkspaceMcpConfig {
  return {
    workspaceId: 'ws-test',
    nodeId: 'node-test',
    projectId: 'proj-test',
    repository: 'owner/repo',
    branch: 'main',
    chatSessionId: '',
    taskId: 'task-self',
    workspaceUrl: 'https://ws-test.example.com',
    apiUrl: 'https://api.example.com',
    baseDomain: 'example.com',
    mcpToken: 'token',
    ghToken: 'ghp_test',
    ...overrides,
  };
}

function makeMockApiClient(mcpToolResults: Record<string, unknown> = {}): ApiClient {
  return {
    callMcpTool: vi.fn(async (toolName: string) => {
      return mcpToolResults[toolName] ?? { tasks: [] };
    }),
    callApi: vi.fn(),
    callGitHub: vi.fn(),
  } as unknown as ApiClient;
}

describe('listProjectAgents', () => {
  it('returns other active agents excluding self', async () => {
    const config = makeConfig();
    const apiClient = makeMockApiClient({
      list_tasks: {
        tasks: [
          { id: 'task-self', title: 'My task', status: 'in_progress' },
          { id: 'task-other', title: 'Other task', status: 'in_progress', branch: 'feature-x' },
        ],
      },
    });

    const result = await listProjectAgents(config, apiClient);

    expect(result.selfTaskId).toBe('task-self');
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      taskId: 'task-other',
      title: 'Other task',
      branch: 'feature-x',
    });
  });

  it('returns empty when no other agents', async () => {
    const config = makeConfig();
    const apiClient = makeMockApiClient({
      list_tasks: {
        tasks: [{ id: 'task-self', title: 'My task', status: 'in_progress' }],
      },
    });

    const result = await listProjectAgents(config, apiClient);
    expect(result.agents).toHaveLength(0);
    expect(result.hint).toContain('No other agents');
  });

  it('errors when credentials missing', async () => {
    const config = makeConfig({ mcpToken: '' });
    const apiClient = makeMockApiClient();
    const result = await listProjectAgents(config, apiClient);
    expect(result).toHaveProperty('error');
  });
});

describe('getPeerAgentOutput', () => {
  it('returns peer task details', async () => {
    const config = makeConfig();
    const apiClient = makeMockApiClient({
      get_task_details: {
        task: {
          id: 'task-peer',
          title: 'Peer task',
          status: 'completed',
          description: 'Did some work',
          result: 'All tests pass',
          branch: 'feature-y',
        },
      },
    });

    const result = await getPeerAgentOutput(config, apiClient, {
      taskId: 'task-peer',
    });

    expect(result.taskId).toBe('task-peer');
    expect(result.status).toBe('completed');
    expect(result.result).toBe('All tests pass');
  });

  it('returns error for missing task', async () => {
    const config = makeConfig();
    const apiClient = makeMockApiClient({
      get_task_details: { task: null },
    });

    const result = await getPeerAgentOutput(config, apiClient, {
      taskId: 'nonexistent',
    });
    expect(result).toHaveProperty('error');
  });
});
