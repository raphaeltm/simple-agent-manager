import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MODEL_CATALOG_CACHE_TTL_SECONDS,
  DEFAULT_MODEL_CATALOG_SOURCE_URL,
  getModelCatalogForAgent,
  normalizeOpenCodeModelGroups,
} from '../../../src/services/model-catalog';

interface MockKv {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
}

function makeKv(cached: unknown = null): MockKv & KVNamespace {
  return {
    get: vi.fn().mockResolvedValue(cached),
    put: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockKv & KVNamespace;
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    KV: makeKv(),
    ...overrides,
  } as Parameters<typeof getModelCatalogForAgent>[0];
}

function modelsDevCatalog() {
  return {
    opencode: {
      name: 'OpenCode Zen',
      models: {
        sonnet: { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        deprecated: { id: 'old-model', name: 'Old Model', status: 'deprecated' },
      },
    },
    'opencode-go': {
      name: 'OpenCode Go',
      models: {
        glm: { id: 'glm-5.2', name: 'GLM-5.2' },
      },
    },
  };
}

describe('model catalog service', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns static catalog responses for non-OpenCode agents', async () => {
    const catalog = await getModelCatalogForAgent(makeEnv(), 'claude-code');

    expect(catalog.source).toBe('static');
    expect(catalog.updatedAt).toBeNull();
    expect(catalog.groups.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes OpenCode provider models and filters deprecated entries', () => {
    const groups = normalizeOpenCodeModelGroups(modelsDevCatalog());

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      label: 'OpenCode Zen',
      models: [{ id: 'opencode/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
    });
    expect(groups[1]).toMatchObject({
      label: 'OpenCode Go',
      models: [{ id: 'opencode-go/glm-5.2', name: 'GLM-5.2' }],
    });
    expect(groups.flatMap((group) => group.models).some((model) => model.id.includes('old'))).toBe(
      false
    );
  });

  it('fetches OpenCode models dynamically and writes the normalized cache payload', async () => {
    const kv = makeKv();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(modelsDevCatalog()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const catalog = await getModelCatalogForAgent(
      makeEnv({
        KV: kv,
        MODEL_CATALOG_SOURCE_URL: 'https://catalog.example.test/api.json',
        MODEL_CATALOG_CACHE_TTL_SECONDS: '120',
      }),
      'opencode'
    );

    expect(catalog.source).toBe('dynamic');
    expect(catalog.updatedAt).toEqual(expect.any(String));
    expect(catalog.groups.flatMap((group) => group.models).map((model) => model.id)).toEqual([
      'opencode/claude-sonnet-4-6',
      'opencode-go/glm-5.2',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://catalog.example.test/api.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(kv.put).toHaveBeenCalledWith(
      'model-catalog:v1:opencode:active',
      expect.stringContaining('opencode-go/glm-5.2'),
      { expirationTtl: 120 }
    );
  });

  it('returns a cached OpenCode catalog without fetching upstream', async () => {
    const cached = {
      groups: [
        {
          label: 'OpenCode Go',
          models: [{ id: 'opencode-go/glm-5.2', name: 'GLM-5.2', group: 'OpenCode Go' }],
        },
      ],
      updatedAt: '2026-06-27T00:00:00.000Z',
    };
    const catalog = await getModelCatalogForAgent(makeEnv({ KV: makeKv(cached) }), 'opencode');

    expect(catalog).toEqual({
      agentType: 'opencode',
      groups: cached.groups,
      source: 'cache',
      updatedAt: cached.updatedAt,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the static OpenCode catalog when upstream fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('catalog unavailable'));

    const catalog = await getModelCatalogForAgent(makeEnv(), 'opencode');

    expect(catalog.source).toBe('static');
    expect(catalog.updatedAt).toBeNull();
    expect(
      catalog.groups
        .flatMap((group) => group.models)
        .some((model) => model.id === 'opencode-go/glm-5.2')
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      DEFAULT_MODEL_CATALOG_SOURCE_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('uses default cache TTL when the configured value is outside bounds', async () => {
    const kv = makeKv();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(modelsDevCatalog()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await getModelCatalogForAgent(
      makeEnv({
        KV: kv,
        MODEL_CATALOG_CACHE_TTL_SECONDS: '5',
      }),
      'opencode'
    );

    expect(kv.put).toHaveBeenCalledWith('model-catalog:v1:opencode:active', expect.any(String), {
      expirationTtl: DEFAULT_MODEL_CATALOG_CACHE_TTL_SECONDS,
    });
  });
});
