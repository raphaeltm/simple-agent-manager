/**
 * The model call for one agent-loop turn, split out of agent-loop.ts (rule 18).
 *
 * Route order: an admin-configured OpenAI-compatible endpoint when one is set
 * (services/llm-chat-target.ts), else by model prefix: claude-* to Anthropic (translated at the
 * boundary), @cf/* and @hf/* to Workers AI through AI Gateway or the REST API.
 */
import { SAM_ANTHROPIC_VERSION, type SamConfig } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import {
  type ChatCompletionsTarget,
  chatTargetHeaders,
  fetchChatTarget,
  LlmUnavailableError,
  resolveCloudflareWorkersAiTarget,
} from '../../services/llm-chat-target';
import { aiGatewayOnlyHeaders } from '../../services/platform-capabilities';
import { getPlatformAgentCredential } from '../../services/platform-credentials';
import {
  buildAnthropicGatewayUrl,
  isAnthropicModel,
  isWorkersAIModel,
  type OpenAITool,
  toOpenAITools,
} from './agent-loop-helpers';
import type { OpenAIMessage } from './payload-size';
import type { AnthropicToolDef } from './types';

async function getAnthropicApiKey(env: Env): Promise<string> {
  const { drizzle } = await import('drizzle-orm/d1');
  const db = drizzle(env.DATABASE);
  const encryptionKey = getCredentialEncryptionKey(env);
  const cred = await getPlatformAgentCredential(db, 'claude-code', encryptionKey);
  if (!cred?.credential) {
    throw new Error(
      'No Anthropic API key configured. An admin must add a Claude Code platform credential.'
    );
  }
  return cred.credential;
}

/** Default fetch timeout for LLM calls (configurable via SAM_LLM_TIMEOUT_MS). */
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export async function callLLM(
  env: Env,
  config: SamConfig,
  messages: OpenAIMessage[],
  userId: string,
  conversationId: string,
  baseSystemPrompt: string,
  tools: AnthropicToolDef[],
  endpoint: ChatCompletionsTarget | null
): Promise<Response> {
  const model = config.model;
  const systemPrompt = config.systemPromptAppend
    ? `${baseSystemPrompt}\n\n${config.systemPromptAppend}`
    : baseSystemPrompt;

  const openAITools = toOpenAITools(tools);
  const aigMetadata = JSON.stringify({
    source: config.aigSource,
    userId,
    conversationId,
  });

  // Timeout to prevent hanging fetches inside DOs
  const timeoutMs =
    parseInt(String((env as unknown as Record<string, string>).SAM_LLM_TIMEOUT_MS) || '', 10) ||
    DEFAULT_LLM_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (endpoint) {
      return await callOpenAIChatLLM(
        endpoint,
        systemPrompt,
        messages,
        openAITools,
        aigMetadata,
        config.maxTokens,
        controller.signal
      );
    } else if (isAnthropicModel(model)) {
      return await callAnthropicLLM(
        env,
        model,
        systemPrompt,
        messages,
        openAITools,
        aigMetadata,
        config.maxTokens,
        controller.signal,
        tools
      );
    } else if (isWorkersAIModel(model)) {
      const target = resolveCloudflareWorkersAiTarget(env, model);
      if (!target) throw new LlmUnavailableError('agent');
      return await callOpenAIChatLLM(
        target,
        systemPrompt,
        messages,
        openAITools,
        aigMetadata,
        config.maxTokens,
        controller.signal
      );
    } else {
      throw new Error(`Unknown model provider for model: ${model}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Call Anthropic Messages API, translating from OpenAI format at the boundary. */
async function callAnthropicLLM(
  env: Env,
  model: string,
  systemPrompt: string,
  messages: OpenAIMessage[],
  _openAITools: OpenAITool[],
  aigMetadata: string,
  maxTokens: number,
  signal: AbortSignal,
  anthropicTools: AnthropicToolDef[]
): Promise<Response> {
  const apiKey = await getAnthropicApiKey(env);
  const url = buildAnthropicGatewayUrl(env);

  // Convert OpenAI messages to Anthropic format
  const anthropicMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'user') {
        return { role: 'user' as const, content: m.content || '' };
      } else if (m.role === 'assistant') {
        const content: Array<Record<string, unknown>> = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            let input: unknown = {};
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              /* empty */
            }
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
          }
        }
        return { role: 'assistant' as const, content };
      } else if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            { type: 'tool_result', tool_use_id: m.tool_call_id || '', content: m.content || '' },
          ],
        };
      }
      return { role: 'user' as const, content: m.content || '' };
    });

  return fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': SAM_ANTHROPIC_VERSION,
      'content-type': 'application/json',
      ...aiGatewayOnlyHeaders(env, { 'cf-aig-metadata': aigMetadata }),
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools,
      stream: true,
    }),
  });
}

/** Call an OpenAI-format chat completions target (Workers AI or an OpenAI-compatible endpoint). */
async function callOpenAIChatLLM(
  target: ChatCompletionsTarget,
  systemPrompt: string,
  messages: OpenAIMessage[],
  openAITools: OpenAITool[],
  aigMetadata: string,
  maxTokens: number,
  signal: AbortSignal
): Promise<Response> {
  const fullMessages: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }, ...messages];

  return fetchChatTarget(target, {
    method: 'POST',
    signal,
    headers: chatTargetHeaders(target, { 'cf-aig-metadata': aigMetadata }),
    body: JSON.stringify({
      model: target.model,
      max_tokens: maxTokens,
      messages: fullMessages,
      tools: openAITools.length > 0 ? openAITools : undefined,
      stream: true,
    }),
  });
}
