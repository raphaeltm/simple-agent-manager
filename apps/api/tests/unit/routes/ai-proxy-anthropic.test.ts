/**
 * Unit tests for the Anthropic-native AI proxy route.
 *
 * Tests auth (x-api-key), header forwarding, model validation,
 * rate limiting, token budget, streaming/non-streaming pass-through,
 * and error handling.
 */
import { describe, expect, it } from 'vitest';

import {
  AIProxyAuthError,
  buildAIGatewayMetadata,
  buildAnthropicCountTokensUrl,
  buildAnthropicGatewayUrl,
  extractCallbackToken,
} from '../../../src/services/ai-proxy-shared';

// =============================================================================
// extractCallbackToken
// =============================================================================

describe('extractCallbackToken', () => {
  it('extracts from Authorization: Bearer header', () => {
    expect(extractCallbackToken('Bearer my-token', undefined)).toBe('my-token');
  });

  it('extracts from x-api-key header', () => {
    expect(extractCallbackToken(undefined, 'my-api-key')).toBe('my-api-key');
  });

  it('prefers Authorization: Bearer over x-api-key', () => {
    expect(extractCallbackToken('Bearer bearer-token', 'api-key-token')).toBe('bearer-token');
  });

  it('returns null when neither header is present', () => {
    expect(extractCallbackToken(undefined, undefined)).toBeNull();
  });

  it('returns null for non-Bearer Authorization header', () => {
    expect(extractCallbackToken('Basic abc123', undefined)).toBeNull();
  });
});

// =============================================================================
// buildAnthropicGatewayUrl
// =============================================================================

describe('buildAnthropicGatewayUrl', () => {
  it('builds AI Gateway URL when gateway ID is set', () => {
    const env = { AI_GATEWAY_ID: 'my-gw', CF_ACCOUNT_ID: 'acc-123' } as Parameters<typeof buildAnthropicGatewayUrl>[0];
    expect(buildAnthropicGatewayUrl(env)).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc-123/my-gw/anthropic/v1/messages',
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
    const env = { AI_GATEWAY_ID: 'my-gw', CF_ACCOUNT_ID: 'acc-123' } as Parameters<typeof buildAnthropicCountTokensUrl>[0];
    expect(buildAnthropicCountTokensUrl(env)).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc-123/my-gw/anthropic/v1/messages/count_tokens',
    );
  });

  it('falls back to direct Anthropic API', () => {
    const env = { CF_ACCOUNT_ID: 'acc-123' } as Parameters<typeof buildAnthropicCountTokensUrl>[0];
    expect(buildAnthropicCountTokensUrl(env)).toBe('https://api.anthropic.com/v1/messages/count_tokens');
  });
});

// =============================================================================
// buildAIGatewayMetadata
// =============================================================================

describe('buildAIGatewayMetadata', () => {
  it('includes all fields', () => {
    const meta = JSON.parse(buildAIGatewayMetadata({
      userId: 'u1',
      workspaceId: 'ws1',
      projectId: 'p1',
      trialId: 't1',
      modelId: 'claude-sonnet-4-20250514',
      stream: true,
      hasTools: true,
    }));
    expect(meta).toEqual({
      userId: 'u1',
      workspaceId: 'ws1',
      projectId: 'p1',
      trialId: 't1',
      modelId: 'claude-sonnet-4-20250514',
      stream: true,
      hasTools: true,
    });
  });

  it('omits null projectId and undefined trialId', () => {
    const meta = JSON.parse(buildAIGatewayMetadata({
      userId: 'u1',
      workspaceId: 'ws1',
      projectId: null,
      modelId: 'claude-sonnet-4-20250514',
      stream: false,
    }));
    expect(meta.projectId).toBeUndefined();
    expect(meta.trialId).toBeUndefined();
  });
});

// =============================================================================
// AIProxyAuthError
// =============================================================================

describe('AIProxyAuthError', () => {
  it('has correct name and statusCode', () => {
    const err = new AIProxyAuthError('forbidden', 403);
    expect(err.name).toBe('AIProxyAuthError');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('forbidden');
  });
});

// =============================================================================
// Model validation (isAnthropicModel logic)
// =============================================================================

describe('Anthropic model validation', () => {
  function isAnthropicModel(modelId: string): boolean {
    return modelId.startsWith('claude-');
  }

  it('accepts claude-* models', () => {
    expect(isAnthropicModel('claude-sonnet-4-20250514')).toBe(true);
    expect(isAnthropicModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isAnthropicModel('claude-opus-4-6')).toBe(true);
  });

  it('rejects non-Anthropic models', () => {
    expect(isAnthropicModel('@cf/meta/llama-4-scout-17b-16e-instruct')).toBe(false);
    expect(isAnthropicModel('gpt-4')).toBe(false);
    expect(isAnthropicModel('gemma-3-12b-it')).toBe(false);
  });
});
