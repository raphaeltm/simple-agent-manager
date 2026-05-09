/**
 * Sandbox agent loop — think-act-observe cycle using Workers AI.
 *
 * Implements a self-contained agent loop that calls an LLM through AI Gateway,
 * receives tool calls, executes them via the Sandbox SDK, and feeds results
 * back until the model is done or max turns are reached.
 *
 * Gated behind SANDBOX_ENABLED env var (default: false).
 */
import {
  DEFAULT_SANDBOX_AGENT_MAX_TURNS,
  DEFAULT_SANDBOX_MODEL,
  type SandboxAgentConfig,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';

import {
  type SandboxHandle,
  SANDBOX_TOOLS,
  SANDBOX_TOOL_NAMES,
  executeSandboxTool,
} from './sandbox-tools';

const log = createModuleLogger('sandbox_agent');

// =============================================================================
// Types
// =============================================================================

/** Message in the OpenAI chat-completions format. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** A single tool call collected from the LLM response. */
interface ToolCallEntry {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Record of a single agent turn for observability. */
export interface AgentTurnRecord {
  turn: number;
  textContent: string;
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    result: unknown;
    durationMs: number;
  }>;
}

/** Result of a sandbox agent run. */
export interface SandboxAgentResult {
  success: boolean;
  turns: AgentTurnRecord[];
  totalTurns: number;
  finalResponse: string;
  error?: string;
  tokenUsage?: { promptTokens: number; completionTokens: number };
}

/** SSE event for streaming the agent loop progress. */
export type SandboxAgentSseEvent =
  | { type: 'agent_start'; model: string; maxTurns: number }
  | { type: 'turn_start'; turn: number }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: unknown; durationMs: number }
  | { type: 'turn_end'; turn: number }
  | { type: 'agent_done'; result: SandboxAgentResult }
  | { type: 'agent_error'; message: string };

// =============================================================================
// Config resolution
// =============================================================================

/** Check if sandbox features are enabled. */
export function isSandboxEnabled(env: Env): boolean {
  return env.SANDBOX_ENABLED === 'true' && !!env.SANDBOX;
}

/** Resolve sandbox agent config from env vars with defaults. */
export function resolveSandboxAgentConfig(
  env: Env,
  overrides?: Partial<SandboxAgentConfig>,
): SandboxAgentConfig {
  return {
    modelId: overrides?.modelId || env.SANDBOX_DEFAULT_MODEL || DEFAULT_SANDBOX_MODEL,
    sandboxId: overrides?.sandboxId || 'default',
    maxTurns: overrides?.maxTurns || parseInt(env.SANDBOX_AGENT_MAX_TURNS || '', 10) || DEFAULT_SANDBOX_AGENT_MAX_TURNS,
    execTimeoutMs: overrides?.execTimeoutMs || parseInt(env.SANDBOX_EXEC_TIMEOUT_MS || '', 10) || 30_000,
    gitTimeoutMs: overrides?.gitTimeoutMs || parseInt(env.SANDBOX_GIT_TIMEOUT_MS || '', 10) || 120_000,
    repoUrl: overrides?.repoUrl || '',
    branch: overrides?.branch || 'main',
  };
}

// =============================================================================
// LLM call (non-streaming for simplicity in the agent loop)
// =============================================================================

