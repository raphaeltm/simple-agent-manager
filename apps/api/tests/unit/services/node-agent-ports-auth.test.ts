import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSignTerminalToken = vi.fn();
const mockSignNodeManagementToken = vi.fn();
const mockFetchWithTimeout = vi.fn();
const mockRecordNodeRoutingMetric = vi.fn();

vi.mock('../../../src/services/jwt', () => ({
  signTerminalToken: mockSignTerminalToken,
  signNodeManagementToken: mockSignNodeManagementToken,
}));

vi.mock('../../../src/services/fetch-timeout', () => ({
  fetchWithTimeout: mockFetchWithTimeout,
  getTimeoutMs: vi.fn((_value: string | undefined, fallback: number) => fallback),
}));

vi.mock('../../../src/services/telemetry', () => ({
  recordNodeRoutingMetric: mockRecordNodeRoutingMetric,
}));

const { getWorkspacePortsOnNode } = await import('../../../src/services/node-agent');

describe('getWorkspacePortsOnNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignTerminalToken.mockResolvedValue({
      token: 'workspace-terminal-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    mockSignNodeManagementToken.mockResolvedValue({
      token: 'node-management-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    mockFetchWithTimeout.mockResolvedValue(
      new Response(JSON.stringify({ ports: [{ port: 3000 }], diagnostics: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  });

  it('uses a workspace terminal token for the VM agent ports endpoint', async () => {
    const result = await getWorkspacePortsOnNode('NODE-ABC', 'ws-123', {
      BASE_DOMAIN: 'example.com',
      NODE_AGENT_REQUEST_TIMEOUT_MS: '30000',
    } as never, 'user-1');

    expect(result).toEqual({ ports: [{ port: 3000 }], diagnostics: {} });
    expect(mockSignTerminalToken).toHaveBeenCalledWith('user-1', 'ws-123', expect.any(Object));
    expect(mockSignNodeManagementToken).not.toHaveBeenCalled();
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

    const [url, init, timeout] = mockFetchWithTimeout.mock.calls[0] as [string, RequestInit, number];
    expect(url).toBe('https://node-abc.vm.example.com:8443/workspaces/ws-123/ports');
    expect(timeout).toBe(30000);
    expect(init.method).toBe('GET');

    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer workspace-terminal-token');
    expect(headers.get('X-SAM-Node-Id')).toBe('NODE-ABC');
    expect(headers.get('X-SAM-Workspace-Id')).toBe('ws-123');
  });
});
