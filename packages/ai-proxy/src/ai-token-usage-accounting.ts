import { log } from '@simple-agent-manager/worker-core';
import { maybeJsonRecord } from '@simple-agent-manager/worker-core';

import { buildCostEstimateWrite } from './ai-cost-estimate';
import { priceReportedUsage } from './ai-cost-pricing';
import { hasLocalAiCostMetering } from './ai-gateway-availability';
import {
  type AiProviderUsageAttribution,
  incrementProviderUsage,
  incrementTokenUsage,
} from './ai-token-budget';
import { UTF8 } from './ai-token-input-estimates';
import type { AiProxyEnv } from './env';

export {
  estimateInputTokensFromMessages,
  estimateInputTokensFromRequest,
} from './ai-token-input-estimates';

export type TokenUsageFormat = 'openai' | 'anthropic';

export interface ExtractedTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt-cache reads. Anthropic excludes them from `inputTokens`; OpenAI includes them. */
  cacheReadTokens?: number;
  /** Prompt-cache writes (Anthropic `cache_creation_input_tokens`). */
  cacheWriteTokens?: number;
  /** Reasoning tokens reported separately (OpenAI); also counted in `outputTokens`. */
  reasoningTokens?: number;
  outputBytes?: number;
}

/**
 * Token usage the upstream actually reported for one response, normalized so `inputTokens`
 * excludes cache reads for every format. Never built from the input estimate.
 */
export interface MeasuredTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number | null;
}

export interface TokenUsageAccountingOptions {
  env: AiProxyEnv;
  userId: string;
  format: TokenUsageFormat;
  fallbackInputTokens?: number;
  /** Platform-billed catalog model; BYO and custom endpoints leave this unset. */
  costModelId?: string;
  /** The call bypassed AI Gateway (passthrough), so SAM's price is its only spend record. */
  directUpstream?: boolean;
  estimateMissingUsage?: boolean;
  provider?: AiProviderUsageAttribution;
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>;
  /**
   * Called with the upstream's measured usage (Insights run usage). Not called when the upstream
   * reported no usage, so the input estimate never reaches it. A failure is logged, not thrown.
   */
  onMeasuredUsage?: (usage: MeasuredTokenUsage) => Promise<void>;
}

export interface UpstreamTokenUsageAccountingOptions extends TokenUsageAccountingOptions {
  headers: Headers;
}

export async function accountTokenUsageFromJson(
  payload: unknown,
  options: TokenUsageAccountingOptions
): Promise<void> {
  const usage = extractJsonTokenUsage(payload, options.format);
  if (options.estimateMissingUsage && usage.outputTokens === undefined)
    usage.outputBytes = jsonOutputByteLength(payload, options.format);
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
      cacheReadTokens: numberValue(usage.cache_read_input_tokens),
      cacheWriteTokens: numberValue(usage.cache_creation_input_tokens),
    };
  }

  // Chat Completions: prompt_tokens_details; Responses API: input/output_tokens_details.
  const inputDetails =
    maybeJsonRecord(usage.prompt_tokens_details) ?? maybeJsonRecord(usage.input_tokens_details);
  const outputDetails =
    maybeJsonRecord(usage.completion_tokens_details) ??
    maybeJsonRecord(usage.output_tokens_details);
  return {
    inputTokens: numberValue(usage.prompt_tokens) ?? numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.completion_tokens) ?? numberValue(usage.output_tokens),
    cacheReadTokens: numberValue(inputDetails?.cached_tokens),
    reasoningTokens: numberValue(outputDetails?.reasoning_tokens),
  };
}

/**
 * The measured part of an extraction, or null when the upstream reported no usage at all.
 * OpenAI counts cache reads inside the prompt total; they are moved out so every format means
 * the same thing by `inputTokens` (fresh input), as the harness reports do.
 */
export function measuredTokenUsage(
  usage: ExtractedTokenUsage,
  format: TokenUsageFormat
): MeasuredTokenUsage | null {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const rawInput = usage.inputTokens ?? 0;
  return {
    inputTokens: format === 'openai' ? Math.max(0, rawInput - cacheRead) : rawInput,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? null,
  };
}

