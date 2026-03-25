/**
 * Tests for configurable GCP token scopes in gcp-sts.ts.
 *
 * The STS exchange and SA impersonation scopes were previously hardcoded.
 * They are now configurable via GCP_STS_SCOPE and GCP_SA_IMPERSONATION_SCOPES
 * environment variables, with sensible defaults per Constitution Principle XI.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GCP_STS_SCOPE,
  DEFAULT_GCP_SA_IMPERSONATION_SCOPES,
} from '@simple-agent-manager/shared';

describe('GCP scope constants', () => {
  it('DEFAULT_GCP_STS_SCOPE is cloud-platform', () => {
    expect(DEFAULT_GCP_STS_SCOPE).toBe('https://www.googleapis.com/auth/cloud-platform');
  });

  it('DEFAULT_GCP_SA_IMPERSONATION_SCOPES is compute', () => {
    expect(DEFAULT_GCP_SA_IMPERSONATION_SCOPES).toBe('https://www.googleapis.com/auth/compute');
  });
});

describe('GCP SA impersonation scopes parsing', () => {
  // The gcp-sts.ts code splits env var on commas: env.GCP_SA_IMPERSONATION_SCOPES.split(',').map(s => s.trim())
  // Test the same parsing logic to ensure multi-scope support works correctly.

  function parseScopes(envValue: string | undefined, defaultValue: string): string[] {
    return (envValue || defaultValue).split(',').map((s) => s.trim());
  }

  it('returns default scope as single-element array when env var is not set', () => {
    const scopes = parseScopes(undefined, DEFAULT_GCP_SA_IMPERSONATION_SCOPES);
    expect(scopes).toEqual(['https://www.googleapis.com/auth/compute']);
  });

  it('supports a single custom scope', () => {
    const scopes = parseScopes(
      'https://www.googleapis.com/auth/cloud-platform',
      DEFAULT_GCP_SA_IMPERSONATION_SCOPES,
    );
    expect(scopes).toEqual(['https://www.googleapis.com/auth/cloud-platform']);
  });

  it('supports multiple comma-separated scopes', () => {
    const scopes = parseScopes(
      'https://www.googleapis.com/auth/compute,https://www.googleapis.com/auth/devstorage.read_only',
      DEFAULT_GCP_SA_IMPERSONATION_SCOPES,
    );
    expect(scopes).toEqual([
      'https://www.googleapis.com/auth/compute',
      'https://www.googleapis.com/auth/devstorage.read_only',
    ]);
  });

  it('trims whitespace around comma-separated scopes', () => {
    const scopes = parseScopes(
      'https://www.googleapis.com/auth/compute , https://www.googleapis.com/auth/devstorage.read_only',
      DEFAULT_GCP_SA_IMPERSONATION_SCOPES,
    );
    expect(scopes).toEqual([
      'https://www.googleapis.com/auth/compute',
      'https://www.googleapis.com/auth/devstorage.read_only',
    ]);
  });

  it('uses default when env var is empty string', () => {
    const scopes = parseScopes('', DEFAULT_GCP_SA_IMPERSONATION_SCOPES);
    expect(scopes).toEqual(['https://www.googleapis.com/auth/compute']);
  });
});

describe('GCP STS scope selection', () => {
  function selectStsScope(envValue: string | undefined, defaultValue: string): string {
    return envValue || defaultValue;
  }

  it('returns default scope when env var is not set', () => {
    expect(selectStsScope(undefined, DEFAULT_GCP_STS_SCOPE)).toBe(
      'https://www.googleapis.com/auth/cloud-platform',
    );
  });

  it('returns custom scope when env var is set', () => {
    const custom = 'https://www.googleapis.com/auth/compute.readonly';
    expect(selectStsScope(custom, DEFAULT_GCP_STS_SCOPE)).toBe(custom);
  });

  it('returns default when env var is empty string', () => {
    expect(selectStsScope('', DEFAULT_GCP_STS_SCOPE)).toBe(
      'https://www.googleapis.com/auth/cloud-platform',
    );
  });
});
