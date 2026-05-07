import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.fn();
let workspaceResult: { nodeId: string; status: string } | null = null;

vi.mock('../../src/auth', () => ({
  createAuth: vi.fn(() => ({
    api: {
      getSession: mockGetSession,
    },
  })),
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
    mockGetSession.mockResolvedValue({
      user: { id: 'user-owner' },
      session: { id: 'session-owner', expiresAt: new Date() },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('proxied', { status: 200 })),
    );
  });

  it('rejects unauthenticated workspace subdomain requests', async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await worker.default.fetch(
      new Request(`https://ws-${OWNER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/terminal`),
      env,
    );

    expect(response.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 404 when the authenticated user does not own the workspace', async () => {
    workspaceResult = null;

    const response = await worker.default.fetch(
      new Request(`https://ws-${OTHER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/terminal`),
      env,
    );

    expect(response.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('proxies workspace subdomain requests owned by the authenticated user', async () => {
    const response = await worker.default.fetch(
      new Request(`https://ws-${OWNER_WORKSPACE_ID.toLowerCase()}.workspaces.example.com/terminal`),
      env,
    );

    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const firstFetchCall = vi.mocked(globalThis.fetch).mock.calls.at(0);
    expect(firstFetchCall).toBeDefined();
    const proxiedUrl = new URL(String(firstFetchCall?.[0]));
    expect(proxiedUrl.hostname).toBe('node-owner.vm.workspaces.example.com');
  });
});
