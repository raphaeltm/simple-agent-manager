/**
 * Workspace proxy: cf-container (Instant) port routes.
 *
 * Drives the real Worker fetch handler for ws-<id>--<port> requests on a
 * workspace with public ports enabled, and captures what reaches the vm-agent
 * container binding. Verifies:
 * - the container vm-agent's own port is refused before any token is minted or
 *   the container is called (the port comes from the container config, not a constant)
 * - a dev-server port is still proxied, with the relay marker the vm-agent uses to
 *   withhold loopback trust
 * - non-port container routes carry the same marker
 * - VM runtime routing for the same port number is unchanged
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
let nodeRuntime: 'vm' | 'cf-container' = 'cf-container';
const terminalSessionResult = {
  sessionId: 'session-1',
  userId: 'user-1',
  expiresAt: new Date(Date.now() + 60 * 60_000),
  userRole: 'user',
  userStatus: 'active',
};

vi.mock('../../src/auth', () => ({
  createAuth: vi.fn(() => ({ api: { getSession: mockGetSession } })),
}));

vi.mock('../../src/services/jwt', () => ({
  verifyTerminalToken: mockVerifyTerminalToken,
  signTerminalToken: mockSignTerminalToken,
  verifyPortAccessToken: mockVerifyPortAccessToken,
}));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }), {
  virtual: true,
});
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  switchPort: vi.fn((request: Request) => request),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    select: vi.fn((selection?: Record<string, unknown>) => {
      const getResult = async () => {
        if (selection && 'runtime' in selection) return { runtime: nodeRuntime };
        if (selection && 'sessionId' in selection) return terminalSessionResult;
        if (selection && 'value' in selection) return null;
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

const WORKSPACE_ID = '01KR1000000000000000000001';
const proxyHttp = vi.fn();
const containerFetch = vi.fn();
const containerBinding = {
  idFromName: vi.fn(() => 'do-id'),
  get: vi.fn(() => ({ proxyHttp, fetch: containerFetch })),
};

function containerEnv(overrides: Record<string, string> = {}) {
  return {
    BASE_DOMAIN: 'workspaces.example.com',
    DATABASE: {},
    VM_AGENT_PROTOCOL: 'https',
    VM_AGENT_PORT: '8443',
    CF_CONTAINER_ENABLED: 'true',
    VM_AGENT_CONTAINER: containerBinding,
    ...overrides,
  };
}

function publicPortRequest(port: number, path = '/git-credential?host=github.com') {
  return new Request(
    `https://ws-${WORKSPACE_ID.toLowerCase()}--${port}.workspaces.example.com${path}`
  );
}

describe('cf-container workspace port routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nodeRuntime = 'cf-container';
    workspaceResult = {
      nodeId: 'node-1',
      status: 'running',
      userId: 'user-1',
      portsPublicEnabled: true,
    };
    mockGetSession.mockResolvedValue(null);
    mockVerifyTerminalToken.mockRejectedValue(new Error('Invalid token'));
    mockSignTerminalToken.mockResolvedValue({
      token: 'backend-port-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    proxyHttp.mockImplementation(async () => new Response('proxied', { status: 200 }));
    containerFetch.mockImplementation(async () => new Response('upgraded', { status: 200 }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('vm proxied', { status: 200 }))
    );
  });

  it.each(['vm', 'cf-container'] as const)(
    'strips SAM cookies and returns preview redirects for %s',
    async (runtime) => {
      nodeRuntime = runtime;
      const redirectResponse = () =>
        new Response(null, { status: 302, headers: { location: '/assets/probe.txt' } });
      proxyHttp.mockImplementation(async () => redirectResponse());
      vi.mocked(fetch).mockImplementation(async () => redirectResponse());
      const request = publicPortRequest(3000, '/redirect');
      request.headers.set(
        'cookie',
        'sam_port_access=preview; vm_session=legacy; vm_session_ws=scoped; __Secure-better-auth.session_token=login; __Host-better-auth.session_data=data; app_session=app; theme=dark'
      );
      const response = await worker.default.fetch(request, containerEnv());
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/assets/probe.txt');
      const forwarded =
        runtime === 'cf-container'
          ? (proxyHttp.mock.calls[0]![0] as Request)
          : new Request(vi.mocked(fetch).mock.calls[0]![0], vi.mocked(fetch).mock.calls[0]![1]);
      expect(forwarded.headers.get('cookie')).toBe('app_session=app; theme=dark');
      expect(forwarded.redirect).toBe('manual');
    }
  );

  it('refuses the container vm-agent port on a public port route', async () => {
    const response = await worker.default.fetch(publicPortRequest(8080), containerEnv());

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('PORT_RESERVED');
    expect(proxyHttp).not.toHaveBeenCalled();
    expect(mockSignTerminalToken).not.toHaveBeenCalled();
  });

  it('derives the reserved port from the container config', async () => {
    const env = containerEnv({ CF_CONTAINER_VM_AGENT_PORT: '9090' });

    const reserved = await worker.default.fetch(publicPortRequest(9090), env);
    expect(reserved.status).toBe(403);
    expect(proxyHttp).not.toHaveBeenCalled();

    const ordinary = await worker.default.fetch(publicPortRequest(8080, '/'), env);
    expect(ordinary.status).toBe(200);
    expect(proxyHttp).toHaveBeenCalledTimes(1);
    expect(proxyHttp.mock.calls[0]?.[1]).toBe(9090);
  });

  it('falls back to the default reserved port when the configured port is malformed', async () => {
    const env = containerEnv({ CF_CONTAINER_VM_AGENT_PORT: 'not-a-port' });

    const reserved = await worker.default.fetch(publicPortRequest(8080), env);
    expect(reserved.status).toBe(403);
    expect(proxyHttp).not.toHaveBeenCalled();

    const ordinary = await worker.default.fetch(publicPortRequest(3000, '/'), env);
    expect(ordinary.status).toBe(200);
    expect(proxyHttp.mock.calls[0]?.[1]).toBe(8080);
  });

  it('applies the reserved port and relay marker to WebSocket upgrades', async () => {
    const upgrade = {
      upgrade: 'websocket',
      connection: 'Upgrade',
      cookie: 'sam_port_access=preview; vm_session_ws=scoped; app_session=app',
    };
    const base = `https://ws-${WORKSPACE_ID.toLowerCase()}`;

    const reserved = await worker.default.fetch(
      new Request(`${base}--8080.workspaces.example.com/`, { headers: upgrade }),
      containerEnv()
    );
    expect(reserved.status).toBe(403);
    expect(containerFetch).not.toHaveBeenCalled();

    const ordinary = await worker.default.fetch(
      new Request(`${base}--3000.workspaces.example.com/ws`, { headers: upgrade }),
      containerEnv()
    );
    expect(ordinary.status).toBe(200);
    expect(proxyHttp).not.toHaveBeenCalled();
    const [forwarded] = containerFetch.mock.calls[0] as [Request];
    expect(new URL(forwarded.url).pathname).toBe(`/workspaces/${WORKSPACE_ID}/ports/3000/ws`);
    expect(forwarded.headers.get('cookie')).toBe('app_session=app');
    expect(forwarded.headers.get('X-SAM-Proxied-Request')).toBe('1');
  });

  it('still proxies a dev-server port and marks the request as relayed', async () => {
    const response = await worker.default.fetch(
      publicPortRequest(3000, '/app?x=1'),
      containerEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('proxied');
    expect(proxyHttp).toHaveBeenCalledTimes(1);
    const [forwarded, port] = proxyHttp.mock.calls[0] as [Request, number];
    expect(port).toBe(8080);
    const url = new URL(forwarded.url);
    expect(url.host).toBe('localhost:8080');
    expect(url.pathname).toBe(`/workspaces/${WORKSPACE_ID}/ports/3000/app`);
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.searchParams.get('token')).toBe('backend-port-token');
    expect(forwarded.headers.get('X-SAM-Proxied-Request')).toBe('1');
    expect(forwarded.headers.get('X-Forwarded-Host')).toBe(
      `ws-${WORKSPACE_ID.toLowerCase()}--3000.workspaces.example.com`
    );
  });

  it('marks non-port container routes as relayed too', async () => {
    mockVerifyTerminalToken.mockResolvedValue({
      workspace: WORKSPACE_ID,
      subject: 'user-1',
      sessionToken: 'token-session-1',
    });

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${WORKSPACE_ID.toLowerCase()}.workspaces.example.com/git-credential?token=terminal-jwt`,
        { headers: { cookie: 'vm_session_ws=agent-session' } }
      ),
      containerEnv()
    );

    expect(response.status).toBe(200);
    const [forwarded] = proxyHttp.mock.calls[0] as [Request, number];
    expect(new URL(forwarded.url).pathname).toBe('/git-credential');
    expect(forwarded.headers.get('cookie')).toBe('vm_session_ws=agent-session');
    expect(forwarded.headers.get('X-SAM-Proxied-Request')).toBe('1');
  });

  it('leaves VM runtime port routing unchanged for the same port number', async () => {
    nodeRuntime = 'vm';

    const response = await worker.default.fetch(publicPortRequest(8080, '/'), containerEnv());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('vm proxied');
    expect(proxyHttp).not.toHaveBeenCalled();
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const input = fetchMock.mock.calls[0]?.[0];
    const target = new URL(input instanceof Request ? input.url : String(input));
    expect(target.host).toBe('node-1.vm.workspaces.example.com:8443');
    expect(target.pathname).toBe(`/workspaces/${WORKSPACE_ID}/ports/8080`);
  });
});
