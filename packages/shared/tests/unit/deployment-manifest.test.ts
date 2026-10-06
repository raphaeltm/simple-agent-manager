import { describe, expect, it } from 'vitest';

import type { ManifestError } from '../../src/deployment-manifest';
import { validateManifest } from '../../src/deployment-manifest';

// =============================================================================
// Helpers
// =============================================================================

/** A minimal valid manifest for use as a base in tests. */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    services: {
      web: {
        image: {
          registry: 'registry.cloudflare.com',
          repository: 'proj-123/web',
          digest: 'sha256:' + 'a'.repeat(64),
        },
        env: { PORT: '8080' },
        volumes: [{ name: 'appdata', mountPath: '/data' }],
      },
    },
    volumes: { appdata: { sizeHintMb: 1024 } },
    routes: [{ service: 'web', port: 8080, mode: 'public' }],
    ...overrides,
  };
}

/** A valid digest-pinned image reference for test services. */
function validImage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registry: 'r.io',
    repository: 'app',
    digest: 'sha256:' + 'a'.repeat(64),
    ...overrides,
  };
}

/**
 * A full manifest whose single "web" service is merged with the given fields.
 * Use `manifestOverrides` to replace top-level fields (volumes, routes, ...).
 */
function webServiceManifest(
  service: Record<string, unknown>,
  manifestOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return validManifest({
    services: { web: { image: validImage(), volumes: [], ...service } },
    ...manifestOverrides,
  });
}

function expectErrors(input: unknown): ManifestError[] {
  const result = validateManifest(input);
  expect(result.success).toBe(false);
  if (!result.success) return result.errors;
  return [];
}

