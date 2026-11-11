/**
 * The SAM operator's model for an admin-configured OpenAI-compatible endpoint (self-host T5
 * follow-up, item 10). It used to be Mastra's `ModelRouterLanguageModel` with a `url` config;
 * T5 builds the model with `@ai-sdk/openai-compatible` directly so every request goes through the
 * guarded fetch. This runs the same agent turn, with a tool, through the real Mastra (the version
 * pinned in pnpm-lock.yaml) against a local OpenAI-compatible SSE server, once with the router
 * model and once with `resolveOperatorModel`, and requires the same tool call, final text,
 * per-step usage and request bodies.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { toJsonSchema } from '@valibot/to-json-schema';
import type Database from 'better-sqlite3';
import * as v from 'valibot';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveOperatorModel } from '../../../src/durable-objects/sam-session/operator/model';
import type { Env } from '../../../src/env';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const API_KEY = 'sk-endpoint-test-key';
const MODEL = 'local-model';

interface Captured {
  body: Record<string, unknown>;
  authorization: string | undefined;
}

let captured: Captured[] = [];

function sse(res: import('node:http').ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: MODEL };

/** First call: a tool call. Second call (it carries the tool result): the final answer. */
function answer(req: IncomingMessage, raw: string, res: import('node:http').ServerResponse) {
  const body = JSON.parse(raw) as { messages: Array<{ role: string }> };
  captured.push({ body, authorization: req.headers.authorization });
  if (!body.messages.some((message) => message.role === 'tool')) {
    sse(res, [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"query":"ans' },
                },
              ],
            },
          },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'wer"}' } }] } }],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { ...base, choices: [], usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 } },
    ]);
    return;
  }
  sse(res, [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'The answer ' } }] },
    { ...base, choices: [{ index: 0, delta: { content: 'is 42.' } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, choices: [], usage: { prompt_tokens: 61, completion_tokens: 5, total_tokens: 66 } },
  ]);
}

const server: Server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => {
    raw += chunk.toString();
  });
  req.on('end', () => answer(req, raw, res));
});
let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

let sqlite: Database.Database;
let env: Env;

beforeEach(() => {
  captured = [];
  __resetAdminSettingsCacheForTest();
  ({ sqlite, env } = createAdminSettingsEnv());
});
afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

const lookupInput = v.object({ query: v.string() });

/** The operator's own tool shape: valibot validation plus an explicit JSON schema. */
async function lookupTool(calls: unknown[]) {
  const { createTool } = await import('@mastra/core/tools');
  const jsonSchema = toJsonSchema(lookupInput);
  return createTool({
    id: 'lookup',
    description: 'Look something up.',
    inputSchema: {
      '~standard': {
        ...lookupInput['~standard'],
        jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
      },
    } as never,
    execute: async (input: unknown) => {
      calls.push(input);
      return { found: '42' };
    },
  });
}

interface TurnResult {
  text: string;
  toolCalls: unknown[];
  stepUsage: Array<{ inputTokens?: number; outputTokens?: number }>;
  stepFinishReasons: string[];
  bodies: Captured[];
  chunkTypes: string[];
}

/** The operator's agent.stream call shape (operator/agent.ts), minus SAM's own gates. */
async function runTurn(model: unknown): Promise<TurnResult> {
  const { Agent } = await import('@mastra/core/agent');
  const toolCalls: unknown[] = [];
  const stepUsage: TurnResult['stepUsage'] = [];
  const stepFinishReasons: string[] = [];
  const chunkTypes = new Set<string>();
  const agent = new Agent({
    id: 'sam-account-operator',
    name: 'SAM',
    instructions: 'Use the lookup tool, then answer.',
    model: model as never,
    tools: { lookup: await lookupTool(toolCalls) },
  });
  const output = await agent.stream([{ role: 'user', content: 'What is the answer?' }], {
    maxSteps: 4,
    modelSettings: { maxOutputTokens: 256, maxRetries: 0 },
    eagerToolExecution: false,
    onChunk: (chunk: { type: string }) => {
      chunkTypes.add(chunk.type);
    },
    onStepFinish: async (step: {
      usage: { inputTokens?: number; outputTokens?: number };
      finishReason: string;
    }) => {
      stepUsage.push({ inputTokens: step.usage.inputTokens, outputTokens: step.usage.outputTokens });
      stepFinishReasons.push(step.finishReason);
    },
  } as never);
  const full = await output.getFullOutput();
  if (full.error) throw full.error;
  return {
    text: full.text,
    toolCalls,
    stepUsage,
    stepFinishReasons,
    bodies: captured.splice(0),
    chunkTypes: [...chunkTypes].sort(),
  };
}

describe('SAM operator model for a custom endpoint behaves like Mastra router model', () => {
  it('same tool call, streamed text, usage and request bodies', async () => {
    const { ModelRouterLanguageModel } = await import('@mastra/core/llm');
    const router = await runTurn(
      new ModelRouterLanguageModel({
        providerId: 'sam-openai-compatible',
        modelId: MODEL,
        url: baseUrl,
        apiKey: API_KEY,
        headers: {},
        api: 'chat',
      })
    );

    await updateAdminSettings(env, {
      changes: [
        { name: 'llm.openAICompatible.baseUrl', value: baseUrl },
        { name: 'llm.openAICompatible.apiKey', value: API_KEY },
        { name: 'llm.openAICompatible.model', value: MODEL },
        // The stub is on loopback.
        { name: 'llm.openAICompatible.allowPrivateNetwork', value: true },
      ],
      actorUserId: 'admin',
    });
    const ours = await runTurn(
      await resolveOperatorModel(env, '@cf/zai-org/glm-5.3-flash', {
        metadata: '{}',
        sessionAffinity: 'sam-conv-1',
      })
    );

    // The turn itself: one tool call with the streamed arguments, then the final text.
    expect(router.toolCalls).toEqual([{ query: 'answer' }]);
    expect(router.text).toBe('The answer is 42.');
    expect(router.stepUsage).toEqual([
      { inputTokens: 40, outputTokens: 9 },
      { inputTokens: 61, outputTokens: 5 },
    ]);
    // Equivalence.
    expect(ours.toolCalls).toEqual(router.toolCalls);
    expect(ours.text).toBe(router.text);
    expect(ours.stepUsage).toEqual(router.stepUsage);
    expect(ours.stepFinishReasons).toEqual(router.stepFinishReasons);
    expect(ours.chunkTypes).toEqual(router.chunkTypes);
    expect(ours.bodies).toEqual(router.bodies);
    expect(ours.bodies.map((body) => body.authorization)).toEqual([
      `Bearer ${API_KEY}`,
      `Bearer ${API_KEY}`,
    ]);
    expect(ours.bodies[0]?.body).toMatchObject({ model: MODEL, stream: true });
  });
});
