/**
 * Which upstream URL the AI proxy forwarders call, depending on whether an AI Gateway is
 * usable. A gateway URL is `gateway.ai.cloudflare.com/v1/<account>/<gateway>/...`, so a gateway
 * id with no Cloudflare account (a self-hosted install that kept the default `AI_GATEWAY_ID`)
 * must go straight to the provider. Drives the real forwarders; only `fetch` (the network
 * boundary) is stubbed, so the URL asserted is the one that would be requested.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  forwardToAnthropic,
  forwardToOpenAI,
  forwardToOpenAIResponses,
} from '../../../src/routes/ai-proxy-upstream';

const mockFetch = vi.fn();

const OPENAI_BODY = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
const RESPONSES_BODY = { model: 'gpt-4o', input: 'hi' };
const ANTHROPIC_OPENAI_FORMAT_BODY = {
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 16,
};
const AIG_METADATA = '{"userId":"user-1","workspaceId":"ws-1"}';

function env(overrides: Record<string, unknown>): Env {
  return { ...overrides } as unknown as Env;
}

function okResponse(): Response {
  return new Response(JSON.stringify({ id: 'resp-1', choices: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function anthropicOkResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function requestedUrl(): string {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return mockFetch.mock.calls[0]![0] as string;
}

function requestedHeaders(): Record<string, string> {
  return (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('forwardToOpenAI upstream URL', () => {
  it('uses the AI Gateway when both a gateway id and an account id are configured (Cloudflare)', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await forwardToOpenAI(
      env({ AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: 'acct-1' }),
      OPENAI_BODY,
      'gpt-4o',
      AIG_METADATA,
      'sk-openai'
    );
    expect(requestedUrl()).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct-1/sam/openai/v1/chat/completions'
    );
  });

  it('goes straight to OpenAI when there is a gateway id but no account id', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await forwardToOpenAI(env({ AI_GATEWAY_ID: 'sam' }), OPENAI_BODY, 'gpt-4o', AIG_METADATA, 'sk-openai');
    expect(requestedUrl()).toBe('https://api.openai.com/v1/chat/completions');
    // The caller's own key authenticates the direct call.
    expect(requestedHeaders()['Authorization']).toBe('Bearer sk-openai');
  });

  it('treats a blank account id like a missing one', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await forwardToOpenAI(
      env({ AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: '  ' }),
      OPENAI_BODY,
      'gpt-4o',
      AIG_METADATA,
      'sk-openai'
    );
    expect(requestedUrl()).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('goes straight to OpenAI when an account id is configured without a gateway id (pre-existing behaviour)', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await forwardToOpenAI(env({ CF_ACCOUNT_ID: 'acct-1' }), OPENAI_BODY, 'gpt-4o', AIG_METADATA, 'sk-openai');
    expect(requestedUrl()).toBe('https://api.openai.com/v1/chat/completions');
  });
});

describe('forwardToOpenAI stream usage (overnight B3 A2)', () => {
  const STREAM_BODY = { ...OPENAI_BODY, stream: true };
  const sentBody = () =>
    JSON.parse(String((mockFetch.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;

  it('asks OpenAI for stream usage on a direct call, so SAM can meter it', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await forwardToOpenAI(env({ AI_GATEWAY_ID: '' }), STREAM_BODY, 'gpt-4o', AIG_METADATA, 'sk-openai');
    expect(sentBody().stream_options).toEqual({ include_usage: true });
  });

  it('overrides a client that turned stream usage off on a direct call', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await forwardToOpenAI(
      env({ AI_GATEWAY_ID: '' }),
      { ...STREAM_BODY, stream_options: { include_usage: false } },
      'gpt-4o',
      AIG_METADATA,
      'sk-openai'
    );
    expect(sentBody().stream_options).toEqual({ include_usage: true });
  });

  it('sends the body unchanged through the gateway (Cloudflare control)', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await forwardToOpenAI(
      env({ AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: 'acct-1' }),
      STREAM_BODY,
      'gpt-4o',
      AIG_METADATA,
      'sk-openai'
    );
    expect(sentBody()).toEqual({ ...STREAM_BODY, model: 'gpt-4o' });
  });
});

describe('forwardToOpenAIResponses upstream URL', () => {
  it('uses the AI Gateway when both a gateway id and an account id are configured (Cloudflare)', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await forwardToOpenAIResponses(
      env({ AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: 'acct-1' }),
      RESPONSES_BODY,
      'gpt-4o',
      AIG_METADATA,
      'sk-openai'
    );
    expect(requestedUrl()).toBe('https://gateway.ai.cloudflare.com/v1/acct-1/sam/openai/v1/responses');
  });

  it('goes straight to OpenAI when there is a gateway id but no account id', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await forwardToOpenAIResponses(
      env({ AI_GATEWAY_ID: 'sam' }),
      RESPONSES_BODY,
      'gpt-4o',
      AIG_METADATA,
      'sk-openai'
    );
    expect(requestedUrl()).toBe('https://api.openai.com/v1/responses');
    expect(requestedHeaders()['Authorization']).toBe('Bearer sk-openai');
  });

  it('treats a blank account id like a missing one', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await forwardToOpenAIResponses(
      env({ AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: '' }),
      RESPONSES_BODY,
      'gpt-4o',
      AIG_METADATA,
      'sk-openai'
    );
    expect(requestedUrl()).toBe('https://api.openai.com/v1/responses');
  });
});

describe('forwardToAnthropic upstream URL (chat-completions translation path)', () => {
  const auth = { headers: { 'x-api-key': 'sk-ant-test' } };

  it('uses the AI Gateway when both a gateway id and an account id are configured (Cloudflare)', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOkResponse());
    await forwardToAnthropic(
      env({ AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: 'acct-1' }),
      ANTHROPIC_OPENAI_FORMAT_BODY,
      'claude-sonnet-5',
      AIG_METADATA,
      auth as Parameters<typeof forwardToAnthropic>[4]
    );
    expect(requestedUrl()).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct-1/sam/anthropic/v1/messages'
    );
  });

  it('goes straight to Anthropic when there is a gateway id but no account id', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOkResponse());
    await forwardToAnthropic(
      env({ AI_GATEWAY_ID: 'sam' }),
      ANTHROPIC_OPENAI_FORMAT_BODY,
      'claude-sonnet-5',
      AIG_METADATA,
      auth as Parameters<typeof forwardToAnthropic>[4]
    );
    expect(requestedUrl()).toBe('https://api.anthropic.com/v1/messages');
    expect(requestedHeaders()['x-api-key']).toBe('sk-ant-test');
  });
});

/**
 * Credentials and attribution follow the route. Unified Billing (`cf-aig-authorization`) and
 * `cf-aig-metadata` exist only for AI Gateway; a call that goes straight to the provider must
 * carry the provider key and none of SAM's Cloudflare token or internal ids.
 */
