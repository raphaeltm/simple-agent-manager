import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.fn();
const mockSignLocalForwardToken = vi.fn();
const mockVerifyLocalForwardToken = vi.fn();
let workspaceResult: { id?: string; nodeId: string | null; status: string; userId?: string } | null = null;

vi.mock('../../../src/auth', () => ({
  createAuth: vi.fn(() => ({
    api: {
      getSession: mockGetSession,
    },
  })),
}));

vi.mock('../../../src/services/jwt', () => ({
  signLocalForwardToken: mockSignLocalForwardToken,
  verifyLocalForwardToken: mockVerifyLocalForwardToken,
  verifyTerminalToken: vi.fn(),
  signTerminalToken: vi.fn(),
  verifyPortAccessToken: vi.fn(),
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
          limit: vi.fn(async () => (workspaceResult ? [workspaceResult] : [])),
          get: vi.fn(async () => workspaceResult),
        })),
      })),
    })),
  })),
}));

const worker = await import('../../../src/index');

const env = {
  BASE_DOMAIN: 'workspaces.example.com',
  DATABASE: {},
  VM_AGENT_PROTOCOL: 'https',
  VM_AGENT_PORT: '8443',
};

describe('workspace local-forward routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceResult = { id: 'ws-1', nodeId: 'node-1', status: 'running', userId: 'user-1' };
    mockGetSession.mockResolvedValue({
      user: { id: 'user-1' },
      session: { id: 'session-1', expiresAt: new Date() },
    });
    mockSignLocalForwardToken.mockResolvedValue({
      token: 'forward-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mockVerifyLocalForwardToken.mockResolvedValue({
      userId: 'user-1',
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      remotePort: 5173,
      mode: 'http',
      localAuthority: 'localhost:5173',
      subject: 'user-1',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('proxied', {
          status: 200,
          headers: [['Set-Cookie', 'app_session=next; Path=/']],
        }),
      ),
    );
  });

  it('mints a short-lived local-forward session scoped to localhost authority', async () => {
    const response = await worker.default.fetch(
      new Request('https://api.workspaces.example.com/api/workspaces/ws-1/forwards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remotePort: 5173,
          mode: 'http',
          localAuthority: 'localhost:5173',
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(mockSignLocalForwardToken).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      remotePort: 5173,
      mode: 'http',
      localAuthority: 'localhost:5173',
    }, env);
    expect(await response.json()).toMatchObject({
      token: 'forward-token',
      workspaceId: 'ws-1',
      nodeId: 'node-1',
      remotePort: 5173,
      localAuthority: 'localhost:5173',
    });
  });

  it('rejects non-loopback local authority during session creation', async () => {
    const response = await worker.default.fetch(
      new Request('https://api.workspaces.example.com/api/workspaces/ws-1/forwards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remotePort: 5173,
          mode: 'http',
          localAuthority: 'evil.example.com:5173',
        }),
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(mockSignLocalForwardToken).not.toHaveBeenCalled();
  });

  it('proxies with internal VM token and strips spoofable browser headers', async () => {
    const response = await worker.default.fetch(
      new Request('https://api.workspaces.example.com/api/workspaces/ws-1/local-forward/5173/path?x=1', {
        headers: {
          Authorization: 'Bearer app-token',
          Cookie: 'app_cookie=abc',
          'X-SAM-Forward-Token': 'forward-token',
          'X-SAM-VM-Forward-Token': 'spoofed',
          'X-Forwarded-Host': 'evil.example.com',
          Forwarded: 'for=evil',
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [proxiedUrl, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(new URL(String(proxiedUrl)).toString()).toBe(
      'https://node-1.vm.workspaces.example.com:8443/workspaces/ws-1/local-forward/5173/path?x=1',
    );
    const headers = init?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer app-token');
    expect(headers.get('Cookie')).toBe('app_cookie=abc');
    expect(headers.get('X-SAM-VM-Forward-Token')).toBe('forward-token');
    expect(headers.get('X-SAM-Forward-Token')).toBeNull();
    expect(headers.get('Forwarded')).toBeNull();
    expect(headers.get('X-Forwarded-Host')).toBe('localhost:5173');
    expect(response.headers.get('Set-Cookie')).toContain('app_session=next');
  });

  it('returns clear unsupported response for WebSocket upgrades', async () => {
    const response = await worker.default.fetch(
      new Request('https://api.workspaces.example.com/api/workspaces/ws-1/local-forward/5173/', {
        headers: {
          Upgrade: 'websocket',
          'X-SAM-Forward-Token': 'forward-token',
        },
      }),
      env,
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: 'UNSUPPORTED_UPGRADE' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
