import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AgentModelCatalogEntry, AgentModelCategory } from '@simple-agent-manager/shared';
import { DEFAULT_AGENT_MODEL_DEFAULT_CATEGORIES } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../../src/env';
import {
  buildCatalogResponse,
  getAgentModelCatalog,
  normalizeCatalog,
  normalizeCatalogModel,
  resetAgentModelCatalogCacheForTests,
} from '../../../../src/services/agent-models/catalog';

// Mirrors the Cloudflare /ai/models/search response's `.result` array exactly (73 real rows),
// pretty-printed. See apps/api/tests/fixtures/workers-ai-catalog.json for provenance.
const catalogFixture: unknown[] = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/workers-ai-catalog.json'), 'utf8')
);

function realRow(id: string): unknown {
  const row = (catalogFixture as Array<Record<string, unknown>>).find((entry) => entry.name === id);
  if (!row) throw new Error(`fixture row not found: ${id}`);
  return row;
}

function fakeModel(id: string, category: AgentModelCategory): AgentModelCatalogEntry {
  const [, author = '', name = id] = id.split('/');
  return {
    id,
    name,
    author,
    description: '',
    category,
    task: '',
    prices: [],
    contextWindow: null,
    capabilities: [],
    beta: false,
    partner: false,
    infoUrl: null,
    termsUrl: null,
  };
}

