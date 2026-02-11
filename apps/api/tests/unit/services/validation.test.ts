import { describe, expect, it } from 'vitest';
import { CredentialValidator } from '../../../src/services/validation';

describe('CredentialValidator', () => {
  describe('detectCredentialKind', () => {
    it('detects Anthropic API key prefix', () => {
      const detected = CredentialValidator.detectCredentialKind('sk-ant-api03-1234567890abcdef');
      expect(detected).toBe('api-key');
    });

    it('detects Claude OAuth token prefix', () => {
      const detected = CredentialValidator.detectCredentialKind('sk-ant-oat01-1234567890abcdef');
      expect(detected).toBe('oauth-token');
    });

    it('returns null for unknown opaque formats', () => {
      const detected = CredentialValidator.detectCredentialKind('opaque-token-value');
      expect(detected).toBeNull();
    });
  });

  describe('validateCredential', () => {
    it('accepts opaque OAuth tokens with Claude OAuth prefix', () => {
      const validation = CredentialValidator.validateCredential(
        'sk-ant-oat01-abcdef',
        'oauth-token'
      );
      expect(validation.valid).toBe(true);
    });

    it('rejects obvious API keys in OAuth token mode', () => {
      const validation = CredentialValidator.validateCredential(
        'sk-ant-api03-abcdef',
        'oauth-token'
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('API key');
    });

    it('rejects obvious OAuth tokens in API key mode', () => {
      const validation = CredentialValidator.validateCredential(
        'sk-ant-oat01-abcdef',
        'api-key'
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('OAuth token');
    });
  });
});
