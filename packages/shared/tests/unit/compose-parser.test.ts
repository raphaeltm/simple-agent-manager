import { describe, expect, it, vi } from 'vitest';

import type { ImageResolver } from '../../src/compose-parser';
import { DENIED_SERVICE_FIELDS, DENIED_TOP_LEVEL_FIELDS, isDigestReference, parseCompose, resolveManifest } from '../../src/compose-parser';

// =============================================================================
// Helpers
// =============================================================================

function expectSuccess(yaml: string) {
  const result = parseCompose(yaml);
  if (!result.success) {
    throw new Error(`Expected success but got errors:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }
  return result.manifest;
}

function expectErrors(yaml: string) {
  const result = parseCompose(yaml);
  if (result.success) {
    throw new Error(`Expected errors but got success with manifest:\n${JSON.stringify(result.manifest, null, 2)}`);
  }
  return result.errors;
}

function expectErrorAt(yaml: string, path: string) {
  const errors = expectErrors(yaml);
  const matching = errors.filter((e) => e.path === path || e.path.startsWith(path));
  expect(matching.length).toBeGreaterThan(0);
  return matching;
}

/** Typical web-app compose fixture — the acceptance criterion fixture. */
const TYPICAL_WEB_APP = `
services:
  web:
    image: ghcr.io/myorg/myapp:v1.2.3
    environment:
      NODE_ENV: production
      DATABASE_URL:
        x-sam-secret: db-url
    volumes:
      - data:/app/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  data:

x-sam-routes:
  - service: web
    port: 3000
    mode: public
`;

const FAKE_DIGEST = 'sha256:' + 'a'.repeat(64);

const mockResolver: ImageResolver = vi.fn().mockResolvedValue(FAKE_DIGEST);

// =============================================================================
// Acceptance: typical web-app compose.yaml
// =============================================================================

describe('Acceptance: typical web-app compose.yaml', () => {
  it('parses successfully with only x-sam-routes added', () => {
    const manifest = expectSuccess(TYPICAL_WEB_APP);

    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.services)).toEqual(['web']);

    const web = manifest.services['web']!;
    expect(web.image).toEqual({
      registry: 'ghcr.io',
      repository: 'myorg/myapp',
      reference: 'v1.2.3',
    });
    expect(web.env).toEqual({
      NODE_ENV: 'production',
      DATABASE_URL: { secret: 'db-url' },
    });
    expect(web.volumes).toEqual([{ name: 'data', mountPath: '/app/data' }]);
    expect(web.healthCheck).toEqual({ path: '/health', port: 3000, expectedStatus: 200 });

    expect(manifest.volumes).toEqual({ data: {} });
    expect(manifest.routes).toEqual([{ service: 'web', port: 3000, mode: 'public' }]);
  });

  it('resolves to a valid DeploymentManifest', async () => {
    const parsed = parseCompose(TYPICAL_WEB_APP);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const resolved = await resolveManifest(parsed.manifest, mockResolver);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;

    const m = resolved.manifest;
    expect(m.version).toBe(1);
    expect(m.services['web']!.image.digest).toBe(FAKE_DIGEST);
    expect(m.routes[0]!.service).toBe('web');
    expect(m.routes[0]!.mode).toBe('public');
  });
});

// =============================================================================
// YAML parsing errors
// =============================================================================

describe('YAML parsing', () => {
  it('rejects invalid YAML', () => {
    const errors = expectErrors('}{not yaml');
    expect(errors[0]!.path).toBe('(root)');
    expect(errors[0]!.message).toContain('Invalid YAML');
  });

  it('rejects non-object root', () => {
    const errors = expectErrors('- a list');
    expect(errors[0]!.message).toContain('mapping');
  });

  it('rejects scalar root', () => {
    const errors = expectErrors('"just a string"');
    expect(errors[0]!.message).toContain('mapping');
  });
});

// =============================================================================
// Top-level field validation
// =============================================================================

describe('Top-level field validation', () => {
  it('rejects unknown top-level fields', () => {
    const errors = expectErrors(`
services:
  web:
    image: nginx
something_random: true
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(errors.some((e) => e.path === 'something_random')).toBe(true);
  });

  it('silently ignores "name" and "version" fields', () => {
    const manifest = expectSuccess(`
name: my-app
version: "3.8"
services:
  web:
    image: nginx
volumes: {}
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']).toBeDefined();
  });

  it('allows unknown x- extensions (Compose-spec-valid)', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
x-custom-thing: true
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest).toBeDefined();
  });

  for (const [field, message] of Object.entries(DENIED_TOP_LEVEL_FIELDS)) {
    it(`rejects denied top-level field "${field}" with explicit error`, () => {
      const errors = expectErrors(`
services:
  web:
    image: nginx
${field}:
  foo: bar
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
      const match = errors.find((e) => e.path === field);
      expect(match).toBeDefined();
      expect(match!.message).toBe(message);
    });
  }
});

