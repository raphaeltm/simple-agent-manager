// Moved to @simple-agent-manager/ai-proxy (worker modularization W5). Re-exported so the
// worker's existing importers are unchanged. Request auth stays in the worker
// (./ai-proxy-auth) and is re-exported here as before. `fetchWorkersAIChatCompletion` also stays
// in the worker: it resolves its target through the admin-configured LLM endpoint
// (./llm-chat-target), which reads worker settings.
import { expectJsonRecord } from '@simple-agent-manager/worker-core';

import {
  readSafeGatewayErrorDiagnostic,
  type WorkersAIChatMessage,
  WorkersAIGatewayError,
} from '@simple-agent-manager/ai-proxy';

import type { Env } from '../env';
import {
  chatTargetHeaders,
  fetchChatTarget,
  isCloudflareChatTarget,
  type LlmPurpose,
  LlmUnavailableError,
  resolveWorkersAiChatTargetWithin,
} from './llm-chat-target';

export {
  AIProxyAuthError,
  type AIProxyAuthResult,
  type AIProxyCredentialAttribution,
  extractCallbackToken,
  updateAIProxyAgentCredentialAttribution,
  verifyAIProxyAuth,
} from './ai-proxy-auth';
export {
  buildAIGatewayMetadata,
  buildAnthropicCountTokensUrl,
  buildAnthropicGatewayUrl,
  isAnthropicModel,
  readSafeGatewayErrorDiagnostic,
  UPSTREAM_ERROR_BODY_PARSE_MAX_BYTES,
  UPSTREAM_ERROR_REASON_MAX_LENGTH,
  upstreamErrorLogFields,
  type WorkersAIChatMessage,
  WorkersAIGatewayError,
} from '@simple-agent-manager/ai-proxy';

export interface WorkersAIChatCompletionOptions {
  /** Which control-plane caller this is; selects its model on an OpenAI-compatible endpoint. */
  purpose: LlmPurpose;
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

export async function fetchWorkersAIChatCompletion(
  env: Env,
  options: WorkersAIChatCompletionOptions
): Promise<string | null> {
  // One budget for the whole call, armed before the endpoint settings read.
  const signal = AbortSignal.timeout(options.timeoutMs);
  const target = await resolveWorkersAiChatTargetWithin(
    env,
    options.purpose,
    options.modelId,
    signal
  );
  if (!target) throw new LlmUnavailableError(options.purpose);
  // reasoning_effort and chat_template_kwargs are Workers AI model quirks keyed by the
  // Cloudflare model id; another endpoint's model would reject or misread them.
  const cloudflare = isCloudflareChatTarget(target);
  const response = await fetchChatTarget(target, {
    method: 'POST',
    signal,
    headers: chatTargetHeaders(target, { 'cf-aig-metadata': JSON.stringify(options.metadata) }),
    body: JSON.stringify({
      model: target.model,
      max_tokens: options.maxTokens,
      messages: options.messages,
      ...(cloudflare && options.reasoningEffort !== undefined
        ? { reasoning_effort: options.reasoningEffort }
        : {}),
      ...(cloudflare && options.chatTemplateKwargs
        ? { chat_template_kwargs: options.chatTemplateKwargs }
        : {}),
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
