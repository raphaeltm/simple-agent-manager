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
    // Helper to build a base64url-encoded JWT payload
    function makeJwt(payload: Record<string, unknown>): string {
      const header = btoa(JSON.stringify({ alg: 'RS256' })).replace(/=/g, '');
      const body = btoa(JSON.stringify(payload)).replace(/=/g, '');
      return `${header}.${body}.test-signature`;
    }

    const validAccessToken = makeJwt({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 3600 });
    const validIdToken = makeJwt({ sub: 'test', email: 'test@example.com' });

    // Current format (from `codex login`)
    const validAuthJsonCurrent = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: validAccessToken,
        refresh_token: 'some_refresh_token',
        id_token: validIdToken,
        account_id: 'acct-test',
      },
      last_refresh: '2026-01-15T10:30:00Z',
    });

    // Legacy format
    const validAuthJsonLegacy = JSON.stringify({
      auth_mode: 'Chatgpt',
      tokens: {
        access_token: validAccessToken,
        refresh_token: 'rt_test_refresh_token_value',
        id_token: validIdToken,
      },
      last_refresh: '2026-01-15T10:30:00Z',
    });

    it('accepts current-format auth.json (OPENAI_API_KEY: null)', () => {
      const validation = CredentialValidator.validateCredential(
        validAuthJsonCurrent,
        'oauth-token',
        'openai-codex'
      );
      expect(validation.valid).toBe(true);
    });

    it('accepts legacy-format auth.json (auth_mode: Chatgpt)', () => {
      const validation = CredentialValidator.validateCredential(
        validAuthJsonLegacy,
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

    it('rejects auth.json with missing tokens object', () => {
      const invalid = JSON.stringify({
        OPENAI_API_KEY: null,
      });
      const validation = CredentialValidator.validateCredential(
        invalid,
        'oauth-token',
        'openai-codex'
      );
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('tokens');
    });

    it('rejects auth.json with missing access_token', () => {
      const invalid = JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          refresh_token: 'rt_test',
          id_token: validIdToken,
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

    it('accepts auth.json with unexpected token formats (warns but does not reject)', () => {
      // Missing id_token, non-standard refresh_token — should still pass
      const loose = JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: validAccessToken,
          refresh_token: 'some-opaque-token',
        },
      });
      const validation = CredentialValidator.validateCredential(
        loose,
        'oauth-token',
        'openai-codex'
      );
      expect(validation.valid).toBe(true);
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
  function makeJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: 'RS256' })).replace(/=/g, '');
    const body = btoa(JSON.stringify(payload)).replace(/=/g, '');
    return `${header}.${body}.test-signature`;
  }

  it('accepts current-format auth.json and extracts metadata', () => {
    const validJson = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: makeJwt({ sub: 'test-user', exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'some_refresh',
        id_token: makeJwt({
          sub: 'test-user',
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'plus',
            chatgpt_account_id: 'acct-123',
          },
        }),
        account_id: 'acct-123',
      },
    });

    const result = validateOpenAICodexAuthJson(validJson);
    expect(result.valid).toBe(true);
    expect(result.metadata?.planType).toBe('plus');
    expect(result.metadata?.isExpired).toBe(false);
  });

  it('detects expired access token as warning, still valid', () => {
    const json = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: makeJwt({ sub: 'test', exp: Math.floor(Date.now() / 1000) - 3600 }),
        refresh_token: 'some_refresh',
        id_token: makeJwt({ sub: 'test' }),
      },
    });

    const result = validateOpenAICodexAuthJson(json);
    expect(result.valid).toBe(true);
    expect(result.metadata?.isExpired).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.includes('expired'))).toBe(true);
  });

  it('accepts auth.json with missing id_token (warns)', () => {
    const json = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: makeJwt({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: 'some_refresh',
      },
    });

    const result = validateOpenAICodexAuthJson(json);
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.includes('id_token'))).toBe(true);
  });

  it('rejects non-JSON input', () => {
    const result = validateOpenAICodexAuthJson('this is not json');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid JSON');
  });

  it('rejects when tokens object is missing', () => {
    const result = validateOpenAICodexAuthJson(JSON.stringify({ OPENAI_API_KEY: null }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('tokens');
  });

  it('rejects when access_token is missing', () => {
    const json = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { refresh_token: 'rt_test' },
    });
    const result = validateOpenAICodexAuthJson(json);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('access_token');
  });
});
