import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  gatewayTestUpstreamFetch,
  resolveTestUpstreamGatewayProvider,
  testUpstreamGatewayUrl,
} from '../../../src/services/ai-test-upstream-gateway';

const PROVIDER = 'custom-sam-test-upstream';
const GW = 'https://gateway.ai.cloudflare.com/v1/acct/sam';

describe('testUpstreamGatewayUrl', () => {
  it.each([
    [`${GW}/anthropic/v1/messages`, `${GW}/${PROVIDER}/v1/messages`],
    [`${GW}/anthropic/v1/messages/count_tokens`, `${GW}/${PROVIDER}/v1/messages/count_tokens`],
    [`${GW}/openai/v1/chat/completions`, `${GW}/${PROVIDER}/v1/chat/completions`],
    [`${GW}/openai/v1/responses`, `${GW}/${PROVIDER}/v1/responses`],
  ])('rewrites %s', (from, to) => {
    expect(testUpstreamGatewayUrl(from, PROVIDER)).toBe(to);
  });

  it.each([
    [`${GW}/workers-ai/v1/chat/completions`],
    ['https://api.anthropic.com/v1/messages'],
    ['http://gateway.ai.cloudflare.com/v1/acct/sam/anthropic/v1/messages'],
    ['https://gateway.ai.cloudflare.com/v2/acct/sam/anthropic/v1/messages'],
    ['not a url'],
  ])('refuses %s', (url) => {
    expect(testUpstreamGatewayUrl(url, PROVIDER)).toBeNull();
  });
});

describe('resolveTestUpstreamGatewayProvider', () => {
  it('accepts only a custom provider segment', () => {
    expect(
      resolveTestUpstreamGatewayProvider({ AI_TEST_UPSTREAM_GATEWAY_PROVIDER: PROVIDER })
    ).toBe(PROVIDER);
    for (const value of [undefined, '', 'anthropic', 'openai', 'custom-', 'custom-A/b']) {
      expect(
        resolveTestUpstreamGatewayProvider({ AI_TEST_UPSTREAM_GATEWAY_PROVIDER: value })
      ).toBeNull();
    }
  });
});

describe('gatewayTestUpstreamFetch', () => {
  it('never sends a route it cannot rewrite anywhere', async () => {
    const realFetch = vi.fn();
    const fetch = gatewayTestUpstreamFetch({} as Env, PROVIDER, 0.4, realFetch);
    const response = await fetch(`${GW}/workers-ai/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it('drops provider credentials and unknown headers, adds gateway auth and the cost', async () => {
    const realFetch = vi.fn(async () => new Response('{}'));
    const env = { AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: 'acct', CF_AIG_TOKEN: 'gw' } as Env;
    await gatewayTestUpstreamFetch(
      env,
      PROVIDER,
      0.25,
      realFetch
    )(`${GW}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': 'provider-key',
        Authorization: 'Bearer provider-key',
        'x-custom': 'dropped',
        'content-type': 'application/json',
        'cf-aig-metadata': '{"userId":"u"}',
      },
      body: JSON.stringify({ model: 'unpriced-model' }),
    });
    const [url, init] = realFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GW}/${PROVIDER}/v1/messages`);
    const headers = init.headers as Headers;
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-custom')).toBeNull();
    expect(headers.get('cf-aig-authorization')).toBe('Bearer gw');
    expect(headers.get('cf-aig-metadata')).toBe('{"userId":"u"}');
    expect(headers.get('x-sam-test-upstream-cost-usd')).toBe('0.25');
    // No catalog price for this model: no custom cost is invented.
    expect(headers.get('cf-aig-custom-cost')).toBeNull();
  });
});
