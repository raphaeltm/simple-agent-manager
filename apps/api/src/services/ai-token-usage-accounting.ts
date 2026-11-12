import type { Env } from '../env';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { findPricedModel, priceModelUsageUsd } from './ai-cost-pricing';
import { incrementModelUsage } from './ai-model-usage';
import {
  type AiProviderUsageAttribution,
  incrementProviderUsage,
  incrementTokenUsage,
} from './ai-token-budget';
import { hasLocalAiCostMetering } from './platform-capabilities';

export type TokenUsageFormat = 'openai' | 'anthropic';

export interface ExtractedTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** UTF-8 bytes of generated output seen, collected only when usage may need estimating. */
  outputBytes?: number;
  /**
   * Prompt tokens served from the provider's cache. Anthropic reports them apart from
   * `input_tokens`; OpenAI includes them in `prompt_tokens`. Priced only, never budgeted.
   */
  cachedInputTokens?: number;
  /** Anthropic prompt-cache writes, reported apart from `input_tokens`. Priced only. */
  cacheWriteInputTokens?: number;
}

export interface TokenUsageAccountingOptions {
  env: Env;
  userId: string;
  format: TokenUsageFormat;
  fallbackInputTokens?: number;
  provider?: AiProviderUsageAttribution;
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>;
  /**
   * Estimate counts the upstream did not report instead of charging nothing. Set only for an
   * admin-configured OpenAI-compatible endpoint, which may omit `usage`; Cloudflare and
   * first-party provider routes keep their reported-only accounting unchanged.
   */
  estimateMissingUsage?: boolean;
  /**
   * The catalog model a platform-billed call was sent to. Without an AI Gateway
   * (`hasLocalAiCostMetering`) SAM prices the call from it and records the cost for the monthly
   * cap. Set only by platform-billed routes; BYO passthrough calls are the user's own spend.
   */
  costModelId?: string;
}

/** UTF-8 bytes/3 over-counts typical English token density, so an estimate errs toward the budget. */
export function estimateTokensFromByteLength(byteLength: number): number {
  return Math.ceil(Math.max(0, byteLength) / 3);
}

/** The one token estimator for model output SAM cannot get a count for (proxy and operator). */
export function estimateTokensFromText(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value ?? '') ?? '');
  return estimateTokensFromByteLength(utf8ByteLength(text));
}

/** One encoder for every delta (the custom-endpoint stream path counts each one). */
const UTF8 = new TextEncoder();

function utf8ByteLength(text: string): number {
  return UTF8.encode(text).byteLength;
}

export interface UpstreamTokenUsageAccountingOptions extends TokenUsageAccountingOptions {
  headers: Headers;
}

export async function accountTokenUsageFromJson(
  payload: unknown,
  options: TokenUsageAccountingOptions
): Promise<void> {
  const usage = extractJsonTokenUsage(payload, options.format);
  if (options.estimateMissingUsage && usage.outputTokens === undefined) {
    usage.outputBytes = jsonOutputByteLength(payload);
  }
  await incrementExtractedUsage(usage, options);
}

export function accountTokenUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  options: TokenUsageAccountingOptions
): void {
  scheduleTokenAccounting(
    collectStreamTokenUsage(stream, options.format, options.estimateMissingUsage === true).then(
      (usage) => incrementExtractedUsage(usage, options)
    ),
    options
  );
}

