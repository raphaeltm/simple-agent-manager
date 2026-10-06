import { describe, expect, it } from 'vitest';

import {
  buildVerifiedCustomRouteTargets,
  getEnvironmentPublicRouteTargets,
} from '../../../src/services/deployment-custom-domains';
import { environmentPortOffset } from '../../../src/services/deployment-routing';

type PublicRouteDb = Parameters<typeof getEnvironmentPublicRouteTargets>[0];
type CustomDomainDb = Parameters<typeof buildVerifiedCustomRouteTargets>[0];
type WorkerEnv = Parameters<typeof getEnvironmentPublicRouteTargets>[1];

function manifest() {
  return {
    version: 1,
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
      worker: {
        image: {
          registry: 'docker.io',
          repository: 'example/worker',
          digest: `sha256:${'b'.repeat(64)}`,
        },
        env: {},
        volumes: [],
      },
    },
    volumes: {},
    routes: [
      { service: 'web', port: 3000, mode: 'public' },
      { service: 'worker', port: 9000, mode: 'private' },
      { service: 'web', port: 3001, mode: 'public' },
    ],
  };
}

function releaseDb(manifestJson: string | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => (manifestJson ? [{ manifest: manifestJson }] : []),
          }),
        }),
      }),
    }),
  } as unknown as PublicRouteDb;
}

function customDomainDb(
  rows: Array<{
    hostname: string;
    service: string;
    port: number;
    verificationStatus?: string;
    verifiedCnameTarget?: string | null;
    desiredState?: string;
    deletedAt?: string | null;
  }>
) {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  } as unknown as CustomDomainDb;
}

const workerEnv = {
  BASE_DOMAIN: 'sammy.party',
  DEPLOYMENT_ROUTE_PORT_BASE: '36000',
  DEPLOYMENT_ROUTE_PORT_SPAN: '10',
} as unknown as WorkerEnv;

describe('getEnvironmentPublicRouteTargets', () => {
  it('derives attachable public routes from the latest release manifest', async () => {
    const routes = await getEnvironmentPublicRouteTargets(
      releaseDb(JSON.stringify(manifest())),
      workerEnv,
      'env-1'
    );
    const basePort = 36_000 + environmentPortOffset('env-1', 10, 36_000);

    expect(routes).toEqual([
      {
        hostname: 'r1-web-3000-env-1.apps.sammy.party',
        service: 'web',
        containerPort: 3000,
        hostPort: basePort,
      },
      {
        hostname: 'r2-web-3001-env-1.apps.sammy.party',
        service: 'web',
        containerPort: 3001,
        hostPort: basePort + 1,
      },
    ]);
  });

  it('returns no attachable routes when the environment has no release yet', async () => {
    await expect(
      getEnvironmentPublicRouteTargets(releaseDb(null), workerEnv, 'env-1')
    ).resolves.toEqual([]);
  });
});

describe('buildVerifiedCustomRouteTargets', () => {
  it('reuses the parent public route hostPort for verified custom hostnames', async () => {
    const parentRoutes = [
      {
        hostname: 'r1-web-3000-env-1.apps.sammy.party',
        service: 'web',
        containerPort: 3000,
        hostPort: 36007,
      },
      {
        hostname: 'r2-api-8080-env-1.apps.sammy.party',
        service: 'api',
        containerPort: 8080,
        hostPort: 36008,
      },
    ];

    const customTargets = await buildVerifiedCustomRouteTargets(
      customDomainDb([
        {
          hostname: 'App.Customer.Example.com',
          service: 'web',
          port: 3000,
          verifiedCnameTarget: 'r1-web-3000-env-1.apps.sammy.party',
          desiredState: 'active',
          deletedAt: null,
        },
        {
          hostname: 'api.customer.example.com',
          service: 'api',
          port: 8080,
          verifiedCnameTarget: 'r2-api-8080-env-1.apps.sammy.party',
          desiredState: 'active',
          deletedAt: null,
        },
      ]),
      'env-1',
      parentRoutes
    );

    expect(customTargets).toEqual([
      {
        hostname: 'app.customer.example.com',
        service: 'web',
        containerPort: 3000,
        hostPort: 36007,
      },
      {
        hostname: 'api.customer.example.com',
        service: 'api',
        containerPort: 8080,
        hostPort: 36008,
      },
    ]);
  });

  it('skips verified custom domains whose parent route no longer exists', async () => {
    const customTargets = await buildVerifiedCustomRouteTargets(
      customDomainDb([
        {
          hostname: 'old.customer.example.com',
          service: 'old',
          port: 3000,
          verifiedCnameTarget: 'r1-old-3000-env-1.apps.sammy.party',
          desiredState: 'active',
          deletedAt: null,
        },
      ]),
      'env-1',
      [
        {
          hostname: 'r1-web-3000-env-1.apps.sammy.party',
          service: 'web',
          containerPort: 3000,
          hostPort: 36007,
        },
      ]
    );

    expect(customTargets).toEqual([]);
  });
});