// =============================================================================
// Denylist: every service-level denied field
// =============================================================================

describe('Service-level denylist', () => {
  for (const [field, message] of Object.entries(DENIED_SERVICE_FIELDS)) {
    it(`rejects "${field}" with explicit error`, () => {
      // Some fields need a non-empty value to parse as YAML correctly
      const value = field === 'build' ? '"."' : 'true';
      const errors = expectErrors(`
services:
  web:
    image: nginx
    ${field}: ${value}
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
      const match = errors.find((e) => e.path === `services.web.${field}`);
      expect(match).toBeDefined();
      expect(match!.message).toBe(message);
    });
  }
});

// =============================================================================
// Unknown field rejection (default-deny)
// =============================================================================

describe('Unknown field rejection (default-deny)', () => {
  it('rejects unknown service fields', () => {
    const errors = expectErrors(`
services:
  web:
    image: nginx
    unknown_field: true
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(errors.some((e) => e.path === 'services.web.unknown_field')).toBe(true);
  });

  it('allows x-* extensions on services (Compose-spec-valid)', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    x-custom-label: foo
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']).toBeDefined();
  });
});

// =============================================================================
// Image parsing
// =============================================================================

describe('Image parsing', () => {
  it('parses full registry/repo:tag', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: ghcr.io/org/app:v1.0
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.image).toEqual({
      registry: 'ghcr.io',
      repository: 'org/app',
      reference: 'v1.0',
    });
  });

  it('parses image with digest', () => {
    const digest = 'sha256:' + 'b'.repeat(64);
    const manifest = expectSuccess(`
services:
  web:
    image: ghcr.io/org/app@${digest}
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.image.reference).toBe(digest);
  });

  it('defaults bare image name to docker.io/library/', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.image).toEqual({
      registry: 'docker.io',
      repository: 'library/nginx',
      reference: 'latest',
    });
  });

  it('defaults docker.io namespace for org/repo format', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: myorg/myapp:v2
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.image).toEqual({
      registry: 'docker.io',
      repository: 'myorg/myapp',
      reference: 'v2',
    });
  });

  it('rejects missing image field', () => {
    expectErrorAt(`
services:
  web:
    environment:
      FOO: bar
x-sam-routes:
  - service: web
    port: 80
    mode: public
`, 'services.web.image');
  });
});

// =============================================================================
// isDigestReference
// =============================================================================

describe('isDigestReference', () => {
  it('returns true for a valid sha256 digest', () => {
    expect(isDigestReference('sha256:' + 'a'.repeat(64))).toBe(true);
  });
  it('returns false for a tag', () => {
    expect(isDigestReference('latest')).toBe(false);
    expect(isDigestReference('v1.2.3')).toBe(false);
  });
});

// =============================================================================
// Command/entrypoint handling
// =============================================================================

describe('Command and entrypoint', () => {
  it('parses command as array', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    command: ["node", "server.js"]
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.command).toEqual(['node', 'server.js']);
  });

  it('parses command as shell-form string', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    command: node server.js
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.command).toEqual(['node', 'server.js']);
  });

  it('entrypoint takes precedence over command', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    entrypoint: ["/entrypoint.sh"]
    command: ["serve"]
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.command).toEqual(['/entrypoint.sh']);
  });
});

// =============================================================================
// Environment and secret references
// =============================================================================

describe('Environment parsing', () => {
  it('handles mapping format', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    environment:
      FOO: bar
      COUNT: 42
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.env).toEqual({ FOO: 'bar', COUNT: '42' });
  });

  it('handles list format (KEY=VALUE)', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    environment:
      - FOO=bar
      - EMPTY=
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.env['FOO']).toBe('bar');
    expect(manifest.services['web']!.env['EMPTY']).toBe('');
  });

  it('extracts x-sam-secret references', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    environment:
      DB_URL:
        x-sam-secret: database-url
      API_KEY:
        x-sam-secret: my-api-key
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.env).toEqual({
      DB_URL: { secret: 'database-url' },
      API_KEY: { secret: 'my-api-key' },
    });
  });

  it('skips null environment values (inherit from host)', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    environment:
      INHERIT_ME:
      NORMAL: value
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.env).toEqual({ NORMAL: 'value' });
  });
});

// =============================================================================
// Named vs bind volume discrimination
// =============================================================================

describe('Volume parsing', () => {
  it('accepts named volumes in short syntax', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    volumes:
      - mydata:/app/data
volumes:
  mydata:
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.volumes).toEqual([{ name: 'mydata', mountPath: '/app/data' }]);
  });

  it('accepts named volumes in long syntax', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    volumes:
      - type: volume
        source: mydata
        target: /app/data
volumes:
  mydata:
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.volumes).toEqual([{ name: 'mydata', mountPath: '/app/data' }]);
  });

  it('rejects bind mounts (short syntax)', () => {
    expectErrorAt(`
services:
  web:
    image: nginx
    volumes:
      - ./src:/app/src
x-sam-routes:
  - service: web
    port: 80
    mode: public
`, 'services.web.volumes[0]');
  });

  it('rejects bind mounts (long syntax)', () => {
    expectErrorAt(`
services:
  web:
    image: nginx
    volumes:
      - type: bind
        source: ./src
        target: /app/src
x-sam-routes:
  - service: web
    port: 80
    mode: public
`, 'services.web.volumes[0]');
  });

  it('rejects Docker socket mounts', () => {
    expectErrorAt(`
services:
  web:
    image: nginx
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
x-sam-routes:
  - service: web
    port: 80
    mode: public
`, 'services.web.volumes[0]');
  });

  it('rejects external volumes', () => {
    expectErrorAt(`
services:
  web:
    image: nginx
    volumes:
      - ext:/data
volumes:
  ext:
    external: true
x-sam-routes:
  - service: web
    port: 80
    mode: public
`, 'volumes.ext');
  });

  it('validates volume cross-references (undeclared volume)', () => {
    const errors = expectErrors(`
services:
  web:
    image: nginx
    volumes:
      - missing:/data
volumes: {}
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(errors.some((e) => e.message.includes('missing'))).toBe(true);
  });
});