/** Build the Workers AI Gateway URL. */
function buildGatewayUrl(env: Env): string {
  const gatewayId = env.AI_GATEWAY_ID;
  if (gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/workers-ai/v1/chat/completions`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
}

/** Call LLM via AI Gateway (non-streaming, returns full response). */
async function callLLM(
  env: Env,
  model: string,
  messages: ChatMessage[],
  maxTokens: number = 4096,
): Promise<{
  textContent: string;
  toolCalls: ToolCallEntry[];
  promptTokens: number;
  completionTokens: number;
}> {
  const url = buildGatewayUrl(env);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages,
      tools: SANDBOX_TOOLS,
      tool_choice: 'auto',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`LLM call failed (${response.status}): ${errorText.slice(0, 500)}`);
  }

  const data = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = data.choices?.[0];
  const message = choice?.message;
  const textContent = message?.content || '';

  const toolCalls: ToolCallEntry[] = [];
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* empty */ }
      toolCalls.push({ id: tc.id, name: tc.function.name, args });
    }
  }

  return {
    textContent,
    toolCalls,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

// =============================================================================
// Agent loop
// =============================================================================

/**
 * Run the sandbox agent loop.
 *
 * Think-act-observe cycle:
 * 1. Call LLM with conversation + sandbox tool definitions
 * 2. If model returns tool calls, execute them via sandbox
 * 3. Feed results back, repeat until no more tool calls or max turns
 *
 * @param env - Worker environment bindings
 * @param sandbox - Sandbox handle (exec, readFile, writeFile, listFiles)
 * @param config - Agent config (model, max turns, timeouts)
 * @param prompt - The user's prompt
 * @param systemPrompt - Optional system prompt override
 * @param onEvent - Optional SSE event callback for streaming progress
 */
export async function runSandboxAgent(
  env: Env,
  sandbox: SandboxHandle,
  config: SandboxAgentConfig,
  prompt: string,
  systemPrompt?: string,
  onEvent?: (event: SandboxAgentSseEvent) => Promise<void>,
): Promise<SandboxAgentResult> {
  const model = config.modelId;
  const maxTurns = config.maxTurns;

  log.info('sandbox_agent.start', { model, maxTurns, sandboxId: config.sandboxId });
  await onEvent?.({ type: 'agent_start', model, maxTurns });

  const defaultSystem = `You are a coding assistant with access to a sandboxed Linux environment. You can execute shell commands, read/write files, list directories, and clone git repositories. Use these tools to help the user with their request.

When working with code:
- Use sandbox_exec to run commands and see output
- Use sandbox_read_file to examine existing files
- Use sandbox_write_file to create or modify files
- Use sandbox_list_files to explore the directory structure
- Use sandbox_git_clone to clone repositories

Be concise and action-oriented. Execute commands to verify your work.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt || defaultSystem },
    { role: 'user', content: prompt },
  ];

  const turns: AgentTurnRecord[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let finalResponse = '';

  for (let turn = 1; turn <= maxTurns; turn++) {
    log.info('sandbox_agent.turn_start', { turn, model });
    await onEvent?.({ type: 'turn_start', turn });

    let llmResult;
    try {
      llmResult = await callLLM(env, model, messages);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('sandbox_agent.llm_error', { turn, error: errMsg });
      await onEvent?.({ type: 'agent_error', message: errMsg });
      return {
        success: false,
        turns,
        totalTurns: turn,
        finalResponse,
        error: errMsg,
        tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
      };
    }

    totalPromptTokens += llmResult.promptTokens;
    totalCompletionTokens += llmResult.completionTokens;

    if (llmResult.textContent) {
      finalResponse = llmResult.textContent;
      await onEvent?.({ type: 'thinking', content: llmResult.textContent });
    }

    // No tool calls — agent is done
    if (llmResult.toolCalls.length === 0) {
      log.info('sandbox_agent.done', { turn, reason: 'no_tool_calls' });
      turns.push({ turn, textContent: llmResult.textContent, toolCalls: [] });
      await onEvent?.({ type: 'turn_end', turn });
      break;
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: llmResult.textContent || null,
      tool_calls: llmResult.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    });

    // Execute each tool call
    const turnToolCalls: AgentTurnRecord['toolCalls'] = [];
    for (const tc of llmResult.toolCalls) {
      await onEvent?.({ type: 'tool_call', tool: tc.name, args: tc.args });

      const toolStart = Date.now();
      let result: unknown;

      if (SANDBOX_TOOL_NAMES.has(tc.name)) {
        try {
          result = await executeSandboxTool(
            sandbox,
            tc.name,
            tc.args,
            config.execTimeoutMs,
            config.gitTimeoutMs,
          );
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      } else {
        result = { error: `Unknown tool: ${tc.name}` };
      }

      const toolDurationMs = Date.now() - toolStart;
      turnToolCalls.push({ name: tc.name, args: tc.args, result, durationMs: toolDurationMs });
      await onEvent?.({ type: 'tool_result', tool: tc.name, result, durationMs: toolDurationMs });

      // Add tool result message
      messages.push({
        role: 'tool',
        content: JSON.stringify(result),
        tool_call_id: tc.id,
      });
    }

    turns.push({ turn, textContent: llmResult.textContent, toolCalls: turnToolCalls });
    await onEvent?.({ type: 'turn_end', turn });
  }

  const agentResult: SandboxAgentResult = {
    success: true,
    turns,
    totalTurns: turns.length,
    finalResponse,
    tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
  };

  log.info('sandbox_agent.complete', {
    totalTurns: agentResult.totalTurns,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
  });
  await onEvent?.({ type: 'agent_done', result: agentResult });

  return agentResult;
}