export async function collectStreamTokenUsage(
  stream: ReadableStream<Uint8Array>,
  format: TokenUsageFormat,
  estimate = false
): Promise<ExtractedTokenUsage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const usage: ExtractedTokenUsage = estimate ? { outputBytes: 0 } : {};

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
  const outputTokens =
    usage.outputTokens ??
    (options.estimateMissingUsage ? Math.ceil((usage.outputBytes ?? 0) / 3) : 0);
  if (inputTokens <= 0 && outputTokens <= 0) return;

  // Priced on every install. It is the spend record (display rows) without a gateway, and for a
  // call that bypassed one. A gateway-routed call's price only backstops the gateway total
  // (ai-cost-estimate.ts) and stays out of the display rows GET /api/usage/ai adds to it.
  const localMetering = hasLocalAiCostMetering(options.env);
  const samRecorded = localMetering || options.directUpstream === true;
  const { model: pricedModel, costUsd } = priceReportedUsage(options.costModelId, {
    anthropicFormat: options.format === 'anthropic',
    inputTokens,
    outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  });
  const costEstimate = localMetering
    ? undefined
    : buildCostEstimateWrite(costUsd, options.directUpstream ? 'direct' : 'estimate');
  await incrementTokenUsage(
    options.env.KV,
    options.userId,
    inputTokens,
    outputTokens,
    options.env,
    ...(costEstimate ? [costEstimate] : [])
  );
  const model = samRecorded ? pricedModel : null;
  const provider =
    options.provider ??
    (model
      ? { providerId: model.provider, providerName: model.provider, dialect: options.format }
      : undefined);
  if (provider) {
    const displayCostUsd = model ? costUsd : 0;
    const args = [options.env.KV, options.userId, provider, inputTokens, outputTokens] as const;
    // A priced call also records its catalog model (per-model breakdown without a gateway).
    if (model) await incrementProviderUsage(...args, options.env, displayCostUsd, model.id);
    else if (options.costModelId) await incrementProviderUsage(...args, options.env, 0);
    else await incrementProviderUsage(...args, options.env);
  }
  // Budget accounting is the billing control and runs first; run usage is telemetry and must
  // never delay or starve it.
  scheduleMeasuredUsage(usage, options);
}

/**
 * Hand the measured usage to `onMeasuredUsage` outside the response path: inside the request's
 * `waitUntil` when there is one, so a slow D1 write never adds latency to a proxied response.
 */
function scheduleMeasuredUsage(
  usage: ExtractedTokenUsage,
  options: TokenUsageAccountingOptions
): void {
  if (!options.onMeasuredUsage) return;
  const pending = recordMeasuredUsage(usage, options);
  try {
    options.executionCtx?.waitUntil(pending);
  } catch {
    // Tests and local runtimes may not provide a Cloudflare execution context.
  }
}

async function recordMeasuredUsage(
  usage: ExtractedTokenUsage,
  options: TokenUsageAccountingOptions
): Promise<void> {
  if (!options.onMeasuredUsage) return;
  const measured = measuredTokenUsage(usage, options.format);
  if (!measured) return;
  try {
    await options.onMeasuredUsage(measured);
  } catch (err) {
    // Run usage is telemetry: it must never fail the budget accounting that follows.
    log.warn('ai_proxy.run_usage_record_failed', {
      userId: options.userId,
      format: options.format,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
    usage.cacheReadTokens =
      numberValue(startUsage?.cache_read_input_tokens) ?? usage.cacheReadTokens;
    usage.cacheWriteTokens =
      numberValue(startUsage?.cache_creation_input_tokens) ?? usage.cacheWriteTokens;
    usage.outputTokens = numberValue(deltaUsage?.output_tokens) ?? usage.outputTokens;
    if (usage.outputBytes !== undefined) {
      const delta = maybeJsonRecord(record.delta);
      for (const key of ['text', 'thinking', 'partial_json'] as const) {
        if (typeof delta?.[key] === 'string') usage.outputBytes += utf8ByteLength(delta[key]);
      }
      usage.outputBytes += anthropicOutputByteLength([record.content_block]);
    }
    return;
  }

  // Chat Completions streams usage at the top level; the Responses API inside `response`.
  const jsonUsage = extractJsonTokenUsage(maybeJsonRecord(record.response) ?? record, 'openai');
  usage.inputTokens = jsonUsage.inputTokens ?? usage.inputTokens;
  usage.outputTokens = jsonUsage.outputTokens ?? usage.outputTokens;
  usage.cacheReadTokens = jsonUsage.cacheReadTokens ?? usage.cacheReadTokens;
  usage.reasoningTokens = jsonUsage.reasoningTokens ?? usage.reasoningTokens;
  if (usage.outputBytes !== undefined) {
    usage.outputBytes += choicesOutputByteLength(record.choices, 'delta');
    if (
      typeof record.delta === 'string' &&
      [
        'response.output_text.delta',
        'response.function_call_arguments.delta',
        'response.reasoning_text.delta',
      ].includes(String(record.type))
    )
      usage.outputBytes += utf8ByteLength(record.delta);
  }
}

function utf8ByteLength(text: string): number {
  return UTF8.encode(text).byteLength;
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
    const functionCall = maybeJsonRecord(part.function_call);
    for (const key of ['name', 'arguments'] as const) {
      if (typeof functionCall?.[key] === 'string') bytes += utf8ByteLength(functionCall[key]);
    }
  }
  return bytes;
}

function anthropicOutputByteLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  for (const block of content) {
    const part = maybeJsonRecord(block);
    if (!part) continue;
    for (const key of ['text', 'thinking'] as const) {
      if (typeof part[key] === 'string') bytes += utf8ByteLength(part[key]);
    }
    if (part.type === 'tool_use' && part.input !== undefined) {
      bytes += utf8ByteLength(JSON.stringify(part.input));
    }
  }
  return bytes;
}

function jsonOutputByteLength(payload: unknown, format: TokenUsageFormat): number {
  const record = maybeJsonRecord(payload);
  return format === 'anthropic'
    ? anthropicOutputByteLength(record?.content)
    : choicesOutputByteLength(record?.choices, 'message');
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
