import { describe, expect,it } from 'vitest';

import { getBetterAuthSecret, getCredentialEncryptionKey, getWebhookSecret } from '../../../src/lib/secrets';

describe('Secret key resolution helpers', () => {
  const baseEnv = {
    ENCRYPTION_KEY: 'shared-fallback-key',
  };

  describe('getBetterAuthSecret', () => {
    it('returns BETTER_AUTH_SECRET when set', () => {
      expect(getBetterAuthSecret({ ...baseEnv, BETTER_AUTH_SECRET: 'dedicated-auth-secret' }))
        .toBe('dedicated-auth-secret');
    });

    it('falls back to ENCRYPTION_KEY when BETTER_AUTH_SECRET is not set', () => {
      expect(getBetterAuthSecret(baseEnv)).toBe('shared-fallback-key');
    });

    it('falls back to ENCRYPTION_KEY when BETTER_AUTH_SECRET is undefined', () => {
      expect(getBetterAuthSecret({ ...baseEnv, BETTER_AUTH_SECRET: undefined }))
        .toBe('shared-fallback-key');
    });
  });

  describe('getCredentialEncryptionKey', () => {
    it('returns CREDENTIAL_ENCRYPTION_KEY when set', () => {
      expect(getCredentialEncryptionKey({ ...baseEnv, CREDENTIAL_ENCRYPTION_KEY: 'dedicated-cred-key' }))
        .toBe('dedicated-cred-key');
    });

    it('falls back to ENCRYPTION_KEY when CREDENTIAL_ENCRYPTION_KEY is not set', () => {
      expect(getCredentialEncryptionKey(baseEnv)).toBe('shared-fallback-key');
    });
  });

  describe('getWebhookSecret', () => {
    it('returns GITHUB_WEBHOOK_SECRET when set', () => {
      expect(getWebhookSecret({ ...baseEnv, GITHUB_WEBHOOK_SECRET: 'dedicated-webhook-secret' }))
        .toBe('dedicated-webhook-secret');
    });

    it('falls back to ENCRYPTION_KEY when GITHUB_WEBHOOK_SECRET is not set', () => {
      expect(getWebhookSecret(baseEnv)).toBe('shared-fallback-key');
    });
  });

  describe('empty-string fallback', () => {
    it('falls back to ENCRYPTION_KEY when BETTER_AUTH_SECRET is empty string', () => {
      expect(getBetterAuthSecret({ ...baseEnv, BETTER_AUTH_SECRET: '' }))
        .toBe('shared-fallback-key');
    });

    it('falls back to ENCRYPTION_KEY when CREDENTIAL_ENCRYPTION_KEY is empty string', () => {
      expect(getCredentialEncryptionKey({ ...baseEnv, CREDENTIAL_ENCRYPTION_KEY: '' }))
        .toBe('shared-fallback-key');
    });

    it('falls back to ENCRYPTION_KEY when GITHUB_WEBHOOK_SECRET is empty string', () => {
      expect(getWebhookSecret({ ...baseEnv, GITHUB_WEBHOOK_SECRET: '' }))
        .toBe('shared-fallback-key');
    });
  });

  describe('isolation', () => {
    it('each helper returns a different key when all three are set', () => {
      const env = {
        ENCRYPTION_KEY: 'shared',
        BETTER_AUTH_SECRET: 'auth-key',
        CREDENTIAL_ENCRYPTION_KEY: 'cred-key',
        GITHUB_WEBHOOK_SECRET: 'webhook-key',
      };

      expect(getBetterAuthSecret(env)).toBe('auth-key');
      expect(getCredentialEncryptionKey(env)).toBe('cred-key');
      expect(getWebhookSecret(env)).toBe('webhook-key');
    });

    it('all helpers return ENCRYPTION_KEY when no overrides are set', () => {
      expect(getBetterAuthSecret(baseEnv)).toBe('shared-fallback-key');
      expect(getCredentialEncryptionKey(baseEnv)).toBe('shared-fallback-key');
      expect(getWebhookSecret(baseEnv)).toBe('shared-fallback-key');
    });
  });
});
