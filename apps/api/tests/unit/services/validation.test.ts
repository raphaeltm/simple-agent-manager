import { describe, expect, it } from 'vitest';
import { CredentialValidator, validateOpenAICodexAuthJson } from '../../../src/services/validation';

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

    it('rejects empty credentials', () => {
      const validation = CredentialValidator.validateCredential('', 'api-key');
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('empty');
    });

    it('accepts opaque API keys for non-Anthropic agents', () => {
      const validation = CredentialValidator.validateCredential(
        'sk-1234567890abcdef',
        'api-key',
        'openai-codex'
      );
      expect(validation.valid).toBe(true);
    });
  });

  describe('validateCredential for OpenAI Codex OAuth', () => {
    const validAuthJson = JSON.stringify({
      auth_mode: 'Chatgpt',
      tokens: {
        access_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature',
        refresh_token: 'rt_test_refresh_token_value',
        id_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature',
      },
      last_refresh: '2026-01-15T10:30:00Z',
    });

    it('accepts valid auth.json for openai-codex oauth-token', () => {
      const validation = CredentialValidator.validateCredential(
        validAuthJson,
        'oauth-token',
        'openai-codex'
      );
      expect(validation.valid).toBe(true);
    });

    it('rejects invalid JSON for openai-codex oauth-token', () => {
      const validation = CredentialValidator.validateCredential(
        'not json at all',
        'oauth-token',
        'openai-codex'
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('Invalid JSON');
    });

    it('rejects auth.json with wrong auth_mode', () => {
      const invalid = JSON.stringify({
        auth_mode: 'ApiKey',
        tokens: {
          access_token: 'eyJtest',
          refresh_token: 'rt_test',
          id_token: 'eyJtest',
        },
      });
      const validation = CredentialValidator.validateCredential(
        invalid,
        'oauth-token',
        'openai-codex'
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('auth_mode');
    });

    it('rejects auth.json with missing tokens', () => {
      const invalid = JSON.stringify({
        auth_mode: 'Chatgpt',
      });
      const validation = CredentialValidator.validateCredential(
        invalid,
        'oauth-token',
        'openai-codex'
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('tokens');
    });

    it('rejects auth.json with invalid access_token', () => {
      const invalid = JSON.stringify({
        auth_mode: 'Chatgpt',
        tokens: {
          access_token: 'not-a-jwt',
          refresh_token: 'rt_test',
          id_token: 'eyJtest',
        },
      });
      const validation = CredentialValidator.validateCredential(
        invalid,
        'oauth-token',
        'openai-codex'
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('access_token');
    });

    it('rejects auth.json with invalid refresh_token prefix', () => {
      const invalid = JSON.stringify({
        auth_mode: 'Chatgpt',
        tokens: {
          access_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig',
          refresh_token: 'invalid_prefix_token',
          id_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig',
        },
      });
      const validation = CredentialValidator.validateCredential(
        invalid,
        'oauth-token',
        'openai-codex'
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('refresh_token');
    });
  });

  describe('getCredentialErrorMessage', () => {
    it('returns OpenAI-specific message for codex unauthorized', () => {
      const msg = CredentialValidator.getCredentialErrorMessage('oauth-token', '401 unauthorized', 'openai-codex');
      expect(msg).toContain('OpenAI');
      expect(msg).toContain('codex login');
    });

    it('returns Claude-specific message for Claude OAuth unauthorized', () => {
      const msg = CredentialValidator.getCredentialErrorMessage('oauth-token', '401 unauthorized');
      expect(msg).toContain('claude');
    });

    it('returns generic message for unknown errors', () => {
      const msg = CredentialValidator.getCredentialErrorMessage('api-key', 'some unknown error');
      expect(msg).toContain('Authentication failed');
    });
  });
});

describe('validateOpenAICodexAuthJson', () => {
  it('accepts valid auth.json and extracts metadata', () => {
    // Build a minimal valid JWT with plan_type in the namespace claim
    const header = btoa(JSON.stringify({ alg: 'RS256' })).replace(/=/g, '');
    const idPayload = btoa(JSON.stringify({
      sub: 'test-user',
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
        chatgpt_account_id: 'acct-123',
      },
    })).replace(/=/g, '');
    const accessPayload = btoa(JSON.stringify({
      sub: 'test-user',
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    })).replace(/=/g, '');
    const sig = 'signature';

    const validJson = JSON.stringify({
      auth_mode: 'Chatgpt',
      tokens: {
        access_token: `${header}.${accessPayload}.${sig}`,
        refresh_token: 'rt_test_refresh_token',
        id_token: `${header}.${idPayload}.${sig}`,
      },
    });

    const result = validateOpenAICodexAuthJson(validJson);
    expect(result.valid).toBe(true);
    expect(result.metadata?.planType).toBe('plus');
    expect(result.metadata?.isExpired).toBe(false);
  });

  it('detects expired access token', () => {
    const header = btoa(JSON.stringify({ alg: 'RS256' })).replace(/=/g, '');
    const accessPayload = btoa(JSON.stringify({
      sub: 'test-user',
      exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago (expired)
    })).replace(/=/g, '');
    const idPayload = btoa(JSON.stringify({ sub: 'test' })).replace(/=/g, '');
    const sig = 'signature';

    const json = JSON.stringify({
      auth_mode: 'Chatgpt',
      tokens: {
        access_token: `${header}.${accessPayload}.${sig}`,
        refresh_token: 'rt_test_refresh',
        id_token: `${header}.${idPayload}.${sig}`,
      },
    });

    const result = validateOpenAICodexAuthJson(json);
    expect(result.valid).toBe(true);
    expect(result.metadata?.isExpired).toBe(true);
  });

  it('rejects non-JSON input', () => {
    const result = validateOpenAICodexAuthJson('this is not json');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid JSON');
  });

  it('accepts lowercase chatgpt auth_mode', () => {
    const header = btoa(JSON.stringify({ alg: 'RS256' })).replace(/=/g, '');
    const payload = btoa(JSON.stringify({ sub: 'test' })).replace(/=/g, '');
    const sig = 'sig';
    const json = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: `${header}.${payload}.${sig}`,
        refresh_token: 'rt_test',
        id_token: `${header}.${payload}.${sig}`,
      },
    });
    const result = validateOpenAICodexAuthJson(json);
    expect(result.valid).toBe(true);
  });
});
