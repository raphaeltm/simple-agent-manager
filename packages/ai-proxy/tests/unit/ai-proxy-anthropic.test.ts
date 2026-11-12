/**
 * Unit tests for the shared Anthropic-native AI proxy helpers: gateway URLs, metadata and
 * model validation. The request-auth helpers stay in the worker
 * (apps/api/tests/unit/routes/ai-proxy-anthropic.test.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  buildAIGatewayMetadata,
  buildAnthropicCountTokensUrl,
  buildAnthropicGatewayUrl,
  isAnthropicModel,
} from '../../src/ai-proxy-shared';

describe('buildAnthropicGatewayUrl', () => {
  it('builds AI Gateway URL when gateway ID is set', () => {
    const env = { AI_GATEWAY_ID: 'my-gw', CF_ACCOUNT_ID: 'acc-123' } as Parameters<
      typeof buildAnthropicGatewayUrl
    >[0];
    expect(buildAnthropicGatewayUrl(env)).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc-123/my-gw/anthropic/v1/messages'
    );
  });

  it('falls back to direct Anthropic API when no gateway ID', () => {
    const env = { CF_ACCOUNT_ID: 'acc-123' } as Parameters<typeof buildAnthropicGatewayUrl>[0];
    expect(buildAnthropicGatewayUrl(env)).toBe('https://api.anthropic.com/v1/messages');
  });
});

// =============================================================================
// buildAnthropicCountTokensUrl
// =============================================================================

describe('buildAnthropicCountTokensUrl', () => {
  it('builds AI Gateway URL for count_tokens', () => {
    const env = { AI_GATEWAY_ID: 'my-gw', CF_ACCOUNT_ID: 'acc-123' } as Parameters<
      typeof buildAnthropicCountTokensUrl
    >[0];
    expect(buildAnthropicCountTokensUrl(env)).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc-123/my-gw/anthropic/v1/messages/count_tokens'
    );
  });

  it('falls back to direct Anthropic API', () => {
    const env = { CF_ACCOUNT_ID: 'acc-123' } as Parameters<typeof buildAnthropicCountTokensUrl>[0];
    expect(buildAnthropicCountTokensUrl(env)).toBe(
      'https://api.anthropic.com/v1/messages/count_tokens'
    );
  });
});

// =============================================================================
// buildAIGatewayMetadata
// =============================================================================

describe('buildAIGatewayMetadata', () => {
  it('includes all fields', () => {
    const meta = JSON.parse(
      buildAIGatewayMetadata({
        userId: 'u1',
        workspaceId: 'ws1',
        projectId: 'p1',
        modelId: 'claude-sonnet-5',
        stream: true,
        hasTools: true,
        providerId: 'deepseek-anthropic',
        providerName: 'DeepSeek Anthropic API',
        providerDialect: 'anthropic',
      })
    );
    expect(meta).toEqual({
      userId: 'u1',
      workspaceId: 'ws1',
      projectId: 'p1',
      modelId: 'claude-sonnet-5',
      stream: true,
      hasTools: true,
      providerId: 'deepseek-anthropic',
      providerName: 'DeepSeek Anthropic API',
      providerDialect: 'anthropic',
    });
  });

  it('omits null projectId and never emits a trialId', () => {
    const meta = JSON.parse(
      buildAIGatewayMetadata({
        userId: 'u1',
        workspaceId: 'ws1',
        projectId: null,
        modelId: 'claude-sonnet-5',
        stream: false,
      })
    );
    expect(meta.projectId).toBeUndefined();
    expect(meta.trialId).toBeUndefined();
  });
});

// =============================================================================
// AIProxyAuthError
// =============================================================================

describe('Anthropic model validation', () => {
  it('accepts claude-* models', () => {
    expect(isAnthropicModel('claude-sonnet-5')).toBe(true);
    expect(isAnthropicModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isAnthropicModel('claude-opus-4-6')).toBe(true);
  });

  it('rejects non-Anthropic models', () => {
    expect(isAnthropicModel('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe(false);
    expect(isAnthropicModel('gpt-4')).toBe(false);
    expect(isAnthropicModel('@cf/qwen/qwen3-30b-a3b-fp8')).toBe(false);
  });
});
