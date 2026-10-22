/**
 * Cloudflare-hosted model catalog for agent model calls.
 *
 * The list comes from the Workers AI binding (`env.AI.models()`), so it needs no extra
 * API-token permission and only ever contains models Cloudflare runs itself (`@cf/…`).
 * Third-party gateway models are not part of that list, and any id that does not match the
 * Workers AI id shape is dropped. Each row is normalized on its own: one malformed row is
 * skipped and logged, never fatal (rule 50).
 */
import {
  type AgentModelCapability,
  type AgentModelCatalogEntry,
  type AgentModelCatalogResponse,
  type AgentModelCategory,
  type AgentModelPrice,
  categorizeAgentModel,
  computeDefaultAgentModelIds,
  isAgentModelId,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import { getWorkersAiBinding } from './workers-ai';

const log = createModuleLogger('agent_models.catalog');

/** Cloudflare returns the whole catalog in one page today; the loop guards against growth. */
const CATALOG_PAGE_SIZE = 100;
const CATALOG_MAX_PAGES = 10;
/** A stale KV copy is still served when Cloudflare cannot be reached, up to this age. */
const CATALOG_KV_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CATALOG_KV_KEY = 'agent-models:catalog:v1';

const CAPABILITY_PROPERTIES: ReadonlyArray<
  readonly [property: string, capability: AgentModelCapability]
> = [
  ['vision', 'vision'],
  ['reasoning', 'reasoning'],
  ['function_calling', 'function-calling'],
  ['lora', 'lora'],
  ['realtime', 'realtime'],
];

interface CachedCatalog {
  models: AgentModelCatalogEntry[];
  fetchedAt: number;
}

let isolateCatalog: CachedCatalog | null = null;

function propertyMap(value: unknown): Map<string, unknown> {
  const properties = new Map<string, unknown>();
  if (!Array.isArray(value)) return properties;
  for (const entry of value) {
    const record = maybeJsonRecord(entry);
    if (record && typeof record.property_id === 'string') {
      properties.set(record.property_id, record.value);
    }
  }
  return properties;
}

function isTrue(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

/**
 * The REST search API returns `price` as an array; the binding's type declares every property
 * value a string. Accept both, so a stringified price can never silently turn every model into an
 * unpriced one.
 */
function priceArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parsePrices(value: unknown): AgentModelPrice[] {
  const entries = priceArray(value);
  if (entries.length === 0) return [];
  const prices: AgentModelPrice[] = [];
  for (const entry of entries) {
    const record = maybeJsonRecord(entry);
    if (!record) continue;
    const usd = typeof record.price === 'number' ? record.price : Number.NaN;
    const unit = typeof record.unit === 'string' ? record.unit.trim() : '';
    const currency = typeof record.currency === 'string' ? record.currency.toUpperCase() : 'USD';
    // A zero price means "not published" in practice (beta image models); the budget treats
    // those as unpriced and charges the configured per-call estimate instead of nothing.
    if (unit && currency === 'USD' && Number.isFinite(usd) && usd > 0) {
      prices.push({ unit, usd });
    }
  }
  return prices;
}

function optionalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Normalize one raw Workers AI catalog row; null when it is not a usable hosted model. */
export function normalizeCatalogModel(raw: unknown): AgentModelCatalogEntry | null {
  const record = maybeJsonRecord(raw);
  if (!record) return null;
  const id = typeof record.name === 'string' ? record.name.trim() : '';
  if (!isAgentModelId(id)) return null;
  const task = maybeJsonRecord(record.task);
  const taskName = typeof task?.name === 'string' ? task.name : '';
  const properties = propertyMap(record.properties);
  const contextWindow = Number.parseInt(String(properties.get('context_window') ?? ''), 10);
  const [, author = '', name = id] = id.split('/');
  return {
    id,
    name,
    author,
    description: typeof record.description === 'string' ? record.description.trim() : '',
    category: categorizeAgentModel(id, taskName),
    task: taskName,
    prices: parsePrices(properties.get('price')),
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    capabilities: CAPABILITY_PROPERTIES.filter(([property]) =>
      isTrue(properties.get(property))
    ).map(([, capability]) => capability),
    beta: isTrue(properties.get('beta')),
    partner: isTrue(properties.get('partner')),
    infoUrl: optionalUrl(properties.get('info')),
    termsUrl: optionalUrl(properties.get('terms')),
  };
}

export function normalizeCatalog(rows: readonly unknown[]): AgentModelCatalogEntry[] {
  const byId = new Map<string, AgentModelCatalogEntry>();
  for (const row of rows) {
    try {
      const model = normalizeCatalogModel(row);
      if (model) byId.set(model.id, model);
    } catch (err) {
      log.error('row_skipped', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchCatalogFromCloudflare(env: Env): Promise<AgentModelCatalogEntry[]> {
  const ai = getWorkersAiBinding(env);
  const rows: unknown[] = [];
  for (let page = 1; page <= CATALOG_MAX_PAGES; page++) {
    const batch = await ai.models({ per_page: CATALOG_PAGE_SIZE, page });
    if (!Array.isArray(batch)) break;
    rows.push(...batch);
    if (batch.length < CATALOG_PAGE_SIZE) break;
  }
  const models = normalizeCatalog(rows);
  if (models.length === 0) throw new Error('Cloudflare returned an empty model catalog');
  return models;
}

async function readKvCatalog(env: Env): Promise<CachedCatalog | null> {
  const raw = await env.KV.get(CATALOG_KV_KEY);
  if (!raw) return null;
  try {
    const record = maybeJsonRecord(JSON.parse(raw) as unknown);
    if (!record || typeof record.fetchedAt !== 'number' || !Array.isArray(record.models))
      return null;
    const models = normalizeCachedModels(record.models);
    return models.length > 0 ? { models, fetchedAt: record.fetchedAt } : null;
  } catch {
    return null;
  }
}

/** The KV copy holds normalized entries; re-validate the shape before trusting it. */
function normalizeCachedModels(values: unknown[]): AgentModelCatalogEntry[] {
  return values.filter((value): value is AgentModelCatalogEntry => {
    const record = maybeJsonRecord(value);
    return (
      !!record &&
      isAgentModelId(record.id) &&
      typeof record.name === 'string' &&
      typeof record.category === 'string' &&
      Array.isArray(record.prices) &&
      Array.isArray(record.capabilities)
    );
  });
}

/**
 * The catalog, cached per isolate and in KV for `cacheSeconds`. When Cloudflare cannot be
 * reached, a stale copy (isolate or KV, up to a week old) is served rather than failing.
 */
export async function getAgentModelCatalog(
  env: Env,
  cacheSeconds: number,
  now: number = Date.now()
): Promise<CachedCatalog> {
  const maxAgeMs = cacheSeconds * 1000;
  if (isolateCatalog && now - isolateCatalog.fetchedAt < maxAgeMs) return isolateCatalog;
  const kvCatalog = await readKvCatalog(env).catch(() => null);
  if (kvCatalog && now - kvCatalog.fetchedAt < maxAgeMs) {
    isolateCatalog = kvCatalog;
    return kvCatalog;
  }
  try {
    const models = await fetchCatalogFromCloudflare(env);
    isolateCatalog = { models, fetchedAt: now };
    await env.KV.put(CATALOG_KV_KEY, JSON.stringify(isolateCatalog), {
      expirationTtl: CATALOG_KV_MAX_AGE_SECONDS,
    }).catch((err: unknown) => {
      log.warn('kv_write_failed', { error: err instanceof Error ? err.message : String(err) });
    });
    return isolateCatalog;
  } catch (err) {
    const stale = [isolateCatalog, kvCatalog]
      .filter((entry): entry is CachedCatalog => entry !== null)
      .sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
    log.error('fetch_failed', {
      error: err instanceof Error ? err.message : String(err),
      servingStale: Boolean(stale),
      staleAgeSeconds: stale ? Math.round((now - stale.fetchedAt) / 1000) : null,
    });
    if (stale) return stale;
    throw err;
  }
}

export function buildCatalogResponse(
  catalog: CachedCatalog,
  defaultCategories: AgentModelCategory[]
): AgentModelCatalogResponse {
  return {
    models: catalog.models,
    defaultModelIds: computeDefaultAgentModelIds(catalog.models, defaultCategories),
    defaultCategories,
    fetchedAt: new Date(catalog.fetchedAt).toISOString(),
  };
}

/** Test seam: forget the isolate copy. */
export function resetAgentModelCatalogCacheForTests(): void {
  isolateCatalog = null;
}
