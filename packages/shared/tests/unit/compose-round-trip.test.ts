/**
 * Round-trip integrity test: parseCompose → resolveManifest → renderCompose.
 *
 * Proves that a realistic Compose file with x-sam-* extensions, secret refs,
 * volume refs, route mappings, and resource limits survives the full pipeline
 * with all semantically-meaningful fields preserved.
 *
 * This covers the shared half (parse→resolve); renderCompose lives in apps/api
 * and its YAML-round-trip assertions are exercised there.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ImageResolver } from '../../src/compose-parser';
import { parseCompose, resolveManifest } from '../../src/compose-parser';

// Inline renderCompose since it lives in apps/api — we test the shared half
// (parse→resolve) and verify the resolved manifest shape, then separately
// verify the rendered output format.
// For the full round-trip, we import renderCompose dynamically or test the
// manifest structure directly.

// =============================================================================
// Test fixtures
// =============================================================================

const FIXED_DIGEST = 'sha256:a3ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4';

/** Realistic single-service Compose with full x-sam-* extensions */
const REALISTIC_COMPOSE = `
services:
  web:
    image: ghcr.io/myorg/myapp:v2.1.0
    command: ["node", "server.js"]
    environment:
      NODE_ENV: production
      PORT: "8080"
      DATABASE_URL:
        x-sam-secret: db-connection-string
      API_KEY:
        x-sam-secret: stripe-api-key
    volumes:
      - app-data:/data
      - cache:/tmp/cache
    deploy:
      resources:
        limits:
          memory: 512m
          cpus: "1.5"
    healthcheck:
      x-sam-path: /health
      x-sam-port: 8080
      x-sam-expected-status: 200
    restart: unless-stopped

volumes:
  app-data:
    x-sam-size-hint-mb: 1024
  cache:
    x-sam-size-hint-mb: 256

x-sam-routes:
  - service: web
    port: 8080
    mode: public

x-sam-pre-flight:
  service: web
  command: ["node", "migrate.js"]
  timeoutSeconds: 120
`;

// =============================================================================
// Tests
// =============================================================================