// =============================================================================
// Ports/expose → route hints
// =============================================================================

describe('Ports/expose → route hints', () => {
  it('translates ports to public route hints', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    // Explicit x-sam-routes takes precedence; ports don't duplicate
    expect(manifest.routes).toEqual([{ service: 'web', port: 80, mode: 'public' }]);
  });

  it('translates expose to private route hints', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    expose:
      - "3000"
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.routes).toHaveLength(2);
    expect(manifest.routes).toContainEqual({ service: 'web', port: 3000, mode: 'private' });
  });

  it('extracts container port from host:container format', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    ports:
      - "9090:3000"
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.routes).toContainEqual({ service: 'web', port: 3000, mode: 'public' });
  });

  it('does not duplicate routes from ports when x-sam-routes covers the same port', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    ports:
      - "80:80"
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    const port80Routes = manifest.routes.filter((r) => r.port === 80);
    expect(port80Routes).toHaveLength(1);
  });

  it('handles long-syntax ports (object with target)', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    ports:
      - target: 8080
        published: 8080
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.routes).toContainEqual({ service: 'web', port: 8080, mode: 'public' });
  });
});

// =============================================================================
// x-sam-routes validation
// =============================================================================

describe('x-sam-routes', () => {
  it('requires at least one route', () => {
    const errors = expectErrors(`
services:
  web:
    image: nginx
`);
    expect(errors.some((e) => e.message.includes('route'))).toBe(true);
  });

  it('validates route service references', () => {
    const errors = expectErrors(`
services:
  web:
    image: nginx
x-sam-routes:
  - service: nonexistent
    port: 80
    mode: public
`);
    expect(errors.some((e) => e.message.includes('nonexistent'))).toBe(true);
  });

  it('validates route mode', () => {
    expectErrorAt(`
services:
  web:
    image: nginx
x-sam-routes:
  - service: web
    port: 80
    mode: invalid
`, 'x-sam-routes[0].mode');
  });

  it('validates route port', () => {
    expectErrorAt(`
services:
  web:
    image: nginx
x-sam-routes:
  - service: web
    port: 0
    mode: public
`, 'x-sam-routes[0].port');
  });
});

