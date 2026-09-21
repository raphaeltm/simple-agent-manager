import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEPLOYMENT_SERVICE_CPU_MILLIS,
  DEFAULT_DEPLOYMENT_SERVICE_DISK_MB,
  DEFAULT_DEPLOYMENT_SERVICE_MEMORY_MB,
  type DeploymentManifest,
  resolveDeploymentManifestReservation,
} from '../../src';

function manifest(
  services: DeploymentManifest['services'],
  volumes: DeploymentManifest['volumes'] = {}
): DeploymentManifest {
  return {
    version: 1,
    services,
    volumes,
    routes: [{ service: Object.keys(services)[0]!, port: 8080, mode: 'public' }],
  };
}

const image = {
  registry: 'registry.example.com',
  repository: 'app',
  digest: `sha256:${'a'.repeat(64)}`,
};

describe('resolveDeploymentManifestReservation', () => {
  it('sums explicit service limits without environment-name heuristics', () => {
    const reservation = resolveDeploymentManifestReservation(
      manifest({
        api: { image, env: {}, volumes: [], resources: { cpuLimit: 0.75, memoryLimitMb: 768 } },
        worker: {
          image,
          env: {},
          volumes: [],
          resources: { cpuLimit: 0.25, memoryLimitMb: 256 },
        },
      }),
      'production'
    );

    expect(reservation).toMatchObject({
      cpuMillis: 1_000,
      memoryMb: 1_024,
      diskMb: DEFAULT_DEPLOYMENT_SERVICE_DISK_MB * 2,
      exclusiveNode: false,
      sourceId: 'production',
    });
    expect(reservation.diagnostics).toEqual(['deployment-manifest-reservation:v1']);
  });

  it('uses explicit conservative defaults for services without declarations', () => {
    const reservation = resolveDeploymentManifestReservation(
      manifest({ api: { image, env: {}, volumes: [] } }),
      'preview'
    );

    expect(reservation).toMatchObject({
      cpuMillis: DEFAULT_DEPLOYMENT_SERVICE_CPU_MILLIS,
      memoryMb: DEFAULT_DEPLOYMENT_SERVICE_MEMORY_MB,
      diskMb: DEFAULT_DEPLOYMENT_SERVICE_DISK_MB,
      exclusiveNode: false,
    });
    expect(reservation.diagnostics).toContain('deployment-service-resource-defaults-applied');
  });

  it('uses caller-configured fallback reservations when declarations are omitted', () => {
    const reservation = resolveDeploymentManifestReservation(
      manifest({ api: { image, env: {}, volumes: [] } }),
      'preview',
      { cpuMillis: 400, memoryMb: 640, diskMb: 2_048 }
    );

    expect(reservation).toMatchObject({
      cpuMillis: 400,
      memoryMb: 640,
      diskMb: 2_048,
    });
  });

  it('adds declared volume capacity and preserves exclusive-node behavior', () => {
    const reservation = resolveDeploymentManifestReservation(
      manifest(
        { api: { image, env: {}, volumes: [{ name: 'data', mountPath: '/data' }] } },
        { data: { sizeHintMb: 4_096 } }
      ),
      'staging'
    );

    expect(reservation.diskMb).toBe(DEFAULT_DEPLOYMENT_SERVICE_DISK_MB + 4_096);
    expect(reservation.exclusiveNode).toBe(true);
  });
});
