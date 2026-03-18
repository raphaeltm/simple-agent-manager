import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient } from '../../src/api-client.js';
import type { WorkspaceMcpConfig } from '../../src/config.js';

function makeConfig(overrides: Partial<WorkspaceMcpConfig> = {}): WorkspaceMcpConfig {
  return {
    workspaceId: 'ws-test',
    nodeId: 'node-test',
    projectId: 'proj-test',
    repository: 'owner/repo',
    branch: 'main',
    chatSessionId: '',
    taskId: '',
    workspaceUrl: 'https://ws-test.example.com',
    apiUrl: 'https://api.example.com',
    baseDomain: 'example.com',
    mcpToken: 'token-abc',
    ghToken: 'ghp_test',
    ...overrides,
  };
}

describe('ApiClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('callMcpTool', () => {
    it('sends JSON-RPC request with correct auth', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: {
            content: [{ type: 'text', text: '{"hello":"world"}' }],
          },
        }),
      });
      globalThis.fetch = mockFetch;

      const client = new ApiClient(makeConfig());
      const result = await client.callMcpTool('test_tool', { key: 'value' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/mcp',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer token-abc',
          }),
        }),
      );
      expect(result).toEqual({ hello: 'world' });
    });

    it('throws when API URL is missing', async () => {
      const client = new ApiClient(makeConfig({ apiUrl: '' }));
      await expect(client.callMcpTool('test')).rejects.toThrow(
        'SAM_API_URL and SAM_MCP_TOKEN are required',
      );
    });

    it('throws on HTTP error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const client = new ApiClient(makeConfig());
      await expect(client.callMcpTool('test')).rejects.toThrow('500');
    });
  });

  describe('callGitHub', () => {
    it('sends request with correct headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: 'test' }),
      });
      globalThis.fetch = mockFetch;

      const client = new ApiClient(makeConfig());
      await client.callGitHub('/repos/owner/repo');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer ghp_test',
            'User-Agent': 'sam-workspace-mcp',
          }),
        }),
      );
    });

    it('throws when GH_TOKEN is missing', async () => {
      const client = new ApiClient(makeConfig({ ghToken: '' }));
      await expect(client.callGitHub('/test')).rejects.toThrow(
        'GH_TOKEN is required',
      );
    });
  });

  describe('callApi', () => {
    it('sends GET request by default', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'ok' }),
      });
      globalThis.fetch = mockFetch;

      const client = new ApiClient(makeConfig());
      const result = await client.callApi('/api/test');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/api/test',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result).toEqual({ result: 'ok' });
    });

    it('sends POST with JSON body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      globalThis.fetch = mockFetch;

      const client = new ApiClient(makeConfig());
      await client.callApi('/api/test', {
        method: 'POST',
        body: { key: 'value' },
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.method).toBe('POST');
      expect(options.body).toBe('{"key":"value"}');
    });
  });
});
