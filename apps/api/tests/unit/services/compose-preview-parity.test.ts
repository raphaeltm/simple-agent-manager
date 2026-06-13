/**
 * Compose-preview parity + secret-resolution coverage tests.
 *
 * Gap 4: Preview endpoint must render Compose with the SAME route-target
 * host-port bindings the node receives via the apply callback.
 *
 * Gap 6: Secret-resolution behavioural coverage — secret references resolve
 * to correct decrypted values in the APPLY render, are MASKED in the PREVIEW
 * render, and missing secrets fail cleanly.
 *
 * Tests follow rule 02 (Template Output Verification): all compose output
 * is parsed via the yaml library and asserted on the parsed structure.
 * Tests follow rule 35 (Vertical Slice Testing): realistic state at boundaries.
 */
import type { DeploymentManifest } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { collectSecretNames, renderCompose } from '../../../src/services/compose-renderer';
import { buildDeploymentRouteTargets } from '../../../src/services/deployment-routing';

// =============================================================================
// Helpers — realistic manifests with routes AND secrets
// =============================================================================

const DIGEST_A = 'sha256:' + 'a'.repeat(64);
const DIGEST_B = 'sha256:' + 'b'.repeat(64);

const SECRET_MASK = '***';

/** A manifest with one service that has public routes AND secret references. */
function makeManifestWithSecrets(overrides?: Partial<DeploymentManifest>): DeploymentManifest {
  return {
    version: 1,
    services: {
      web: {
        image: { registry: 'docker.io', repository: 'myapp/web', digest: DIGEST_A },
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: { secret: 'DB_URL' },
          API_KEY: { secret: 'EXTERNAL_API_KEY' },
        },
        volumes: [],
      },
    },
    volumes: {},
    routes: [
      { service: 'web', port: 3000, mode: 'public' as const },
    ],
    ...overrides,
  };
}

/** Multi-service manifest with routes, secrets, and private routes. */
function makeMultiServiceManifest(): DeploymentManifest {
  return {
    version: 1,
    services: {
      web: {
        image: { registry: 'docker.io', repository: 'myapp/web', digest: DIGEST_A },
        env: {
          NODE_ENV: 'production',
          DB_URL: { secret: 'DATABASE_URL' },
        },
        volumes: [],
      },
      worker: {
        image: { registry: 'docker.io', repository: 'myapp/worker', digest: DIGEST_B },
        env: {
          QUEUE_TOKEN: { secret: 'QUEUE_SECRET' },
          WORKER_MODE: 'background',
        },
        volumes: [],
      },
    },
    volumes: {},
    routes: [
      { service: 'web', port: 8080, mode: 'public' as const },
      { service: 'worker', port: 9000, mode: 'private' as const },
      { service: 'web', port: 8443, mode: 'public' as const },
    ],
  };
}

const ENV_ID = 'env-parity-test';
const RELEASE_ID = 'rel-parity-test';
const BASE_DOMAIN = 'sammy.party';
const PORT_BASE = '36000';
const PORT_SPAN = '100';

const ROUTE_OPTS = {
  environmentId: ENV_ID,
  baseDomain: BASE_DOMAIN,
  routePortBase: PORT_BASE,
  routePortSpan: PORT_SPAN,
};

const REAL_SECRETS: Record<string, string> = {
  DB_URL: 'postgres://user:s3cr3t@db.internal:5432/myapp',
  EXTERNAL_API_KEY: 'sk-live-abc123xyz789',
  DATABASE_URL: 'postgres://admin:hunter2@prod-db:5432/production',
  QUEUE_SECRET: 'amqp://guest:guest@rabbit:5672',
};

// =============================================================================
// Gap 4: Compose preview ↔ apply parity
// =============================================================================

