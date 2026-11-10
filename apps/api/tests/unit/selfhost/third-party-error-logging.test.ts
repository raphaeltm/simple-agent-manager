/**
 * A failed model call to an admin-configured OpenAI-compatible endpoint must not put that
 * endpoint's response body in the logs: it can echo the configured key or the prompt. Both
 * callers (the SAM agent loop and the /ai/v1 Workers AI route) log the status and a bounded,
 * sanitized reason instead. Cloudflare's own routes keep logging the body, as before.
 */
import type { SamConfig } from '@simple-agent-manager/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAgentLoop } from '../../../src/durable-objects/sam-session/agent-loop';
import type { Env } from '../../../src/env';
import { forwardToWorkersAI } from '../../../src/routes/ai-proxy-upstream';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const CLOUDFLARE = { CF_ACCOUNT_ID: 'account-1', CF_API_TOKEN: 'cf-token', AI_GATEWAY_ID: 'sam' };
const ENDPOINT_KEY = 'sk-endpoint-secret-key';
/** An error body that echoes the key and the prompt, as some self-hosted servers do. */
const LEAKY_BODY = JSON.stringify({
  error: {
    type: 'invalid_request_error',
    code: 'context_length_exceeded',
    message: `Bearer ${ENDPOINT_KEY} rejected for prompt "my private prompt text"`,
  },
});

const AGENT_CONFIG = {
  model: '@cf/test/model',
  maxTokens: 128,
  maxTurns: 1,
  maxRequestBodyBytes: 100_000,
  maxToolResultBytes: 10_000,
  aigSource: 'sam-session',
  ftsEnabled: false,
} as SamConfig;

let sqlite: Database.Database;
let env: Env;
let errorLogs: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  ({ sqlite, env } = createAdminSettingsEnv());
  Object.assign(env, CLOUDFLARE);
  errorLogs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(LEAKY_BODY, { status: 400 }))
  );
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function configureEndpoint() {
  await updateAdminSettings(env, {
    changes: [
      { name: 'llm.openAICompatible.baseUrl', value: 'https://llm.example.com/v1' },
      { name: 'llm.openAICompatible.apiKey', value: ENDPOINT_KEY },
      { name: 'llm.openAICompatible.model', value: 'endpoint-model' },
    ],
    actorUserId: 'admin',
  });
}

/** The structured record logged under `event`, parsed from the console line. */
function loggedRecord(event: string): Record<string, unknown> {
  for (const call of errorLogs.mock.calls) {
    const line = call.map(String).join(' ');
    if (!line.includes(event)) continue;
    const json = line.slice(line.indexOf('{'));
    return JSON.parse(json) as Record<string, unknown>;
  }
  throw new Error(`no ${event} log line`);
}

function allErrorLogText(): string {
  return errorLogs.mock.calls.flat().map(String).join('\n');
}

async function runAgentTurn() {
  await runAgentLoop(
    'conv-1',
    [],
    'hi',
    AGENT_CONFIG,
    env,
    'user-1',
    new WritableStream<Uint8Array>().getWriter(),
    vi.fn()
  );
}

describe('SAM agent loop model error logging', () => {
  it('logs status and a sanitized reason, never the endpoint body, for a configured endpoint', async () => {
    await configureEndpoint();
    await runAgentTurn();

    const record = loggedRecord('sam.llm_error');
    expect(record.status).toBe(400);
    expect(record.reason).toBe(
      'code=context_length_exceeded type=invalid_request_error message=provider rejected request'
    );
    expect(record).not.toHaveProperty('body');
    expect(allErrorLogText()).not.toContain(ENDPOINT_KEY);
    expect(allErrorLogText()).not.toContain('my private prompt text');
  });

  it('keeps logging the body for the Cloudflare gateway route (unchanged)', async () => {
    await runAgentTurn();

    const record = loggedRecord('sam.llm_error');
    expect(record.status).toBe(400);
    // The logger still redacts bearer tokens inside it; the body itself is logged as before.
    expect(record.body).toContain('my private prompt text');
    expect(record).not.toHaveProperty('reason');
  });
});

describe('a long, message-first error body', () => {
  it('still yields the code and type as the reason, never the message', async () => {
    await configureEndpoint();
    // OpenAI-style: a long message first, the classifying fields last, well past 256 bytes.
    const body = JSON.stringify({
      error: {
        message: `my private prompt text ${'x'.repeat(600)}`,
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 404 }))
    );
    await runAgentTurn();

    const record = loggedRecord('sam.llm_error');
    expect(record.status).toBe(404);
    expect(record.reason).toContain('code=model_not_found');
    expect(record.reason).toContain('type=invalid_request_error');
    expect(String(record.reason).length).toBeLessThanOrEqual(256);
    expect(allErrorLogText()).not.toContain('my private prompt text');
  });
});

describe('/ai/v1 Workers AI route error logging', () => {
  it('logs status and a sanitized reason, never the endpoint body, for a configured endpoint', async () => {
    await configureEndpoint();
    const { response: res } = await forwardToWorkersAI(env, { messages: [] }, '@cf/m/x', '{}');

    expect(res.status).toBe(400);
    const record = loggedRecord('ai_proxy.workers_ai_error');
    expect(record).toMatchObject({ status: 400, target: 'openai-compatible' });
    expect(record.reason).toContain('code=context_length_exceeded');
    expect(record).not.toHaveProperty('body');
    expect(allErrorLogText()).not.toContain(ENDPOINT_KEY);
    expect(allErrorLogText()).not.toContain('my private prompt text');
  });

  it('keeps logging the body for the Cloudflare gateway route (unchanged)', async () => {
    const { response: res } = await forwardToWorkersAI(env, { messages: [] }, '@cf/m/x', '{}');

    expect(res.status).toBe(400);
    const record = loggedRecord('ai_proxy.workers_ai_error');
    expect(record).toMatchObject({ status: 400, target: 'cloudflare-gateway' });
    expect(record.body).toContain('my private prompt text');
  });
});
