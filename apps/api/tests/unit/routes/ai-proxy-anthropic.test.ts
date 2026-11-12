/**
 * Request-auth helpers of the AI proxy (worker side; the other shared helpers are tested in
 * packages/ai-proxy/tests/unit/ai-proxy-anthropic.test.ts).
 */
import { describe, expect, it } from 'vitest';

import { AIProxyAuthError, extractCallbackToken } from '../../../src/services/ai-proxy-shared';

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
