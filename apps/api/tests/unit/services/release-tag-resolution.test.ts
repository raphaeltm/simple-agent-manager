/**
 * Vertical slice test: release-path tag→digest resolution.
 *
 * Exercises resolveManifestImageTags() — the Phase 0 pre-processor that
 * rewrites tag-based image references to digest-pinned references before
 * the manifest hits Zod validation.
 *
 * Mocks at system boundaries:
 *   - Registry HTTP (via createImageResolver's fetchFn)
 *   - mintProjectRegistryCredential (best-effort auth)
 *
 * Asserts:
 *   - Tag-based `image.tag` field → digest-pinned `image.digest`
 *   - Tag-in-digest-field → resolved to real digest
 *   - Already-digested images are untouched (no resolver call)
 *   - Registry failure → structured error with path
 *   - Resolved body passes DeploymentManifestSchema validation
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveManifestImageTags } from '../../../src/routes/deployment-releases';

// Mock the image-resolver module so we can inject a fake fetchFn
vi.mock('../../../src/services/image-resolver', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/image-resolver')>(
    '../../../src/services/image-resolver',
  );
  return {
    ...actual,
    // We re-export the real createImageResolver — the test controls
    // behavior via the fetchFn option (already supported).
    createImageResolver: actual.createImageResolver,
    ImageResolveError: actual.ImageResolveError,
  };
});

// Mock registry credentials — always fails (public registry path)
vi.mock('../../../src/services/registry-credentials', () => ({
  mintProjectRegistryCredential: vi.fn().mockRejectedValue(new Error('no creds configured')),
}));

// =============================================================================
// Helpers
// =============================================================================

const FIXED_DIGEST = 'sha256:a3ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4';

/**
 * Build a minimal valid manifest body with a tag-based image.
 */
function makeManifestBody(overrides?: {
  imageDigest?: string;
  imageTag?: string;
  registry?: string;
  repository?: string;
}) {
  const image: Record<string, string> = {
    registry: overrides?.registry ?? 'ghcr.io',
    repository: overrides?.repository ?? 'myorg/myapp',
  };
  if (overrides?.imageDigest !== undefined) {
    image['digest'] = overrides.imageDigest;
  }
  if (overrides?.imageTag !== undefined) {
    image['tag'] = overrides.imageTag;
  }

  return {
    version: 1,
    services: {
      web: {
        image,
        env: { PORT: '8080' },
        volumes: [],
      },
    },
    volumes: {},
    routes: [{ service: 'web', port: 8080, mode: 'public' }],
  };
}

/**
 * Minimal Env stub — only used for mintProjectRegistryCredential
 * which is mocked to fail anyway.
 */
function makeEnv(): Record<string, unknown> {
  return {
    DATABASE: {},
    ENCRYPTION_KEY: 'test-key',
  };
}

/**
 * Stub global fetch so createImageResolver's default fetch path
 * returns a realistic registry response.
 */
function stubGlobalFetch(digest: string = FIXED_DIGEST) {
  const original = globalThis.fetch;
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
          'Docker-Content-Digest': digest,
        },
      });
    }
    return new Response('{}', {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
        'Docker-Content-Digest': digest,
      },
    });
  });
  globalThis.fetch = fetchFn as typeof fetch;
  return { fetchFn, restore: () => { globalThis.fetch = original; } };
}

function stubGlobalFetchError(status: number) {
  const original = globalThis.fetch;
  const fetchFn = vi.fn(async () => {
    return new Response('Error', { status });
  });
  globalThis.fetch = fetchFn as typeof fetch;
  return { fetchFn, restore: () => { globalThis.fetch = original; } };
}

// =============================================================================
// Tests
// =============================================================================

