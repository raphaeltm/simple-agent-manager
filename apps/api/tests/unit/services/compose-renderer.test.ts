/**
 * Unit tests for the server-side Compose renderer.
 *
 * Tests use the yaml library to parse the output and assert on the
 * parsed structure (rule 02: Template Output Verification).
 */
import type { DeploymentManifest } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { type ComposeRenderContext,renderCompose } from '../../../src/services/compose-renderer';

// =============================================================================
// Helpers
// =============================================================================

function makeManifest(overrides?: Partial<DeploymentManifest>): DeploymentManifest {
  return {
    version: 1,
    services: {
      web: {
        image: {
          registry: 'docker.io',
          repository: 'myapp/web',
          digest: 'sha256:' + 'a'.repeat(64),
        },
        env: { NODE_ENV: 'production', PORT: '3000' },
        volumes: [{ name: 'data', mountPath: '/app/data' }],
        command: ['node', 'server.js'],
      },
    },
    volumes: { data: { sizeHintMb: 1024 } },
    routes: [{ service: 'web', port: 3000, mode: 'public' as const }],
    ...overrides,
  };
}

const CTX: ComposeRenderContext = {
  environmentId: 'env-001',
  releaseId: 'rel-001',
};

// =============================================================================
// Tests
// =============================================================================

