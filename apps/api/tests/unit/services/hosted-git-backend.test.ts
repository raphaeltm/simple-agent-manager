/**
 * The hosted-git seam (self-host landing slice L16).
 *
 * `resolveArtifactsBackend` is the one answer to "which Artifacts backend does this install use?".
 * On Cloudflare it is the binding or nothing; a self-host build may register a fallback that is
 * used only when Artifacts is enabled and no binding exists. Every caller (capability flag,
 * project creation and deletion, git tokens, repository browsing) goes through it.
 */
import { repoHostingPorts } from '@simple-agent-manager/repo-hosting/ports';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  type ArtifactsBackend,
  isArtifactsAvailable,
  registerArtifactsBackendFallback,
  resolveArtifactsBackend,
} from '../../../src/services/hosted-git/backend';

function backend(label: string): ArtifactsBackend {
  return {
    create: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    label,
  } as unknown as ArtifactsBackend;
}

function env(fields: Partial<Env>): Env {
  return { ...fields } as Env;
}

afterEach(() => {
  registerArtifactsBackendFallback(null);
});

describe('resolveArtifactsBackend', () => {
  it('returns the Cloudflare binding when Artifacts is enabled (unchanged Cloudflare path)', () => {
    const binding = backend('cloudflare');
    expect(resolveArtifactsBackend(env({ ARTIFACTS_ENABLED: 'true', ARTIFACTS: binding }))).toBe(
      binding
    );
  });

  it('returns null when Artifacts is enabled but no binding and no fallback exist', () => {
    expect(resolveArtifactsBackend(env({ ARTIFACTS_ENABLED: 'true' }))).toBeNull();
  });

  it('returns null whenever ARTIFACTS_ENABLED is not "true", binding or fallback notwithstanding', () => {
    const fallback = vi.fn(() => backend('selfhost'));
    registerArtifactsBackendFallback(fallback);
    for (const enabled of [undefined, '', 'false', 'TRUE', '1']) {
      expect(
        resolveArtifactsBackend(env({ ARTIFACTS_ENABLED: enabled, ARTIFACTS: backend('cf') }))
      ).toBeNull();
      expect(resolveArtifactsBackend(env({ ARTIFACTS_ENABLED: enabled }))).toBeNull();
    }
    expect(fallback).not.toHaveBeenCalled();
  });

  it('uses a registered fallback only when the binding is absent, and passes it the env', () => {
    const selfhost = backend('selfhost');
    const fallback = vi.fn(() => selfhost);
    registerArtifactsBackendFallback(fallback);
    const e = env({ ARTIFACTS_ENABLED: 'true', BASE_DOMAIN: 'sam.example' });
    expect(resolveArtifactsBackend(e)).toBe(selfhost);
    expect(fallback).toHaveBeenCalledWith(e);
  });

  it('prefers the Cloudflare binding over a registered fallback', () => {
    const binding = backend('cloudflare');
    const fallback = vi.fn(() => backend('selfhost'));
    registerArtifactsBackendFallback(fallback);
    expect(resolveArtifactsBackend(env({ ARTIFACTS_ENABLED: 'true', ARTIFACTS: binding }))).toBe(
      binding
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it('treats a fallback that declines (not configured on this install) as no backend', () => {
    registerArtifactsBackendFallback(() => null);
    expect(resolveArtifactsBackend(env({ ARTIFACTS_ENABLED: 'true' }))).toBeNull();
    expect(isArtifactsAvailable(env({ ARTIFACTS_ENABLED: 'true' }))).toBe(false);
  });
});

describe('isArtifactsAvailable (the /api/config/artifacts-enabled answer)', () => {
  it('is true for flag + binding, false for flag alone, false for binding alone', () => {
    expect(isArtifactsAvailable(env({ ARTIFACTS_ENABLED: 'true', ARTIFACTS: backend('cf') }))).toBe(
      true
    );
    expect(isArtifactsAvailable(env({ ARTIFACTS_ENABLED: 'true' }))).toBe(false);
    expect(isArtifactsAvailable(env({ ARTIFACTS: backend('cf') }))).toBe(false);
  });

  it('is true when a self-host fallback serves repositories', () => {
    registerArtifactsBackendFallback(() => backend('selfhost'));
    expect(isArtifactsAvailable(env({ ARTIFACTS_ENABLED: 'true' }))).toBe(true);
  });
});

describe('repo-hosting artifacts port (installed by the worker test setup)', () => {
  it('resolves through the same seam: binding, fallback, or nothing', () => {
    const port = repoHostingPorts().artifacts;
    const binding = backend('cloudflare');
    expect(port.resolve({ ARTIFACTS_ENABLED: 'true', ARTIFACTS: binding } as never)).toBe(binding);
    expect(port.resolve({ ARTIFACTS_ENABLED: 'true' } as never)).toBeNull();

    const selfhost = backend('selfhost');
    registerArtifactsBackendFallback(() => selfhost);
    expect(port.resolve({ ARTIFACTS_ENABLED: 'true' } as never)).toBe(selfhost);
    expect(port.resolve({ ARTIFACTS_ENABLED: 'false' } as never)).toBeNull();
  });
});
