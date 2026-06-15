import type { Env } from '../env';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import {
  type AiProviderUsageAttribution,
  incrementProviderUsage,
  incrementTokenUsage,
} from './ai-token-budget';

export type TokenUsageFormat = 'openai' | 'anthropic';

export interface ExtractedTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface TokenUsageAccountingOptions {
  env: Env;
  userId: string;
  format: TokenUsageFormat;
  fallbackInputTokens?: number;
  provider?: AiProviderUsageAttribution;
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>;
}

export interface UpstreamTokenUsageAccountingOptions extends TokenUsageAccountingOptions {
  headers: Headers;
}

export async function accountTokenUsageFromJson(
  payload: unknown,
  options: TokenUsageAccountingOptions,
): Promise<void> {
  const usage = extractJsonTokenUsage(payload, options.format);
  await incrementExtractedUsage(usage, options);
}

export function accountTokenUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  options: TokenUsageAccountingOptions,
): void {
  scheduleTokenAccounting(
    collectStreamTokenUsage(stream, options.format)
      .then((usage) => incrementExtractedUsage(usage, options)),
    options,
  );
}

export async function attachTokenUsageAccounting(
  response: Response,
  options: TokenUsageAccountingOptions,
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
    await accountTokenUsageFromJson(payload, { ...options, fallbackInputTokens: undefined });
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
  getExecutionCtx: () => Pick<ExecutionContext, 'waitUntil'>,
): Pick<ExecutionContext, 'waitUntil'> | undefined {
  try {
    return getExecutionCtx();
  } catch {
    return undefined;
  }
}

export function attachUpstreamTokenUsageAccounting(
  upstreamResponse: Response,
  options: UpstreamTokenUsageAccountingOptions,
): Promise<Response> {
  return attachTokenUsageAccounting(
    new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: options.headers,
    }),
    options,
  );
}

export function extractJsonTokenUsage(
  payload: unknown,
  format: TokenUsageFormat,
): ExtractedTokenUsage {
  const record = maybeJsonRecord(payload);
  const usage = maybeJsonRecord(record?.usage);
  if (!usage) return {};

  if (format === 'anthropic') {
    return {
      inputTokens: numberValue(usage.input_tokens),
      outputTokens: numberValue(usage.output_tokens),
    };
  }

  return {
    inputTokens: numberValue(usage.prompt_tokens) ?? numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.completion_tokens) ?? numberValue(usage.output_tokens),
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
): Promise<ExtractedTokenUsage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const usage: ExtractedTokenUsage = {};

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
  options: TokenUsageAccountingOptions,
): Promise<void> {
  const inputTokens = usage.inputTokens ?? options.fallbackInputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (inputTokens <= 0 && outputTokens <= 0) return;

  await incrementTokenUsage(
    options.env.KV,
    options.userId,
    inputTokens,
    outputTokens,
    options.env,
  );
  if (options.provider) {
    await incrementProviderUsage(
      options.env.KV,
      options.userId,
      options.provider,
      inputTokens,
      outputTokens,
      options.env,
    );
  }
}

function processSseBuffer(
  buffer: string,
  format: TokenUsageFormat,
  usage: ExtractedTokenUsage,
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
  usage: ExtractedTokenUsage,
): void {
  const record = maybeJsonRecord(payload);
  if (!record) return;

  if (format === 'anthropic') {
    const message = maybeJsonRecord(record.message);
    const startUsage = maybeJsonRecord(message?.usage);
    const deltaUsage = maybeJsonRecord(record.usage);
    usage.inputTokens = numberValue(startUsage?.input_tokens) ?? usage.inputTokens;
    usage.outputTokens = numberValue(deltaUsage?.output_tokens) ?? usage.outputTokens;
    return;
  }

  const jsonUsage = extractJsonTokenUsage(record, 'openai');
  usage.inputTokens = jsonUsage.inputTokens ?? usage.inputTokens;
  usage.outputTokens = jsonUsage.outputTokens ?? usage.outputTokens;
}

function isStreamingResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('text/event-stream') || response.headers.get('cache-control') === 'no-cache';
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
  options: TokenUsageAccountingOptions,
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
