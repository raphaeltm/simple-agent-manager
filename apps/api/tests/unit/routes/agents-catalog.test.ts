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

type QueryResult = Record<string, unknown>[];

interface CatalogDbState {
  agentCredentials?: QueryResult;
  agentProviderSettings?: QueryResult;
}

function makeCatalogDb(state: CatalogDbState) {
  let selectCount = 0;
  const selectResults = [state.agentCredentials ?? [], state.agentProviderSettings ?? []];

  return {
    select: vi.fn(() => {
      selectCount += 1;
      const result = selectResults[selectCount - 1] ?? [];
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn(() => Promise.resolve(result)),
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
    app = new Hono<{ Bindings: Env }>();
    app.route('/api/agents', agentsCatalogRoutes);
  });

  it('marks OpenCode configured via a dedicated key', async () => {
    vi.mocked(drizzle).mockReturnValue(
      makeCatalogDb({
        agentCredentials: [{ agentType: 'opencode' }],
      }) as ReturnType<typeof drizzle>
    );

    const { agents } = await listAgents();
    const opencode = agents.find((agent) => agent.id === 'opencode');

    expect(opencode).toMatchObject({
      configured: true,
      fallbackCredentialSource: null,
    });
  });

  it('includes Amp as an API-key agent without proxy fallback', async () => {
    vi.mocked(drizzle).mockReturnValue(
      makeCatalogDb({
        agentCredentials: [{ agentType: 'amp' }],
      }) as ReturnType<typeof drizzle>
    );

    const { agents } = await listAgents();
    const amp = agents.find((agent) => agent.id === 'amp');

    expect(amp).toMatchObject({
      configured: true,
      fallbackCredentialSource: null,
    });
  });

  it('does not mark OpenCode configured without a dedicated key', async () => {
    vi.mocked(drizzle).mockReturnValue(makeCatalogDb({}) as ReturnType<typeof drizzle>);

    const { agents } = await listAgents();
    const opencode = agents.find((agent) => agent.id === 'opencode');

    expect(opencode).toMatchObject({
      configured: false,
      fallbackCredentialSource: null,
    });
  });

  it('marks Claude Code configured via SAM provider mode when proxy is enabled', async () => {
    vi.mocked(drizzle).mockReturnValue(
      makeCatalogDb({
        agentProviderSettings: [{ agentType: 'claude-code', providerMode: 'sam' }],
      }) as ReturnType<typeof drizzle>
    );

    const { agents } = await listAgents();
    const claude = agents.find((agent) => agent.id === 'claude-code');

    expect(claude).toMatchObject({
      configured: true,
      fallbackCredentialSource: 'platform-sam',
    });
  });

  it('does not mark Claude Code configured via SAM provider mode when proxy is disabled', async () => {
    vi.mocked(drizzle).mockReturnValue(
      makeCatalogDb({
        agentProviderSettings: [{ agentType: 'claude-code', providerMode: 'sam' }],
      }) as ReturnType<typeof drizzle>
    );

    const { agents } = await listAgents(env({ AI_PROXY_ENABLED: 'false' } as Partial<Env>));
    const claude = agents.find((agent) => agent.id === 'claude-code');

    expect(claude).toMatchObject({
      configured: false,
      fallbackCredentialSource: null,
    });
  });

  it('does not mark OpenCode configured via SAM provider mode', async () => {
    // SAM provider fallback only applies to claude-code / openai-codex, never opencode.
    vi.mocked(drizzle).mockReturnValue(
      makeCatalogDb({
        agentProviderSettings: [{ agentType: 'opencode', providerMode: 'sam' }],
      }) as ReturnType<typeof drizzle>
    );

    const { agents } = await listAgents();
    const opencode = agents.find((agent) => agent.id === 'opencode');

    expect(opencode).toMatchObject({
      configured: false,
      fallbackCredentialSource: null,
    });
  });

  it('prefers a dedicated key over SAM provider mode for Claude Code', async () => {
    vi.mocked(drizzle).mockReturnValue(
      makeCatalogDb({
        agentCredentials: [{ agentType: 'claude-code' }],
        agentProviderSettings: [{ agentType: 'claude-code', providerMode: 'sam' }],
      }) as ReturnType<typeof drizzle>
    );

    const { agents } = await listAgents();
    const claude = agents.find((agent) => agent.id === 'claude-code');

    // Dedicated key wins; no SAM fallback source.
    expect(claude).toMatchObject({
      configured: true,
      fallbackCredentialSource: null,
    });
  });

  it('returns an empty configuration when no credentials or provider settings exist', async () => {
    vi.mocked(drizzle).mockReturnValue(makeCatalogDb({}) as ReturnType<typeof drizzle>);

    const { agents } = await listAgents();
    const opencode = agents.find((agent) => agent.id === 'opencode');
    const claude = agents.find((agent) => agent.id === 'claude-code');

    expect(opencode).toMatchObject({ configured: false, fallbackCredentialSource: null });
    expect(claude).toMatchObject({ configured: false, fallbackCredentialSource: null });
  });
});