describe('Compose round-trip integrity', () => {
  it('parseCompose → resolveManifest preserves all semantically-meaningful fields', async () => {
    // Step 1: Parse
    const parseResult = parseCompose(REALISTIC_COMPOSE);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) throw new Error('Parse failed');
    const unresolved = parseResult.manifest;

    // Verify unresolved manifest captured everything
    expect(unresolved.version).toBe(1);
    expect(Object.keys(unresolved.services)).toEqual(['web']);

    const unresolvedWeb = unresolved.services['web']!;
    expect(unresolvedWeb.image.registry).toBe('ghcr.io');
    expect(unresolvedWeb.image.repository).toBe('myorg/myapp');
    expect(unresolvedWeb.image.reference).toBe('v2.1.0'); // tag, not digest
    expect(unresolvedWeb.command).toEqual(['node', 'server.js']);
    expect(unresolvedWeb.env['NODE_ENV']).toBe('production');
    expect(unresolvedWeb.env['PORT']).toBe('8080');
    expect(unresolvedWeb.env['DATABASE_URL']).toEqual({ secret: 'db-connection-string' });
    expect(unresolvedWeb.env['API_KEY']).toEqual({ secret: 'stripe-api-key' });
    expect(unresolvedWeb.volumes).toEqual([
      { name: 'app-data', mountPath: '/data' },
      { name: 'cache', mountPath: '/tmp/cache' },
    ]);
    expect(unresolvedWeb.resources).toEqual({ memoryLimitMb: 512, cpuLimit: 1.5 });
    expect(unresolvedWeb.healthCheck).toEqual({ path: '/health', port: 8080, expectedStatus: 200 });

    // Volumes
    expect(unresolved.volumes['app-data']).toEqual({ sizeHintMb: 1024 });
    expect(unresolved.volumes['cache']).toEqual({ sizeHintMb: 256 });

    // Routes
    expect(unresolved.routes).toEqual([{ service: 'web', port: 8080, mode: 'public' }]);

    // Hooks
    expect(unresolved.hooks).toEqual({
      preFlight: { service: 'web', command: ['node', 'migrate.js'], timeoutSeconds: 120 },
    });

    // Step 2: Resolve (with mock resolver returning fixed digest)
    const mockResolver: ImageResolver = vi.fn().mockResolvedValue(FIXED_DIGEST);
    const resolveResult = await resolveManifest(unresolved, mockResolver);
    expect(resolveResult.success).toBe(true);
    if (!resolveResult.success) throw new Error(`Resolve failed: ${JSON.stringify(resolveResult.errors)}`);

    const manifest = resolveResult.manifest;

    // Verify the resolver was called with the right args
    expect(mockResolver).toHaveBeenCalledWith('ghcr.io', 'myorg/myapp', 'v2.1.0');

    // Step 3: Verify all fields survived the round-trip into DeploymentManifest
    expect(manifest.version).toBe(1);

    // Image — now digest-pinned
    const web = manifest.services['web']!;
    expect(web.image.registry).toBe('ghcr.io');
    expect(web.image.repository).toBe('myorg/myapp');
    expect(web.image.digest).toBe(FIXED_DIGEST);

    // Command
    expect(web.command).toEqual(['node', 'server.js']);

    // Environment — plain strings and secret refs
    expect(web.env['NODE_ENV']).toBe('production');
    expect(web.env['PORT']).toBe('8080');
    expect(web.env['DATABASE_URL']).toEqual({ secret: 'db-connection-string' });
    expect(web.env['API_KEY']).toEqual({ secret: 'stripe-api-key' });

    // Volumes
    expect(web.volumes).toEqual([
      { name: 'app-data', mountPath: '/data' },
      { name: 'cache', mountPath: '/tmp/cache' },
    ]);

    // Resources
    expect(web.resources).toEqual({ memoryLimitMb: 512, cpuLimit: 1.5 });

    // Health check
    expect(web.healthCheck).toEqual({ path: '/health', port: 8080, expectedStatus: 200 });

    // Top-level volumes
    expect(manifest.volumes['app-data']).toEqual({ sizeHintMb: 1024 });
    expect(manifest.volumes['cache']).toEqual({ sizeHintMb: 256 });

    // Routes
    expect(manifest.routes).toEqual([{ service: 'web', port: 8080, mode: 'public' }]);

    // Hooks
    expect(manifest.hooks).toEqual({
      preFlight: { service: 'web', command: ['node', 'migrate.js'], timeoutSeconds: 120 },
    });
  });

  it('preserves already-digested images without calling the resolver', async () => {
    const digestedCompose = `
services:
  api:
    image: ghcr.io/org/api@sha256:a3ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4
    environment:
      PORT: "3000"

x-sam-routes:
  - service: api
    port: 3000
    mode: public
`;

    const parseResult = parseCompose(digestedCompose);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) throw new Error('Parse failed');

    const mockResolver: ImageResolver = vi.fn();
    const resolveResult = await resolveManifest(parseResult.manifest, mockResolver);
    expect(resolveResult.success).toBe(true);
    if (!resolveResult.success) throw new Error('Resolve failed');

    // Resolver should NOT have been called (already a digest)
    expect(mockResolver).not.toHaveBeenCalled();

    const api = resolveResult.manifest.services['api']!;
    expect(api.image.digest).toBe('sha256:a3ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4');
  });

  it('resolved manifest validates against DeploymentManifestSchema (Zod)', async () => {
    const parseResult = parseCompose(REALISTIC_COMPOSE);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) throw new Error('Parse failed');

    const mockResolver: ImageResolver = vi.fn().mockResolvedValue(FIXED_DIGEST);
    const resolveResult = await resolveManifest(parseResult.manifest, mockResolver);

    // resolveManifest internally validates against DeploymentManifestSchema
    // so a success here proves Zod validation passed
    expect(resolveResult.success).toBe(true);
  });

  it('handles resolver failure with structured error', async () => {
    const parseResult = parseCompose(REALISTIC_COMPOSE);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) throw new Error('Parse failed');

    const mockResolver: ImageResolver = vi.fn().mockRejectedValue(
      new Error('Registry returned 404'),
    );
    const resolveResult = await resolveManifest(parseResult.manifest, mockResolver);

    expect(resolveResult.success).toBe(false);
    if (resolveResult.success) throw new Error('Expected failure');
    expect(resolveResult.errors).toHaveLength(1);
    expect(resolveResult.errors[0]!.path).toBe('services.web.image');
    expect(resolveResult.errors[0]!.message).toContain('Registry returned 404');
  });

  it('cross-checks rendered image ref format matches compose-renderer convention', async () => {
    // The compose-renderer builds: `${registry}/${repository}@${digest}`
    // Verify the resolved manifest has the components to produce this format
    const parseResult = parseCompose(REALISTIC_COMPOSE);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) throw new Error('Parse failed');

    const mockResolver: ImageResolver = vi.fn().mockResolvedValue(FIXED_DIGEST);
    const resolveResult = await resolveManifest(parseResult.manifest, mockResolver);
    expect(resolveResult.success).toBe(true);
    if (!resolveResult.success) throw new Error('Resolve failed');

    const web = resolveResult.manifest.services['web']!;
    // Reconstruct the image ref as compose-renderer.ts:125 does
    const renderedRef = `${web.image.registry}/${web.image.repository}@${web.image.digest}`;
    expect(renderedRef).toBe(`ghcr.io/myorg/myapp@${FIXED_DIGEST}`);

    // Parse it back to verify it's a valid reference
    expect(renderedRef).toMatch(/^[a-z0-9.-]+\/[a-z0-9/._-]+@sha256:[a-f0-9]{64}$/);
  });

  it('docker.io default: bare image name gets library/ prefix', async () => {
    const compose = `
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: test

x-sam-routes:
  - service: db
    port: 5432
    mode: private
`;
    const parseResult = parseCompose(compose);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) throw new Error('Parse failed');

    const db = parseResult.manifest.services['db']!;
    expect(db.image.registry).toBe('docker.io');
    expect(db.image.repository).toBe('library/postgres');
    expect(db.image.reference).toBe('16');
  });

  it('minimal compose with no optional fields survives round-trip', async () => {
    const minimal = `
services:
  app:
    image: ghcr.io/org/simple:v1

x-sam-routes:
  - service: app
    port: 80
    mode: public
`;
    const parseResult = parseCompose(minimal);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) throw new Error('Parse failed');

    const mockResolver: ImageResolver = vi.fn().mockResolvedValue(FIXED_DIGEST);
    const resolveResult = await resolveManifest(parseResult.manifest, mockResolver);
    expect(resolveResult.success).toBe(true);
    if (!resolveResult.success) throw new Error(`Resolve failed: ${JSON.stringify(resolveResult.errors)}`);

    const manifest = resolveResult.manifest;
    expect(manifest.services['app']!.image.digest).toBe(FIXED_DIGEST);
    expect(manifest.services['app']!.env).toEqual({});
    expect(manifest.services['app']!.volumes).toEqual([]);
    expect(manifest.services['app']!.command).toBeUndefined();
    expect(manifest.services['app']!.resources).toBeUndefined();
    expect(manifest.services['app']!.healthCheck).toBeUndefined();
    expect(manifest.routes).toEqual([{ service: 'app', port: 80, mode: 'public' }]);
    expect(manifest.hooks).toBeUndefined();
  });
});
