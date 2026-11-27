/**
 * The staging-only fake AI upstream Worker (`ai-test-upstream-worker.ts`): gating, credential
 * refusal, cost sizing from a header or query, the Anthropic and OpenAI shapes (JSON and SSE),
 * and that it never makes a network call.
 */
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { priceModelUsageUsd } from '../../src/ai-cost-pricing';
import {
  AI_TEST_UPSTREAM_COST_HEADER,
  AI_TEST_UPSTREAM_GATE_HEADER,
  AI_TEST_UPSTREAM_GATE_VALUE,
} from '../../src/ai-test-upstream-contract';
import { FAKE_UPSTREAM_TEXT } from '../../src/ai-test-upstream-responses';
import worker, {
  AI_TEST_UPSTREAM_MAX_BODY_BYTES,
  handleFakeAiUpstreamRequest,
} from '../../src/ai-test-upstream-worker';

const CLAUDE = PLATFORM_AI_MODELS.find(
  (model) => model.provider === 'anthropic' && model.costPer1kOutputTokens > 0
)!;
const OPENAI = PLATFORM_AI_MODELS.find(
  (model) => model.provider === 'openai' && model.costPer1kOutputTokens > 0
)!;
const BASE = 'https://sam-fake-ai-staging.example.workers.dev';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
});
afterEach(() => {
  fetchSpy.mockRestore();
});

function request(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST'
): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      [AI_TEST_UPSTREAM_GATE_HEADER]: AI_TEST_UPSTREAM_GATE_VALUE,
      ...headers,
    },
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const messages = (stream = false) => ({
  model: CLAUDE.id,
  max_tokens: 8,
  stream,
  messages: [{ role: 'user', content: 'hi' }],
});

describe('fake AI upstream Worker: gating', () => {
  it('answers 404 without the gating header, with a wrong value, and for GET', async () => {
    const noGate = new Request(`${BASE}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify(messages()),
    });
    expect((await handleFakeAiUpstreamRequest(noGate)).status).toBe(404);
    const wrong = request('/v1/messages', messages(), { [AI_TEST_UPSTREAM_GATE_HEADER]: 'nope' });
    expect((await handleFakeAiUpstreamRequest(wrong)).status).toBe(404);
    expect(
      (await handleFakeAiUpstreamRequest(request('/v1/messages', null, {}, 'GET'))).status
    ).toBe(404);
    // Liveness: the same request with the gate is answered.
    expect((await handleFakeAiUpstreamRequest(request('/v1/messages', messages()))).status).toBe(
      200
    );
  });

  it.each(['authorization', 'x-api-key', 'cf-aig-authorization'])(
    'refuses a request carrying %s, naming the header but never its value',
    async (header) => {
      const response = await handleFakeAiUpstreamRequest(
        request('/v1/messages', messages(), { [header]: 'Bearer secret-value' })
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain(header);
      expect(text).not.toContain('secret-value');
    }
  );

  it('rejects an out-of-range cost and a body over the limit', async () => {
    for (const cost of ['-1', '11', 'abc']) {
      const response = await handleFakeAiUpstreamRequest(
        request('/v1/messages', messages(), { [AI_TEST_UPSTREAM_COST_HEADER]: cost })
      );
      expect(response.status).toBe(400);
    }
    const big = await handleFakeAiUpstreamRequest(
      request('/v1/messages', {
        model: CLAUDE.id,
        pad: 'x'.repeat(AI_TEST_UPSTREAM_MAX_BODY_BYTES),
      })
    );
    expect(big.status).toBe(413);
    const notJson = await handleFakeAiUpstreamRequest(request('/v1/messages', 'not json'));
    expect(notJson.status).toBe(400);
  });
});

describe('fake AI upstream Worker: replies', () => {
  it('sizes Anthropic usage to the cost in the header', async () => {
    const response = await worker.fetch(
      request('/v1/messages', messages(), { [AI_TEST_UPSTREAM_COST_HEADER]: '0.4' })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      content: Array<{ text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.content[0]?.text).toBe(FAKE_UPSTREAM_TEXT);
    const cost = priceModelUsageUsd(CLAUDE, {
      inputTokens: body.usage.input_tokens,
      outputTokens: body.usage.output_tokens,
    });
    expect(cost).toBeCloseTo(0.4, 3);
  });

  it('takes the cost from the query when there is no header, and the header wins over it', async () => {
    const fromQuery = await handleFakeAiUpstreamRequest(
      request('/v1/chat/completions?cost_usd=0.2', { model: OPENAI.id, messages: [] })
    );
    const queryBody = (await fromQuery.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(
      priceModelUsageUsd(OPENAI, {
        inputTokens: queryBody.usage.prompt_tokens,
        outputTokens: queryBody.usage.completion_tokens,
      })
    ).toBeCloseTo(0.2, 3);

    const both = await handleFakeAiUpstreamRequest(
      request(
        '/v1/chat/completions?cost_usd=0.2',
        { model: OPENAI.id, messages: [] },
        { [AI_TEST_UPSTREAM_COST_HEADER]: '0.6' }
      )
    );
    const bothBody = (await both.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(
      priceModelUsageUsd(OPENAI, {
        inputTokens: bothBody.usage.prompt_tokens,
        outputTokens: bothBody.usage.completion_tokens,
      })
    ).toBeCloseTo(0.6, 3);
  });

  it('streams Anthropic and OpenAI SSE with usage', async () => {
    const anthropic = await handleFakeAiUpstreamRequest(
      request('/v1/messages', messages(true), { [AI_TEST_UPSTREAM_COST_HEADER]: '0.4' })
    );
    expect(anthropic.headers.get('content-type')).toBe('text/event-stream');
    const anthropicText = await anthropic.text();
    expect(anthropicText).toContain('event: message_delta');
    expect(anthropicText).toContain(FAKE_UPSTREAM_TEXT);

    const openai = await handleFakeAiUpstreamRequest(
      request('/v1/chat/completions', { model: OPENAI.id, stream: true, messages: [] })
    );
    const openaiText = await openai.text();
    expect(openaiText).toContain('"usage"');
    expect(openaiText.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('answers an unknown path with 404 and never makes a network call', async () => {
    const response = await handleFakeAiUpstreamRequest(request('/v1/embeddings', { model: 'x' }));
    expect(response.status).toBe(404);
    await handleFakeAiUpstreamRequest(request('/v1/messages', messages(true)));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
