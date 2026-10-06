import {
  DEFAULT_DEBUG_AGENT_DAILY_TOKEN_LIMIT,
  DEFAULT_DEBUG_AGENT_HARD_DEADLINE_MS,
  DEFAULT_DEBUG_AGENT_MAX_TURNS,
  DEFAULT_DEBUG_AGENT_MAX_WINDOW_HOURS,
  DEFAULT_DEBUG_AGENT_MODEL,
  DEFAULT_DEBUG_AGENT_MODEL_OUTPUT_TOKENS,
  DEFAULT_DEBUG_AGENT_RETRY_BASE_DELAY_MS,
  DEFAULT_DEBUG_AGENT_RETRY_MAX_DELAY_MS,
  DEFAULT_DEBUG_AGENT_RUN_TOKEN_LIMIT,
  DEFAULT_DEBUG_AGENT_STALE_HEARTBEAT_MS,
  DEFAULT_DEBUG_AGENT_STEP_MAX_RETRIES,
  DEFAULT_DEBUG_AGENT_TIMEOUT_MS,
  DEFAULT_DEBUG_AGENT_TOOL_RESULT_BYTES,
  DEFAULT_DEBUG_AGENT_TOOL_RESULT_LIMIT,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { resolveDebugAgentConfig } from '../../../src/services/debug-agent';

describe('resolveDebugAgentConfig', () => {
  it('uses the registered GLM default and bounded shared defaults', () => {
    expect(resolveDebugAgentConfig({} as Env)).toEqual({
      model: DEFAULT_DEBUG_AGENT_MODEL,
      maxTurns: DEFAULT_DEBUG_AGENT_MAX_TURNS,
      runTokenLimit: DEFAULT_DEBUG_AGENT_RUN_TOKEN_LIMIT,
      modelOutputTokens: DEFAULT_DEBUG_AGENT_MODEL_OUTPUT_TOKENS,
      dailyTokenLimit: DEFAULT_DEBUG_AGENT_DAILY_TOKEN_LIMIT,
      toolResultLimit: DEFAULT_DEBUG_AGENT_TOOL_RESULT_LIMIT,
      toolResultBytes: DEFAULT_DEBUG_AGENT_TOOL_RESULT_BYTES,
      maxWindowHours: DEFAULT_DEBUG_AGENT_MAX_WINDOW_HOURS,
      timeoutMs: DEFAULT_DEBUG_AGENT_TIMEOUT_MS,
      hardDeadlineMs: DEFAULT_DEBUG_AGENT_HARD_DEADLINE_MS,
      staleHeartbeatMs: DEFAULT_DEBUG_AGENT_STALE_HEARTBEAT_MS,
      retryBaseDelayMs: DEFAULT_DEBUG_AGENT_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: DEFAULT_DEBUG_AGENT_RETRY_MAX_DELAY_MS,
      stepMaxRetries: DEFAULT_DEBUG_AGENT_STEP_MAX_RETRIES,
    });
  });

  it('honors positive environment overrides', () => {
    const config = resolveDebugAgentConfig({
      DEBUG_AGENT_MODEL: '@cf/google/gemma-4-26b-a4b-it',
      DEBUG_AGENT_MAX_TURNS: '3',
      DEBUG_AGENT_RUN_TOKEN_LIMIT: '8000',
      DEBUG_AGENT_MODEL_OUTPUT_TOKENS: '2048',
      DEBUG_AGENT_DAILY_TOKEN_LIMIT: '32000',
      DEBUG_AGENT_TOOL_RESULT_LIMIT: '20',
      DEBUG_AGENT_TOOL_RESULT_BYTES: '8192',
      DEBUG_AGENT_MAX_WINDOW_HOURS: '4',
      DEBUG_AGENT_TIMEOUT_MS: '45000',
    } as Env);
    expect(config).toMatchObject({
      model: '@cf/google/gemma-4-26b-a4b-it',
      maxTurns: 3,
      runTokenLimit: 8000,
      modelOutputTokens: 2048,
      dailyTokenLimit: 32000,
      toolResultLimit: 20,
      toolResultBytes: 8192,
      maxWindowHours: 4,
      timeoutMs: 45000,
    });
  });

  it('falls back safely when a numeric override is invalid', () => {
    expect(resolveDebugAgentConfig({ DEBUG_AGENT_MAX_TURNS: 'invalid' } as Env).maxTurns).toBe(
      DEFAULT_DEBUG_AGENT_MAX_TURNS
    );
  });
  it('rejects models outside the registered Workers AI tool-call set', () => {
    expect(() =>
      resolveDebugAgentConfig({
        DEBUG_AGENT_MODEL: 'claude-sonnet-5',
      } as Env)
    ).toThrow('registered Workers AI model with tool support');
  });
});