// =============================================================================
// Multi-service with depends_on
// =============================================================================

describe('Multi-service', () => {
  it('parses multiple services with depends_on (ordering only)', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: ghcr.io/org/web:latest
    depends_on:
      - db
    environment:
      DB_HOST: db
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: myapp

volumes: {}

x-sam-routes:
  - service: web
    port: 3000
    mode: public
`);
    expect(Object.keys(manifest.services)).toEqual(['web', 'db']);
    expect(manifest.services['web']!.env['DB_HOST']).toBe('db');
    expect(manifest.services['db']!.env['POSTGRES_DB']).toBe('myapp');
  });
});

// =============================================================================
// Healthcheck
// =============================================================================

describe('Healthcheck', () => {
  it('extracts HTTP health check from curl command', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/healthz"]
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.healthCheck).toEqual({
      path: '/healthz',
      port: 8080,
      expectedStatus: 200,
    });
  });

  it('extracts HTTP health check from x-sam-* extensions', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    healthcheck:
      test: ["CMD", "true"]
      x-sam-path: /ready
      x-sam-port: 3000
      x-sam-expected-status: 204
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.healthCheck).toEqual({
      path: '/ready',
      port: 3000,
      expectedStatus: 204,
    });
  });

  it('returns no healthCheck when test is not an HTTP check', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    healthcheck:
      test: ["CMD", "pg_isready"]
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.healthCheck).toBeUndefined();
  });
});

// =============================================================================
// Resource limits
// =============================================================================

describe('Resource limits', () => {
  it('extracts deploy.resources.limits', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    deploy:
      resources:
        limits:
          memory: 512m
          cpus: "0.5"
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.resources).toEqual({
      memoryLimitMb: 512,
      cpuLimit: 0.5,
    });
  });

  it('parses memory in gigabytes', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    deploy:
      resources:
        limits:
          memory: 2g
          cpus: "1"
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.resources!.memoryLimitMb).toBe(2048);
  });

  it('defaults cpuLimit when only memory is set', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    deploy:
      resources:
        limits:
          memory: 256m
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.resources).toEqual({
      memoryLimitMb: 256,
      cpuLimit: 1,
    });
  });

  it('rejects unsupported deploy sub-fields', () => {
    expectErrorAt(`
services:
  web:
    image: nginx
    deploy:
      replicas: 3
x-sam-routes:
  - service: web
    port: 80
    mode: public
`, 'services.web.deploy.replicas');
  });
});

// =============================================================================
// x-sam-pre-flight
// =============================================================================

describe('x-sam-pre-flight', () => {
  it('extracts pre-flight hook', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
  migrate:
    image: ghcr.io/org/app:v1

x-sam-routes:
  - service: web
    port: 80
    mode: public

x-sam-pre-flight:
  service: migrate
  command: ["npm", "run", "migrate"]
  timeoutSeconds: 120
`);
    expect(manifest.hooks).toEqual({
      preFlight: {
        service: 'migrate',
        command: ['npm', 'run', 'migrate'],
        timeoutSeconds: 120,
      },
    });
  });

  it('defaults timeoutSeconds to 300', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
x-sam-routes:
  - service: web
    port: 80
    mode: public
x-sam-pre-flight:
  service: web
  command: ["echo", "preflight"]
`);
    expect(manifest.hooks!.preFlight!.timeoutSeconds).toBe(300);
  });

  it('validates hook service reference', () => {
    const errors = expectErrors(`
services:
  web:
    image: nginx
x-sam-routes:
  - service: web
    port: 80
    mode: public
x-sam-pre-flight:
  service: nonexistent
  command: ["echo"]
`);
    expect(errors.some((e) => e.path === 'x-sam-pre-flight.service' && e.message.includes('nonexistent'))).toBe(true);
  });
});

// =============================================================================
// Tag→digest resolution round-trip
// =============================================================================

describe('Tag→digest resolution', () => {
  it('resolves tags to digests via injectable resolver', async () => {
    const parsed = parseCompose(`
services:
  web:
    image: ghcr.io/org/app:v1.0
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const resolved = await resolveManifest(parsed.manifest, mockResolver);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;

    expect(resolved.manifest.services['web']!.image.digest).toBe(FAKE_DIGEST);
    expect(mockResolver).toHaveBeenCalledWith('ghcr.io', 'org/app', 'v1.0');
  });

  it('passes through images that are already digest-pinned', async () => {
    const digest = 'sha256:' + 'c'.repeat(64);
    const parsed = parseCompose(`
services:
  web:
    image: ghcr.io/org/app@${digest}
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const skipResolver: ImageResolver = vi.fn();
    const resolved = await resolveManifest(parsed.manifest, skipResolver);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;

    expect(resolved.manifest.services['web']!.image.digest).toBe(digest);
    expect(skipResolver).not.toHaveBeenCalled();
  });

  it('returns errors when resolver fails', async () => {
    const parsed = parseCompose(`
services:
  web:
    image: ghcr.io/org/app:v1.0
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const failingResolver: ImageResolver = vi.fn().mockRejectedValue(new Error('Not found'));
    const resolved = await resolveManifest(parsed.manifest, failingResolver);
    expect(resolved.success).toBe(false);
    if (resolved.success) return;

    expect(resolved.errors[0]!.path).toBe('services.web.image');
    expect(resolved.errors[0]!.message).toContain('Not found');
  });

  it('returns errors when resolver returns invalid digest', async () => {
    const parsed = parseCompose(`
services:
  web:
    image: ghcr.io/org/app:v1.0
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const badResolver: ImageResolver = vi.fn().mockResolvedValue('not-a-digest');
    const resolved = await resolveManifest(parsed.manifest, badResolver);
    expect(resolved.success).toBe(false);
    if (resolved.success) return;

    expect(resolved.errors[0]!.message).toContain('invalid digest');
  });

  it('resolves multiple services', async () => {
    const parsed = parseCompose(`
services:
  web:
    image: ghcr.io/org/web:v1
  worker:
    image: ghcr.io/org/worker:v2
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const multiResolver: ImageResolver = vi.fn().mockImplementation(
      (_reg: string, _repo: string, tag: string) =>
        Promise.resolve('sha256:' + (tag === 'v1' ? 'a' : 'b').repeat(64)),
    );

    const resolved = await resolveManifest(parsed.manifest, multiResolver);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;

    expect(resolved.manifest.services['web']!.image.digest).toBe('sha256:' + 'a'.repeat(64));
    expect(resolved.manifest.services['worker']!.image.digest).toBe('sha256:' + 'b'.repeat(64));
  });
});

