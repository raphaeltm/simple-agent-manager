/**
 * Workspace Proxy Port-Access Token Tests
 *
 * Verifies:
 * - ?port_token= on port subdomain → sets cookie, returns 302 to clean URL
 * - sam_port_access cookie on subsequent request → proxied successfully
 * - Token for port 3000 rejected on port 8080 subdomain
 * - Token for workspace A rejected on workspace B subdomain
 * - Expired/invalid token → HTML error page (not JSON)
 * - Container Set-Cookie headers stripped from port-proxy responses
 * - Existing terminal token auth still works for non-port workspace requests
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.fn();
const mockVerifyTerminalToken = vi.fn();
const mockSignTerminalToken = vi.fn();
const mockVerifyPortAccessToken = vi.fn();
let workspaceResult: {
  nodeId: string;
  status: string;
  userId?: string;
  portsPublicEnabled?: boolean;
} | null = null;
let terminalSessionResult: {
  sessionId: string;
  userId: string;
  expiresAt: Date;
  userRole: string;
  userStatus: string;
} | null = null;
let platformSettingResult: {
  value: string;
  updatedAt: string | null;
  updatedBy: string | null;
} | null = null;

vi.mock('../../src/auth', () => ({
  createAuth: vi.fn(() => ({
    api: {
      getSession: mockGetSession,
    },
  })),
}));

vi.mock('../../src/services/jwt', () => ({
  verifyTerminalToken: mockVerifyTerminalToken,
  signTerminalToken: mockSignTerminalToken,
  verifyPortAccessToken: mockVerifyPortAccessToken,
}));

vi.mock(
  'cloudflare:workers',
  () => ({
    DurableObject: class {},
  }),
  { virtual: true }
);

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class {},
}));

vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  switchPort: vi.fn((request: Request) => request),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    select: vi.fn((selection?: Record<string, unknown>) => {
      const getResult = async () => {
        if (selection && 'sessionId' in selection) return terminalSessionResult;
        if (selection && 'value' in selection) return platformSettingResult;
        return workspaceResult;
      };
      const chain = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        get: vi.fn(getResult),
      };
      return chain;
    }),
  })),
}));

const worker = await import('../../src/index');

// parseWorkspaceSubdomain converts workspace IDs to uppercase
const WORKSPACE_ID = '01KR1000000000000000000001';
const OTHER_WORKSPACE_ID = '01KR2000000000000000000002';

const env = {
  BASE_DOMAIN: 'workspaces.example.com',
  DATABASE: {},
  VM_AGENT_PROTOCOL: 'https',
  VM_AGENT_PORT: '8443',
};

function workspacePortsRequest() {
  return new Request(
    `https://ws-${WORKSPACE_ID}.workspaces.example.com/workspaces/${WORKSPACE_ID}/ports?token=terminal-jwt`
  );
}

function allowTerminalWorkspaceAccess() {
  mockVerifyTerminalToken.mockResolvedValue({
    workspace: WORKSPACE_ID,
    subject: 'user-1',
    sessionToken: 'token-session-1',
  });
}

describe('workspace proxy port-access auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceResult = {
      nodeId: 'node-1',
      status: 'running',
      userId: 'user-1',
      portsPublicEnabled: false,
    };
    terminalSessionResult = {
      sessionId: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
      userRole: 'user',
      userStatus: 'active',
    };
    platformSettingResult = null;
    mockGetSession.mockResolvedValue(null); // No session cookie on port subdomains
    mockVerifyTerminalToken.mockRejectedValue(new Error('Invalid token'));
    mockSignTerminalToken.mockResolvedValue({
      token: 'backend-port-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('proxied', { status: 200 }))
    );
  });

  it('validates ?port_token, sets cookie, and 302 redirects', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/?port_token=valid-jwt`),
      env
    );

    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    expect(location).not.toContain('port_token');
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('sam_port_access=valid-jwt');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('accepts sam_port_access cookie and proxies request', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`, {
        headers: { cookie: 'sam_port_access=valid-jwt' },
      }),
      env
    );

    // Should proxy through (not 302, not 401)
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('proxied');
  });

  it('rejects cookie for wrong port (port 3000 cookie on port 8080 subdomain)', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000, // Cookie JWT is for port 3000
      subject: 'user-1',
    });

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--8080.workspaces.example.com/`, {
        headers: { cookie: 'sam_port_access=wrong-port-cookie-jwt' },
      }),
      env
    );

    // Cookie port (3000) !== subdomain port (8080) → HTML 401
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('Session expired');
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('rejects token for wrong port (port 3000 token on port 8080 subdomain)', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000, // Token is for port 3000
      subject: 'user-1',
    });

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${WORKSPACE_ID}--8080.workspaces.example.com/?port_token=wrong-port-jwt`
      ),
      env
    );

    // Port mismatch: token.port (3000) !== targetPort (8080) → HTML 401
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('Session expired');
    expect(body).toContain('expose_port');
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('rejects token for wrong workspace', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: OTHER_WORKSPACE_ID, // Token is for different workspace
      port: 3000,
      subject: 'user-1',
    });

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/?port_token=wrong-ws-jwt`
      ),
      env
    );

    // Workspace mismatch → HTML 401
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('Session expired');
  });

  it('returns HTML error page for expired token', async () => {
    mockVerifyPortAccessToken.mockRejectedValue(new Error('Token expired'));

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/?port_token=expired-jwt`
      ),
      env
    );

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('Session expired');
    expect(body).toContain('expose_port');
    expect(response.headers.get('content-type')).toContain('text/html');
    // Should NOT be JSON
    expect(body).not.toContain('"error"');
  });

  it('returns HTML error for port request with no auth at all', async () => {
    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`),
      env
    );

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('Session expired');
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('proxies a port request without browser auth when workspace ports are public', async () => {
    workspaceResult = {
      nodeId: 'node-1',
      status: 'running',
      userId: 'user-1',
      portsPublicEnabled: true,
    };

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('proxied');
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockVerifyTerminalToken).not.toHaveBeenCalled();
  });

  it('strips Set-Cookie from container responses on port-proxy path', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });

    // Simulate container response with a Set-Cookie header
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('container page', {
            status: 200,
            headers: {
              'set-cookie': 'malicious_cookie=evil; Path=/',
              'content-type': 'text/html',
            },
          })
      )
    );

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`, {
        headers: { cookie: 'sam_port_access=valid-jwt' },
      }),
      env
    );

    expect(response.status).toBe(200);
    // Container's Set-Cookie must be stripped
    expect(response.headers.get('set-cookie')).toBeNull();
    // Content should still pass through
    expect(await response.text()).toBe('container page');
  });

  it('preserves terminal token auth for non-port workspace requests', async () => {
    mockVerifyTerminalToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      subject: 'user-1',
      sessionToken: 'token-session-1',
    });

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}.workspaces.example.com/terminal?token=terminal-jwt`),
      env
    );

    // Non-port workspace request should still work with terminal token
    expect(response.status).toBe(200);
    expect(mockVerifyTerminalToken).toHaveBeenCalledWith('terminal-jwt', env);
  });

  it.each(['sleeping', 'stopped', 'deleted'] as const)(
    'returns a structured non-retryable ports lifecycle payload when the workspace is %s',
    async (status) => {
      allowTerminalWorkspaceAccess();
      workspaceResult = {
        nodeId: 'node-1',
        status,
        userId: 'user-1',
        portsPublicEnabled: false,
      };
      const fetchMock = vi.fn(async () => new Response('should not proxy', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const response = await worker.default.fetch(workspacePortsRequest(), env);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ports: [],
        state: status,
        workspaceStatus: status,
        retryable: false,
        message: `Workspace is ${status}`,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('returns a structured retryable ports payload while a creating workspace is not ready', async () => {
    allowTerminalWorkspaceAccess();
    workspaceResult = {
      nodeId: 'node-1',
      status: 'creating',
      userId: 'user-1',
      portsPublicEnabled: false,
    };
    const fetchMock = vi.fn(async () => new Response('should not proxy', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.default.fetch(workspacePortsRequest(), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ports: [],
      state: 'not_ready',
      workspaceStatus: 'creating',
      retryable: true,
      message: 'Workspace is creating',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a structured gone ports payload when the workspace row is absent', async () => {
    allowTerminalWorkspaceAccess();
    workspaceResult = null;
    const fetchMock = vi.fn(async () => new Response('should not proxy', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.default.fetch(workspacePortsRequest(), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ports: [],
      state: 'gone',
      workspaceStatus: null,
      retryable: false,
      message: 'Workspace not found',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes an expected upstream ports 503 into a retryable not_ready payload', async () => {
    allowTerminalWorkspaceAccess();
    const fetchMock = vi.fn(async () => new Response('vm agent not ready', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.default.fetch(workspacePortsRequest(), env);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ports: [],
      state: 'not_ready',
      workspaceStatus: 'running',
      retryable: true,
      message: 'Workspace ports are not ready',
      diagnostics: {
        runtime: 'vm',
        upstreamStatus: 503,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps terminal token failures as auth failures for workspace ports requests', async () => {
    mockVerifyTerminalToken.mockRejectedValue(new Error('bad token'));

    const response = await worker.default.fetch(workspacePortsRequest(), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'UNAUTHORIZED',
      message: 'Invalid workspace token',
    });
  });
});
