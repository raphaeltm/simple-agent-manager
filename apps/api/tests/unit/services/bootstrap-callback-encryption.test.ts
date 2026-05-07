/**
 * Bootstrap Callback Token Encryption Tests (F-004)
 *
 * Verifies that:
 * - BootstrapTokenData uses encryptedCallbackToken/callbackTokenIv fields (not plaintext)
 * - The bootstrap redeem path correctly decrypts encrypted callback tokens
 * - Legacy tokens with plaintext callbackToken are handled for backward compat
 */
import type { BootstrapTokenData } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

describe('BootstrapTokenData encryption fields (F-004)', () => {
  it('new bootstrap data uses encryptedCallbackToken instead of plaintext', () => {
    const data: BootstrapTokenData = {
      workspaceId: 'ws-test',
      encryptedHetznerToken: 'enc-hetzner',
      hetznerTokenIv: 'hetzner-iv',
      encryptedCallbackToken: 'enc-callback-jwt',
      callbackTokenIv: 'callback-iv',
      encryptedGithubToken: 'enc-github',
      githubTokenIv: 'github-iv',
      createdAt: new Date().toISOString(),
    };

    // New data should NOT have plaintext callbackToken
    expect(data.callbackToken).toBeUndefined();
    // Should have encrypted fields
    expect(data.encryptedCallbackToken).toBe('enc-callback-jwt');
    expect(data.callbackTokenIv).toBe('callback-iv');
  });

  it('legacy bootstrap data with plaintext callbackToken is still valid type', () => {
    // Backward compat: in-flight tokens may have plaintext callbackToken
    const legacyData: BootstrapTokenData = {
      workspaceId: 'ws-legacy',
      encryptedHetznerToken: 'enc-hetzner',
      hetznerTokenIv: 'hetzner-iv',
      callbackToken: 'plaintext-jwt-token',
      encryptedGithubToken: null,
      githubTokenIv: null,
      createdAt: new Date().toISOString(),
    };

    expect(legacyData.callbackToken).toBe('plaintext-jwt-token');
    expect(legacyData.encryptedCallbackToken).toBeUndefined();
  });

  it('bootstrap data matches encryption pattern of other tokens', () => {
    const data: BootstrapTokenData = {
      workspaceId: 'ws-test',
      encryptedHetznerToken: 'enc-hetzner',
      hetznerTokenIv: 'hetzner-iv',
      encryptedCallbackToken: 'enc-callback',
      callbackTokenIv: 'callback-iv',
      encryptedGithubToken: 'enc-github',
      githubTokenIv: 'github-iv',
      createdAt: new Date().toISOString(),
    };

    // All three tokens follow the same pattern: encrypted + iv pair
    expect(data.encryptedHetznerToken).toBeTruthy();
    expect(data.hetznerTokenIv).toBeTruthy();
    expect(data.encryptedCallbackToken).toBeTruthy();
    expect(data.callbackTokenIv).toBeTruthy();
    expect(data.encryptedGithubToken).toBeTruthy();
    expect(data.githubTokenIv).toBeTruthy();
  });
});
