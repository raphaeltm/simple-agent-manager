/**
 * Canned provider responses for the test-only fake AI upstream: answered in-process by the API
 * Worker on installations without an AI Gateway (`apps/api/src/services/ai-test-upstream.ts`), and
 * by the staging-only fake Worker behind the gateway (`ai-test-upstream-worker.ts`).
 *
 * Each response has the shape the real provider returns on that path (Anthropic Messages,
 * OpenAI Chat Completions, OpenAI Responses; JSON and SSE), with fixed text and a `usage` block
 * sized so the requested model's catalog price (`PLATFORM_AI_MODELS`) comes to the configured
 * cost. Nothing here makes a network call.
 */
import { maybeJsonRecord } from '@simple-agent-manager/worker-core';

import { findPricedModel } from './ai-cost-pricing';

/** The text every fake completion returns. */
export const FAKE_UPSTREAM_TEXT = 'SAM test upstream: canned reply (no real model was called).';
/** Input tokens every fake call reports; the rest of the cost is put on output tokens. */
export const FAKE_UPSTREAM_INPUT_TOKENS = 10;
/** Output tokens reported for a model with no catalog price (it costs $0 whatever is reported). */
const UNPRICED_OUTPUT_TOKENS = 16;

export interface FakeUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Usage that prices to `costUsd` for `modelId` under `priceModelUsageUsd` (to within one output
 * token). An unpriced model gets a small fixed usage.
 */
export function fakeUsageForCost(modelId: string, costUsd: number): FakeUsage {
  const model = findPricedModel(modelId);
  if (!model || model.costPer1kOutputTokens <= 0) {
    return { inputTokens: FAKE_UPSTREAM_INPUT_TOKENS, outputTokens: UNPRICED_OUTPUT_TOKENS };
  }
  const target = Math.max(0, costUsd);
  const inputCostUsd = (FAKE_UPSTREAM_INPUT_TOKENS * model.costPer1kInputTokens) / 1000;
  if (target <= inputCostUsd) {
    // A cost at or below the fixed input's price (including 0) is all input: never overcharge it.
    const inputTokens =
      model.costPer1kInputTokens > 0
        ? Math.floor((target * 1000) / model.costPer1kInputTokens)
        : FAKE_UPSTREAM_INPUT_TOKENS;
    return { inputTokens: Math.min(inputTokens, FAKE_UPSTREAM_INPUT_TOKENS), outputTokens: 0 };
  }
  return {
    inputTokens: FAKE_UPSTREAM_INPUT_TOKENS,
    outputTokens: Math.round(((target - inputCostUsd) * 1000) / model.costPer1kOutputTokens),
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sse(frames: string[]): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

function event(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function anthropicMessages(model: string, stream: boolean, usage: FakeUsage): Response {
  const id = 'msg_sam_test_upstream';
  if (!stream) {
    return json({
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: FAKE_UPSTREAM_TEXT }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    });
  }
  return sse([
    event('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.inputTokens, output_tokens: 1 },
      },
    }),
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: FAKE_UPSTREAM_TEXT },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      // Input too, as the real API reports it: the Anthropic-to-OpenAI stream translator drops
      // `message_start` usage, so this is the only usage a translated stream keeps.
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    }),
    event('message_stop', { type: 'message_stop' }),
  ]);
}

function openAIChat(model: string, stream: boolean, usage: FakeUsage): Response {
  const id = 'chatcmpl-sam-test-upstream';
  const created = Math.floor(Date.now() / 1000);
  const openAIUsage = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
  if (!stream) {
    return json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: FAKE_UPSTREAM_TEXT },
          finish_reason: 'stop',
        },
      ],
      usage: openAIUsage,
    });
  }
  const chunk = { id, object: 'chat.completion.chunk', created, model };
  return sse([
    data({
      ...chunk,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: FAKE_UPSTREAM_TEXT },
          finish_reason: null,
        },
      ],
    }),
    data({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    data({ ...chunk, choices: [], usage: openAIUsage }),
    'data: [DONE]\n\n',
  ]);
}

function openAIResponses(model: string, stream: boolean, usage: FakeUsage): Response {
  const itemId = 'msg_sam_test_upstream';
  const textPart = { type: 'output_text', text: FAKE_UPSTREAM_TEXT, annotations: [] };
  const message = {
    id: itemId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [textPart],
  };
  const response = {
    id: 'resp_sam_test_upstream',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [message],
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
  if (!stream) return json(response);
  // The full item lifecycle a real Responses stream sends. Clients such as Codex take the
  // assistant message from `response.output_item.done`, not from the text deltas.
  const part = { item_id: itemId, output_index: 0, content_index: 0 };
  return sse([
    event('response.created', {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [], usage: null },
    }),
    event('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    }),
    event('response.content_part.added', {
      type: 'response.content_part.added',
      ...part,
      part: { ...textPart, text: '' },
    }),
    event('response.output_text.delta', {
      type: 'response.output_text.delta',
      ...part,
      delta: FAKE_UPSTREAM_TEXT,
    }),
    event('response.output_text.done', {
      type: 'response.output_text.done',
      ...part,
      text: FAKE_UPSTREAM_TEXT,
    }),
    event('response.content_part.done', {
      type: 'response.content_part.done',
      ...part,
      part: textPart,
    }),
    event('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: message,
    }),
    event('response.completed', { type: 'response.completed', response }),
  ]);
}

/**
 * The canned response for an upstream path. `path` is the upstream URL's path; matching is on
 * its suffix, so gateway and direct provider URLs answer alike. Unknown paths get a 404.
 */
export function buildFakeUpstreamResponse(path: string, body: unknown, costUsd: number): Response {
  const record = maybeJsonRecord(body);
  const model = typeof record?.model === 'string' ? record.model : 'unknown';
  const stream = record?.stream === true;
  if (path.endsWith('/messages/count_tokens')) {
    return json({ input_tokens: FAKE_UPSTREAM_INPUT_TOKENS });
  }
  const usage = fakeUsageForCost(model, costUsd);
  if (path.endsWith('/messages')) return anthropicMessages(model, stream, usage);
  if (path.endsWith('/chat/completions')) return openAIChat(model, stream, usage);
  if (path.endsWith('/responses')) return openAIResponses(model, stream, usage);
  return json(
    { error: { type: 'not_found_error', message: 'Unknown path on the SAM test upstream' } },
    404
  );
}
