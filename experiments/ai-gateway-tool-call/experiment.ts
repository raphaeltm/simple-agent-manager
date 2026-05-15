/**
 * AI Gateway Unified API tool-call experiment.
 *
 * Tests multi-model tool calling through CF AI Gateway's Unified API endpoint.
 * The Unified API accepts OpenAI-format requests and handles format translation
 * server-side for all providers (Anthropic, OpenAI, Workers AI).
 *
 * Usage:
 *   CF_ACCOUNT_ID=xxx CF_API_TOKEN=xxx AI_GATEWAY_ID=xxx npx tsx experiments/ai-gateway-tool-call/experiment.ts
 *
 * Required env vars:
 *   CF_ACCOUNT_ID  — Cloudflare account ID
 *   CF_API_TOKEN   — Cloudflare API token (for Unified Billing via cf-aig-authorization)
 *   AI_GATEWAY_ID  — AI Gateway name/ID
 *
 * Optional:
 *   CF_AIG_TOKEN   — Dedicated AI Gateway billing token (preferred over CF_API_TOKEN)
 */

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI format)
// ---------------------------------------------------------------------------

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city. Returns temperature in Fahrenheit and condition.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name (e.g., "Paris")' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a mathematical expression and return the result.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Math expression (e.g., "(72 - 32) * 5/9")' },
        },
        required: ['expression'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Mock tool execution
// ---------------------------------------------------------------------------

function executeTool(name: string, args: Record<string, unknown>): string {
  if (name === 'get_weather') {
    return JSON.stringify({
      city: args.city,
      temperature_f: 72,
      condition: 'sunny',
      humidity_percent: 45,
    });
  }
  if (name === 'calculate') {
    const expr = String(args.expression);
    // Safe eval for basic math only
    const sanitized = expr.replace(/[^0-9+\-*/().% ]/g, '');
    if (sanitized !== expr) {
      return JSON.stringify({ error: 'Invalid expression' });
    }
    try {
      // eslint-disable-next-line no-eval
      const result = Function(`"use strict"; return (${sanitized})`)();
      return JSON.stringify({ result: Number(result.toFixed(4)) });
    } catch {
      return JSON.stringify({ error: 'Evaluation failed' });
    }
  }
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// ---------------------------------------------------------------------------
// Unified API client
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: ChatMessage;
    finish_reason: string;
  }>;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

type FailureCategory =
  | 'credential-config'
  | 'provider-unsupported'
  | 'tool-call-shape-mismatch'
  | 'model-quality'
  | 'network-error'
  | 'unknown';

interface ExperimentResult {
  modelId: string;
  unifiedApiModelId: string;
  success: boolean;
  toolCallsCompleted: number;
  totalTurns: number;
  failureCategory?: FailureCategory;
  failureDetail?: string;
  requestShape?: Record<string, unknown>;
  responseShape?: Record<string, unknown>;
  finalAnswer?: string;
  usage?: ChatCompletionResponse['usage'];
  durationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('tool_call arguments must be a JSON object');
  }
  return parsed;
}

function parseUsage(value: unknown): ChatCompletionResponse['usage'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('usage must be an object when present');
  }
  return {
    prompt_tokens: requireNumber(value.prompt_tokens, 'usage.prompt_tokens'),
    completion_tokens: requireNumber(value.completion_tokens, 'usage.completion_tokens'),
    total_tokens: requireNumber(value.total_tokens, 'usage.total_tokens'),
  };
}

function parseChatMessage(value: unknown, path: string): ChatMessage {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }

  const role = requireString(value.role, `${path}.role`);
  const content =
    value.content === undefined || value.content === null
      ? value.content
      : requireString(value.content, `${path}.content`);
  const toolCallId =
    value.tool_call_id === undefined
      ? undefined
      : requireString(value.tool_call_id, `${path}.tool_call_id`);

  let toolCalls: ChatMessage['tool_calls'];
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls)) {
      throw new Error(`${path}.tool_calls must be an array when present`);
    }
    toolCalls = value.tool_calls.map((toolCall, index) => {
      if (!isRecord(toolCall)) {
        throw new Error(`${path}.tool_calls[${index}] must be an object`);
      }
      if (toolCall.type !== 'function') {
        throw new Error(`${path}.tool_calls[${index}].type must be "function"`);
      }
      if (!isRecord(toolCall.function)) {
        throw new Error(`${path}.tool_calls[${index}].function must be an object`);
      }
      return {
        id: requireString(toolCall.id, `${path}.tool_calls[${index}].id`),
        type: 'function',
        function: {
          name: requireString(
            toolCall.function.name,
            `${path}.tool_calls[${index}].function.name`,
          ),
          arguments: requireString(
            toolCall.function.arguments,
            `${path}.tool_calls[${index}].function.arguments`,
          ),
        },
      };
    });
  }

  return {
    role,
    ...(content !== undefined ? { content } : {}),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(toolCallId ? { tool_call_id: toolCallId } : {}),
  };
}

