import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.fn();
const mockVerifyTerminalToken = vi.fn();
const mockSignTerminalToken = vi.fn();
let workspaceResult: { nodeId: string; status: string } | null = null;
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

const OWNER_WORKSPACE_ID = '01KR1000000000000000000001';
const OTHER_WORKSPACE_ID = '01KR1000000000000000000002';

const env = {
  BASE_DOMAIN: 'workspaces.example.com',
  DATABASE: {},
  VM_AGENT_PROTOCOL: 'https',
  VM_AGENT_PORT: '8443',
};

describe('workspace subdomain proxy ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceResult = { nodeId: 'node-owner', status: 'running' };
    terminalSessionResult = {
      sessionId: 'session-owner',
      userId: 'user-owner',
      expiresAt: new Date(Date.now() + 60_000),
      userRole: 'user',
      userStatus: 'active',
    };
    platformSettingResult = null;
    mockGetSession.mockResolvedValue({
      user: { id: 'user-owner' },
      session: { id: 'session-owner', token: 'token-owner', expiresAt: new Date() },
    });
    mockVerifyTerminalToken.mockResolvedValue({
      workspace: OWNER_WORKSPACE_ID,
      subject: 'user-owner',
      sessionToken: 'token-owner',
    });
    mockSignTerminalToken.mockResolvedValue({
      token: 'backend-port-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('proxied', { status: 200 }))
    );
  });

  it('rejects unauthenticated workspace subdomain requests', async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await worker.default.fetch(
      new Request(`https://ws-${OWNER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/terminal`),
      env
    );

    expect(response.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects suspended browser-session workspace subdomain requests before proxying', async () => {
    mockGetSession.mockResolvedValue({
      user: { id: 'user-owner', status: 'suspended', role: 'admin' },
      session: { id: 'session-owner', token: 'token-owner', expiresAt: new Date() },
    });

    const response = await worker.default.fetch(
      new Request(`https://ws-${OWNER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/terminal`),
      env
    );

    expect(response.status).toBe(403);
    expect(mockGetSession).toHaveBeenCalledWith(
      expect.objectContaining({ query: { disableCookieCache: true } })
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('proxies workspace subdomain requests authorized by terminal token when no app session cookie is present', async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${OWNER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/agent/ws?token=valid-terminal-token`
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(mockVerifyTerminalToken).toHaveBeenCalledWith('valid-terminal-token', env);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const firstFetchCall = vi.mocked(globalThis.fetch).mock.calls.at(0);
    expect(firstFetchCall).toBeDefined();
    const proxiedUrl = new URL(String(firstFetchCall?.[0]));
    expect(proxiedUrl.hostname).toBe('node-owner.vm.workspaces.example.com');
    expect(proxiedUrl.searchParams.get('token')).toBe('valid-terminal-token');
  });

  it('rejects a captured terminal token after the minting session row is gone', async () => {
    mockGetSession.mockResolvedValue(null);
    terminalSessionResult = null;

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${OWNER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/terminal/ws/multi?token=logout-revoked-token`
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects a terminal token without a minting session claim', async () => {
    mockGetSession.mockResolvedValue(null);
    mockVerifyTerminalToken.mockResolvedValue({
      workspace: OWNER_WORKSPACE_ID,
      subject: 'user-owner',
    });

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${OWNER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/terminal/ws/multi?token=legacy-token`
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects a terminal token for a suspended user even when its session row exists', async () => {
    mockGetSession.mockResolvedValue(null);
    terminalSessionResult = {
      sessionId: 'session-owner',
      userId: 'user-owner',
      expiresAt: new Date(Date.now() + 60_000),
      userRole: 'user',
      userStatus: 'suspended',
    };

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${OWNER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/terminal/ws/multi?token=suspended-token`
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects terminal tokens for a different workspace', async () => {
    mockGetSession.mockResolvedValue(null);
    mockVerifyTerminalToken.mockResolvedValue({
      workspace: OTHER_WORKSPACE_ID,
      subject: 'user-owner',
    });

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${OWNER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/agent/ws?token=wrong-workspace-token`
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects terminal tokens when the token subject does not own the workspace', async () => {
    mockGetSession.mockResolvedValue(null);
    mockVerifyTerminalToken.mockResolvedValue({
      workspace: OTHER_WORKSPACE_ID,
      subject: 'user-other',
      sessionToken: 'token-other',
    });
    terminalSessionResult = {
      sessionId: 'session-other',
      userId: 'user-other',
      expiresAt: new Date(Date.now() + 60_000),
      userRole: 'user',
      userStatus: 'active',
    };
    workspaceResult = null;

    const response = await worker.default.fetch(
      new Request(
        `https://ws-${OTHER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/agent/ws?token=other-user-token`
      ),
      env
    );

    expect(response.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 404 when the authenticated user does not own the workspace', async () => {
    workspaceResult = null;

    const response = await worker.default.fetch(
      new Request(`https://ws-${OTHER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/terminal`),
      env
    );

    expect(response.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('proxies workspace subdomain requests owned by the authenticated user', async () => {
    const response = await worker.default.fetch(
      new Request(`https://ws-${OWNER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/terminal`),
      env
    );

    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const firstFetchCall = vi.mocked(globalThis.fetch).mock.calls.at(0);
    expect(firstFetchCall).toBeDefined();
    const proxiedUrl = new URL(String(firstFetchCall?.[0]));
    expect(proxiedUrl.hostname).toBe('node-owner.vm.workspaces.example.com');
  });
});
