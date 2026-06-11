/**
 * Unit tests for secret resolution in the compose renderer.
 *
 * Tests collectSecretNames() and renderCompose() secret injection behaviour.
 * Output is parsed via the yaml library (rule 02: Template Output Verification).
 */
import type { DeploymentManifest } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { ComposeRenderContext } from '../../../src/services/compose-renderer';
import { collectSecretNames, renderCompose } from '../../../src/services/compose-renderer';

// =============================================================================
// Helpers
// =============================================================================

const DIGEST = 'sha256:' + 'a'.repeat(64);

function makeManifest(env: Record<string, unknown> = {}): DeploymentManifest {
  return {
    version: 1,
    services: {
      web: {
        image: { registry: 'docker.io', repository: 'library/nginx', digest: DIGEST },
        env: env as Record<string, string | { secret: string }>,
        volumes: [],
      },
    },
    volumes: {},
    routes: [{ service: 'web', port: 80, mode: 'public' as const }],
  };
}

const CTX: ComposeRenderContext = {
  environmentId: 'env-test',
  releaseId: 'rel-test',
};

// =============================================================================
// collectSecretNames
// =============================================================================

describe('collectSecretNames', () => {
  it('returns empty array when no secret refs exist', () => {
    const manifest = makeManifest({ NODE_ENV: 'production', PORT: '8080' });
    expect(collectSecretNames(manifest)).toEqual([]);
  });

  it('returns sorted unique names from a single service', () => {
    const manifest = makeManifest({
      DB_URL: { secret: 'ZEBRA_SECRET' },
      API_KEY: { secret: 'ALPHA_SECRET' },
      ANOTHER: { secret: 'ALPHA_SECRET' }, // duplicate — same secret name
    });
    expect(collectSecretNames(manifest)).toEqual(['ALPHA_SECRET', 'ZEBRA_SECRET']);
  });

  it('handles multiple services with overlapping secret refs', () => {
    const manifest: DeploymentManifest = {
      version: 1,
      services: {
        web: {
          image: { registry: 'docker.io', repository: 'app/web', digest: DIGEST },
          env: {
            DB_URL: { secret: 'DATABASE_URL' },
            SHARED_KEY: { secret: 'SHARED_SECRET' },
          },
          volumes: [],
        },
        worker: {
          image: { registry: 'docker.io', repository: 'app/worker', digest: 'sha256:' + 'b'.repeat(64) },
          env: {
            QUEUE_URL: { secret: 'QUEUE_SECRET' },
            SHARED_KEY: { secret: 'SHARED_SECRET' }, // same secret referenced in both services
          },
          volumes: [],
        },
      },
      volumes: {},
      routes: [{ service: 'web', port: 80, mode: 'public' as const }],
    };
    // Returns sorted unique names: DATABASE_URL, QUEUE_SECRET, SHARED_SECRET
    expect(collectSecretNames(manifest)).toEqual(['DATABASE_URL', 'QUEUE_SECRET', 'SHARED_SECRET']);
  });
});

// =============================================================================
// renderCompose — secret resolution
// =============================================================================

describe('renderCompose with secrets', () => {
  it('resolves secret references to actual values in rendered Compose YAML', () => {
    const manifest = makeManifest({ DB_URL: { secret: 'DB_URL' } });
    const ctx: ComposeRenderContext = {
      ...CTX,
      resolvedSecrets: { DB_URL: 'postgres://localhost/db' },
    };
    const doc = parse(renderCompose(manifest, ctx));
    expect(doc.services.web.environment.DB_URL).toBe('postgres://localhost/db');
  });

  it('passes through literal string env values unchanged alongside secrets', () => {
    const manifest = makeManifest({
      NODE_ENV: 'production',
      DB_PASS: { secret: 'DATABASE_PASSWORD' },
    });
    const ctx: ComposeRenderContext = {
      ...CTX,
      resolvedSecrets: { DATABASE_PASSWORD: 's3cr3t!' },
    };
    const doc = parse(renderCompose(manifest, ctx));
    expect(doc.services.web.environment.NODE_ENV).toBe('production');
    expect(doc.services.web.environment.DB_PASS).toBe('s3cr3t!');
  });

  it('throws error listing ALL missing secrets when secrets are not provided', () => {
    const manifest = makeManifest({
      SECRET_A: { secret: 'SECRET_A' },
      SECRET_B: { secret: 'SECRET_B' },
    });
    expect(() => renderCompose(manifest, { ...CTX, resolvedSecrets: {} })).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('SECRET_A'),
      }),
    );
    expect(() => renderCompose(manifest, { ...CTX, resolvedSecrets: {} })).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('SECRET_B'),
      }),
    );
  });

  it('renders correctly when no secrets are referenced (backward compat)', () => {
    const manifest = makeManifest({ PORT: '8080', NODE_ENV: 'staging' });
    // No resolvedSecrets provided at all
    const doc = parse(renderCompose(manifest, CTX));
    expect(doc.services.web.environment).toEqual({ PORT: '8080', NODE_ENV: 'staging' });
  });

  it('does not mutate the input manifest when resolving secrets', () => {
    const secretRef = { secret: 'MY_SECRET' };
    const manifest = makeManifest({ API_KEY: secretRef });
    const ctx: ComposeRenderContext = {
      ...CTX,
      resolvedSecrets: { MY_SECRET: 'resolved-value' },
    };
    renderCompose(manifest, ctx);
    // The original env value must remain a secret reference, not the resolved string
    const envEntry = manifest.services.web!.env.API_KEY;
    expect(typeof envEntry).toBe('object');
    expect((envEntry as { secret: string }).secret).toBe('MY_SECRET');
  });
});
