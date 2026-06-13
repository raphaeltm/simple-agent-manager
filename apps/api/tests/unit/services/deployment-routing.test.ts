import { describe, expect, it } from 'vitest';

import {
  buildDeploymentRouteTargets,
  collectEnvironmentRouteHostnames,
} from '../../../src/services/deployment-routing';

function manifest() {
  return {
    version: 1 as const,
    services: {
      web: {
        image: { registry: 'docker.io', repository: 'example/web', digest: `sha256:${'a'.repeat(64)}` },
        env: {},
        volumes: [],
      },
      api: {
        image: { registry: 'docker.io', repository: 'example/api', digest: `sha256:${'b'.repeat(64)}` },
        env: {},
        volumes: [],
      },
    },
    volumes: {},
    routes: [
      { service: 'web', port: 3000, mode: 'public' as const },
      { service: 'api', port: 8080, mode: 'private' as const },
      { service: 'api', port: 8081, mode: 'public' as const },
    ],
  };
}

describe('buildDeploymentRouteTargets', () => {
  it('derives stable app hostnames and loopback host ports for public routes only', () => {
    const targets = buildDeploymentRouteTargets(manifest(), {
      environmentId: '01KTX9M6J0TPMGW0CQ98HQ1EAW',
      baseDomain: 'sammy.party',
      routePortBase: '36000',
      routePortSpan: '20',
    });

    expect(targets).toEqual([
      {
        hostname: 'r1-web-3000-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
        service: 'web',
        containerPort: 3000,
        hostPort: 36000,
      },
      {
        hostname: 'r2-api-8081-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
        service: 'api',
        containerPort: 8081,
        hostPort: 36001,
      },
    ]);
  });

  it('keeps enough environment entropy to avoid ULID timestamp-prefix hostname collisions', () => {
    const first = buildDeploymentRouteTargets(manifest(), {
      environmentId: '01KTX9M6J0AAAAAAAAAAAAAAAA',
      baseDomain: 'sammy.party',
    });
    const second = buildDeploymentRouteTargets(manifest(), {
      environmentId: '01KTX9M6J0BBBBBBBBBBBBBBBB',
      baseDomain: 'sammy.party',
    });

    expect(first[0]!.hostname).toBe('r1-web-3000-01ktx9m6j0aaaaaaaaaaaaaaaa.apps.sammy.party');
    expect(second[0]!.hostname).toBe('r1-web-3000-01ktx9m6j0bbbbbbbbbbbbbbbb.apps.sammy.party');
    expect(first[0]!.hostname).not.toBe(second[0]!.hostname);
  });

  it('fails before assigning ports outside the configured per-environment span', () => {
    expect(() => buildDeploymentRouteTargets(manifest(), {
      environmentId: 'env-1',
      baseDomain: 'example.com',
      routePortBase: '35000',
      routePortSpan: '1',
    })).toThrow('exceeding configured deployment route port span 1');
  });

  it('fails before assigning loopback ports outside the TCP range', () => {
    expect(() => buildDeploymentRouteTargets(manifest(), {
      environmentId: 'env-1',
      baseDomain: 'example.com',
      routePortBase: '65535',
      routePortSpan: '20',
    })).toThrow('exceeding maximum TCP port 65535');
  });
});

describe('collectEnvironmentRouteHostnames', () => {
  const opts = { environmentId: '01KTX9M6J0TPMGW0CQ98HQ1EAW', baseDomain: 'sammy.party' };

  it('reuses the apply-path derivation to collect public-route hostnames', () => {
    const hostnames = collectEnvironmentRouteHostnames([JSON.stringify(manifest())], opts);
    expect(hostnames).toEqual([
      'r1-web-3000-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
      'r2-api-8081-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
    ]);
  });

  it('dedupes hostnames across multiple releases of the same environment', () => {
    const hostnames = collectEnvironmentRouteHostnames(
      [JSON.stringify(manifest()), JSON.stringify(manifest())],
      opts,
    );
    expect(hostnames).toEqual([
      'r1-web-3000-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
      'r2-api-8081-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
    ]);
  });

  it('skips malformed manifests instead of aborting teardown', () => {
    const hostnames = collectEnvironmentRouteHostnames(
      ['not-json', JSON.stringify(manifest())],
      opts,
    );
    expect(hostnames).toEqual([
      'r1-web-3000-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
      'r2-api-8081-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
    ]);
  });

  it('skips manifests whose route set exceeds the configured span', () => {
    const hostnames = collectEnvironmentRouteHostnames([JSON.stringify(manifest())], {
      ...opts,
      routePortSpan: '1',
    });
    expect(hostnames).toEqual([]);
  });

  it('returns an empty list when no release defines a public route', () => {
    const noPublic = {
      ...manifest(),
      routes: [{ service: 'api', port: 8080, mode: 'private' as const }],
    };
    expect(collectEnvironmentRouteHostnames([JSON.stringify(noPublic)], opts)).toEqual([]);
  });
});