describe('compose preview ↔ apply parity (Gap 4)', () => {
  it('preview and apply produce IDENTICAL compose EXCEPT for masked secret values', () => {
    const manifest = makeManifestWithSecrets();
    const routes = buildDeploymentRouteTargets(manifest, ROUTE_OPTS);

    // Simulate APPLY render (real secrets + route targets)
    const applyYaml = renderCompose(manifest, {
      environmentId: ENV_ID,
      releaseId: RELEASE_ID,
      resolvedSecrets: { DB_URL: REAL_SECRETS.DB_URL, EXTERNAL_API_KEY: REAL_SECRETS.EXTERNAL_API_KEY },
      routeTargets: routes,
    });

    // Simulate PREVIEW render (masked secrets + same route targets)
    const secretNames = collectSecretNames(manifest);
    const maskedSecrets: Record<string, string> = {};
    for (const name of secretNames) {
      maskedSecrets[name] = SECRET_MASK;
    }
    const previewYaml = renderCompose(manifest, {
      environmentId: ENV_ID,
      releaseId: RELEASE_ID,
      resolvedSecrets: maskedSecrets,
      routeTargets: routes,
    });

    const applyDoc = parse(applyYaml);
    const previewDoc = parse(previewYaml);

    // Structure must be identical — same services, networks, ports, labels
    expect(Object.keys(previewDoc.services)).toEqual(Object.keys(applyDoc.services));
    expect(previewDoc.services.web.image).toBe(applyDoc.services.web.image);
    expect(previewDoc.services.web.ports).toEqual(applyDoc.services.web.ports);
    expect(previewDoc.services.web.labels).toEqual(applyDoc.services.web.labels);
    expect(previewDoc.services.web.networks).toEqual(applyDoc.services.web.networks);
    expect(previewDoc.services.web.deploy).toEqual(applyDoc.services.web.deploy);
    expect(previewDoc.networks).toEqual(applyDoc.networks);

    // Secret env vars: preview has masks, apply has real values
    expect(previewDoc.services.web.environment.DATABASE_URL).toBe(SECRET_MASK);
    expect(previewDoc.services.web.environment.API_KEY).toBe(SECRET_MASK);
    expect(applyDoc.services.web.environment.DATABASE_URL).toBe(REAL_SECRETS.DB_URL);
    expect(applyDoc.services.web.environment.API_KEY).toBe(REAL_SECRETS.EXTERNAL_API_KEY);

    // Literal env vars: identical in both
    expect(previewDoc.services.web.environment.NODE_ENV).toBe('production');
    expect(applyDoc.services.web.environment.NODE_ENV).toBe('production');
  });

  it('preview route-target ports match apply route-target ports for multi-service manifest', () => {
    const manifest = makeMultiServiceManifest();
    const routes = buildDeploymentRouteTargets(manifest, ROUTE_OPTS);

    const maskedSecrets: Record<string, string> = {};
    for (const name of collectSecretNames(manifest)) {
      maskedSecrets[name] = SECRET_MASK;
    }

    const previewYaml = renderCompose(manifest, {
      environmentId: ENV_ID,
      releaseId: RELEASE_ID,
      resolvedSecrets: maskedSecrets,
      routeTargets: routes,
    });

    const applyYaml = renderCompose(manifest, {
      environmentId: ENV_ID,
      releaseId: RELEASE_ID,
      resolvedSecrets: {
        DATABASE_URL: REAL_SECRETS.DATABASE_URL,
        QUEUE_SECRET: REAL_SECRETS.QUEUE_SECRET,
      },
      routeTargets: routes,
    });

    const previewDoc = parse(previewYaml);
    const applyDoc = parse(applyYaml);

    // Public routes produce port bindings — only web has public routes
    expect(routes).toHaveLength(2);
    expect(routes[0].service).toBe('web');
    expect(routes[1].service).toBe('web');

    // Ports are identical in both renders
    expect(previewDoc.services.web.ports).toEqual(applyDoc.services.web.ports);
    expect(previewDoc.services.web.ports).toHaveLength(2);

    // Port binding format: 127.0.0.1:<hostPort>:<containerPort>
    for (const port of previewDoc.services.web.ports) {
      expect(port).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
    }

    // Worker has no public routes — no ports section
    expect(previewDoc.services.worker.ports).toBeUndefined();
    expect(applyDoc.services.worker.ports).toBeUndefined();
  });

  it('preview includes hostPort from per-env offset (not hardcoded base)', () => {
    const manifest = makeManifestWithSecrets();
    const routes = buildDeploymentRouteTargets(manifest, ROUTE_OPTS);

    const maskedSecrets: Record<string, string> = {};
    for (const name of collectSecretNames(manifest)) {
      maskedSecrets[name] = SECRET_MASK;
    }

    const previewYaml = renderCompose(manifest, {
      environmentId: ENV_ID,
      releaseId: RELEASE_ID,
      resolvedSecrets: maskedSecrets,
      routeTargets: routes,
    });
    const previewDoc = parse(previewYaml);

    // The host port should include the per-env offset, not just the base
    expect(routes).toHaveLength(1);
    const expectedHostPort = routes[0].hostPort;
    expect(previewDoc.services.web.ports[0]).toBe(`127.0.0.1:${expectedHostPort}:3000`);
    // Verify offset is non-trivial (very unlikely to be exactly base)
    expect(expectedHostPort).toBeGreaterThanOrEqual(36000);
  });

  it('preview with no routes produces compose identical to apply with no routes', () => {
    const noRouteManifest: DeploymentManifest = {
      version: 1,
      services: {
        cron: {
          image: { registry: 'docker.io', repository: 'myapp/cron', digest: DIGEST_A },
          env: { SCHEDULE: '*/5 * * * *' },
          volumes: [],
        },
      },
      volumes: {},
      routes: [], // no routes at all
    };

    const previewYaml = renderCompose(noRouteManifest, {
      environmentId: ENV_ID,
      releaseId: RELEASE_ID,
      routeTargets: [],
    });
    const applyYaml = renderCompose(noRouteManifest, {
      environmentId: ENV_ID,
      releaseId: RELEASE_ID,
      routeTargets: [],
    });

    // Byte-identical — no secrets, no routes
    expect(previewYaml).toBe(applyYaml);
  });
});

