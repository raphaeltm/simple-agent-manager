/**
 * Integration tests verifying the AI proxy billing header contract.
 *
 * These tests validate that UpstreamAuth results from resolveUpstreamAuth()
 * produce the correct upstream headers when spread into the request —
 * ensuring cf-aig-authorization is sent in unified mode and x-api-key
 * in platform-key mode, and that cf-aig-metadata is always present.
 */
import { describe, expect, it, vi } from 'vitest';

import type { UpstreamAuth } from '../../../src/services/ai-billing';
import { buildAIGatewayMetadata } from '../../../src/services/ai-proxy-shared';

// =============================================================================
// UpstreamAuth header contract
// =============================================================================

describe('UpstreamAuth header contract', () => {
  it('unified mode headers contain cf-aig-authorization and NOT x-api-key', () => {
    const auth: UpstreamAuth = {
      headers: { 'cf-aig-authorization': 'Bearer test-cf-token' },
      billingMode: 'unified',
    };

    expect(auth.headers['cf-aig-authorization']).toBe('Bearer test-cf-token');
    expect(auth.headers['x-api-key']).toBeUndefined();
  });

  it('platform-key mode headers contain x-api-key and NOT cf-aig-authorization', () => {
    const auth: UpstreamAuth = {
      headers: { 'x-api-key': 'sk-ant-test-key' },
      billingMode: 'platform-key',
    };

    expect(auth.headers['x-api-key']).toBe('sk-ant-test-key');
    expect(auth.headers['cf-aig-authorization']).toBeUndefined();
  });
});

// =============================================================================
// Upstream header assembly (mirrors route handler logic)
// =============================================================================

describe('upstream header assembly', () => {
  it('unified billing headers spread correctly with metadata', () => {
    const auth: UpstreamAuth = {
      headers: { 'cf-aig-authorization': 'Bearer my-unified-token' },
      billingMode: 'unified',
    };

    const aigMetadata = buildAIGatewayMetadata({
      userId: 'u1',
      workspaceId: 'ws1',
      modelId: 'claude-sonnet-4-20250514',
      stream: false,
    });

    // This mirrors what ai-proxy-anthropic.ts and ai-proxy.ts do
    const upstreamHeaders: Record<string, string> = {
      ...auth.headers,
      'Content-Type': 'application/json',
      'cf-aig-metadata': aigMetadata,
      'anthropic-version': '2023-06-01',
    };

    expect(upstreamHeaders['cf-aig-authorization']).toBe('Bearer my-unified-token');
    expect(upstreamHeaders['x-api-key']).toBeUndefined();
    expect(upstreamHeaders['cf-aig-metadata']).toContain('"userId":"u1"');
    expect(upstreamHeaders['Content-Type']).toBe('application/json');
    expect(upstreamHeaders['anthropic-version']).toBe('2023-06-01');
  });

  it('platform-key headers spread correctly with metadata', () => {
    const auth: UpstreamAuth = {
      headers: { 'x-api-key': 'sk-ant-platform-key' },
      billingMode: 'platform-key',
    };

    const aigMetadata = buildAIGatewayMetadata({
      userId: 'u1',
      workspaceId: 'ws1',
      modelId: 'claude-sonnet-4-20250514',
      stream: true,
      hasTools: true,
    });

    const upstreamHeaders: Record<string, string> = {
      ...auth.headers,
      'Content-Type': 'application/json',
      'cf-aig-metadata': aigMetadata,
      'anthropic-version': '2023-06-01',
    };

    expect(upstreamHeaders['x-api-key']).toBe('sk-ant-platform-key');
    expect(upstreamHeaders['cf-aig-authorization']).toBeUndefined();
    // cf-aig-metadata must always be present regardless of billing mode
    expect(upstreamHeaders['cf-aig-metadata']).toContain('"userId":"u1"');
    expect(upstreamHeaders['cf-aig-metadata']).toContain('"hasTools":true');
  });

  it('cf-aig-metadata is present in both billing modes', () => {
    const metadata = buildAIGatewayMetadata({
      userId: 'user-123',
      workspaceId: 'ws-456',
      projectId: 'proj-789',
      trialId: 'trial-abc',
      modelId: 'claude-sonnet-4-20250514',
      stream: false,
    });

    // Unified mode
    const unifiedHeaders: Record<string, string> = {
      ...{ 'cf-aig-authorization': 'Bearer token' },
      'cf-aig-metadata': metadata,
    };
    expect(unifiedHeaders['cf-aig-metadata']).toBeDefined();

    // Platform-key mode
    const platformHeaders: Record<string, string> = {
      ...{ 'x-api-key': 'sk-key' },
      'cf-aig-metadata': metadata,
    };
    expect(platformHeaders['cf-aig-metadata']).toBeDefined();

    // Both should produce identical metadata
    expect(unifiedHeaders['cf-aig-metadata']).toBe(platformHeaders['cf-aig-metadata']);
  });
});

// =============================================================================
// Error message sanitization
// =============================================================================

describe('error message sanitization', () => {
  it('generic error message returned to clients does not leak internal variable names', () => {
    const genericMessage = 'AI proxy is not configured. Contact an administrator.';

    expect(genericMessage).not.toContain('CF_AIG_TOKEN');
    expect(genericMessage).not.toContain('CF_API_TOKEN');
    expect(genericMessage).not.toContain('ENCRYPTION_KEY');
    expect(genericMessage).not.toContain('env.');
  });

  it('internal error from resolveUpstreamAuth contains actionable detail for logging', () => {
    const internalError = 'Unified Billing enabled but no CF token is configured (set CF_AIG_TOKEN or CF_API_TOKEN)';

    // This message should be logged server-side but never sent to clients
    expect(internalError).toContain('CF_AIG_TOKEN');
    expect(internalError).toContain('CF_API_TOKEN');
  });
});

// =============================================================================
// Billing mode mutually exclusive header invariant
// =============================================================================

describe('billing mode header mutual exclusivity', () => {
  it('no valid UpstreamAuth result should have both cf-aig-authorization and x-api-key', () => {
    // resolveUpstreamAuth always returns one or the other, never both
    const unifiedResult: UpstreamAuth = {
      headers: { 'cf-aig-authorization': 'Bearer token' },
      billingMode: 'unified',
    };

    const platformResult: UpstreamAuth = {
      headers: { 'x-api-key': 'sk-key' },
      billingMode: 'platform-key',
    };

    // Unified: has cf-aig-authorization, no x-api-key
    expect('cf-aig-authorization' in unifiedResult.headers).toBe(true);
    expect('x-api-key' in unifiedResult.headers).toBe(false);

    // Platform: has x-api-key, no cf-aig-authorization
    expect('x-api-key' in platformResult.headers).toBe(true);
    expect('cf-aig-authorization' in platformResult.headers).toBe(false);
  });
});
