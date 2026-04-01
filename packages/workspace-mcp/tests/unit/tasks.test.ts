import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../src/api-client.js';
import type { WorkspaceMcpConfig } from '../../src/config.js';
import { getTaskDependencies } from '../../src/tools/tasks.js';

function makeConfig(overrides: Partial<WorkspaceMcpConfig> = {}): WorkspaceMcpConfig {
  return {
    workspaceId: 'ws-test',
    nodeId: 'node-test',
    projectId: 'proj-test',
    repository: 'owner/repo',
    branch: 'main',
    chatSessionId: '',
    taskId: 'task-current',
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
      return mcpToolResults[toolName] ?? {};
    }),
    callApi: vi.fn(),
    callGitHub: vi.fn(),
  } as unknown as ApiClient;
}

describe('getTaskDependencies', () => {
  it('returns error when no task ID', async () => {
    const config = makeConfig({ taskId: '' });
    const result = await getTaskDependencies(config, makeMockApiClient());
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('task mode');
  });

  it('returns error when credentials missing', async () => {
    const config = makeConfig({ mcpToken: '' });
    const result = await getTaskDependencies(config, makeMockApiClient());
    expect(result).toHaveProperty('error');
  });

  it('returns upstream, downstream, and sibling tasks', async () => {
    const config = makeConfig();
    const apiClient = makeMockApiClient({
      get_task_details: {
        task: {
          id: 'task-current',
          title: 'Current task',
          status: 'in_progress',
          parentTaskId: 'task-parent',
        },
      },
      list_tasks: {
        tasks: [
          { id: 'task-parent', title: 'Parent', status: 'completed' },
          { id: 'task-current', title: 'Current', status: 'in_progress', parentTaskId: 'task-parent' },
          { id: 'task-sibling', title: 'Sibling', status: 'pending', parentTaskId: 'task-parent' },
          { id: 'task-child', title: 'Child', status: 'pending', parentTaskId: 'task-current' },
        ],
      },
    });

    const result = await getTaskDependencies(config, apiClient);

    expect(result.upstream).toMatchObject({ id: 'task-parent', status: 'completed' });
    expect(result.downstream).toHaveLength(1);
    expect(result.downstream[0]).toMatchObject({ id: 'task-child' });
    expect(result.siblings).toHaveLength(1);
    expect(result.siblings[0]).toMatchObject({ id: 'task-sibling' });
  });

  it('returns standalone task with no dependencies', async () => {
    const config = makeConfig();
    const apiClient = makeMockApiClient({
      get_task_details: {
        task: { id: 'task-current', title: 'Solo', status: 'in_progress' },
      },
      list_tasks: {
        tasks: [{ id: 'task-current', title: 'Solo', status: 'in_progress' }],
      },
    });

    const result = await getTaskDependencies(config, apiClient);
    expect(result.upstream).toBeNull();
    expect(result.downstream).toHaveLength(0);
    expect(result.siblings).toHaveLength(0);
    expect(result.hint).toContain('standalone');
  });

  it('returns error when current task not found', async () => {
    const config = makeConfig();
    const apiClient = makeMockApiClient({
      get_task_details: { task: null },
      list_tasks: { tasks: [] },
    });

    const result = await getTaskDependencies(config, apiClient);
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('not found');
  });

  it('handles API errors gracefully', async () => {
    const config = makeConfig();
    const apiClient = {
      callMcpTool: vi.fn().mockRejectedValue(new Error('API down')),
      callApi: vi.fn(),
      callGitHub: vi.fn(),
    } as unknown as ApiClient;

    const result = await getTaskDependencies(config, apiClient);
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('API down');
  });
});
