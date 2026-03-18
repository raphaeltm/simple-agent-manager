import { describe, it, expect, vi } from 'vitest';
import { getCiStatus, getDeploymentStatus } from '../../src/tools/cicd.js';
import type { WorkspaceMcpConfig } from '../../src/config.js';
import type { ApiClient } from '../../src/api-client.js';

function makeConfig(overrides: Partial<WorkspaceMcpConfig> = {}): WorkspaceMcpConfig {
  return {
    workspaceId: 'ws-test',
    nodeId: 'node-test',
    projectId: 'proj-test',
    repository: 'owner/repo',
    branch: 'feature-test',
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

function makeMockApiClient(githubResults: Record<string, unknown> = {}): ApiClient {
  return {
    callMcpTool: vi.fn(),
    callApi: vi.fn(),
    callGitHub: vi.fn(async (path: string) => {
      for (const [pattern, result] of Object.entries(githubResults)) {
        if (path.includes(pattern)) return result;
      }
      return { workflow_runs: [] };
    }),
  } as unknown as ApiClient;
}

describe('getCiStatus', () => {
  it('returns workflow runs for current branch', async () => {
    const config = makeConfig();
    const apiClient = makeMockApiClient({
      'actions/runs': {
        workflow_runs: [
          {
            id: 1,
            name: 'CI',
            status: 'completed',
            conclusion: 'success',
            head_branch: 'feature-test',
            created_at: '2026-03-18T10:00:00Z',
            updated_at: '2026-03-18T10:05:00Z',
            html_url: 'https://github.com/owner/repo/actions/runs/1',
          },
          {
            id: 2,
            name: 'CI',
            status: 'completed',
            conclusion: 'failure',
            head_branch: 'feature-test',
            created_at: '2026-03-18T09:00:00Z',
            updated_at: '2026-03-18T09:05:00Z',
            html_url: 'https://github.com/owner/repo/actions/runs/2',
          },
        ],
      },
    });

    const result = await getCiStatus(config, apiClient);

    expect(result.branch).toBe('feature-test');
    expect(result.overallStatus).toBe('partial_failure');
    expect(result.summary).toEqual({
      total: 2,
      inProgress: 0,
      failed: 1,
      succeeded: 1,
    });
  });

  it('errors when GH_TOKEN missing', async () => {
    const config = makeConfig({ ghToken: '' });
    const apiClient = makeMockApiClient();
    const result = await getCiStatus(config, apiClient);
    expect(result).toHaveProperty('error');
  });

  it('errors when repository missing', async () => {
    const config = makeConfig({ repository: '' });
    const apiClient = makeMockApiClient();
    const result = await getCiStatus(config, apiClient);
    expect(result).toHaveProperty('error');
  });
});

describe('getDeploymentStatus', () => {
  it('returns staging and production deploy status', async () => {
    const config = makeConfig();
    const apiClient = makeMockApiClient({
      'deploy-staging.yml': {
        workflow_runs: [
          {
            id: 10,
            status: 'completed',
            conclusion: 'success',
            head_branch: 'main',
            created_at: '2026-03-18T08:00:00Z',
            html_url: 'https://github.com/owner/repo/actions/runs/10',
          },
        ],
      },
      'deploy.yml': {
        workflow_runs: [
          {
            id: 20,
            status: 'in_progress',
            conclusion: null,
            head_branch: 'main',
            created_at: '2026-03-18T09:00:00Z',
            html_url: 'https://github.com/owner/repo/actions/runs/20',
          },
        ],
      },
    });

    const result = await getDeploymentStatus(config, apiClient);

    expect(result.staging?.isDeploying).toBe(false);
    expect(result.production?.isDeploying).toBe(true);
  });
});
