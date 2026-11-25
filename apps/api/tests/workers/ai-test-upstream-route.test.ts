/**
 * Public test-only fake AI upstream route (`routes/ai-test-upstream-route.ts`), through the real
 * Worker. The AI Gateway reaches it as a custom provider on staging; production must 404, and it
 * must never call out.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import worker from '../../src/index';
import { FAKE_UPSTREAM_TEXT } from '../../src/services/ai-test-upstream-responses';

const bindings = env as unknown as Env;
const STAGING: Partial<Env> = { ENVIRONMENT: 'staging', AI_TEST_UPSTREAM_ENABLED: 'true' };

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('unexpected outbound fetch');
  });
});
afterEach(() => fetchSpy.mockRestore());

async function post(path: string, body: unknown, overrides: Partial<Env>): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://api.${bindings.BASE_DOMAIN}/ai/_test-upstream${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { ...bindings, ...overrides },
    ctx
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return new Response(text, { status: response.status, headers: response.headers });
}

const messages = {
  model: 'claude-opus-4-6',
  max_tokens: 8,
  messages: [{ role: 'user', content: 'hi' }],
};

describe('public fake AI upstream route', () => {
  it('answers Anthropic and OpenAI shapes on a staging deployment, without calling out', async () => {
    const anthropic = await post('/v1/messages', messages, STAGING);
    expect(anthropic.status).toBe(200);
    expect(await anthropic.json()).toMatchObject({
      type: 'message',
      content: [{ type: 'text', text: FAKE_UPSTREAM_TEXT }],
      usage: { input_tokens: 10 },
    });
    const openai = await post(
      '/v1/chat/completions',
      { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] },
      STAGING
    );
    expect(openai.status).toBe(200);
    expect(await openai.text()).toContain(FAKE_UPSTREAM_TEXT);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['production', { ENVIRONMENT: 'production', AI_TEST_UPSTREAM_ENABLED: 'true' }],
    ['an unset environment', { ENVIRONMENT: '', AI_TEST_UPSTREAM_ENABLED: 'true' }],
    ['staging without the flag', { ENVIRONMENT: 'staging', AI_TEST_UPSTREAM_ENABLED: undefined }],
  ])('is 404 on %s', async (_label, overrides) => {
    const response = await post('/v1/messages', messages, overrides as Partial<Env>);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(FAKE_UPSTREAM_TEXT);
  });

  it('refuses a body that is not a JSON object', async () => {
    const response = await post('/v1/messages', ['not', 'an', 'object'], STAGING);
    expect(response.status).toBe(400);
  });
});