describe('normalizeCatalog / normalizeCatalogModel (real catalog fixture)', () => {
  it('keeps all 73 real catalog models, sorted by id', () => {
    const result = normalizeCatalog(catalogFixture);
    expect(result).toHaveLength(73);
    const ids = result.map((model) => model.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('categorizes the clef family as decision and clairic as extraction', () => {
    const byId = new Map(normalizeCatalog(catalogFixture).map((model) => [model.id, model]));
    expect(byId.get('@cf/cloudflare/clef')?.category).toBe('decision');
    expect(byId.get('@cf/cloudflare/clef-flash')?.category).toBe('decision');
    expect(byId.get('@cf/cloudflare/clef-omni')?.category).toBe('decision');
    expect(byId.get('@cf/cloudflare/clairic')?.category).toBe('extraction');
  });

  it('categorizes bge-reranker-base, distilbert and resnet-50 as classification', () => {
    const byId = new Map(normalizeCatalog(catalogFixture).map((model) => [model.id, model]));
    expect(byId.get('@cf/baai/bge-reranker-base')?.category).toBe('classification');
    expect(byId.get('@cf/huggingface/distilbert-sst-2-int8')?.category).toBe('classification');
    expect(byId.get('@cf/microsoft/resnet-50')?.category).toBe('classification');
  });

  it('parses a real published price', () => {
    const byId = new Map(normalizeCatalog(catalogFixture).map((model) => [model.id, model]));
    expect(byId.get('@cf/cloudflare/clef-flash')?.prices).toEqual([
      { unit: 'per M input tokens', usd: 0.038 },
    ]);
  });

  it('parses a price the binding returns as a JSON string, the same as an array', () => {
    const asArray = normalizeCatalogModel({
      name: '@cf/cloudflare/clef-flash',
      task: { name: 'Text Generation' },
      properties: [
        {
          property_id: 'price',
          value: [{ unit: 'per M input tokens', price: 0.038, currency: 'USD' }],
        },
      ],
    });
    const asString = normalizeCatalogModel({
      name: '@cf/cloudflare/clef-flash',
      task: { name: 'Text Generation' },
      properties: [
        {
          property_id: 'price',
          value: JSON.stringify([{ unit: 'per M input tokens', price: 0.038, currency: 'USD' }]),
        },
      ],
    });
    expect(asString?.prices).toEqual([{ unit: 'per M input tokens', usd: 0.038 }]);
    expect(asString?.prices).toEqual(asArray?.prices);
  });

  it('treats an unparseable price string as unpublished', () => {
    const model = normalizeCatalogModel({
      name: '@cf/cloudflare/clef-flash',
      task: { name: 'Text Generation' },
      properties: [{ property_id: 'price', value: 'not json' }],
    });
    expect(model?.prices).toEqual([]);
  });

  it('drops a published "0 USD per step" price as unpublished', () => {
    const byId = new Map(normalizeCatalog(catalogFixture).map((model) => [model.id, model]));
    expect(byId.get('@cf/bytedance/stable-diffusion-xl-lightning')?.prices).toEqual([]);
  });

  it('reads real capability flags, including three at once', () => {
    const byId = new Map(normalizeCatalog(catalogFixture).map((model) => [model.id, model]));
    expect([...(byId.get('@cf/google/gemma-4-26b-a4b-it')?.capabilities ?? [])].sort()).toEqual(
      ['function-calling', 'reasoning', 'vision'].sort()
    );
  });

  it('reads real beta and partner flags independently of capabilities', () => {
    const byId = new Map(normalizeCatalog(catalogFixture).map((model) => [model.id, model]));

    const gemma2b = byId.get('@cf/google/gemma-2b-it-lora');
    expect(gemma2b?.capabilities).toEqual(['lora']);
    expect(gemma2b?.beta).toBe(true);
    expect(gemma2b?.partner).toBe(false);

    const phoenix = byId.get('@cf/leonardo/phoenix-1.0');
    expect(phoenix?.capabilities).toEqual([]);
    expect(phoenix?.beta).toBe(false);
    expect(phoenix?.partner).toBe(true);

    const aura = byId.get('@cf/deepgram/aura-1');
    expect(aura?.capabilities).toEqual(['realtime']);
    expect(aura?.partner).toBe(true);
  });

  it('drops a third-party gateway row that does not match the Workers AI id shape', () => {
    const rows = [
      realRow('@cf/cloudflare/clef-flash'),
      { name: 'typesafe/jev', task: { name: 'Text Generation' } },
      { name: 'openai/gpt-5', task: { name: 'Text Generation' } },
      realRow('@cf/cloudflare/clairic'),
    ];
    const result = normalizeCatalog(rows);
    expect(result.map((model) => model.id)).toEqual([
      '@cf/cloudflare/clairic',
      '@cf/cloudflare/clef-flash',
    ]);
  });

  it('skips a row that throws while normalizing, keeping the good rows before and after it (rule 50)', () => {
    const throwingRow = {
      name: '@cf/acme/throws-during-normalize',
      task: { name: 'Text Generation' },
      properties: [
        {
          property_id: 'context_window',
          // Coercing this to a string (`String(...)`) throws — simulates a row whose shape
          // normalization cannot tolerate, without being rejected earlier by a type guard.
          value: {
            toString() {
              throw new Error('boom');
            },
          },
        },
      ],
    };
    const rows = [
      realRow('@cf/cloudflare/clef-flash'),
      throwingRow,
      realRow('@cf/cloudflare/clairic'),
    ];
    const result = normalizeCatalog(rows);
    expect(result.map((model) => model.id)).toEqual([
      '@cf/cloudflare/clairic',
      '@cf/cloudflare/clef-flash',
    ]);
  });

  it('collapses duplicate ids, keeping the later row', () => {
    const rows = [
      { name: '@cf/acme/widget', description: 'first', task: { name: 'Text Generation' } },
      { name: '@cf/acme/widget', description: 'second', task: { name: 'Text Generation' } },
    ];
    const result = normalizeCatalog(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe('second');
  });
});

describe('normalizeCatalogModel info URL handling (synthetic rows)', () => {
  it('drops a non-https info url', () => {
    const model = normalizeCatalogModel({
      name: '@cf/acme/widget',
      task: { name: 'Text Generation' },
      properties: [{ property_id: 'info', value: 'http://example.com/docs' }],
    });
    expect(model?.infoUrl).toBeNull();
  });

  it('keeps a valid https info url', () => {
    const model = normalizeCatalogModel({
      name: '@cf/acme/widget',
      task: { name: 'Text Generation' },
      properties: [{ property_id: 'info', value: 'https://example.com/docs' }],
    });
    expect(model?.infoUrl).toBe('https://example.com/docs');
  });

  it('drops a malformed info url string', () => {
    const model = normalizeCatalogModel({
      name: '@cf/acme/widget',
      task: { name: 'Text Generation' },
      properties: [{ property_id: 'info', value: 'not a url' }],
    });
    expect(model?.infoUrl).toBeNull();
  });
});

function createKv() {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

type FakeKv = ReturnType<typeof createKv>;

function createEnv(
  modelsImpl: (params?: { per_page?: number; page?: number }) => Promise<unknown[]>,
  kv: FakeKv = createKv()
) {
  const modelsMock = vi.fn(modelsImpl);
  const env = {
    AI: { models: modelsMock, run: vi.fn() },
    KV: kv,
  } as unknown as Env;
  return { env, modelsMock, kv };
}

// The module's own private KV key (not exported). Kept in sync by the "fresh KV copy" and
// "stale KV copy" tests below, which populate it directly.
const CATALOG_KV_KEY = 'agent-models:catalog:v1';

describe('getAgentModelCatalog', () => {
  beforeEach(() => {
    resetAgentModelCatalogCacheForTests();
  });

  it('pages through Workers AI results until a short page is returned', async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      name: `@cf/acme/model-${index}`,
      task: { name: 'Text Generation' },
    }));
    const page2 = [{ name: '@cf/acme/model-last', task: { name: 'Text Generation' } }];
    const { env, modelsMock } = createEnv(async (params) => (params?.page === 1 ? page1 : page2));

    const result = await getAgentModelCatalog(env, 3600, 1_700_000_000_000);

    expect(result.models).toHaveLength(101);
    expect(modelsMock).toHaveBeenCalledTimes(2);
    expect(modelsMock).toHaveBeenNthCalledWith(1, { per_page: 100, page: 1 });
    expect(modelsMock).toHaveBeenNthCalledWith(2, { per_page: 100, page: 2 });
  });

  it('does not refetch within the cache TTL', async () => {
    const { env, modelsMock } = createEnv(async () => [
      { name: '@cf/acme/model-a', task: { name: 'Text Generation' } },
    ]);
    const t0 = 1_700_000_000_000;

    const first = await getAgentModelCatalog(env, 3600, t0);
    const second = await getAgentModelCatalog(env, 3600, t0 + 1000);

    expect(second).toBe(first);
    expect(modelsMock).toHaveBeenCalledTimes(1);
  });

  it('refetches after the cache TTL elapses', async () => {
    const { env, modelsMock } = createEnv(async () => [
      { name: '@cf/acme/model-a', task: { name: 'Text Generation' } },
    ]);
    const t0 = 1_700_000_000_000;

    await getAgentModelCatalog(env, 3600, t0);
    await getAgentModelCatalog(env, 3600, t0 + 3600 * 1000 + 1);

    expect(modelsMock).toHaveBeenCalledTimes(2);
  });

  it('serves a fresh KV copy without calling the Workers AI binding', async () => {
    const kv = createKv();
    const fetchedAt = 1_700_000_000_000;
    await kv.put(
      CATALOG_KV_KEY,
      JSON.stringify({
        fetchedAt,
        models: [fakeModel('@cf/acme/kv-1', 'decision'), fakeModel('@cf/acme/kv-2', 'extraction')],
      })
    );
    const { env, modelsMock } = createEnv(async () => {
      throw new Error('the Workers AI binding must not be called');
    }, kv);

    const result = await getAgentModelCatalog(env, 3600, fetchedAt + 1000);

    expect(result.models.map((model) => model.id)).toEqual(['@cf/acme/kv-1', '@cf/acme/kv-2']);
    expect(modelsMock).not.toHaveBeenCalled();
  });

  it('serves a stale KV copy when the Workers AI binding fails and nothing fresher exists', async () => {
    const kv = createKv();
    const staleFetchedAt = 1_700_000_000_000;
    await kv.put(
      CATALOG_KV_KEY,
      JSON.stringify({
        fetchedAt: staleFetchedAt,
        models: [fakeModel('@cf/acme/stale', 'decision')],
      })
    );
    const { env, modelsMock } = createEnv(async () => {
      throw new Error('network down');
    }, kv);
    // Past the TTL for both the (empty) isolate cache and the stored KV copy.
    const now = staleFetchedAt + 3600 * 1000 + 1;

    const result = await getAgentModelCatalog(env, 3600, now);

    expect(result.models.map((model) => model.id)).toEqual(['@cf/acme/stale']);
    expect(modelsMock).toHaveBeenCalled();
  });

  it('rejects when the Workers AI binding fails and nothing is cached at all', async () => {
    const { env } = createEnv(async () => {
      throw new Error('network down');
    });

    await expect(getAgentModelCatalog(env, 3600, 1_700_000_000_000)).rejects.toThrow(
      'network down'
    );
  });

  it('treats an empty catalog from Cloudflare as a failure', async () => {
    const { env } = createEnv(async () => []);

    await expect(getAgentModelCatalog(env, 3600, 1_700_000_000_000)).rejects.toThrow(
      'Cloudflare returned an empty model catalog'
    );
  });

  it('rejects when the Workers AI binding is not configured', async () => {
    const env = { KV: createKv() } as unknown as Env;

    await expect(getAgentModelCatalog(env, 3600, 1_700_000_000_000)).rejects.toThrow(
      'The Workers AI binding (AI) is not configured for this deployment'
    );
  });
});

describe('buildCatalogResponse', () => {
  it('computes defaultModelIds for the configured default categories', () => {
    const models = [
      fakeModel('@cf/a/decision-model', 'decision'),
      fakeModel('@cf/a/extraction-model', 'extraction'),
      fakeModel('@cf/a/classification-model', 'classification'),
      fakeModel('@cf/a/text-model', 'text-generation'),
    ];
    const defaultCategories = [...DEFAULT_AGENT_MODEL_DEFAULT_CATEGORIES];

    const response = buildCatalogResponse(
      { models, fetchedAt: 1_700_000_000_000 },
      defaultCategories
    );

    expect(response.defaultModelIds).toEqual([
      '@cf/a/decision-model',
      '@cf/a/extraction-model',
      '@cf/a/classification-model',
    ]);
    expect(response.defaultCategories).toEqual(defaultCategories);
    expect(response.models).toBe(models);
    expect(response.fetchedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});
