import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../src/api-client.js';
import type { WorkspaceMcpConfig } from '../../src/config.js';
import { reportEnvironmentIssue } from '../../src/tools/observability.js';

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

describe('reportEnvironmentIssue', () => {
  it('reports issue to control plane API', async () => {
    const config = makeConfig();
    const mockCallApi = vi.fn().mockResolvedValue({});
    const apiClient = {
      callApi: mockCallApi,
      callMcpTool: vi.fn(),
      callGitHub: vi.fn(),
    } as unknown as ApiClient;

    const result = await reportEnvironmentIssue(config, apiClient, {
      category: 'network',
      severity: 'high',
      description: 'DNS not resolving',
      diagnosticData: { attempts: 3 },
    });

    expect(result.reported).toBe(true);
    expect(mockCallApi).toHaveBeenCalledWith(
      '/api/workspace-context/report-issue',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          category: 'network',
          severity: 'high',
        }),
      }),
    );
  });

  it('falls back to task status when API fails', async () => {
    const config = makeConfig();
    const mockCallMcpTool = vi.fn().mockResolvedValue({});
    const apiClient = {
      callApi: vi.fn().mockRejectedValue(new Error('Not found')),
      callMcpTool: mockCallMcpTool,
      callGitHub: vi.fn(),
    } as unknown as ApiClient;

    const result = await reportEnvironmentIssue(config, apiClient, {
      category: 'disk',
      severity: 'critical',
      description: 'Disk full',
    });

    expect(result.reported).toBe(true);
    expect(result.method).toBe('task_status_update');
    expect(mockCallMcpTool).toHaveBeenCalledWith(
      'update_task_status',
      expect.objectContaining({
        message: expect.stringContaining('CRITICAL'),
      }),
    );
  });

  it('returns not reported when all methods fail', async () => {
    const config = makeConfig({ apiUrl: '', mcpToken: '' });
    const apiClient = {
      callApi: vi.fn(),
      callMcpTool: vi.fn(),
      callGitHub: vi.fn(),
    } as unknown as ApiClient;

    const result = await reportEnvironmentIssue(config, apiClient, {
      category: 'test',
      severity: 'low',
      description: 'Test issue',
    });

    expect(result.reported).toBe(false);
  });
});