// =============================================================================
// Error format
// =============================================================================

describe('Error format', () => {
  it('errors match ManifestError conventions (path + message)', () => {
    const errors = expectErrors(`
services:
  web:
    image: nginx
    build: .
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    for (const error of errors) {
      expect(error).toHaveProperty('path');
      expect(error).toHaveProperty('message');
      expect(typeof error.path).toBe('string');
      expect(typeof error.message).toBe('string');
    }
  });
});

// =============================================================================
// container_name is silently ignored
// =============================================================================

describe('Silently ignored service fields', () => {
  it('container_name is accepted and ignored', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    container_name: my-web-container
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']).toBeDefined();
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('Edge cases', () => {
  it('requires at least one service', () => {
    const errors = expectErrors(`
services: {}
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(errors.some((e) => e.message.includes('At least one service'))).toBe(true);
  });

  it('handles empty environment gracefully', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.env).toEqual({});
  });

  it('handles service with no optional fields', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    const svc = manifest.services['web']!;
    expect(svc.command).toBeUndefined();
    expect(svc.resources).toBeUndefined();
    expect(svc.healthCheck).toBeUndefined();
    expect(svc.volumes).toEqual([]);
  });

  it('handles volume with x-sam-size-hint-mb', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    volumes:
      - data:/app/data
volumes:
  data:
    x-sam-size-hint-mb: 1024
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.volumes['data']).toEqual({ sizeHintMb: 1024 });
  });

  it('rejects custom volume drivers', () => {
    expectErrorAt(`
services:
  web:
    image: nginx
    volumes:
      - mydata:/data
volumes:
  mydata:
    driver: nfs
x-sam-routes:
  - service: web
    port: 80
    mode: public
`, 'volumes.mydata');
  });

  it('depends_on is accepted but not extracted (ordering is informational)', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    depends_on:
      - db
  db:
    image: postgres:16
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    // depends_on passes the allowlist but produces no output — by design,
    // the manifest schema has no ordering field. depends_on is accepted
    // so existing compose files work without removal.
    expect(manifest.services['web']).toBeDefined();
    expect(manifest.services['db']).toBeDefined();
  });

  it('defaults memoryLimitMb when only cpus is set', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    deploy:
      resources:
        limits:
          cpus: "2"
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.resources).toEqual({
      memoryLimitMb: 512,
      cpuLimit: 2,
    });
  });

  it('rejects pre-flight timeoutSeconds out of range', () => {
    expectErrorAt(`
services:
  web:
    image: nginx
x-sam-routes:
  - service: web
    port: 80
    mode: public
x-sam-pre-flight:
  service: web
  command: ["echo"]
  timeoutSeconds: 9999
`, 'x-sam-pre-flight.timeoutSeconds');
  });

  it('rejects tmpfs volume type in long syntax', () => {
    expectErrorAt(`
services:
  web:
    image: nginx
    volumes:
      - type: tmpfs
        target: /tmp/data
x-sam-routes:
  - service: web
    port: 80
    mode: public
`, 'services.web.volumes[0]');
  });

  it('handles numeric port spec in ports array', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    ports:
      - 8080
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.routes).toContainEqual({ service: 'web', port: 8080, mode: 'public' });
  });

  it('handles port with protocol suffix (80/tcp)', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    ports:
      - "80/tcp"
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    // Explicit x-sam-routes already covers port 80, so no duplicate
    const port80 = manifest.routes.filter((r) => r.port === 80);
    expect(port80).toHaveLength(1);
  });

  it('handles boolean environment values', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    environment:
      DEBUG: true
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    expect(manifest.services['web']!.env['DEBUG']).toBe('true');
  });

  it('handles environment list with key-only entries (host inherit)', () => {
    const manifest = expectSuccess(`
services:
  web:
    image: nginx
    environment:
      - PATH
      - FOO=bar
x-sam-routes:
  - service: web
    port: 80
    mode: public
`);
    // PATH without = is skipped (host-inherit), FOO=bar is kept
    expect(manifest.services['web']!.env).toEqual({ FOO: 'bar' });
  });
});
