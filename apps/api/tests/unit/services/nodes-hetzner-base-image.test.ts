import { describe, expect, it } from 'vitest';

import { resolveHetznerBaseImageOverride } from '../../../src/services/nodes';

describe('resolveHetznerBaseImageOverride (HETZNER_BASE_IMAGE → provider.createVM)', () => {
  it('returns undefined for non-hetzner providers even if env is set', () => {
    expect(resolveHetznerBaseImageOverride('scaleway', 'docker-ce')).toBeUndefined();
    expect(resolveHetznerBaseImageOverride('gcp', 'ubuntu-24.04')).toBeUndefined();
  });

  it('returns undefined when provider is undefined', () => {
    expect(resolveHetznerBaseImageOverride(undefined, 'docker-ce')).toBeUndefined();
  });

  it('returns undefined when env var is absent', () => {
    expect(resolveHetznerBaseImageOverride('hetzner', undefined)).toBeUndefined();
  });

  it('returns undefined when env var is empty or whitespace', () => {
    expect(resolveHetznerBaseImageOverride('hetzner', '')).toBeUndefined();
    expect(resolveHetznerBaseImageOverride('hetzner', '   ')).toBeUndefined();
  });

  it('returns the trimmed env value for hetzner when set', () => {
    expect(resolveHetznerBaseImageOverride('hetzner', 'docker-ce')).toBe('docker-ce');
    expect(resolveHetznerBaseImageOverride('hetzner', '  ubuntu-24.04  ')).toBe('ubuntu-24.04');
  });

  it('preserves the emergency-rollback case (ubuntu-24.04)', () => {
    // The primary operator-facing use case: rollback from docker-ce to ubuntu
    // via env var without a code change.
    expect(resolveHetznerBaseImageOverride('hetzner', 'ubuntu-24.04')).toBe('ubuntu-24.04');
  });
});
