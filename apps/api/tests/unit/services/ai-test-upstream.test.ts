import { findPricedModel, priceModelUsageUsd } from '@simple-agent-manager/ai-proxy';
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { isAiTestUpstreamDeployable } from '../../../src/services/ai-test-upstream';
import {
  buildFakeUpstreamResponse,
  FAKE_UPSTREAM_TEXT,
  fakeUsageForCost,
} from '../../../src/services/ai-test-upstream-responses';

describe('isAiTestUpstreamDeployable (deploy-time locks)', () => {
  it.each([
    ['selfhost', 'true', true],
    ['staging', 'true', true],
    ['production', 'true', false],
    ['PRODUCTION', 'true', false],
    [' prod ', 'true', false],
    ['', 'true', false],
    [undefined, 'true', false],
    ['selfhost', undefined, false],
    ['selfhost', 'TRUE', false],
    ['selfhost', '1', false],
    ['selfhost', 'false', false],
  ])('ENVIRONMENT=%j, AI_TEST_UPSTREAM_ENABLED=%j -> %s', (environment, flag, expected) => {
    expect(
      isAiTestUpstreamDeployable({ ENVIRONMENT: environment, AI_TEST_UPSTREAM_ENABLED: flag })
    ).toBe(expected);
  });
});

describe('fakeUsageForCost', () => {
  const priced = PLATFORM_AI_MODELS.filter((model) => model.costPer1kOutputTokens > 0);

  it.each(priced.map((model) => [model.id]))(
    '%s: the reported usage prices to the configured cost',
    (modelId) => {
      const model = findPricedModel(modelId)!;
      const usage = fakeUsageForCost(modelId, 0.4);
      const priced = priceModelUsageUsd(model, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
      // Within one output token of the target.
      expect(Math.abs(priced - 0.4)).toBeLessThanOrEqual(model.costPer1kOutputTokens / 1000);
    }
  );

  it('reports a small fixed usage for a model with no catalog price', () => {
    expect(fakeUsageForCost('not-a-catalog-model', 0.4)).toEqual({
      inputTokens: 10,
      outputTokens: 16,
    });
  });
});

describe('buildFakeUpstreamResponse', () => {
  const body = (stream: boolean) => ({ model: 'claude-opus-4-6', stream });

  it.each([
    ['/v1/messages', false, 'application/json'],
    ['/v1/messages', true, 'text/event-stream'],
    ['/v1/chat/completions', false, 'application/json'],
    ['/v1/chat/completions', true, 'text/event-stream'],
    ['/v1/responses', false, 'application/json'],
    ['/v1/responses', true, 'text/event-stream'],
  ])('%s stream=%s answers in the provider shape', async (path, stream, contentType) => {
    const response = buildFakeUpstreamResponse(path, body(stream), 0.4);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(contentType);
    expect(await response.text()).toContain(FAKE_UPSTREAM_TEXT);
  });

  it('answers count_tokens with a fixed count', async () => {
    const response = buildFakeUpstreamResponse('/v1/messages/count_tokens', body(false), 0.4);
    expect(await response.json()).toEqual({ input_tokens: 10 });
  });

  it('404s an unknown path instead of guessing', () => {
    expect(buildFakeUpstreamResponse('/v1/embeddings', body(false), 0.4).status).toBe(404);
  });
});