function expectSuccess(input: unknown) {
  const result = validateManifest(input);
  if (!result.success) {
    throw new Error(`Expected success but got errors:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }
  return result.manifest;
}

// =============================================================================
// Valid manifests
// =============================================================================

describe('valid manifests', () => {
  it('accepts a minimal valid manifest', () => {
    const manifest = expectSuccess(validManifest());
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.services)).toEqual(['web']);
    expect(manifest.routes).toHaveLength(1);
  });

  it('accepts a manifest with multiple services', () => {
    const manifest = expectSuccess(
      validManifest({
        services: {
          web: {
            image: { registry: 'r.io', repository: 'app/web', digest: 'sha256:' + 'a'.repeat(64) },
            env: {},
            volumes: [],
          },
          worker: {
            image: { registry: 'r.io', repository: 'app/worker', digest: 'sha256:' + 'b'.repeat(64) },
            env: { QUEUE: 'default' },
            volumes: [{ name: 'scratch', mountPath: '/var/work' }],
          },
        },
        volumes: { scratch: {} },
        routes: [
          { service: 'web', port: 3000, mode: 'public' },
          { service: 'worker', port: 9090, mode: 'private' },
        ],
      }),
    );
    expect(Object.keys(manifest.services)).toHaveLength(2);
  });

  it('accepts a manifest with optional fields (resources, healthCheck, hooks, command)', () => {
    const manifest = expectSuccess(
      validManifest({
        services: {
          web: {
            image: { registry: 'r.io', repository: 'app/web', digest: 'sha256:' + 'c'.repeat(64) },
            command: ['node', 'server.js'],
            env: { PORT: '3000', DB_URL: { secret: 'db-url' } },
            volumes: [],
            resources: { memoryLimitMb: 512, cpuLimit: 0.5 },
            healthCheck: { path: '/healthz', port: 3000, expectedStatus: 200 },
          },
        },
        volumes: {},
        routes: [{ service: 'web', port: 3000, mode: 'public' }],
        hooks: {
          preFlight: { service: 'web', command: ['./migrate'], timeoutSeconds: 300 },
        },
      }),
    );
    expect(manifest.services.web.command).toEqual(['node', 'server.js']);
    expect(manifest.services.web.resources?.memoryLimitMb).toBe(512);
    expect(manifest.services.web.healthCheck?.path).toBe('/healthz');
    expect(manifest.hooks?.preFlight?.timeoutSeconds).toBe(300);
  });

  it('accepts a manifest with secret env references', () => {
    const manifest = expectSuccess(
      validManifest({
        services: {
          web: {
            image: { registry: 'r.io', repository: 'app', digest: 'sha256:' + 'd'.repeat(64) },
            env: {
              PUBLIC_VAR: 'hello',
              SECRET_VAR: { secret: 'my-secret-key' },
              ANOTHER: { secret: 'with_underscores-and-hyphens' },
            },
            volumes: [],
          },
        },
        volumes: {},
        routes: [{ service: 'web', port: 80, mode: 'public' }],
      }),
    );
    expect(manifest.services.web.env['SECRET_VAR']).toEqual({ secret: 'my-secret-key' });
  });

  it('defaults volumes and env to empty when omitted', () => {
    const manifest = expectSuccess({
      version: 1,
      services: {
        web: {
          image: { registry: 'r.io', repository: 'app', digest: 'sha256:' + 'e'.repeat(64) },
        },
      },
      routes: [{ service: 'web', port: 80, mode: 'public' }],
    });
    expect(manifest.volumes).toEqual({});
    expect(manifest.services.web.env).toEqual({});
    expect(manifest.services.web.volumes).toEqual([]);
  });
});

// =============================================================================
// Image digest enforcement
// =============================================================================

describe('image digest enforcement', () => {
  it('rejects a mutable tag instead of a digest', () => {
    const errors = expectErrors(webServiceManifest({ image: validImage({ digest: 'latest' }) }));
    expect(errors.some((e) => e.message.includes('sha256') && e.message.includes('Mutable tags'))).toBe(true);
  });

  it('rejects a digest with wrong prefix', () => {
    const errors = expectErrors(
      webServiceManifest({ image: validImage({ digest: 'md5:' + 'a'.repeat(64) }) }),
    );
    expect(errors.some((e) => e.message.includes('sha256'))).toBe(true);
  });

  it('rejects a digest with too few hex characters', () => {
    const errors = expectErrors(webServiceManifest({ image: validImage({ digest: 'sha256:abcd' }) }));
    expect(errors.some((e) => e.message.includes('sha256'))).toBe(true);
  });

  it('rejects a digest with uppercase hex', () => {
    const errors = expectErrors(
      webServiceManifest({ image: validImage({ digest: 'sha256:' + 'A'.repeat(64) }) }),
    );
    expect(errors.some((e) => e.message.includes('sha256'))).toBe(true);
  });

  it('rejects a tag-style reference (no digest at all)', () => {
    const errors = expectErrors(webServiceManifest({ image: validImage({ digest: 'v1.2.3' }) }));
    expect(errors.some((e) => e.message.includes('sha256'))).toBe(true);
  });

  it('rejects empty registry', () => {
    const errors = expectErrors(webServiceManifest({ image: validImage({ registry: '' }) }));
    expect(errors.some((e) => e.message.includes('Registry'))).toBe(true);
  });

  it('rejects empty repository', () => {
    const errors = expectErrors(webServiceManifest({ image: validImage({ repository: '' }) }));
    expect(errors.some((e) => e.message.includes('Repository'))).toBe(true);
  });
});

// =============================================================================
// Secret reference enforcement
// =============================================================================

describe('secret references', () => {
  it('rejects inline secret values (object without "secret" key)', () => {
    const errors = expectErrors(
      webServiceManifest({ env: { DB_URL: { value: 'postgres://user:pass@host/db' } } }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects secret names with invalid characters', () => {
    const errors = expectErrors(webServiceManifest({ env: { KEY: { secret: 'has spaces' } } }));
    expect(errors.some((e) => e.message.includes('Secret name'))).toBe(true);
  });

  it('rejects empty secret name', () => {
    const errors = expectErrors(webServiceManifest({ env: { KEY: { secret: '' } } }));
    expect(errors.some((e) => e.message.includes('Secret name'))).toBe(true);
  });

  it('rejects secret ref with extra fields (strict)', () => {
    const errors = expectErrors(
      webServiceManifest({ env: { KEY: { secret: 'name', extra: 'field' } } }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Volume enforcement
// =============================================================================

describe('volume enforcement', () => {
  it('rejects host path bind mounts (string-style volume)', () => {
    const errors = expectErrors(
      webServiceManifest(
        { volumes: [{ name: '/host/path', mountPath: '/data' }] },
        { volumes: {} },
      ),
    );
    // /host/path won't match the volume name regex
    expect(errors.some((e) => e.message.includes('Volume name'))).toBe(true);
  });

  it('rejects volumes with invalid names', () => {
    const errors = expectErrors(
      webServiceManifest({ volumes: [{ name: 'Has_Uppercase', mountPath: '/data' }] }),
    );
    expect(errors.some((e) => e.message.includes('Volume name'))).toBe(true);
  });

  it('rejects service volume referencing undeclared volume', () => {
    const errors = expectErrors(
      webServiceManifest(
        { volumes: [{ name: 'missing-vol', mountPath: '/data' }] },
        { volumes: {} },
      ),
    );
    expect(errors.some((e) => e.path.includes('volumes') && e.message.includes('missing-vol'))).toBe(true);
  });

  it('rejects empty mount path', () => {
    const errors = expectErrors(
      webServiceManifest(
        { volumes: [{ name: 'data', mountPath: '' }] },
        { volumes: { data: {} } },
      ),
    );
    expect(errors.some((e) => e.message.includes('Mount path'))).toBe(true);
  });
});

// =============================================================================
// Route cross-reference validation
// =============================================================================

describe('route cross-references', () => {
  it('rejects routes referencing non-existent services', () => {
    const errors = expectErrors(
      validManifest({
        routes: [{ service: 'nonexistent', port: 80, mode: 'public' }],
      }),
    );
    expect(errors.some((e) => e.path.includes('routes') && e.message.includes('nonexistent'))).toBe(true);
  });

  it('rejects empty routes array', () => {
    const errors = expectErrors(
      validManifest({
        routes: [],
      }),
    );
    expect(errors.some((e) => e.message.includes('At least one route'))).toBe(true);
  });

  it('rejects invalid port in route', () => {
    const errors = expectErrors(
      validManifest({
        routes: [{ service: 'web', port: 0, mode: 'public' }],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid route mode', () => {
    const errors = expectErrors(
      validManifest({
        routes: [{ service: 'web', port: 80, mode: 'external' }],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Hook cross-reference validation
// =============================================================================

describe('hook cross-references', () => {
  it('rejects hook referencing non-existent service', () => {
    const errors = expectErrors(
      validManifest({
        hooks: { preFlight: { service: 'migrator', command: ['./run'], timeoutSeconds: 60 } },
      }),
    );
    expect(errors.some((e) => e.path.includes('hooks') && e.message.includes('migrator'))).toBe(true);
  });

  it('rejects hook with empty command', () => {
    const errors = expectErrors(
      validManifest({
        hooks: { preFlight: { service: 'web', command: [], timeoutSeconds: 60 } },
      }),
    );
    expect(errors.some((e) => e.message.includes('at least one element'))).toBe(true);
  });

  it('rejects hook with timeout exceeding limit', () => {
    const errors = expectErrors(
      validManifest({
        hooks: { preFlight: { service: 'web', command: ['./migrate'], timeoutSeconds: 7200 } },
      }),
    );
    expect(errors.some((e) => e.message.includes('3600'))).toBe(true);
  });
});

// =============================================================================
// Dangerous Compose-isms (friendly error messages)
// =============================================================================

describe('dangerous Compose-isms', () => {
  it('rejects "build" at service level with friendly message', () => {
    const errors = expectErrors(webServiceManifest({ build: { context: '.' } }));
    expect(errors.some((e) => e.path === 'services.web.build' && e.message.includes('prebuilt'))).toBe(true);
  });

  it('rejects "privileged" at service level', () => {
    const errors = expectErrors(webServiceManifest({ privileged: true }));
    expect(errors.some((e) => e.path === 'services.web.privileged' && e.message.includes('not allowed'))).toBe(true);
  });

  it('rejects "network_mode" at service level', () => {
    const errors = expectErrors(webServiceManifest({ network_mode: 'host' }));
    expect(errors.some((e) => e.path === 'services.web.network_mode')).toBe(true);
  });

  it('rejects "ports" at service level', () => {
    const errors = expectErrors(webServiceManifest({ ports: ['8080:80'] }));
    expect(errors.some((e) => e.path === 'services.web.ports' && e.message.includes('routes'))).toBe(true);
  });

  it('rejects "devices" at service level', () => {
    const errors = expectErrors(webServiceManifest({ devices: ['/dev/sda:/dev/xvdc:rwm'] }));
    expect(errors.some((e) => e.path === 'services.web.devices')).toBe(true);
  });

  it('rejects "cap_add" at service level', () => {
    const errors = expectErrors(webServiceManifest({ cap_add: ['SYS_ADMIN'] }));
    expect(errors.some((e) => e.path === 'services.web.cap_add')).toBe(true);
  });

  it('rejects "env_file" at service level', () => {
    const errors = expectErrors(webServiceManifest({ env_file: ['.env'] }));
    expect(errors.some((e) => e.path === 'services.web.env_file' && e.message.includes('secret'))).toBe(true);
  });

  it('rejects multiple dangerous fields and reports all', () => {
    const errors = expectErrors(
      webServiceManifest({ privileged: true, cap_add: ['NET_ADMIN'], network_mode: 'host' }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(3);
    const paths = errors.map((e) => e.path);
    expect(paths).toContain('services.web.privileged');
    expect(paths).toContain('services.web.cap_add');
    expect(paths).toContain('services.web.network_mode');
  });
});

// =============================================================================
// Unknown/extra fields (strict mode)
// =============================================================================

describe('unknown field rejection (strict)', () => {
  it('rejects unknown top-level fields', () => {
    const errors = expectErrors(
      validManifest({ networks: { custom: {} } }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown service-level fields (not in dangerous list)', () => {
    const errors = expectErrors(webServiceManifest({ restart: 'always' }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown image fields', () => {
    const errors = expectErrors(webServiceManifest({ image: validImage({ tag: 'latest' }) }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown route fields', () => {
    const errors = expectErrors(
      validManifest({
        routes: [{ service: 'web', port: 80, mode: 'public', tls: true }],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Empty / malformed manifests
// =============================================================================

describe('empty and malformed manifests', () => {
  it('rejects null input', () => {
    const result = validateManifest(null);
    expect(result.success).toBe(false);
  });

  it('rejects undefined input', () => {
    const result = validateManifest(undefined);
    expect(result.success).toBe(false);
  });

  it('rejects empty object', () => {
    const errors = expectErrors({});
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects array input', () => {
    const result = validateManifest([]);
    expect(result.success).toBe(false);
  });

  it('rejects string input', () => {
    const result = validateManifest('not a manifest');
    expect(result.success).toBe(false);
  });

  it('rejects manifest with no services', () => {
    const errors = expectErrors({ version: 1, services: {}, routes: [{ service: 'x', port: 80, mode: 'public' }] });
    expect(errors.some((e) => e.message.includes('At least one service'))).toBe(true);
  });

  it('rejects wrong version number', () => {
    const errors = expectErrors(
      validManifest({ version: 2 }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects version as string', () => {
    const errors = expectErrors(
      validManifest({ version: '1' }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Service name validation
// =============================================================================

describe('service name validation', () => {
  it('rejects service names with uppercase', () => {
    const errors = expectErrors({
      version: 1,
      services: { WebApp: { image: validImage() } },
      routes: [{ service: 'WebApp', port: 80, mode: 'public' }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects service names starting with hyphen', () => {
    const errors = expectErrors({
      version: 1,
      services: { '-web': { image: validImage() } },
      routes: [{ service: '-web', port: 80, mode: 'public' }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts service names with hyphens', () => {
    expectSuccess({
      version: 1,
      services: { 'my-web-app': { image: validImage() } },
      routes: [{ service: 'my-web-app', port: 80, mode: 'public' }],
    });
  });
});

// =============================================================================
// Resource limits validation
// =============================================================================

describe('resource limits', () => {
  it('rejects zero memory limit', () => {
    const errors = expectErrors(webServiceManifest({ resources: { memoryLimitMb: 0, cpuLimit: 1 } }));
    expect(errors.some((e) => e.message.includes('positive'))).toBe(true);
  });

  it('rejects negative cpu limit', () => {
    const errors = expectErrors(
      webServiceManifest({ resources: { memoryLimitMb: 512, cpuLimit: -1 } }),
    );
    expect(errors.some((e) => e.message.includes('positive'))).toBe(true);
  });

  it('rejects fractional memory limit', () => {
    const errors = expectErrors(
      webServiceManifest({ resources: { memoryLimitMb: 512.5, cpuLimit: 1 } }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Health check validation
// =============================================================================

describe('health check', () => {
  it('rejects invalid port', () => {
    const errors = expectErrors(
      webServiceManifest({ healthCheck: { path: '/health', port: 70000, expectedStatus: 200 } }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid HTTP status code', () => {
    const errors = expectErrors(
      webServiceManifest({ healthCheck: { path: '/health', port: 8080, expectedStatus: 999 } }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Error format quality
// =============================================================================

describe('error format', () => {
  it('includes path and message in every error', () => {
    const errors = expectErrors({});
    for (const error of errors) {
      expect(error).toHaveProperty('path');
      expect(error).toHaveProperty('message');
      expect(typeof error.path).toBe('string');
      expect(typeof error.message).toBe('string');
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it('provides path context for nested errors', () => {
    const errors = expectErrors(webServiceManifest({ image: validImage({ digest: 'bad' }) }));
    const digestError = errors.find((e) => e.message.includes('sha256'));
    expect(digestError).toBeDefined();
    expect(digestError!.path).toContain('services');
    expect(digestError!.path).toContain('digest');
  });
});

// =============================================================================
// Type inference smoke test
// =============================================================================

describe('type inference', () => {
  it('returns typed manifest on success', () => {
    const result = validateManifest(validManifest());
    if (result.success) {
      // These are compile-time checks: if types are wrong, tsc fails
      const _version: 1 = result.manifest.version;
      const _services: Record<string, unknown> = result.manifest.services;
      const _routes: Array<{ service: string; port: number; mode: 'public' | 'private' }> = result.manifest.routes;
      // Suppress unused variable warnings
      void _version;
      void _services;
      void _routes;
    }
  });
});