describe('renderCompose', () => {
  it('produces valid YAML that can be parsed', () => {
    const yaml = renderCompose(makeManifest(), CTX);
    const doc = parse(yaml);
    expect(doc).toBeDefined();
    expect(doc.services).toBeDefined();
  });

  it('renders image as registry/repo@digest', () => {
    const doc = parse(renderCompose(makeManifest(), CTX));
    expect(doc.services.web.image).toBe(
      `docker.io/myapp/web@sha256:${'a'.repeat(64)}`,
    );
  });

  it('renders command array', () => {
    const doc = parse(renderCompose(makeManifest(), CTX));
    expect(doc.services.web.command).toEqual(['node', 'server.js']);
  });

  it('omits command when not specified', () => {
    const manifest = makeManifest();
    delete manifest.services.web!.command;
    const doc = parse(renderCompose(manifest, CTX));
    expect(doc.services.web.command).toBeUndefined();
  });

  it('renders environment variables as key-value map', () => {
    const doc = parse(renderCompose(makeManifest(), CTX));
    expect(doc.services.web.environment).toEqual({
      NODE_ENV: 'production',
      PORT: '3000',
    });
  });

  it('omits environment when env is empty', () => {
    const manifest = makeManifest();
    manifest.services.web!.env = {};
    const doc = parse(renderCompose(manifest, CTX));
    expect(doc.services.web.environment).toBeUndefined();
  });

  it('renders volume bind mounts under environment-specific volume root', () => {
    const doc = parse(renderCompose(makeManifest(), CTX));
    // Default derives from SAM_VOLUME_MOUNT_PATH_TEMPLATE: /mnt/sam-env-{environmentId}/volumes/{name}
    expect(doc.services.web.volumes).toEqual([
      '/mnt/sam-env-env-001/volumes/data:/app/data',
    ]);
  });

  it('uses custom volume root when provided', () => {
    const ctx: ComposeRenderContext = { ...CTX, volumeRoot: '/custom/volumes' };
    const doc = parse(renderCompose(makeManifest(), ctx));
    expect(doc.services.web.volumes).toEqual([
      '/custom/volumes/data:/app/data',
    ]);
  });

  it('omits volumes when service has none', () => {
    const manifest = makeManifest();
    manifest.services.web!.volumes = [];
    const doc = parse(renderCompose(manifest, CTX));
    expect(doc.services.web.volumes).toBeUndefined();
  });

  it('applies default memory limit when resources omitted', () => {
    const manifest = makeManifest();
    delete manifest.services.web!.resources;
    const doc = parse(renderCompose(manifest, CTX));
    expect(doc.services.web.deploy.resources.limits.memory).toBe('256M');
  });

  it('uses custom default memory limit', () => {
    const manifest = makeManifest();
    delete manifest.services.web!.resources;
    const ctx: ComposeRenderContext = { ...CTX, defaultMemoryLimitMb: 512 };
    const doc = parse(renderCompose(manifest, ctx));
    expect(doc.services.web.deploy.resources.limits.memory).toBe('512M');
  });

  it('uses manifest-specified memory and cpu limits', () => {
    const manifest = makeManifest();
    manifest.services.web!.resources = { memoryLimitMb: 1024, cpuLimit: 2.5 };
    const doc = parse(renderCompose(manifest, CTX));
    expect(doc.services.web.deploy.resources.limits.memory).toBe('1024M');
    expect(doc.services.web.deploy.resources.limits.cpus).toBe('2.5');
  });

  it('omits cpus when cpuLimit not specified', () => {
    const manifest = makeManifest();
    delete manifest.services.web!.resources;
    const doc = parse(renderCompose(manifest, CTX));
    expect(doc.services.web.deploy.resources.limits.cpus).toBeUndefined();
  });

  it('sets restart policy to unless-stopped', () => {
    const doc = parse(renderCompose(makeManifest(), CTX));
    expect(doc.services.web.restart).toBe('unless-stopped');
  });

  it('sets sam labels with environment, release, and service name', () => {
    const doc = parse(renderCompose(makeManifest(), CTX));
    expect(doc.services.web.labels).toEqual({
      'sam.environmentId': 'env-001',
      'sam.releaseId': 'rel-001',
      'sam.service': 'web',
    });
  });

  it('attaches service to sam-internal network', () => {
    const doc = parse(renderCompose(makeManifest(), CTX));
    expect(doc.services.web.networks).toEqual(['sam-internal']);
  });

  it('declares sam-internal network as a non-internal bridge', () => {
    // Regression: an `internal: true` network drops Docker's host->container
    // forwarding for published ports, so node-local Caddy reverse-proxying to
    // `127.0.0.1:<hostPort>` returns 502 even when the container is healthy.
    // Public routes require host ingress, which an internal network forbids.
    const doc = parse(renderCompose(makeManifest(), CTX));
    expect(doc.networks['sam-internal']).toEqual({
      driver: 'bridge',
    });
    expect(doc.networks['sam-internal'].internal).toBeUndefined();
  });

  it('renders multiple services with distinct labels', () => {
    const manifest = makeManifest({
      services: {
        web: {
          image: { registry: 'docker.io', repository: 'app/web', digest: 'sha256:' + 'a'.repeat(64) },
          env: {},
          volumes: [],
        },
        worker: {
          image: { registry: 'docker.io', repository: 'app/worker', digest: 'sha256:' + 'b'.repeat(64) },
          env: { QUEUE: 'jobs' },
          volumes: [],
        },
      },
    });
    const doc = parse(renderCompose(manifest, CTX));
    expect(Object.keys(doc.services)).toHaveLength(2);
    expect(doc.services.web.labels['sam.service']).toBe('web');
    expect(doc.services.worker.labels['sam.service']).toBe('worker');
    expect(doc.services.worker.environment).toEqual({ QUEUE: 'jobs' });
    // Both share the same network
    expect(doc.services.web.networks).toEqual(['sam-internal']);
    expect(doc.services.worker.networks).toEqual(['sam-internal']);
  });

  it('ignores healthCheck field (deferred to future slice)', () => {
    const manifest = makeManifest();
    // Cast to add healthCheck which the renderer intentionally ignores
    (manifest.services.web as Record<string, unknown>).healthCheck = {
      path: '/health',
      port: 3000,
      expectedStatus: 200,
    };
    const doc = parse(renderCompose(manifest, CTX));
    expect(doc.services.web.healthcheck).toBeUndefined();
    expect(doc.services.web.health_check).toBeUndefined();
  });

  it('round-trips environment values with special characters', () => {
    const manifest = makeManifest();
    manifest.services.web!.env = {
      DB_URL: 'postgres://user:p@ss=w0rd@host:5432/db?sslmode=require',
      MULTILINE: 'line1\nline2\nline3',
    };
    const doc = parse(renderCompose(manifest, CTX));
    expect(doc.services.web.environment.DB_URL).toBe(
      'postgres://user:p@ss=w0rd@host:5432/db?sslmode=require',
    );
    expect(doc.services.web.environment.MULTILINE).toBe('line1\nline2\nline3');
  });

  it('publishes public route targets to loopback for host-level Caddy', () => {
    const doc = parse(renderCompose(makeManifest(), {
      ...CTX,
      routeTargets: [
        { service: 'web', containerPort: 3000, hostPort: 35000 },
        { service: 'web', containerPort: 3001, hostPort: 35001 },
      ],
    }));

    expect(doc.services.web.ports).toEqual([
      '127.0.0.1:35000:3000',
      '127.0.0.1:35001:3001',
    ]);
  });
});
