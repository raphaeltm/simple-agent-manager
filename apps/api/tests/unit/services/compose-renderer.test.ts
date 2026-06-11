/**
 * Unit tests for the server-side Compose renderer.
 *
 * Tests use the yaml library to parse the output and assert on the
 * parsed structure (rule 02: Template Output Verification).
 */
import type { DeploymentManifest } from '@simple-agent-manager/shared';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { renderCompose, type ComposeRenderContext } from '../../../src/services/compose-renderer';

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

  it('renders volume bind mounts under default volume root', () => {
    const doc = parse(renderCompose(makeManifest(), CTX));
    expect(doc.services.web.volumes).toEqual([
      '/mnt/data/volumes/data:/app/data',
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

  it('declares sam-internal network as bridge + internal', () => {
    const doc = parse(renderCompose(makeManifest(), CTX));
    expect(doc.networks['sam-internal']).toEqual({
      driver: 'bridge',
      internal: true,
    });
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
});
