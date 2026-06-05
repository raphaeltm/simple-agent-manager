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
let workspaceResult: { nodeId: string; status: string; userId?: string; portsPublicEnabled?: boolean } | null = null;

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

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}), { virtual: true });

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class {},
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => workspaceResult),
        })),
      })),
    })),
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

describe('workspace proxy port-access auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceResult = { nodeId: 'node-1', status: 'running', userId: 'user-1', portsPublicEnabled: false };
    mockGetSession.mockResolvedValue(null); // No session cookie on port subdomains
    mockVerifyTerminalToken.mockRejectedValue(new Error('Invalid token'));
    mockSignTerminalToken.mockResolvedValue({
      token: 'backend-port-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('proxied', { status: 200 })),
    );
  });

  it('validates ?port_token, sets cookie, and 302 redirects', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/?port_token=valid-jwt`,
      ),
      env,
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
      env,
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
      env,
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
        `https://ws-${WORKSPACE_ID}--8080.workspaces.example.com/?port_token=wrong-port-jwt`,
      ),
      env,
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
        `https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/?port_token=wrong-ws-jwt`,
      ),
      env,
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
        `https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/?port_token=expired-jwt`,
      ),
      env,
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
      new Request(
        `https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`,
      ),
      env,
    );

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('Session expired');
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('proxies a port request without browser auth when workspace ports are public', async () => {
    workspaceResult = { nodeId: 'node-1', status: 'running', userId: 'user-1', portsPublicEnabled: true };

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`,
      ),
      env,
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
      vi.fn(async () =>
        new Response('container page', {
          status: 200,
          headers: {
            'set-cookie': 'malicious_cookie=evil; Path=/',
            'content-type': 'text/html',
          },
        }),
      ),
    );

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`, {
        headers: { cookie: 'sam_port_access=valid-jwt' },
      }),
      env,
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
    });

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${WORKSPACE_ID}.workspaces.example.com/terminal?token=terminal-jwt`,
      ),
      env,
    );

    // Non-port workspace request should still work with terminal token
    expect(response.status).toBe(200);
    expect(mockVerifyTerminalToken).toHaveBeenCalledWith('terminal-jwt', env);
  });
});
