/**
 * Workspace Proxy Port-Access Token Tests
 *
 * Verifies:
 * - ?port_token= on port subdomain → sets cookie, returns 302 to clean URL
 * - sam_port_access cookie on subsequent request → proxied successfully
 * - Token for port 3000 rejected on port 8080 subdomain
 * - Token for workspace A rejected on workspace B subdomain
 * - Expired/invalid token → HTML error page (not JSON)
 * - Reserved Set-Cookie headers stripped and application cookies forced host-only
 * - SAM-reserved cookies stripped before the VM-agent proxy
 * - SAM bearer credentials stripped without breaking application bearer auth
 * - Preview responses cannot clear control-plane cookies
 * - Privileged WebSocket upgrades reject sibling preview origins
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
  runtime?: string;
  userId?: string;
  portsPublicEnabled?: boolean;
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
    workspaceResult = {
      nodeId: 'node-1',
      status: 'running',
      userId: 'user-1',
      portsPublicEnabled: false,
    };
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

  it('strips reserved Set-Cookie from container responses on port-proxy path', async () => {
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
              'set-cookie': 'sam_port_access=evil; Path=/',
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

  it('strips SAM-reserved cookies before the VM request and preserves ordinary preview cookies', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });

    const fetch = vi.fn(async () => new Response('proxied', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`, {
        headers: {
          cookie: [
            'sam_port_access=valid-jwt',
            'vm_session=shared-session',
            `vm_session_${WORKSPACE_ID}=workspace-session`,
            '__Secure-better-auth.session_token=control-plane-session',
            'vm_session_extension=ordinary-extension',
            'better-auth.session_extension=ordinary-extension',
            'preview_theme=dark',
          ].join('; '),
        },
      }),
      env
    );

    expect(response.status).toBe(200);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('cookie')).toBe(
      'vm_session_extension=ordinary-extension; better-auth.session_extension=ordinary-extension; preview_theme=dark'
    );
  });

  it('strips a positively identified SAM bearer before the preview app', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });
    mockVerifyTerminalToken.mockImplementation(async (token: string) => {
      if (token === 'sam-workspace-jwt') {
        return { workspace: WORKSPACE_ID, subject: 'user-1' };
      }
      throw new Error('not a SAM token');
    });

    const fetch = vi.fn(async () => new Response('proxied', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`, {
        headers: {
          cookie: 'sam_port_access=valid-jwt',
          authorization: 'bEaReR sam-workspace-jwt',
        },
      }),
      env
    );

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBeNull();
  });

  it('strips a valid SAM bearer scoped to a different workspace', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });
    mockVerifyTerminalToken.mockResolvedValue({
      workspace: '01KR2000000000000000000002',
      subject: 'user-1',
    });

    const fetch = vi.fn(async () => new Response('proxied', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`, {
        headers: {
          cookie: 'sam_port_access=valid-jwt',
          authorization: 'Bearer sam-other-workspace-jwt',
        },
      }),
      env
    );

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBeNull();
  });

  it('preserves an arbitrary application Authorization bearer', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });

    const fetch = vi.fn(async () => new Response('proxied', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`, {
        headers: {
          cookie: 'sam_port_access=valid-jwt',
          authorization: 'Bearer app-owned-token',
        },
      }),
      env
    );

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer app-owned-token');
  });

  it('isolates credentials on the cf-container path while preserving application contracts', async () => {
    workspaceResult = {
      nodeId: 'node-1',
      status: 'running',
      runtime: 'cf-container',
      userId: 'user-1',
      portsPublicEnabled: false,
    };
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });
    const responseHeaders = new Headers();
    responseHeaders.append('set-cookie', 'sam_port_access=evil; Path=/');
    responseHeaders.append(
      'set-cookie',
      'preview_session=ordinary; Domain=.workspaces.example.com; Path=/'
    );
    responseHeaders.set('clear-site-data', '"cache", "cookies"');
    const proxyHttp = vi.fn(
      async () => new Response('container page', { status: 200, headers: responseHeaders })
    );
    const containerFetch = vi.fn(
      async () => new Response('container websocket boundary', { status: 200 })
    );
    const cfEnv = {
      ...env,
      CF_CONTAINER_ENABLED: 'true',
      VM_AGENT_CONTAINER: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ proxyHttp, fetch: containerFetch })),
      },
    };

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/socket?port_token=valid-jwt&token=client-sam-token&channel=app`,
        {
          headers: {
            cookie: 'sam_port_access=valid-jwt; vm_session=shared-session; preview_theme=dark',
            authorization: 'Bearer app-owned-token',
          },
        }
      ),
      cfEnv
    );

    expect(response.status).toBe(200);
    expect(proxyHttp).toHaveBeenCalledOnce();
    const request = proxyHttp.mock.calls[0]?.[0] as Request;
    expect(request.url).toContain('/workspaces/' + WORKSPACE_ID + '/ports/3000/socket');
    expect(new URL(request.url).searchParams.get('channel')).toBe('app');
    expect(new URL(request.url).searchParams.get('port_token')).toBeNull();
    expect(new URL(request.url).searchParams.get('token')).toBe('backend-port-token');
    expect(request.headers.get('authorization')).toBe('Bearer app-owned-token');
    expect(request.headers.get('cookie')).toBe('preview_theme=dark');
    expect(response.headers.get('set-cookie')).toContain('preview_session=ordinary');
    expect(response.headers.get('set-cookie')).not.toMatch(/Domain=/i);
    expect(response.headers.get('set-cookie')).not.toContain('sam_port_access=');
    expect(response.headers.get('clear-site-data')).toBe('"cache"');

    const upgradeResponse = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/socket`, {
        headers: {
          cookie: 'sam_port_access=valid-jwt; vm_session=shared-session; preview_theme=dark',
          authorization: 'Bearer app-owned-token',
          connection: 'Upgrade',
          upgrade: 'websocket',
        },
      }),
      cfEnv
    );
    expect(upgradeResponse.status).toBe(200);
    expect(containerFetch).toHaveBeenCalledOnce();
    const upgradeRequest = containerFetch.mock.calls[0]?.[0] as Request;
    expect(upgradeRequest.headers.get('authorization')).toBe('Bearer app-owned-token');
    expect(upgradeRequest.headers.get('cookie')).toBe('preview_theme=dark');
  });

  it('preserves ordinary response cookies as host-only and blocks reserved cookies', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });
    const responseHeaders = new Headers({ 'content-type': 'text/html' });
    responseHeaders.append('set-cookie', 'sam_port_access=evil; Path=/');
    responseHeaders.append('set-cookie', 'vm_session=evil; Path=/');
    responseHeaders.append('set-cookie', '__Secure-better-auth.session_token=evil; Path=/; Secure');
    responseHeaders.append('set-cookie', 'vm_session_extension=ordinary; Path=/');
    responseHeaders.append('set-cookie', 'better-auth.session_extension=ordinary; Path=/');
    responseHeaders.append('set-cookie', 'preview_session=ordinary; Path=/; HttpOnly');
    responseHeaders.append(
      'set-cookie',
      'preview_parent=ordinary; Domain=.workspaces.example.com; Path=/'
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('container page', { status: 200, headers: responseHeaders }))
    );

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`, {
        headers: { cookie: 'sam_port_access=valid-jwt' },
      }),
      env
    );

    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] })
      .getSetCookie;
    const setCookies = getSetCookie
      ? getSetCookie.call(response.headers)
      : [response.headers.get('set-cookie') ?? ''];
    expect(setCookies.join('\n')).toContain('preview_session=ordinary');
    expect(setCookies.join('\n')).toContain('preview_parent=ordinary');
    expect(setCookies.join('\n')).toContain('vm_session_extension=ordinary');
    expect(setCookies.join('\n')).toContain('better-auth.session_extension=ordinary');
    expect(setCookies.join('\n')).not.toMatch(/Domain=/i);
    expect(setCookies.join('\n')).not.toContain('sam_port_access=');
    expect(setCookies.join('\n')).not.toContain('vm_session=');
    expect(setCookies.join('\n')).not.toContain('better-auth.session_token=');
  });

  it('removes cookie-clearing Clear-Site-Data directives from preview responses', async () => {
    mockVerifyPortAccessToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      port: 3000,
      subject: 'user-1',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('container page', {
            status: 200,
            headers: { 'Clear-Site-Data': '"cache", "cookies", "storage"' },
          })
      )
    );

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}--3000.workspaces.example.com/`, {
        headers: { cookie: 'sam_port_access=valid-jwt' },
      }),
      env
    );

    expect(response.headers.get('clear-site-data')).toBe('"cache", "storage"');
  });

  it('rejects a preview sibling Origin on privileged workspace WebSockets', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}.workspaces.example.com/agent/ws`, {
        headers: {
          upgrade: 'websocket',
          origin: `https://ws-${WORKSPACE_ID}--3000.workspaces.example.com`,
        },
      }),
      env
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves exact app-origin and no-Origin privileged WebSocket flows', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });

    for (const origin of ['https://app.workspaces.example.com', null]) {
      const headers = new Headers({ upgrade: 'websocket' });
      if (origin) headers.set('origin', origin);
      const response = await worker.default.fetch(
        new Request(`https://ws-${WORKSPACE_ID}.workspaces.example.com/agent/ws`, { headers }),
        env
      );
      expect(response.status).toBe(200);
    }
  });

  it('preserves terminal token auth for non-port workspace requests', async () => {
    mockVerifyTerminalToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      subject: 'user-1',
    });

    const response = await worker.default.fetch(
      new Request(`https://ws-${WORKSPACE_ID}.workspaces.example.com/terminal?token=terminal-jwt`),
      env
    );

    // Non-port workspace request should still work with terminal token
    expect(response.status).toBe(200);
    expect(mockVerifyTerminalToken).toHaveBeenCalledWith('terminal-jwt', env);
  });
});
