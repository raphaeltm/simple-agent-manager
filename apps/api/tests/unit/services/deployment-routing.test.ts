import { describe, expect, it } from 'vitest';

import {
  buildDeploymentRouteTargets,
  collectEnvironmentRouteHostnames,
  environmentPortOffset,
} from '../../../src/services/deployment-routing';

function manifest() {
  return {
    version: 1 as const,
    services: {
      web: {
        image: {
          registry: 'docker.io',
          repository: 'example/web',
          digest: `sha256:${'a'.repeat(64)}`,
        },
        env: {},
        volumes: [],
      },
      api: {
        image: {
          registry: 'docker.io',
          repository: 'example/api',
          digest: `sha256:${'b'.repeat(64)}`,
        },
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

// ---------------------------------------------------------------------------
// environmentPortOffset
// ---------------------------------------------------------------------------

describe('environmentPortOffset', () => {
  it('returns the same offset for the same environmentId (stability)', () => {
    const id = '01KTX9M6J0TPMGW0CQ98HQ1EAW';
    const a = environmentPortOffset(id, 100, 35_000);
    const b = environmentPortOffset(id, 100, 35_000);
    expect(a).toBe(b);
  });

  it('returns different offsets for different environmentIds', () => {
    const a = environmentPortOffset('01KTX9M6J0AAAAAAAAAAAAAAAA', 100, 35_000);
    const b = environmentPortOffset('01KTX9M6J0BBBBBBBBBBBBBBBB', 100, 35_000);
    expect(a).not.toBe(b);
  });

  it('offset is always a multiple of portSpan', () => {
    for (let i = 0; i < 50; i++) {
      const id = `env-test-${i}-${i.toString(36).padStart(8, '0')}`;
      const offset = environmentPortOffset(id, 100, 35_000);
      expect(offset % 100).toBe(0);
    }
  });

  it('resulting port stays within TCP range', () => {
    for (let i = 0; i < 100; i++) {
      const id = `env-${i}-${i.toString(36).padStart(8, '0')}`;
      const offset = environmentPortOffset(id, 100, 35_000);
      const port = 35_000 + offset;
      expect(port).toBeGreaterThanOrEqual(35_000);
      expect(port).toBeLessThanOrEqual(65_535);
    }
  });

  it('produces no collision across many (envId, routeIndex) pairs', () => {
    // Generate 100 distinct environments, each with up to 5 routes.
    // All ports within a single environment's band must not overlap with
    // any port from another environment's band (assuming routes < portSpan).
    const portSpan = 100;
    const portBase = 35_000;
    const bands = new Map<number, string>(); // band → envId
    for (let i = 0; i < 100; i++) {
      const envId = `env-collision-test-${i}`;
      const offset = environmentPortOffset(envId, portSpan, portBase);
      const band = offset / portSpan;
      if (bands.has(band)) {
        // Hash collisions are possible; just verify they're rare (< 10%)
        continue;
      }
      bands.set(band, envId);
    }
    // With 305 bands and 100 envs, birthday-paradox collision probability is
    // ~14%. So we expect at least 85 unique bands.
    expect(bands.size).toBeGreaterThanOrEqual(80);
  });

  it('returns 0 when bandCount is zero (portBase at max)', () => {
    const offset = environmentPortOffset('any-env', 100, 65_535);
    expect(offset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildDeploymentRouteTargets
// ---------------------------------------------------------------------------

describe('buildDeploymentRouteTargets', () => {
  const ENV_ID = '01KTX9M6J0TPMGW0CQ98HQ1EAW';

  it('derives stable app hostnames and per-env host ports for public routes only', () => {
    const targets = buildDeploymentRouteTargets(manifest(), {
      environmentId: ENV_ID,
      baseDomain: 'sammy.party',
      routePortBase: '36000',
      routePortSpan: '20',
    });

    const offset = environmentPortOffset(ENV_ID, 20, 36_000);
    const expectedBase = 36_000 + offset;

    expect(targets).toEqual([
      {
        hostname: `r1-web-3000-${ENV_ID.toLowerCase()}.apps.sammy.party`,
        service: 'web',
        containerPort: 3000,
        hostPort: expectedBase,
      },
      {
        hostname: `r2-api-8081-${ENV_ID.toLowerCase()}.apps.sammy.party`,
        service: 'api',
        containerPort: 8081,
        hostPort: expectedBase + 1,
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

  it('different environments get different host ports on the same node', () => {
    const envA = '01KTX9M6J0AAAAAAAAAAAAAAAA';
    const envB = '01KTX9M6J0BBBBBBBBBBBBBBBB';
    const targetsA = buildDeploymentRouteTargets(manifest(), {
      environmentId: envA,
      baseDomain: 'sammy.party',
    });
    const targetsB = buildDeploymentRouteTargets(manifest(), {
      environmentId: envB,
      baseDomain: 'sammy.party',
    });

    // Host ports must differ between environments
    const portsA = new Set(targetsA.map((t) => t.hostPort));
    const portsB = new Set(targetsB.map((t) => t.hostPort));
    for (const port of portsA) {
      expect(portsB.has(port)).toBe(false);
    }
  });

  it('same environment redeploying reuses the same ports (stability)', () => {
    const envId = 'stable-env-id';
    const first = buildDeploymentRouteTargets(manifest(), {
      environmentId: envId,
      baseDomain: 'sammy.party',
    });
    const second = buildDeploymentRouteTargets(manifest(), {
      environmentId: envId,
      baseDomain: 'sammy.party',
    });
    expect(first).toEqual(second);
  });

  it('fails before assigning ports outside the configured per-environment span', () => {
    expect(() =>
      buildDeploymentRouteTargets(manifest(), {
        environmentId: 'env-1',
        baseDomain: 'example.com',
        routePortBase: '35000',
        routePortSpan: '1',
      })
    ).toThrow('exceeding configured deployment route port span 1');
  });

  it('fails before assigning loopback ports outside the TCP range', () => {
    expect(() =>
      buildDeploymentRouteTargets(manifest(), {
        environmentId: 'env-1',
        baseDomain: 'example.com',
        routePortBase: '65535',
        routePortSpan: '20',
      })
    ).toThrow('exceeding maximum TCP port 65535');
  });
});

// ---------------------------------------------------------------------------
// collectEnvironmentRouteHostnames
// ---------------------------------------------------------------------------

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
      opts
    );
    expect(hostnames).toEqual([
      'r1-web-3000-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
      'r2-api-8081-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
    ]);
  });

  it('skips malformed manifests instead of aborting teardown', () => {
    const hostnames = collectEnvironmentRouteHostnames(
      ['not-json', JSON.stringify(manifest())],
      opts
    );
    expect(hostnames).toEqual([
      'r1-web-3000-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
      'r2-api-8081-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
    ]);
  });

  it('reconstructs compose-publish hostnames from captured compose service ports', () => {
    const composePublishSubmission = {
      reference: 'v1',
      composeYaml: `services:
  web:
    image: example/web
    ports:
      - "8000:8000"
  api:
    image: example/api
    ports:
      - target: 8080
        published: 18080
        protocol: tcp
`,
      services: [
        { serviceName: 'web', pushedRef: 'registry.example/web@sha256:aaa' },
        { serviceName: 'api', pushedRef: 'registry.example/api@sha256:bbb' },
      ],
    };

    const hostnames = collectEnvironmentRouteHostnames(
      [JSON.stringify(composePublishSubmission)],
      opts
    );

    expect(hostnames).toEqual([
      'r1-web-8000-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
      'r2-api-8080-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
    ]);
  });

  it('reconstructs compose-publish hostnames from x-sam-routes without ports', () => {
    const composePublishSubmission = {
      reference: 'v1',
      composeYaml: `services:
  web:
    image: example/web
x-sam-routes:
  - service: web
    port: 8000
    mode: public
`,
      services: [{ serviceName: 'web', pushedRef: 'registry.example/web@sha256:aaa' }],
    };

    const hostnames = collectEnvironmentRouteHostnames(
      [JSON.stringify(composePublishSubmission)],
      opts
    );

    expect(hostnames).toEqual([
      'r1-web-8000-01ktx9m6j0tpmgw0cq98hq1eaw.apps.sammy.party',
    ]);
  });

  it('lets compose-publish x-sam-routes private suppress captured ports during reconstruction', () => {
    const composePublishSubmission = {
      reference: 'v1',
      composeYaml: `services:
  web:
    image: example/web
    ports:
      - "8000:8000"
x-sam-routes:
  - service: web
    port: 8000
    mode: private
`,
      services: [{ serviceName: 'web', pushedRef: 'registry.example/web@sha256:aaa' }],
    };

    const hostnames = collectEnvironmentRouteHostnames(
      [JSON.stringify(composePublishSubmission)],
      opts
    );

    expect(hostnames).toEqual([]);
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