describe('gateway-only headers', () => {
  const CF_TOKEN = 'cf-api-token-secret';

  it.each([
    ['forwardToOpenAI', forwardToOpenAI, OPENAI_BODY],
    ['forwardToOpenAIResponses', forwardToOpenAIResponses, RESPONSES_BODY],
  ] as const)(
    '%s sends the caller key, not the Cloudflare token, when it goes direct',
    async (_name, forward, body) => {
      mockFetch.mockResolvedValueOnce(okResponse());
      await forward(
        env({ AI_GATEWAY_ID: 'sam', CF_API_TOKEN: CF_TOKEN }),
        body,
        'gpt-4o',
        AIG_METADATA,
        'sk-openai'
      );
      expect(requestedUrl()).toMatch(/^https:\/\/api\.openai\.com\//);
      const headers = requestedHeaders();
      expect(headers.Authorization).toBe('Bearer sk-openai');
      expect(JSON.stringify(headers)).not.toContain(CF_TOKEN);
      expect(headers['cf-aig-metadata']).toBeUndefined();
    }
  );

  it.each([
    ['forwardToOpenAI', forwardToOpenAI, OPENAI_BODY],
    ['forwardToOpenAIResponses', forwardToOpenAIResponses, RESPONSES_BODY],
  ] as const)(
    '%s keeps Unified Billing and attribution through the gateway (Cloudflare)',
    async (_name, forward, body) => {
      mockFetch.mockResolvedValueOnce(okResponse());
      await forward(
        env({ AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: 'acct-1', CF_API_TOKEN: CF_TOKEN }),
        body,
        'gpt-4o',
        AIG_METADATA,
        'sk-openai'
      );
      const headers = requestedHeaders();
      expect(headers['cf-aig-authorization']).toBe(`Bearer ${CF_TOKEN}`);
      expect(headers['cf-aig-metadata']).toBe(AIG_METADATA);
      expect(headers.Authorization).toBeUndefined();
    }
  );

  it('forwardToAnthropic drops gateway attribution when it goes direct, keeps it through the gateway', async () => {
    const auth = {
      headers: { 'x-api-key': 'sk-ant' },
      billingMode: 'platform-key',
      credentialReference: 'platform_credentials:c1',
      credentialSource: 'platform',
      credentialProvider: 'anthropic',
      providerMode: 'platform-key',
    } as never;
    mockFetch.mockResolvedValueOnce(anthropicOkResponse());
    await forwardToAnthropic(
      env({ AI_GATEWAY_ID: 'sam' }),
      ANTHROPIC_OPENAI_FORMAT_BODY,
      'claude-sonnet-5',
      AIG_METADATA,
      auth
    );
    expect(requestedHeaders()['cf-aig-metadata']).toBeUndefined();
    expect(requestedHeaders()['x-api-key']).toBe('sk-ant');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(anthropicOkResponse());
    await forwardToAnthropic(
      env({ AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: 'acct-1' }),
      ANTHROPIC_OPENAI_FORMAT_BODY,
      'claude-sonnet-5',
      AIG_METADATA,
      auth
    );
    expect(requestedHeaders()['cf-aig-metadata']).toBe(AIG_METADATA);
  });
});
