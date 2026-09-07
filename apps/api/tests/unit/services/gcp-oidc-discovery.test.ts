import { describe, expect,it } from 'vitest';

import { getOidcDiscovery } from '../../../src/services/jwt';

describe('OIDC Discovery', () => {
  const mockEnv = {
    BASE_DOMAIN: 'example.com',
  } as any;

  it('should return correct issuer derived from BASE_DOMAIN', () => {
    const doc = getOidcDiscovery(mockEnv);
    expect(doc.issuer).toBe('https://api.example.com');
  });

  it('should return JWKS URI under the issuer', () => {
    const doc = getOidcDiscovery(mockEnv);
    expect(doc.jwks_uri).toBe('https://api.example.com/.well-known/jwks.json');
  });

  it('should support RS256 signing algorithm', () => {
    const doc = getOidcDiscovery(mockEnv);
    expect(doc.id_token_signing_alg_values_supported).toContain('RS256');
  });

  it('should include SAM-specific claims', () => {
    const doc = getOidcDiscovery(mockEnv);
    expect(doc.claims_supported).toContain('project_id');
    expect(doc.claims_supported).toContain('user_id');
    expect(doc.claims_supported).toContain('workspace_id');
    expect(doc.claims_supported).toContain('node_id');
  });

  it('should use id_token response type', () => {
    const doc = getOidcDiscovery(mockEnv);
    expect(doc.response_types_supported).toEqual(['id_token']);
  });

  it('should derive URLs from env, not hardcode them', () => {
    const customEnv = { BASE_DOMAIN: 'custom.domain.io' } as any;
    const doc = getOidcDiscovery(customEnv);
    expect(doc.issuer).toBe('https://api.custom.domain.io');
    expect(doc.jwks_uri).toBe('https://api.custom.domain.io/.well-known/jwks.json');
  });
});
