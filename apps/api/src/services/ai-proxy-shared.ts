// Moved to @simple-agent-manager/ai-proxy (worker modularization W5). Re-exported so the
// worker's existing importers are unchanged. Request auth stays in the worker
// (./ai-proxy-auth) and is re-exported here as before.
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
  buildWorkersAIGatewayUrl,
  isAnthropicModel,
  readSafeGatewayErrorDiagnostic,
  WorkersAIGatewayError,
} from '@simple-agent-manager/ai-proxy';

import {
  fetchWorkersAIChatCompletion as fetchCompletion,
  LlmUnavailableError,
  type WorkersAIChatCompletionOptions,
} from '@simple-agent-manager/ai-proxy';

import type { Env } from '../env';
import { resolveWorkersAiChatTargetWithin } from './llm-chat-target';
import type { LlmPurpose } from './llm-endpoint-settings';
/** Bind settings at the worker edge; package keeps the protocol and response parsing. */
export async function fetchWorkersAIChatCompletion(
  env: Env,
  options: WorkersAIChatCompletionOptions & { purpose?: LlmPurpose }
) {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const target = await resolveWorkersAiChatTargetWithin(
    env,
    options.purpose ?? 'taskTitle',
    options.modelId,
    options.timeoutMs
  );
  if (!target) throw new LlmUnavailableError(options.purpose ?? 'taskTitle');
  return fetchCompletion(env, options, target, signal);
}