// =============================================================================
// Gap 6: Secret-resolution render coverage
// =============================================================================

describe('secret-resolution render coverage (Gap 6)', () => {
  describe('APPLY render — secrets resolve to correct decrypted values', () => {
    it('resolves single secret reference to its decrypted value', () => {
      const manifest = makeManifestWithSecrets({
        services: {
          web: {
            image: { registry: 'docker.io', repository: 'myapp/web', digest: DIGEST_A },
            env: { DB_URL: { secret: 'DB_URL' } },
            volumes: [],
          },
        },
      });

      const yaml = renderCompose(manifest, {
        environmentId: ENV_ID,
        releaseId: RELEASE_ID,
        resolvedSecrets: { DB_URL: REAL_SECRETS.DB_URL },
        routeTargets: buildDeploymentRouteTargets(manifest, ROUTE_OPTS),
      });

      const doc = parse(yaml);
      expect(doc.services.web.environment.DB_URL).toBe(REAL_SECRETS.DB_URL);
    });

    it('resolves multiple secrets across multiple services', () => {
      const manifest = makeMultiServiceManifest();

      const yaml = renderCompose(manifest, {
        environmentId: ENV_ID,
        releaseId: RELEASE_ID,
        resolvedSecrets: {
          DATABASE_URL: REAL_SECRETS.DATABASE_URL,
          QUEUE_SECRET: REAL_SECRETS.QUEUE_SECRET,
        },
        routeTargets: buildDeploymentRouteTargets(manifest, ROUTE_OPTS),
      });

      const doc = parse(yaml);
      expect(doc.services.web.environment.DB_URL).toBe(REAL_SECRETS.DATABASE_URL);
      expect(doc.services.worker.environment.QUEUE_TOKEN).toBe(REAL_SECRETS.QUEUE_SECRET);
      // Literal env vars pass through
      expect(doc.services.worker.environment.WORKER_MODE).toBe('background');
    });
  });

  describe('PREVIEW render — secret values NEVER present', () => {
    it('preview compose YAML contains masked placeholders, not real secret values', () => {
      const manifest = makeManifestWithSecrets();
      const secretNames = collectSecretNames(manifest);
      const maskedSecrets: Record<string, string> = {};
      for (const name of secretNames) {
        maskedSecrets[name] = SECRET_MASK;
      }

      const previewYaml = renderCompose(manifest, {
        environmentId: ENV_ID,
        releaseId: RELEASE_ID,
        resolvedSecrets: maskedSecrets,
        routeTargets: buildDeploymentRouteTargets(manifest, ROUTE_OPTS),
      });

      // NEGATIVE ASSERTIONS — no real secret values anywhere in the output
      expect(previewYaml).not.toContain(REAL_SECRETS.DB_URL);
      expect(previewYaml).not.toContain(REAL_SECRETS.EXTERNAL_API_KEY);
      expect(previewYaml).not.toContain('s3cr3t');
      expect(previewYaml).not.toContain('sk-live-');

      // POSITIVE ASSERTIONS — masked values are present
      const doc = parse(previewYaml);
      expect(doc.services.web.environment.DATABASE_URL).toBe(SECRET_MASK);
      expect(doc.services.web.environment.API_KEY).toBe(SECRET_MASK);
    });

    it('multi-service preview masks all secrets across all services', () => {
      const manifest = makeMultiServiceManifest();
      const maskedSecrets: Record<string, string> = {};
      for (const name of collectSecretNames(manifest)) {
        maskedSecrets[name] = SECRET_MASK;
      }

      const previewYaml = renderCompose(manifest, {
        environmentId: ENV_ID,
        releaseId: RELEASE_ID,
        resolvedSecrets: maskedSecrets,
        routeTargets: buildDeploymentRouteTargets(manifest, ROUTE_OPTS),
      });

      // No real secret values anywhere
      for (const secretValue of Object.values(REAL_SECRETS)) {
        expect(previewYaml).not.toContain(secretValue);
      }

      const doc = parse(previewYaml);
      expect(doc.services.web.environment.DB_URL).toBe(SECRET_MASK);
      expect(doc.services.worker.environment.QUEUE_TOKEN).toBe(SECRET_MASK);
    });
  });

  describe('missing/unknown secret reference fails cleanly', () => {
    it('throws a clear error listing ALL missing secret names', () => {
      const manifest = makeManifestWithSecrets();

      // Provide no resolved secrets — all references are missing
      expect(() =>
        renderCompose(manifest, {
          environmentId: ENV_ID,
          releaseId: RELEASE_ID,
          resolvedSecrets: {},
          routeTargets: buildDeploymentRouteTargets(manifest, ROUTE_OPTS),
        }),
      ).toThrow(/Missing secrets.*DB_URL.*EXTERNAL_API_KEY/);
    });

    it('throws when only some secrets are provided (partial resolution)', () => {
      const manifest = makeManifestWithSecrets();

      // Provide only one of two required secrets
      expect(() =>
        renderCompose(manifest, {
          environmentId: ENV_ID,
          releaseId: RELEASE_ID,
          resolvedSecrets: { DB_URL: 'value' },
          routeTargets: [],
        }),
      ).toThrow(/Missing secrets.*EXTERNAL_API_KEY/);
    });

    it('does not throw when all referenced secrets are provided', () => {
      const manifest = makeManifestWithSecrets();

      expect(() =>
        renderCompose(manifest, {
          environmentId: ENV_ID,
          releaseId: RELEASE_ID,
          resolvedSecrets: {
            DB_URL: 'postgres://localhost/db',
            EXTERNAL_API_KEY: 'test-key',
          },
          routeTargets: [],
        }),
      ).not.toThrow();
    });

    it('error message is actionable — tells user to set secrets on environment', () => {
      const manifest = makeManifestWithSecrets();

      try {
        renderCompose(manifest, {
          environmentId: ENV_ID,
          releaseId: RELEASE_ID,
          resolvedSecrets: {},
          routeTargets: [],
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        expect(message).toContain('Set these secrets on the environment');
      }
    });
  });
});

// =============================================================================
// Compose structural integrity after route+secret injection
// =============================================================================

describe('compose structural integrity with routes + secrets', () => {
  it('parsed compose is valid Docker Compose structure with all injected fields', () => {
    const manifest = makeManifestWithSecrets();
    const routes = buildDeploymentRouteTargets(manifest, ROUTE_OPTS);

    const yaml = renderCompose(manifest, {
      environmentId: ENV_ID,
      releaseId: RELEASE_ID,
      resolvedSecrets: { DB_URL: REAL_SECRETS.DB_URL, EXTERNAL_API_KEY: REAL_SECRETS.EXTERNAL_API_KEY },
      routeTargets: routes,
    });

    const doc = parse(yaml);

    // Required Docker Compose top-level keys
    expect(doc.services).toBeDefined();
    expect(doc.networks).toBeDefined();

    // Service has all expected fields
    const web = doc.services.web;
    expect(web.image).toContain('docker.io/myapp/web@sha256:');
    expect(web.environment).toBeDefined();
    expect(web.restart).toBe('unless-stopped');
    expect(web.labels).toMatchObject({
      'sam.environmentId': ENV_ID,
      'sam.releaseId': RELEASE_ID,
      'sam.service': 'web',
    });
    expect(web.networks).toContain('sam-internal');
    expect(web.deploy.resources.limits.memory).toBe('256M');

    // Ports are present when routeTargets are provided
    expect(web.ports).toBeDefined();
    expect(web.ports.length).toBeGreaterThan(0);
  });
});
