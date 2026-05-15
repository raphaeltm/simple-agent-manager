/**
 * Eval scenario runner.
 *
 * Executes a single eval scenario against a single model through SAM's AI Gateway.
 * Implements the think-act-observe loop with full trace capture.
 */

import type {
  ChatMessage,
  ChatCompletionResponse,
  EvalScenario,
  EvalTool,
  ModelConfig,
  ScenarioRun,
  TokenUsage,
  ToolCallRecord,
} from './types.js';
import { buildGatewayUrl, buildHeaders } from './models.js';

interface RunnerEnv {
  accountId: string;
  gatewayId: string;
  authToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('usage must be an object');
  if (
    typeof value.prompt_tokens !== 'number' ||
    typeof value.completion_tokens !== 'number' ||
    typeof value.total_tokens !== 'number'
  ) {
    throw new Error('usage token counts must be numbers');
  }
  return {
    prompt_tokens: value.prompt_tokens,
    completion_tokens: value.completion_tokens,
    total_tokens: value.total_tokens,
  };
}

function parseChatMessage(value: unknown, path: string): ChatMessage {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const role = requireString(value.role, `${path}.role`);
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    throw new Error(`${path}.role has an unsupported value`);
  }

  let toolCalls: ChatMessage['tool_calls'];
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls)) throw new Error(`${path}.tool_calls must be an array`);
    toolCalls = value.tool_calls.map((rawToolCall, index) => {
      if (!isRecord(rawToolCall)) throw new Error(`${path}.tool_calls[${index}] must be an object`);
      if (rawToolCall.type !== 'function') {
        throw new Error(`${path}.tool_calls[${index}].type must be "function"`);
      }
      if (!isRecord(rawToolCall.function)) {
        throw new Error(`${path}.tool_calls[${index}].function must be an object`);
      }
      return {
        id: requireString(rawToolCall.id, `${path}.tool_calls[${index}].id`),
        type: 'function',
        function: {
          name: requireString(rawToolCall.function.name, `${path}.tool_calls[${index}].function.name`),
          arguments: requireString(
            rawToolCall.function.arguments,
            `${path}.tool_calls[${index}].function.arguments`,
          ),
        },
      };
    });
  }

  return {
    role,
    content:
      value.content === undefined || value.content === null
        ? value.content
        : requireString(value.content, `${path}.content`),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(typeof value.tool_call_id === 'string' ? { tool_call_id: value.tool_call_id } : {}),
    ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}),
  };
}

function parseChatCompletionResponse(value: unknown): ChatCompletionResponse {
  if (!isRecord(value)) throw new Error('chat completion response must be an object');
  if (!Array.isArray(value.choices)) {
    throw new Error('chat completion response choices must be an array');
  }
  return {
    id: requireString(value.id, 'chat completion response.id'),
    model: requireString(value.model, 'chat completion response.model'),
    choices: value.choices.map((rawChoice, index) => {
      if (!isRecord(rawChoice)) {
        throw new Error(`chat completion response.choices[${index}] must be an object`);
      }
      return {
        message: parseChatMessage(rawChoice.message, `chat completion response.choices[${index}].message`),
        finish_reason: requireString(
          rawChoice.finish_reason,
          `chat completion response.choices[${index}].finish_reason`,
        ),
      };
    }),
    usage: parseUsage(value.usage),
  };
}

/**
 * Run a single scenario against a single model.
 */
