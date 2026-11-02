/**
 * Shared helpers for AI proxy endpoints (OpenAI-compatible and Anthropic-native).
 *
 * Extracted to avoid duplication between ai-proxy.ts and ai-proxy-anthropic.ts.
 * Covers: model validation, metadata injection, and upstream URL builders.
 * Auth verification and workspace resolution live in ai-proxy-auth.ts and are
 * re-exported here.
 *
 * Upstream auth resolution (Unified Billing vs platform key) lives in ai-billing.ts.
 */
import type { Env } from '../env';
import { expectJsonRecord } from '../lib/runtime-validation';

export {
  AIProxyAuthError,
  type AIProxyAuthResult,
  type AIProxyCredentialAttribution,
  extractCallbackToken,
  updateAIProxyAgentCredentialAttribution,
  verifyAIProxyAuth,
} from './ai-proxy-auth';

// =============================================================================
// Model Validation
// =============================================================================

/** Check if a model ID is an Anthropic model (requires claude-* prefix). */
export function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith('claude-');
}

// =============================================================================
// AI Gateway Metadata
// =============================================================================

/**
 * Build the `cf-aig-metadata` header value for AI Gateway analytics.
 * https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
 */
export function buildAIGatewayMetadata(opts: {
  userId: string;
  workspaceId: string;
  projectId?: string | null;
  sessionId?: string | null;
  trialId?: string;
  modelId: string;
  stream: boolean;
  hasTools?: boolean;
  providerId?: string;
  providerName?: string;
  providerDialect?: string;
}): string {
  return JSON.stringify({
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    projectId: opts.projectId ?? undefined,
    sessionId: opts.sessionId ?? undefined,
    trialId: opts.trialId ?? undefined,
    modelId: opts.modelId,
    stream: opts.stream,
    hasTools: opts.hasTools ?? false,
    providerId: opts.providerId,
    providerName: opts.providerName,
    providerDialect: opts.providerDialect,
  });
}

// =============================================================================
// Upstream URL Builders
// =============================================================================

/** Build upstream URL for Anthropic Messages API via AI Gateway. */
export function buildAnthropicGatewayUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/anthropic/v1/messages`;
  }
  // Fallback: direct Anthropic API (no gateway monitoring)
  return 'https://api.anthropic.com/v1/messages';
}

/** Build upstream URL for Workers AI chat completions via AI Gateway. */
export function buildWorkersAIGatewayUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/workers-ai/v1/chat/completions`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
}

export interface WorkersAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface WorkersAIChatCompletionOptions {
  modelId: string;
  maxTokens: number;
  timeoutMs: number;
  messages: WorkersAIChatMessage[];
  metadata: Record<string, unknown>;
  responseLabel: string;
  reasoningEffort?: string | null;
  chatTemplateKwargs?: Record<string, unknown>;
  errorDiagnosticMaxLength?: number;
}

export class WorkersAIGatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly diagnostic: string | undefined
  ) {
    super(
      `Workers AI Gateway request failed with HTTP ${status}${diagnostic ? ` (${diagnostic})` : ''}`
    );
    this.name = 'WorkersAIGatewayError';
  }
}

function sanitizeGatewayDiagnosticValue(field: string, value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (field === 'message') {
    if (/reasoning_effort/i.test(trimmed)) return 'invalid reasoning_effort parameter';
    if (/chat_template_kwargs|enable_thinking/i.test(trimmed))
      return 'invalid chat template parameter';
    if (/max_(?:completion_)?tokens/i.test(trimmed)) return 'invalid output token limit';
    if (/model/i.test(trimmed)) return 'invalid model parameter';
    return 'provider rejected request';
  }

  return /^[A-Za-z0-9_.:-]{1,64}$/.test(trimmed) ? trimmed : '[REDACTED]';
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - totalBytes;
      const chunk = value.slice(0, remaining);
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Extract only bounded, allowlisted provider error fields. */
export async function readSafeGatewayErrorDiagnostic(
  response: Response,
  maxLength: number
): Promise<string | undefined> {
  if (!Number.isFinite(maxLength) || maxLength <= 0) return undefined;
  const boundedMaxLength = Math.floor(maxLength);
  const raw = await readBoundedResponseText(response, boundedMaxLength);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const nestedError =
    record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  const firstError =
    Array.isArray(record.errors) &&
    record.errors[0] &&
    typeof record.errors[0] === 'object' &&
    !Array.isArray(record.errors[0])
      ? (record.errors[0] as Record<string, unknown>)
      : undefined;
  const source = nestedError ?? firstError ?? record;
  const fields = ['code', 'type', 'param', 'message'] as const;
  const parts = fields.flatMap((field) => {
    const sanitized = sanitizeGatewayDiagnosticValue(field, source[field]);
    return sanitized ? [`${field}=${sanitized}`] : [];
  });
  if (parts.length === 0) return undefined;
  return parts.join(' ').slice(0, boundedMaxLength);
}

export async function fetchWorkersAIChatCompletion(
  env: Env,
  options: WorkersAIChatCompletionOptions
): Promise<string | null> {
  const response = await fetch(buildWorkersAIGatewayUrl(env), {
    method: 'POST',
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      'cf-aig-metadata': JSON.stringify(options.metadata),
    },
    body: JSON.stringify({
      model: options.modelId,
      max_tokens: options.maxTokens,
      messages: options.messages,
      ...(options.reasoningEffort !== undefined
        ? { reasoning_effort: options.reasoningEffort }
        : {}),
      ...(options.chatTemplateKwargs ? { chat_template_kwargs: options.chatTemplateKwargs } : {}),
    }),
  });

  if (!response.ok) {
    const diagnostic = options.errorDiagnosticMaxLength
      ? await readSafeGatewayErrorDiagnostic(response, options.errorDiagnosticMaxLength)
      : undefined;
    throw new WorkersAIGatewayError(response.status, diagnostic);
  }

  const payload = expectJsonRecord(await response.json(), options.responseLabel);
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0]
    ? expectJsonRecord(choices[0], `${options.responseLabel}.choices[0]`)
    : undefined;
  const messageRecord = firstChoice?.message
    ? expectJsonRecord(firstChoice.message, `${options.responseLabel}.message`)
    : undefined;
  return typeof messageRecord?.content === 'string' ? messageRecord.content.trim() : null;
}

/** Build upstream URL for Anthropic token counting via AI Gateway. */
export function buildAnthropicCountTokensUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/anthropic/v1/messages/count_tokens`;
  }
  return 'https://api.anthropic.com/v1/messages/count_tokens';
}
