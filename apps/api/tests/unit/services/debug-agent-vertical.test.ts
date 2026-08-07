import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runDebugDiagnosis } from '../../../src/services/debug-agent';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

function createKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  } as unknown as KVNamespace;
}

describe('runDebugDiagnosis vertical slice', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('redacts realistic observability evidence before the next model turn and persists output', async () => {
    const main = new Database(':memory:');
    main.exec(`
      CREATE TABLE debug_diagnoses (
        id TEXT PRIMARY KEY, error_id TEXT, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
        diagnosis TEXT NOT NULL, model TEXT NOT NULL, turns INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        daily_tokens_used INTEGER NOT NULL, daily_token_limit INTEGER NOT NULL,
        idea_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const observability = new Database(':memory:');
    observability.exec(`
      CREATE TABLE platform_errors (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
        stack TEXT, context TEXT, user_id TEXT, node_id TEXT, workspace_id TEXT,
        task_id TEXT, session_id TEXT,
        ip_address TEXT, user_agent TEXT, timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    const timestamp = Date.parse('2026-07-29T10:00:00.000Z');
    const canary = 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    observability
      .prepare(
        `
      INSERT INTO platform_errors
        (id, source, level, message, stack, context, user_id, node_id, workspace_id,
         ip_address, user_agent, timestamp, created_at)
      VALUES (?, 'api', 'error', ?, NULL, ?, 'user-private', NULL, NULL,
              '192.0.2.1', 'private-agent', ?, ?)
    `
      )
      .run(
        'err-1',
        `provider failed with ${canary}`,
        JSON.stringify({
          authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
        }),
        timestamp,
        timestamp
      );

    const responses = [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'get_recent_errors', arguments: '{}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      {
        choices: [
          {
            message: {
              content: '## Summary\nThe provider call failed repeatedly.',
              tool_calls: [],
            },
          },
        ],
        usage: { prompt_tokens: 180, completion_tokens: 30, total_tokens: 210 },
      },
    ];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const response = responses.shift();
      expect(response).toBeDefined();
      expect(url).toContain('/v1/account-1/sam/workers-ai/v1/chat/completions');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer server-only-cloudflare-token');
      expect(headers.get('cf-aig-metadata')).toContain('deployment-debug-agent');
      const payload = JSON.parse(String(init?.body)) as {
        model: string;
        max_tokens: number;
        stream: boolean;
        tool_choice: string;
        tools: Array<{ function: { name: string } }>;
      };
      expect(payload).toMatchObject({
        model: '@cf/zai-org/glm-5.2',
        stream: false,
        tool_choice: 'auto',
      });
      expect(payload.max_tokens).toBeGreaterThan(0);
      expect(payload.tools.map((tool) => tool.function.name)).toEqual([
        'get_vm_incident',
        'get_recent_errors',
        'get_health_summary',
        'get_error_trends',
        'query_cloudflare_logs',
        'get_related_entity_state',
      ]);
      if (fetchMock.mock.calls.length === 2) {
        const body = String(init?.body);
        expect(body).toContain('[REDACTED]');
        expect(body).not.toContain(canary);
        expect(body).not.toContain('user-private');
        expect(body).not.toContain('192.0.2.1');
        expect(body).not.toContain('private-agent');
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      DATABASE: createSqliteD1(main),
      OBSERVABILITY_DATABASE: createSqliteD1(observability),
      KV: createKv(),
      CF_API_TOKEN: 'server-only-cloudflare-token',
      CF_ACCOUNT_ID: 'account-1',
      AI_GATEWAY_ID: 'sam',
    } as Env;
    const diagnosis = await runDebugDiagnosis(env, 'admin-1', { errorId: 'err-1' });

    expect(diagnosis.diagnosis).toContain('provider call failed');
    expect(diagnosis.usage).toMatchObject({
      turns: 2,
      inputTokens: 280,
      outputTokens: 50,
      totalTokens: 330,
      dailyTokensUsed: 330,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(main.prepare('SELECT COUNT(*) AS count FROM debug_diagnoses').get()).toEqual({
      count: 1,
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(String(init?.body)).not.toContain('server-only-cloudflare-token');
    }
  });
});
