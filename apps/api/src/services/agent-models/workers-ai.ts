/**
 * Narrow boundary over the Workers AI binding and the model-schema REST endpoint.
 *
 * Calls run through the binding with `returnRawResponse`, so every model — JSON, text or
 * binary output — comes back as one `Response`. When `AI_GATEWAY_ID` is set the call is routed
 * through SAM's single AI Gateway (policy 7b6f6fa8) with `cf-aig-metadata` attribution.
 */
import type { Env } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { maybeJsonRecord } from '../../lib/runtime-validation';

const log = createModuleLogger('agent_models.workers_ai');

type GatewayMetadata = Record<string, string | number | boolean | null>;

export interface WorkersAiRunOptions {
  returnRawResponse: true;
  signal?: AbortSignal;
  gateway?: { id: string; metadata?: GatewayMetadata };
}

/** The two binding methods this feature uses. The generated `Ai` type cannot express a
 * dynamic model id with `returnRawResponse`, so the cast stays local to this guard. */
export interface WorkersAiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options: WorkersAiRunOptions
  ): Promise<Response>;
  models(params?: { per_page?: number; page?: number }): Promise<unknown[]>;
}

export function getWorkersAiBinding(env: Env): WorkersAiBinding {
  const ai: unknown = (env as { AI?: unknown }).AI;
  const candidate = ai as Partial<WorkersAiBinding> | undefined;
  if (!candidate || typeof candidate.run !== 'function' || typeof candidate.models !== 'function') {
    throw new Error('The Workers AI binding (AI) is not configured for this deployment');
  }
  return candidate as WorkersAiBinding;
}

export function runWorkersAiModel(
  env: Env,
  modelId: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; metadata: GatewayMetadata }
): Promise<Response> {
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  return getWorkersAiBinding(env).run(modelId, input, {
    returnRawResponse: true,
    signal: options.signal,
    ...(gatewayId ? { gateway: { id: gatewayId, metadata: options.metadata } } : {}),
  });
}

export interface ModelSchema {
  input: unknown;
  output: unknown;
}

const SCHEMA_CACHE_MAX_ENTRIES = 100;
const schemaCache = new Map<string, { schema: ModelSchema; fetchedAt: number }>();

/**
 * The model's published input/output JSON Schema, or null when Cloudflare cannot provide it
 * (for example when the API token lacks Workers AI read access). Agents then get the
 * description and the docs link instead; nothing else depends on the schema.
 */
export async function getModelSchema(
  env: Env,
  modelId: string,
  options: { cacheSeconds: number; timeoutMs: number },
  now: number = Date.now()
): Promise<ModelSchema | null> {
  const cached = schemaCache.get(modelId);
  if (cached && now - cached.fetchedAt < options.cacheSeconds * 1000) return cached.schema;
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return cached?.schema ?? null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/models/schema?model=${encodeURIComponent(modelId)}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      log.warn('schema_unavailable', { modelId, status: response.status });
      return cached?.schema ?? null;
    }
    const result = maybeJsonRecord(maybeJsonRecord(await response.json())?.result);
    if (!result) return cached?.schema ?? null;
    const schema: ModelSchema = { input: result.input ?? null, output: result.output ?? null };
    if (schemaCache.size >= SCHEMA_CACHE_MAX_ENTRIES) {
      const oldest = schemaCache.keys().next().value;
      if (oldest !== undefined) schemaCache.delete(oldest);
    }
    schemaCache.set(modelId, { schema, fetchedAt: now });
    return schema;
  } catch (err) {
    log.warn('schema_fetch_failed', {
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return cached?.schema ?? null;
  }
}

/** Public docs page for a model, e.g. https://developers.cloudflare.com/workers-ai/models/clef-flash/. */
export function modelDocsUrl(modelName: string): string {
  return `https://developers.cloudflare.com/workers-ai/models/${encodeURIComponent(modelName)}/`;
}

export function resetModelSchemaCacheForTests(): void {
  schemaCache.clear();
}