export async function runScenario(
  scenario: EvalScenario,
  model: ModelConfig,
  env: RunnerEnv,
): Promise<ScenarioRun> {
  const url = buildGatewayUrl(env.accountId, env.gatewayId, model);
  const headers = buildHeaders(model, env.authToken);

  // Build tool definitions for the API call
  const toolDefs = scenario.tools.map((t) => t.definition);

  // Build tool handler lookup
  const toolHandlers = new Map<string, EvalTool>();
  for (const tool of scenario.tools) {
    toolHandlers.set(tool.definition.function.name, tool);
  }

  // Initialize conversation
  const messages: ChatMessage[] = [
    { role: 'system', content: scenario.systemPrompt },
    { role: 'user', content: scenario.userPrompt },
  ];

  const toolCalls: ToolCallRecord[] = [];
  const turnUsage: Array<{ turn: number; usage: TokenUsage | null }> = [];
  const turnLatency: Array<{ turn: number; latencyMs: number }> = [];
  let totalUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let turnsUsed = 0;

  const overallStart = Date.now();

  try {
    for (let turn = 1; turn <= scenario.maxTurns; turn++) {
      turnsUsed = turn;
      const turnStart = Date.now();

      // Build request body
      const requestModel = model.path === 'workers-ai' ? model.modelId : model.apiModelId;

      // Workers AI quirk: content: null must be "" for some models (not Gemma 4, but keep for safety)
      const sanitizedMessages =
        model.path === 'workers-ai'
          ? messages.map((m) => {
              if (m.role === 'assistant' && m.tool_calls?.length && m.content === null) {
                return { ...m, content: '' };
              }
              return m;
            })
          : messages;

      const body = {
        model: requestModel,
        messages: sanitizedMessages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        tool_choice: toolDefs.length > 0 ? 'auto' : undefined,
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const latencyMs = Date.now() - turnStart;
      turnLatency.push({ turn, latencyMs });

      if (!resp.ok) {
        const errText = await resp.text();
        return buildErrorRun(scenario, model, messages, toolCalls, totalUsage, turnUsage, turnLatency, turnsUsed, `API error ${resp.status}: ${errText.slice(0, 500)}`);
      }

      const payload: unknown = await resp.json();
      const response = parseChatCompletionResponse(payload);

      // Track usage
      if (response.usage) {
        totalUsage = addUsage(totalUsage, response.usage);
        turnUsage.push({ turn, usage: response.usage });
      } else {
        turnUsage.push({ turn, usage: null });
      }

      const choice = response.choices?.[0];
      if (!choice) {
        return buildErrorRun(scenario, model, messages, toolCalls, totalUsage, turnUsage, turnLatency, turnsUsed, 'No choices in API response');
      }

      const msg = choice.message;
      messages.push(msg);

      // If no tool calls, the model is done
      if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) {
        return {
          scenarioId: scenario.id,
          model,
          messages: [...messages],
          toolCalls,
          totalUsage,
          turnUsage,
          totalLatencyMs: Date.now() - overallStart,
          turnLatency,
          stopReason: 'complete',
          turnsUsed,
        };
      }

      // Execute tool calls
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          const errResult = `Error: invalid JSON in tool arguments: ${tc.function.arguments.slice(0, 200)}`;
          toolCalls.push({
            turn,
            toolName: tc.function.name,
            arguments: {},
            result: errResult,
            isError: true,
          });
          messages.push({
            role: 'tool',
            content: errResult,
            tool_call_id: tc.id,
          });
          continue;
        }

        const handler = toolHandlers.get(tc.function.name);
        let result: string;
        let isError = false;

        if (!handler) {
          result = `Error: unknown tool "${tc.function.name}". Available tools: ${Array.from(toolHandlers.keys()).join(', ')}`;
          isError = true;
        } else {
          try {
            result = handler.handler(args);
          } catch (err) {
            result = `Error: tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
            isError = true;
          }
        }

        toolCalls.push({
          turn,
          toolName: tc.function.name,
          arguments: args,
          result,
          isError,
        });

        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    // Exceeded max turns
    return {
      scenarioId: scenario.id,
      model,
      messages: [...messages],
      toolCalls,
      totalUsage,
      turnUsage,
      totalLatencyMs: Date.now() - overallStart,
      turnLatency,
      stopReason: 'max_turns',
      turnsUsed,
    };
  } catch (err) {
    return buildErrorRun(
      scenario,
      model,
      messages,
      toolCalls,
      totalUsage,
      turnUsage,
      turnLatency,
      turnsUsed,
      err instanceof Error ? err.message : String(err),
    );
  }
}

function buildErrorRun(
  scenario: EvalScenario,
  model: ModelConfig,
  messages: ChatMessage[],
  toolCalls: ToolCallRecord[],
  totalUsage: TokenUsage,
  turnUsage: Array<{ turn: number; usage: TokenUsage | null }>,
  turnLatency: Array<{ turn: number; latencyMs: number }>,
  turnsUsed: number,
  error: string,
): ScenarioRun {
  return {
    scenarioId: scenario.id,
    model,
    messages: [...messages],
    toolCalls,
    totalUsage,
    turnUsage,
    totalLatencyMs: turnLatency.reduce((s, t) => s + t.latencyMs, 0),
    turnLatency,
    stopReason: 'error',
    turnsUsed,
    error,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}