describe('resolveManifestImageTags (release-path vertical slice)', () => {
  it('resolves image.tag to image.digest via registry API', async () => {
    const body = makeManifestBody({ imageTag: 'v2.1.0' });
    const { fetchFn, restore } = stubGlobalFetch();

    try {
      const result = await resolveManifestImageTags(body, 'proj-1', 'user-1', makeEnv() as never);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');

      const resolved = result.body as typeof body;
      const img = resolved.services.web.image as Record<string, string>;
      expect(img['digest']).toBe(FIXED_DIGEST);
      expect(img['tag']).toBeUndefined(); // tag field removed

      // Verify registry was called with correct URL
      expect(fetchFn).toHaveBeenCalled();
      const callUrl = fetchFn.mock.calls[0]![0] as string;
      expect(callUrl).toContain('ghcr.io/v2/myorg/myapp/manifests/v2.1.0');
    } finally {
      restore();
    }
  });

  it('resolves tag-in-digest-field (digest field contains tag, not sha256)', async () => {
    // Some agents may put a tag value in the digest field
    const body = makeManifestBody({ imageDigest: 'latest' });
    const { restore } = stubGlobalFetch();

    try {
      const result = await resolveManifestImageTags(body, 'proj-1', 'user-1', makeEnv() as never);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');

      const resolved = result.body as typeof body;
      const img = resolved.services.web.image as Record<string, string>;
      expect(img['digest']).toBe(FIXED_DIGEST);
    } finally {
      restore();
    }
  });

  it('leaves already-digested images untouched (no resolver call)', async () => {
    const body = makeManifestBody({ imageDigest: FIXED_DIGEST });
    const { fetchFn, restore } = stubGlobalFetch();

    try {
      const result = await resolveManifestImageTags(body, 'proj-1', 'user-1', makeEnv() as never);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');

      const resolved = result.body as typeof body;
      const img = resolved.services.web.image as Record<string, string>;
      expect(img['digest']).toBe(FIXED_DIGEST);

      // Registry should NOT have been called
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('returns structured error when registry returns 404', async () => {
    const body = makeManifestBody({ imageTag: 'v999.0.0' });
    const { restore } = stubGlobalFetchError(404);

    try {
      const result = await resolveManifestImageTags(body, 'proj-1', 'user-1', makeEnv() as never);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.path).toBe('services.web.image');
      expect(result.errors[0]!.message).toContain('not found');
    } finally {
      restore();
    }
  });

  it('passes through non-object bodies without error (let validateManifest handle)', async () => {
    const result = await resolveManifestImageTags('not-an-object', 'proj-1', 'user-1', makeEnv() as never);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.body).toBe('not-an-object');
  });

  it('resolved body validates against DeploymentManifestSchema', async () => {
    // Import the validator
    const { validateManifest } = await import('@simple-agent-manager/shared');

    const body = makeManifestBody({ imageTag: 'v1.0' });
    const { restore } = stubGlobalFetch();

    try {
      const resolveResult = await resolveManifestImageTags(body, 'proj-1', 'user-1', makeEnv() as never);
      expect(resolveResult.success).toBe(true);
      if (!resolveResult.success) throw new Error('Expected success');

      // The resolved body should now pass Zod validation
      const validationResult = validateManifest(resolveResult.body);
      expect(validationResult.success).toBe(true);
    } finally {
      restore();
    }
  });

  it('reconstructed image ref matches compose-renderer convention', async () => {
    const body = makeManifestBody({ imageTag: 'v2.0' });
    const { restore } = stubGlobalFetch();

    try {
      const resolveResult = await resolveManifestImageTags(body, 'proj-1', 'user-1', makeEnv() as never);
      expect(resolveResult.success).toBe(true);
      if (!resolveResult.success) throw new Error('Expected success');

      const resolved = resolveResult.body as typeof body;
      const img = resolved.services.web.image as Record<string, string>;

      // compose-renderer.ts:125 builds: `${registry}/${repository}@${digest}`
      const renderedRef = `${img['registry']}/${img['repository']}@${img['digest']}`;
      expect(renderedRef).toBe(`ghcr.io/myorg/myapp@${FIXED_DIGEST}`);
      expect(renderedRef).toMatch(/^[a-z0-9.-]+\/[a-z0-9/._-]+@sha256:[a-f0-9]{64}$/);
    } finally {
      restore();
    }
  });
});