function parseChatCompletionResponse(value: unknown): ChatCompletionResponse {
  if (!isRecord(value)) {
    throw new Error('chat completion response must be an object');
  }
  if (!Array.isArray(value.choices)) {
    throw new Error('chat completion response choices must be an array');
  }

  return {
    id: requireString(value.id, 'chat completion response.id'),
    model: requireString(value.model, 'chat completion response.model'),
    choices: value.choices.map((choice, index) => {
      if (!isRecord(choice)) {
        throw new Error(`chat completion response.choices[${index}] must be an object`);
      }
      return {
        message: parseChatMessage(choice.message, `chat completion response.choices[${index}].message`),
        finish_reason: requireString(
          choice.finish_reason,
          `chat completion response.choices[${index}].finish_reason`,
        ),
      };
    }),
    usage: parseUsage(value.usage),
  };
}

function buildUnifiedApiUrl(accountId: string, gatewayId: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`;
}

function buildAigMetadata(modelId: string): string {
  return JSON.stringify({
    userId: 'experiment',
    workspaceId: 'experiment',
    projectId: 'experiment',
    source: 'ai-gateway-tool-call-experiment',
    modelId,
  });
}

async function callUnifiedApi(
  url: string,
  authToken: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<ChatCompletionResponse> {
  const body = {
    model,
    messages,
    tools,
    tool_choice: 'auto',
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'cf-aig-authorization': `Bearer ${authToken}`,
    'cf-aig-metadata': buildAigMetadata(model),
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API error ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const payload: unknown = await resp.json();
  return parseChatCompletionResponse(payload);
}

// ---------------------------------------------------------------------------
// Two-tool loop experiment
// ---------------------------------------------------------------------------

async function runTwoToolLoop(
  url: string,
  authToken: string,
  unifiedModelId: string,
  displayName: string,
): Promise<ExperimentResult> {
  const start = Date.now();
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a helpful assistant. Use the provided tools to answer questions. When you need to convert temperature, use the calculate tool.',
    },
    {
      role: 'user',
      content: 'What is the weather in Paris right now? Also tell me the temperature in Celsius.',
    },
  ];

  let toolCallsCompleted = 0;
  let totalTurns = 0;
  const maxTurns = 6;
  let lastResponse: ChatCompletionResponse | undefined;

  try {
    while (totalTurns < maxTurns) {
      totalTurns++;
      const response = await callUnifiedApi(url, authToken, unifiedModelId, messages, TOOLS);
      lastResponse = response;

      const choice = response.choices?.[0];
      if (!choice) {
        return {
          modelId: displayName,
          unifiedApiModelId: unifiedModelId,
          success: false,
          toolCallsCompleted,
          totalTurns,
          failureCategory: 'tool-call-shape-mismatch',
          failureDetail: 'No choices in response',
          responseShape: isRecord(response) ? response : undefined,
          durationMs: Date.now() - start,
        };
      }

      const msg = choice.message;
      messages.push(msg);

      if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) {
        // Model finished — check if it actually used tools
        return {
          modelId: displayName,
          unifiedApiModelId: unifiedModelId,
          success: toolCallsCompleted >= 2,
          toolCallsCompleted,
          totalTurns,
          failureCategory: toolCallsCompleted < 2 ? 'model-quality' : undefined,
          failureDetail: toolCallsCompleted < 2 ? `Only ${toolCallsCompleted} tool calls made (need 2)` : undefined,
          finalAnswer: msg.content ?? undefined,
          usage: response.usage,
          durationMs: Date.now() - start,
        };
      }

      // Execute tool calls
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = parseToolArguments(tc.function.arguments);
        } catch {
          return {
            modelId: displayName,
            unifiedApiModelId: unifiedModelId,
            success: false,
            toolCallsCompleted,
            totalTurns,
            failureCategory: 'tool-call-shape-mismatch',
            failureDetail: `Invalid JSON in tool_call arguments: ${tc.function.arguments}`,
            durationMs: Date.now() - start,
          };
        }

        const result = executeTool(tc.function.name, args);
        toolCallsCompleted++;

        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    return {
      modelId: displayName,
      unifiedApiModelId: unifiedModelId,
      success: false,
      toolCallsCompleted,
      totalTurns,
      failureCategory: 'model-quality',
      failureDetail: `Exceeded max turns (${maxTurns}) without completing`,
      usage: lastResponse?.usage,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    let category: FailureCategory = 'unknown';
    if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('authentication')) {
      category = 'credential-config';
    } else if (errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('not supported')) {
      category = 'provider-unsupported';
    } else if (errMsg.includes('fetch') || errMsg.includes('network') || errMsg.includes('ECONNREFUSED')) {
      category = 'network-error';
    }

    return {
      modelId: displayName,
      unifiedApiModelId: unifiedModelId,
      success: false,
      toolCallsCompleted,
      totalTurns,
      failureCategory: category,
      failureDetail: errMsg.slice(0, 500),
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Workers AI path (different endpoint, not Unified API)
// ---------------------------------------------------------------------------

async function runWorkersAiToolLoop(
  accountId: string,
  gatewayId: string,
  authToken: string,
  modelId: string,
  displayName: string,
): Promise<ExperimentResult> {
  const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/v1/chat/completions`;
  const start = Date.now();
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a helpful assistant. Use the provided tools to answer questions. When you need to convert temperature, use the calculate tool.',
    },
    {
      role: 'user',
      content: 'What is the weather in Paris right now? Also tell me the temperature in Celsius.',
    },
  ];

  let toolCallsCompleted = 0;
  let totalTurns = 0;
  const maxTurns = 6;

  try {
    while (totalTurns < maxTurns) {
      totalTurns++;

      // Workers AI quirks:
      // 1. tool_choice "auto" often produces text instead of structured tool_calls —
      //    use "required" when we still need tool calls, switch to "auto" after both tools fired
      // 2. content: null rejected in assistant messages — must use "" (empty string)
      const needsMoreTools = toolCallsCompleted < 2;
      const sanitizedMessages = messages.map((m) => {
        if (m.role === 'assistant' && m.tool_calls?.length && m.content === null) {
          return { ...m, content: '' };
        }
        return m;
      });

      const body = {
        model: modelId,
        messages: sanitizedMessages,
        tools: TOOLS,
        tool_choice: needsMoreTools ? 'required' : 'auto',
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
          'cf-aig-metadata': buildAigMetadata(modelId),
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return {
          modelId: displayName,
          unifiedApiModelId: modelId,
          success: false,
          toolCallsCompleted,
          totalTurns,
          failureCategory: resp.status === 401 || resp.status === 403 ? 'credential-config' : 'provider-unsupported',
          failureDetail: `Workers AI ${resp.status}: ${errText.slice(0, 300)}`,
          durationMs: Date.now() - start,
        };
      }

      const payload: unknown = await resp.json();
      const response = parseChatCompletionResponse(payload);
      const choice = response.choices?.[0];
      if (!choice) {
        return {
          modelId: displayName,
          unifiedApiModelId: modelId,
          success: false,
          toolCallsCompleted,
          totalTurns,
          failureCategory: 'tool-call-shape-mismatch',
          failureDetail: 'No choices in Workers AI response',
          responseShape: isRecord(response) ? response : undefined,
          durationMs: Date.now() - start,
        };
      }

      const msg = choice.message;
      messages.push(msg);

      if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) {
        return {
          modelId: displayName,
          unifiedApiModelId: modelId,
          success: toolCallsCompleted >= 2,
          toolCallsCompleted,
          totalTurns,
          failureCategory: toolCallsCompleted < 2 ? 'model-quality' : undefined,
          failureDetail: toolCallsCompleted < 2 ? `Only ${toolCallsCompleted} tool calls made (need 2)` : undefined,
          finalAnswer: msg.content ?? undefined,
          usage: response.usage,
          durationMs: Date.now() - start,
        };
      }

      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = parseToolArguments(tc.function.arguments);
        } catch {
          return {
            modelId: displayName,
            unifiedApiModelId: modelId,
            success: false,
            toolCallsCompleted,
            totalTurns,
            failureCategory: 'tool-call-shape-mismatch',
            failureDetail: `Invalid JSON in tool_call arguments: ${tc.function.arguments}`,
            durationMs: Date.now() - start,
          };
        }

        const result = executeTool(tc.function.name, args);
        toolCallsCompleted++;

        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    return {
      modelId: displayName,
      unifiedApiModelId: modelId,
      success: false,
      toolCallsCompleted,
      totalTurns,
      failureCategory: 'model-quality',
      failureDetail: `Exceeded max turns (${maxTurns})`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      modelId: displayName,
      unifiedApiModelId: modelId,
      success: false,
      toolCallsCompleted,
      totalTurns,
      failureCategory: 'network-error',
      failureDetail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const MODELS_TO_TEST = [
  { unifiedApiId: 'anthropic/claude-haiku-4-5-20251001', display: 'Claude Haiku 4.5', path: 'unified' },
  { unifiedApiId: 'openai/gpt-4.1-mini', display: 'GPT-4.1 Mini', path: 'unified' },
  { unifiedApiId: '@cf/google/gemma-4-26b-a4b-it', display: 'Gemma 4 26B', path: 'workers-ai' },
  { unifiedApiId: '@cf/qwen/qwen2.5-coder-32b-instruct', display: 'Qwen 2.5 Coder 32B', path: 'workers-ai' },
  { unifiedApiId: '@cf/qwen/qwen3-30b-a3b-fp8', display: 'Qwen 3 30B', path: 'workers-ai' },
] as const;

async function main(): Promise<void> {
  const accountId = process.env.CF_ACCOUNT_ID;
  const authToken = process.env.CF_AIG_TOKEN ?? process.env.CF_API_TOKEN;
  const gatewayId = process.env.AI_GATEWAY_ID;

  if (!accountId || !authToken || !gatewayId) {
    console.error('Missing required env vars: CF_ACCOUNT_ID, CF_API_TOKEN (or CF_AIG_TOKEN), AI_GATEWAY_ID');
    console.error('Current state:');
    console.error(`  CF_ACCOUNT_ID: ${accountId ? 'set' : 'MISSING'}`);
    console.error(`  CF_API_TOKEN: ${process.env.CF_API_TOKEN ? 'set' : 'MISSING'}`);
    console.error(`  CF_AIG_TOKEN: ${process.env.CF_AIG_TOKEN ? 'set' : 'MISSING'}`);
    console.error(`  AI_GATEWAY_ID: ${gatewayId ? 'set' : 'MISSING'}`);
    process.exit(1);
  }

  const unifiedUrl = buildUnifiedApiUrl(accountId, gatewayId);
  console.log(`\nAI Gateway Unified API: ${unifiedUrl}`);
  console.log(`Testing ${MODELS_TO_TEST.length} models...\n`);
  console.log('='.repeat(80));

  const results: ExperimentResult[] = [];

  for (const model of MODELS_TO_TEST) {
    console.log(`\nTesting: ${model.display} (${model.unifiedApiId})`);
    console.log('-'.repeat(60));

    let result: ExperimentResult;
    if (model.path === 'workers-ai') {
      result = await runWorkersAiToolLoop(accountId, gatewayId, authToken, model.unifiedApiId, model.display);
    } else {
      result = await runTwoToolLoop(unifiedUrl, authToken, model.unifiedApiId, model.display);
    }

    results.push(result);

    if (result.success) {
      console.log(`  SUCCESS: ${result.toolCallsCompleted} tool calls in ${result.totalTurns} turns (${result.durationMs}ms)`);
      if (result.finalAnswer) {
        console.log(`  Answer: ${result.finalAnswer.slice(0, 200)}`);
      }
      if (result.usage) {
        console.log(`  Tokens: ${result.usage.prompt_tokens} in / ${result.usage.completion_tokens} out`);
      }
    } else {
      console.log(`  FAILED: [${result.failureCategory}] ${result.failureDetail}`);
      console.log(`  Tool calls completed: ${result.toolCallsCompleted}, turns: ${result.totalTurns} (${result.durationMs}ms)`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('\nSUMMARY');
  console.log('-'.repeat(40));
  for (const r of results) {
    const status = r.success ? 'PASS' : `FAIL (${r.failureCategory})`;
    console.log(`  ${r.modelId.padEnd(30)} ${status}`);
  }

  const passed = results.filter((r) => r.success).length;
  console.log(`\n${passed}/${results.length} models passed the two-tool loop test`);

  // Write detailed results as JSON for PR evidence
  console.log('\n--- DETAILED RESULTS (JSON) ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
