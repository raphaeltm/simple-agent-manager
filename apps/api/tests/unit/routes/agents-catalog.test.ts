import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { agentsCatalogRoutes } from '../../../src/routes/agents-catalog';

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn().mockResolvedValue('{"accessKey":"scw","secretKey":"secret"}'),
  encrypt: vi.fn(),
}));

const { decrypt } = await import('../../../src/services/encryption');

type QueryResult = Record<string, unknown>[];

interface CatalogDbState {
  agentCredentials?: QueryResult;
  scalewayCloudCredentials?: QueryResult;
  platformCloudCredentials?: QueryResult;
}

function makeCatalogDb(state: CatalogDbState) {
  let selectCount = 0;

  return {
    select: vi.fn(() => {
      selectCount += 1;
      const result =
        selectCount === 1
          ? state.agentCredentials ?? []
          : selectCount === 2
            ? state.scalewayCloudCredentials ?? []
            : state.platformCloudCredentials ?? [];
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn(() => (selectCount === 1 ? Promise.resolve(result) : builder)),
        limit: vi.fn(() => Promise.resolve(result)),
      };
      return builder;
    }),
  };
}

describe('GET /api/agents', () => {
  let app: Hono<{ Bindings: Env }>;

  function env(overrides: Partial<Env> = {}): Env {
    return {
      DATABASE: {} as D1Database,
      ENCRYPTION_KEY: 'test-encryption-key',
      KV: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as KVNamespace,
      ...overrides,
    } as Env;
  }

  async function listAgents(bindings: Env = env()) {
    const response = await app.request('/api/agents', { method: 'GET' }, bindings);
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      agents: Array<{
        id: string;
        configured: boolean;
        fallbackCredentialSource: string | null;
      }>;
    }>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decrypt).mockResolvedValue('{"accessKey":"scw","secretKey":"secret"}');
    app = new Hono<{ Bindings: Env }>();
    app.route('/api/agents', agentsCatalogRoutes);
  });

  it('marks OpenCode configured via a dedicated key before any fallback', async () => {
    vi.mocked(drizzle).mockReturnValue(makeCatalogDb({
      agentCredentials: [{ agentType: 'opencode' }],
      scalewayCloudCredentials: [{ id: 'scw-cred' }],
      platformCloudCredentials: [{ id: 'platform-cred', provider: 'scaleway' }],
    }) as ReturnType<typeof drizzle>);

    const { agents } = await listAgents();
    const opencode = agents.find((agent) => agent.id === 'opencode');

    expect(opencode).toMatchObject({
      configured: true,
      fallbackCredentialSource: null,
    });
  });

  it('marks OpenCode configured via Scaleway fallback before platform fallback', async () => {
    vi.mocked(drizzle).mockReturnValue(makeCatalogDb({
      scalewayCloudCredentials: [{ id: 'scw-cred' }],
      platformCloudCredentials: [{ id: 'platform-cred', provider: 'scaleway' }],
    }) as ReturnType<typeof drizzle>);

    const { agents } = await listAgents();
    const opencode = agents.find((agent) => agent.id === 'opencode');

    expect(opencode).toMatchObject({
      configured: true,
      fallbackCredentialSource: 'scaleway-cloud',
    });
  });

  it('marks OpenCode configured via platform availability when no user fallback exists', async () => {
    vi.mocked(drizzle).mockReturnValue(makeCatalogDb({
      agentCredentials: [{ agentType: 'claude-code' }],
      platformCloudCredentials: [{ id: 'platform-cred', provider: 'scaleway' }],
    }) as ReturnType<typeof drizzle>);

    const { agents } = await listAgents();
    const opencode = agents.find((agent) => agent.id === 'opencode');
    const claude = agents.find((agent) => agent.id === 'claude-code');

    expect(opencode).toMatchObject({
      configured: true,
      fallbackCredentialSource: 'platform-opencode',
    });
    expect(claude).toMatchObject({
      configured: true,
      fallbackCredentialSource: null,
    });
  });

  it('matches trial semantics for platform credential decryption operation errors', async () => {
    vi.mocked(decrypt).mockRejectedValueOnce(new DOMException('decrypt failed', 'OperationError'));
    vi.mocked(drizzle).mockReturnValue(makeCatalogDb({
      platformCloudCredentials: [{ id: 'platform-cred', provider: 'scaleway' }],
    }) as ReturnType<typeof drizzle>);

    const { agents } = await listAgents();
    const opencode = agents.find((agent) => agent.id === 'opencode');

    expect(opencode).toMatchObject({
      configured: true,
      fallbackCredentialSource: 'platform-opencode',
    });
  });

  it('does not mark OpenCode configured when AI proxy is disabled', async () => {
    vi.mocked(drizzle).mockReturnValue(makeCatalogDb({
      platformCloudCredentials: [{ id: 'platform-cred', provider: 'scaleway' }],
    }) as ReturnType<typeof drizzle>);

    const { agents } = await listAgents(env({ AI_PROXY_ENABLED: 'false' } as Partial<Env>));
    const opencode = agents.find((agent) => agent.id === 'opencode');

    expect(opencode).toMatchObject({
      configured: false,
      fallbackCredentialSource: null,
    });
  });

  it('does not mark OpenCode configured when platform infra is unavailable', async () => {
    vi.mocked(drizzle).mockReturnValue(makeCatalogDb({}) as ReturnType<typeof drizzle>);

    const { agents } = await listAgents();
    const opencode = agents.find((agent) => agent.id === 'opencode');

    expect(opencode).toMatchObject({
      configured: false,
      fallbackCredentialSource: null,
    });
  });

  it('keeps the catalog available when the non-critical platform check fails', async () => {
    vi.mocked(decrypt).mockRejectedValueOnce(new Error('configuration error'));
    vi.mocked(drizzle).mockReturnValue(makeCatalogDb({
      platformCloudCredentials: [{ id: 'platform-cred', provider: 'scaleway' }],
    }) as ReturnType<typeof drizzle>);

    const { agents } = await listAgents();
    const opencode = agents.find((agent) => agent.id === 'opencode');

    expect(opencode).toMatchObject({
      configured: false,
      fallbackCredentialSource: null,
    });
  });
});