export async function attachTokenUsageAccounting(
  response: Response,
  options: TokenUsageAccountingOptions
): Promise<Response> {
  if (!response.ok) return response;

  const headers = new Headers(response.headers);
  if (isStreamingResponse(response)) {
    if (!response.body) return response;
    const [clientBody, accountingBody] = response.body.tee();
    accountTokenUsageFromStream(accountingBody, options);
    return new Response(clientBody, { status: response.status, headers });
  }

  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch (err) {
    log.warn('ai_proxy.token_usage_parse_failed', {
      userId: options.userId,
      format: options.format,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response(responseText, { status: response.status, headers });
  }

  try {
    // Reported JSON usage is authoritative, so the request estimate is dropped there unless this
    // upstream may omit usage altogether.
    await accountTokenUsageFromJson(
      payload,
      options.estimateMissingUsage ? options : { ...options, fallbackInputTokens: undefined }
    );
  } catch (err) {
    log.warn('ai_proxy.token_usage_increment_failed', {
      userId: options.userId,
      format: options.format,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return new Response(responseText, { status: response.status, headers });
}

export function optionalExecutionContext(
  getExecutionCtx: () => Pick<ExecutionContext, 'waitUntil'>
): Pick<ExecutionContext, 'waitUntil'> | undefined {
  try {
    return getExecutionCtx();
  } catch {
    return undefined;
  }
}

export function attachUpstreamTokenUsageAccounting(
  upstreamResponse: Response,
  options: UpstreamTokenUsageAccountingOptions
): Promise<Response> {
  return attachTokenUsageAccounting(
    new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: options.headers,
    }),
    options
  );
}

export function extractJsonTokenUsage(
  payload: unknown,
  format: TokenUsageFormat
): ExtractedTokenUsage {
  const record = maybeJsonRecord(payload);
  const usage = maybeJsonRecord(record?.usage);
  if (!usage) return {};

  if (format === 'anthropic') {
    return {
      inputTokens: numberValue(usage.input_tokens),
      outputTokens: numberValue(usage.output_tokens),
      cachedInputTokens: numberValue(usage.cache_read_input_tokens),
      cacheWriteInputTokens: numberValue(usage.cache_creation_input_tokens),
    };
  }

  const details =
    maybeJsonRecord(usage.prompt_tokens_details) ?? maybeJsonRecord(usage.input_tokens_details);
  return {
    inputTokens: numberValue(usage.prompt_tokens) ?? numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.completion_tokens) ?? numberValue(usage.output_tokens),
    cachedInputTokens: numberValue(details?.cached_tokens),
  };
}

export function estimateInputTokensFromMessages(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;

  const totalChars = messages.reduce((sum: number, message: unknown) => {
    const record = maybeJsonRecord(message);
    return sum + estimateContentChars(record?.content);
  }, 0);

  return Math.ceil(totalChars / 4);
}

export async function collectStreamTokenUsage(
  stream: ReadableStream<Uint8Array>,
  format: TokenUsageFormat,
  collectOutputBytes = false
): Promise<ExtractedTokenUsage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const usage: ExtractedTokenUsage = collectOutputBytes ? { outputBytes: 0 } : {};

  try {
    let keepReading = true;
    while (keepReading) {
      const { done, value } = await reader.read();
      if (done) {
        keepReading = false;
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = processSseBuffer(buffer, format, usage);
    }
    buffer += decoder.decode();
    processSseBuffer(`${buffer}\n\n`, format, usage);
  } finally {
    reader.releaseLock();
  }

  return usage;
}

async function incrementExtractedUsage(
  usage: ExtractedTokenUsage,
  options: TokenUsageAccountingOptions
): Promise<void> {
  const inputTokens = usage.inputTokens ?? options.fallbackInputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? estimatedOutputTokens(usage, options);
  if (inputTokens <= 0 && outputTokens <= 0) return;

  await incrementTokenUsage(options.env.KV, options.userId, inputTokens, outputTokens, options.env);
  const priced = localCost(usage, inputTokens, outputTokens, options);
  const provider = options.provider ?? priced?.provider;
  if (!provider) return;
  if (priced) {
    await incrementProviderUsage(
      options.env.KV,
      options.userId,
      provider,
      inputTokens,
      outputTokens,
      options.env,
      priced.costUsd
    );
    await incrementModelUsage(
      options.env,
      options.userId,
      priced.modelId,
      provider.providerId,
      inputTokens,
      outputTokens,
      priced.costUsd
    );
    return;
  }
  await incrementProviderUsage(
    options.env.KV,
    options.userId,
    provider,
    inputTokens,
    outputTokens,
    options.env
  );
}

const PRICED_PROVIDER: Readonly<Record<TokenUsageFormat, AiProviderUsageAttribution>> = {
  anthropic: { providerId: 'anthropic', providerName: 'Anthropic', dialect: 'anthropic' },
  openai: { providerId: 'openai', providerName: 'OpenAI', dialect: 'openai' },
};

/**
 * SAM's own price for a platform-billed call on an installation without AI Gateway, or null where
 * the gateway's logs are the spend record, the route is not platform-billed, or the model has no
 * catalog price. Anthropic reports cached and cache-write tokens apart from `input_tokens`, so
 * they are added to the priced prompt; OpenAI's `prompt_tokens` already includes cached tokens.
 */
function localCost(
  usage: ExtractedTokenUsage,
  inputTokens: number,
  outputTokens: number,
  options: TokenUsageAccountingOptions
): { costUsd: number; provider: AiProviderUsageAttribution; modelId: string } | null {
  if (!options.costModelId || !hasLocalAiCostMetering(options.env)) return null;
  const model = findPricedModel(options.costModelId);
  if (!model) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const anthropic = options.format === 'anthropic';
  return {
    costUsd: priceModelUsageUsd(model, {
      inputTokens: anthropic ? inputTokens + cached + cacheWrite : inputTokens,
      outputTokens,
      cachedInputTokens: cached,
      cacheWriteInputTokens: anthropic ? cacheWrite : 0,
    }),
    provider: PRICED_PROVIDER[options.format],
    modelId: model.id,
  };
}

/** Output tokens for a response that reported none: estimated where allowed, else none. */
function estimatedOutputTokens(
  usage: ExtractedTokenUsage,
  options: TokenUsageAccountingOptions
): number {
  if (!options.estimateMissingUsage) return 0;
  const output = estimateTokensFromByteLength(usage.outputBytes ?? 0);
  log.warn('ai_proxy.usage_estimated', {
    userId: options.userId,
    format: options.format,
    inputReported: usage.inputTokens !== undefined,
    outputReported: false,
    output,
  });
  return output;
}

function processSseBuffer(
  buffer: string,
  format: TokenUsageFormat,
  usage: ExtractedTokenUsage
): string {
  const events = buffer.split(/\r?\n\r?\n/);
  const remainder = events.pop() ?? '';

  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;

    try {
      applyStreamUsage(JSON.parse(data), format, usage);
    } catch {
      // Ignore non-JSON SSE data. Upstream providers may emit comments or pings.
    }
  }

  return remainder;
}

function applyStreamUsage(
  payload: unknown,
  format: TokenUsageFormat,
  usage: ExtractedTokenUsage
): void {
  const record = maybeJsonRecord(payload);
  if (!record) return;

  if (format === 'anthropic') {
    const message = maybeJsonRecord(record.message);
    const startUsage = maybeJsonRecord(message?.usage);
    const deltaUsage = maybeJsonRecord(record.usage);
    usage.inputTokens = numberValue(startUsage?.input_tokens) ?? usage.inputTokens;
    usage.outputTokens = numberValue(deltaUsage?.output_tokens) ?? usage.outputTokens;
    usage.cachedInputTokens =
      numberValue(startUsage?.cache_read_input_tokens) ?? usage.cachedInputTokens;
    usage.cacheWriteInputTokens =
      numberValue(startUsage?.cache_creation_input_tokens) ?? usage.cacheWriteInputTokens;
    return;
  }

  // Chat completions put `usage` on the final chunk; the Responses API puts it on the
  // `response.completed` event's `response` object.
  const jsonUsage = extractJsonTokenUsage(
    maybeJsonRecord(record.usage) ? record : (maybeJsonRecord(record.response) ?? record),
    'openai'
  );
  usage.inputTokens = jsonUsage.inputTokens ?? usage.inputTokens;
  usage.outputTokens = jsonUsage.outputTokens ?? usage.outputTokens;
  usage.cachedInputTokens = jsonUsage.cachedInputTokens ?? usage.cachedInputTokens;
  if (usage.outputBytes !== undefined) {
    usage.outputBytes += choicesOutputByteLength(record.choices, 'delta');
  }
}

/** Bytes of generated output in a chat completion's choices (`message`) or chunk (`delta`). */
function choicesOutputByteLength(choices: unknown, field: 'message' | 'delta'): number {
  if (!Array.isArray(choices)) return 0;
  let bytes = 0;
  for (const choice of choices) {
    const part = maybeJsonRecord(maybeJsonRecord(choice)?.[field]);
    if (!part) continue;
    for (const key of ['content', 'reasoning_content', 'reasoning'] as const) {
      if (typeof part[key] === 'string') bytes += utf8ByteLength(part[key]);
    }
    if (Array.isArray(part.tool_calls)) bytes += utf8ByteLength(JSON.stringify(part.tool_calls));
  }
  return bytes;
}

function jsonOutputByteLength(payload: unknown): number {
  return choicesOutputByteLength(maybeJsonRecord(payload)?.choices, 'message');
}

function isStreamingResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return (
    contentType.includes('text/event-stream') ||
    response.headers.get('cache-control') === 'no-cache'
  );
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function estimateContentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;

  return content.reduce((sum: number, part: unknown) => {
    const record = maybeJsonRecord(part);
    if (typeof record?.text === 'string') return sum + record.text.length;
    if (typeof record?.content === 'string') return sum + record.content.length;
    return sum;
  }, 0);
}

function scheduleTokenAccounting(
  promise: Promise<void>,
  options: TokenUsageAccountingOptions
): void {
  const logged = promise.catch((err) => {
    log.warn('ai_proxy.token_usage_increment_failed', {
      userId: options.userId,
      format: options.format,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  try {
    options.executionCtx?.waitUntil(logged);
  } catch {
    // Tests and local runtimes may not provide a Cloudflare execution context.
  }
}
