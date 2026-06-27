import {
  getModelGroupsForAgent,
  type ModelCatalogResponse,
  type ModelGroup,
  type OpenCodeModelsDevProviderId,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../env';
import { createModuleLogger, serializeError } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';

const log = createModuleLogger('model_catalog');

export const DEFAULT_MODEL_CATALOG_SOURCE_URL = 'https://models.dev/api.json';
export const DEFAULT_MODEL_CATALOG_CACHE_TTL_SECONDS = 3600;
export const DEFAULT_MODEL_CATALOG_FETCH_TIMEOUT_MS = 5000;

const MIN_CACHE_TTL_SECONDS = 60;
const MAX_CACHE_TTL_SECONDS = 86_400;
const MIN_FETCH_TIMEOUT_MS = 1000;
const MAX_FETCH_TIMEOUT_MS = 30_000;
const OPENCODE_CACHE_KEY = 'model-catalog:v1:opencode:active';
const OPENCODE_MODELS_DEV_PROVIDER_IDS = [
  'opencode',
  'opencode-go',
] satisfies readonly OpenCodeModelsDevProviderId[];

const modelsDevModelSchema = v.object({
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  status: v.optional(v.string()),
});
const modelsDevProviderSchema = v.object({
  name: v.optional(v.string()),
  models: v.optional(v.record(v.string(), modelsDevModelSchema)),
});
const modelsDevCatalogSchema = v.record(v.string(), v.unknown());

type ModelsDevProvider = v.InferOutput<typeof modelsDevProviderSchema>;
type ModelsDevModel = v.InferOutput<typeof modelsDevModelSchema>;

interface ModelCatalogCacheEntry {
  groups: ModelGroup[];
  updatedAt: string;
}

type ModelCatalogEnv = Pick<
  Env,
  | 'KV'
  | 'MODEL_CATALOG_SOURCE_URL'
  | 'MODEL_CATALOG_CACHE_TTL_SECONDS'
  | 'MODEL_CATALOG_FETCH_TIMEOUT_MS'
>;

export async function getModelCatalogForAgent(
  env: ModelCatalogEnv,
  agentType: string
): Promise<ModelCatalogResponse> {
  if (agentType !== 'opencode') {
    return staticCatalog(agentType);
  }

  const cached = await readCachedOpenCodeCatalog(env);
  if (cached) {
    return {
      agentType,
      groups: cached.groups,
      source: 'cache',
      updatedAt: cached.updatedAt,
    };
  }

  try {
    const groups = await fetchOpenCodeModelGroups(env);
    const updatedAt = new Date().toISOString();
    await writeCachedOpenCodeCatalog(env, { groups, updatedAt });
    return { agentType, groups, source: 'dynamic', updatedAt };
  } catch (err) {
    log.warn('dynamic_fetch_failed', serializeError(err));
    return staticCatalog(agentType);
  }
}

function staticCatalog(agentType: string): ModelCatalogResponse {
  return {
    agentType,
    groups: getModelGroupsForAgent(agentType),
    source: 'static',
    updatedAt: null,
  };
}

async function readCachedOpenCodeCatalog(
  env: ModelCatalogEnv
): Promise<ModelCatalogCacheEntry | null> {
  try {
    const cached = await env.KV.get<ModelCatalogCacheEntry>(OPENCODE_CACHE_KEY, 'json');
    if (cached && isModelGroupArray(cached.groups) && isNonEmptyString(cached.updatedAt)) {
      return cached;
    }
  } catch (err) {
    log.warn('cache_read_failed', serializeError(err));
  }
  return null;
}

async function writeCachedOpenCodeCatalog(
  env: ModelCatalogEnv,
  entry: ModelCatalogCacheEntry
): Promise<void> {
  try {
    await env.KV.put(OPENCODE_CACHE_KEY, JSON.stringify(entry), {
      expirationTtl: resolveCacheTtlSeconds(env.MODEL_CATALOG_CACHE_TTL_SECONDS),
    });
  } catch (err) {
    log.warn('cache_write_failed', serializeError(err));
  }
}

async function fetchOpenCodeModelGroups(env: ModelCatalogEnv): Promise<ModelGroup[]> {
  const response = await fetchWithTimeout(
    resolveSourceUrl(env.MODEL_CATALOG_SOURCE_URL),
    resolveFetchTimeoutMs(env.MODEL_CATALOG_FETCH_TIMEOUT_MS)
  );
  if (!response.ok) {
    throw new Error(`Models.dev request failed with status ${response.status}`);
  }
  const catalog = await readResponseJson(response, modelsDevCatalogSchema, 'models-dev.catalog');
  const groups = normalizeOpenCodeModelGroups(catalog);
  if (groups.length === 0) {
    throw new Error('Models.dev response did not contain usable OpenCode model groups');
  }
  return groups;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeOpenCodeModelGroups(catalog: unknown): ModelGroup[] {
  const parsedCatalog = v.safeParse(modelsDevCatalogSchema, catalog);
  if (!parsedCatalog.success) return [];

  const groups: ModelGroup[] = [];
  for (const providerId of OPENCODE_MODELS_DEV_PROVIDER_IDS) {
    const parsedProvider = v.safeParse(modelsDevProviderSchema, parsedCatalog.output[providerId]);
    if (!parsedProvider.success) continue;

    const group = normalizeProviderModels(providerId, parsedProvider.output);
    if (group.models.length > 0) {
      groups.push(group);
    }
  }
  return groups;
}

function normalizeProviderModels(
  providerId: OpenCodeModelsDevProviderId,
  provider: ModelsDevProvider
): ModelGroup {
  const label = isNonEmptyString(provider.name)
    ? provider.name
    : providerId === 'opencode-go'
      ? 'OpenCode Go'
      : 'OpenCode Zen';
  const models = provider.models ? Object.values(provider.models) : [];
  const normalized = models
    .map((model) => normalizeModel(providerId, label, model))
    .filter((model): model is ModelGroup['models'][number] => model !== null);

  return { label, models: normalized };
}

function normalizeModel(
  providerId: OpenCodeModelsDevProviderId,
  group: string,
  model: ModelsDevModel
): ModelGroup['models'][number] | null {
  if (model.status === 'deprecated') return null;
  if (!isNonEmptyString(model.id) || !isNonEmptyString(model.name)) return null;

  const id = model.id.startsWith(`${providerId}/`) ? model.id : `${providerId}/${model.id}`;
  return { id, name: model.name, group };
}

function resolveSourceUrl(value: string | undefined): string {
  return value?.trim() || DEFAULT_MODEL_CATALOG_SOURCE_URL;
}

function resolveCacheTtlSeconds(value: string | undefined): number {
  return resolveBoundedInteger(
    value,
    DEFAULT_MODEL_CATALOG_CACHE_TTL_SECONDS,
    MIN_CACHE_TTL_SECONDS,
    MAX_CACHE_TTL_SECONDS
  );
}

function resolveFetchTimeoutMs(value: string | undefined): number {
  return resolveBoundedInteger(
    value,
    DEFAULT_MODEL_CATALOG_FETCH_TIMEOUT_MS,
    MIN_FETCH_TIMEOUT_MS,
    MAX_FETCH_TIMEOUT_MS
  );
}

function resolveBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function isModelGroupArray(value: unknown): value is ModelGroup[] {
  return (
    Array.isArray(value) &&
    value.every(
      (group) =>
        isRecord(group) &&
        isNonEmptyString(group.label) &&
        Array.isArray(group.models) &&
        group.models.every(
          (model) =>
            isRecord(model) &&
            isNonEmptyString(model.id) &&
            isNonEmptyString(model.name) &&
            model.group === group.label
        )
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
