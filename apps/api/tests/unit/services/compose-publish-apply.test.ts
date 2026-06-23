import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  buildComposePublishApplyPayload,
  type ComposePublishSubmission,
} from '../../../src/services/compose-publish-apply';

const ENVIRONMENT_ID = 'env-crewai-1';
const RELEASE_ID = 'release-ulid-1';
const BASE_DOMAIN = 'sammy.party';

const OPTS = {
  environmentId: ENVIRONMENT_ID,
  baseDomain: BASE_DOMAIN,
  releaseId: RELEASE_ID,
};

/**
 * A CrewAI-shaped compose: a built `app` service that publishes a port, a built
 * `worker` with no ports, a `chat` model-provider service, and a `postgres`
 * image service. Mirrors the real submission the publish orchestrator captures.
 */
const CREWAI_COMPOSE = `services:
  app:
    build: .
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgres://db
    depends_on:
      - postgres
  worker:
    build:
      context: ./worker
    environment:
      QUEUE: redis://redis
  chat:
    provider:
      type: model
      options:
        model: ai/gemma3:1B-Q4_K_M
  postgres:
    image: pgvector/pgvector:pg16
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`;

function makeSubmission(
  overrides: Partial<ComposePublishSubmission> = {}
): ComposePublishSubmission {
  return {
    reference: 'sam-registry.local:5050/crewai',
    composeYaml: CREWAI_COMPOSE,
    services: [
      {
        serviceName: 'app',
        pushedRef: 'sam-registry.local:5050/proj/app@sha256:aaa',
        digest: 'sha256:aaa',
      },
      {
        serviceName: 'worker',
        pushedRef: 'sam-registry.local:5050/proj/worker@sha256:bbb',
        digest: 'sha256:bbb',
      },
    ],
    ...overrides,
  };
}

describe('buildComposePublishApplyPayload', () => {
  it('passes provider (Model Runner) services through verbatim and flags hasModelProvider', () => {
    const result = buildComposePublishApplyPayload(makeSubmission(), OPTS);
    const doc = parseYaml(result.composeYaml) as Record<string, any>;

    expect(result.hasModelProvider).toBe(true);
    // The provider service is untouched: no SAM labels, no network re-write.
    expect(doc.services.chat).toEqual({
      provider: { type: 'model', options: { model: 'ai/gemma3:1B-Q4_K_M' } },
    });
    expect(doc.services.chat.networks).toBeUndefined();
    expect(doc.services.chat.labels).toBeUndefined();
  });

  it('replaces build: with the submission digest-pinned pushedRef image', () => {
    const result = buildComposePublishApplyPayload(makeSubmission(), OPTS);
    const doc = parseYaml(result.composeYaml) as Record<string, any>;

    expect(doc.services.app.build).toBeUndefined();
    expect(doc.services.app.image).toBe('sam-registry.local:5050/proj/app@sha256:aaa');
    expect(doc.services.worker.build).toBeUndefined();
    expect(doc.services.worker.image).toBe('sam-registry.local:5050/proj/worker@sha256:bbb');
  });

  it('replaces artifact-backed build services with local refs and pull_policy never', () => {
    const result = buildComposePublishApplyPayload(
      makeSubmission({
        services: [
          {
            serviceName: 'app',
            sourceRef: 'crewai-app',
            localImageRef: 'crewai-app',
            r2Key: 'compose-image-artifacts/proj/env/ws/upload/app.tar',
            sizeBytes: 123,
            archiveSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            archiveType: 'docker-save',
            mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
          },
          {
            serviceName: 'worker',
            sourceRef: 'crewai-worker',
            localImageRef: 'crewai-worker',
            r2Key: 'compose-image-artifacts/proj/env/ws/upload/worker.tar',
            sizeBytes: 456,
            archiveSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            archiveType: 'docker-save',
            mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
          },
        ],
      }),
      OPTS
    );
    const doc = parseYaml(result.composeYaml) as Record<string, any>;

    expect(doc.services.app.build).toBeUndefined();
    expect(doc.services.app.image).toBe(`sam-${ENVIRONMENT_ID}-app:${RELEASE_ID}`);
    expect(doc.services.app.pull_policy).toBe('never');
    expect(doc.services.worker.image).toBe(`sam-${ENVIRONMENT_ID}-worker:${RELEASE_ID}`);
    expect(doc.services.worker.pull_policy).toBe('never');
    expect(doc.services.postgres.image).toBe('pgvector/pgvector:pg16');
    expect(doc.services.postgres.pull_policy).toBeUndefined();
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        serviceName: 'app',
        sourceRef: 'crewai-app',
        localImageRef: `sam-${ENVIRONMENT_ID}-app:${RELEASE_ID}`,
        r2Key: 'compose-image-artifacts/proj/env/ws/upload/app.tar',
      }),
      expect.objectContaining({
        serviceName: 'worker',
        localImageRef: `sam-${ENVIRONMENT_ID}-worker:${RELEASE_ID}`,
      }),
    ]);
  });

  it('warns when a build service has no pushed image and no fallback image', () => {
    const submission = makeSubmission({
      services: [
        // Only `worker` has a pushedRef; `app` (which uses build:) has none.
        {
          serviceName: 'worker',
          pushedRef: 'sam-registry.local:5050/proj/worker@sha256:bbb',
          digest: 'sha256:bbb',
        },
      ],
    });
    const result = buildComposePublishApplyPayload(submission, OPTS);

    const buildWarning = result.warnings.find((w) => w.service === 'app' && w.field === 'build');
    expect(buildWarning).toBeDefined();
    expect(buildWarning?.message).toMatch(/no pushed image/i);
  });

  it('transforms ports: into loopback bindings and matching public routes', () => {
    const result = buildComposePublishApplyPayload(makeSubmission(), OPTS);
    const doc = parseYaml(result.composeYaml) as Record<string, any>;

    // One route is derived from app's single published port.
    expect(result.routes).toHaveLength(1);
    const route = result.routes[0]!;
    expect(route.service).toBe('app');
    expect(route.containerPort).toBe(8000);
    expect(route.hostPort).toBeGreaterThanOrEqual(35_000);
    expect(route.hostname).toBe(`r1-app-8000-${ENVIRONMENT_ID}.apps.${BASE_DOMAIN}`);

    // app's ports are rewritten to a loopback binding agreeing with the route.
    expect(doc.services.app.ports).toEqual([`127.0.0.1:${route.hostPort}:8000`]);
    // worker had no ports → none assigned.
    expect(doc.services.worker.ports).toBeUndefined();
  });

  it('allows interpolated host ports because SAM rewrites host bindings', () => {
    const composeWithInterpolatedHostPort = `services:
  app:
    image: example/app:1
    ports:
      - "\${PUBLIC_HOST_PORT:-8000}:8000"
`;
    const result = buildComposePublishApplyPayload(
      makeSubmission({ composeYaml: composeWithInterpolatedHostPort, services: [] }),
      OPTS
    );
    const doc = parseYaml(result.composeYaml) as Record<string, any>;

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]!.containerPort).toBe(8000);
    expect(doc.services.app.ports).toEqual([
      `127.0.0.1:${result.routes[0]!.hostPort}:8000`,
    ]);
  });

  it('rejects interpolated short-syntax container ports with an actionable diagnostic', () => {
    const composeWithInterpolatedContainerPort = `services:
  app:
    image: example/app:1
    ports:
      - "8000:\${APP_PORT}"
`;

    expect(() =>
      buildComposePublishApplyPayload(
        makeSubmission({ composeYaml: composeWithInterpolatedContainerPort, services: [] }),
        OPTS
      )
    ).toThrow(/container ports must be literal numbers/i);
  });

  it('rejects interpolated long-syntax target ports with an actionable diagnostic', () => {
    const composeWithInterpolatedTarget = `services:
  app:
    image: example/app:1
    ports:
      - target: \${APP_PORT}
        published: "\${PUBLIC_HOST_PORT:-8000}"
`;

    expect(() =>
      buildComposePublishApplyPayload(
        makeSubmission({ composeYaml: composeWithInterpolatedTarget, services: [] }),
        OPTS
      )
    ).toThrow(/target\/container ports must be literal numbers/i);
  });

  it('strips denied service fields and reports them as warnings (not errors)', () => {
    const composeWithDenied = `services:
  app:
    image: example/app:1
    privileged: true
    cap_add:
      - NET_ADMIN
    ports:
      - "8000:8000"
`;
    const result = buildComposePublishApplyPayload(
      makeSubmission({ composeYaml: composeWithDenied, services: [] }),
      OPTS
    );
    const doc = parseYaml(result.composeYaml) as Record<string, any>;

    expect(doc.services.app.privileged).toBeUndefined();
    expect(doc.services.app.cap_add).toBeUndefined();
    expect(result.warnings.some((w) => w.field === 'privileged')).toBe(true);
    expect(result.warnings.some((w) => w.field === 'cap_add')).toBe(true);
  });

  it('strips denied top-level fields (networks) and replaces with the SAM bridge', () => {
    const composeWithNetworks = `services:
  app:
    image: example/app:1
networks:
  custom:
    driver: overlay
`;
    const result = buildComposePublishApplyPayload(
      makeSubmission({ composeYaml: composeWithNetworks, services: [] }),
      OPTS
    );
    const doc = parseYaml(result.composeYaml) as Record<string, any>;

    expect(result.warnings.some((w) => w.field === 'networks')).toBe(true);
    // Custom network is gone; replaced with a single SAM bridge network.
    expect(doc.networks).toBeDefined();
    expect(doc.networks.custom).toBeUndefined();
    const networkNames = Object.keys(doc.networks);
    expect(networkNames).toHaveLength(1);
    expect(networkNames[0]).toMatch(/^sam-internal-/);
    expect(doc.networks[networkNames[0]!]).toEqual({ driver: 'bridge' });
  });

  it('applies SAM injections to every normal service', () => {
    const result = buildComposePublishApplyPayload(makeSubmission(), OPTS);
    const doc = parseYaml(result.composeYaml) as Record<string, any>;
    const networkName = `sam-internal-${ENVIRONMENT_ID}`;

    for (const name of ['app', 'worker', 'postgres']) {
      const svc = doc.services[name];
      expect(svc.restart).toBe('unless-stopped');
      expect(svc.labels).toEqual({
        'sam.environmentId': ENVIRONMENT_ID,
        'sam.releaseId': RELEASE_ID,
        'sam.service': name,
      });
      expect(svc.networks).toEqual([networkName]);
      expect(svc.logging).toEqual({
        driver: 'json-file',
        options: { 'max-size': '10m', 'max-file': '3' },
      });
      // Default resource limit injected when compose omits deploy.resources.
      expect(svc.deploy.resources.limits.memory).toBe('256M');
    }
  });

  it('applies configured default memory and log limits', () => {
    const result = buildComposePublishApplyPayload(makeSubmission(), {
      ...OPTS,
      defaultMemoryLimitMb: 512,
      defaultLogMaxSize: '25m',
      defaultLogMaxFile: '7',
    });
    const doc = parseYaml(result.composeYaml) as Record<string, any>;

    expect(doc.services.app.deploy.resources.limits.memory).toBe('512M');
    expect(doc.services.app.logging).toEqual({
      driver: 'json-file',
      options: { 'max-size': '25m', 'max-file': '7' },
    });
  });

  it('preserves an explicit deploy.resources.limits.memory', () => {
    const composeWithLimits = `services:
  app:
    image: example/app:1
    deploy:
      resources:
        limits:
          memory: 1G
`;
    const result = buildComposePublishApplyPayload(
      makeSubmission({ composeYaml: composeWithLimits, services: [] }),
      OPTS
    );
    const doc = parseYaml(result.composeYaml) as Record<string, any>;
    expect(doc.services.app.deploy.resources.limits.memory).toBe('1G');
  });

  it('preserves top-level named volumes', () => {
    const result = buildComposePublishApplyPayload(makeSubmission(), OPTS);
    const doc = parseYaml(result.composeYaml) as Record<string, any>;
    expect(doc.volumes).toEqual({ pgdata: null });
    // The postgres service's volume mount is preserved verbatim.
    expect(doc.services.postgres.volumes).toEqual(['pgdata:/var/lib/postgresql/data']);
  });

  it('rejects host bind mounts before rendering compose-publish applies', () => {
    const composeWithBind = `services:
  app:
    image: example/app:1
    volumes:
      - /:/host
    ports:
      - "8000:8000"
`;

    expect(() =>
      buildComposePublishApplyPayload(
        makeSubmission({ composeYaml: composeWithBind, services: [] }),
        OPTS
      )
    ).toThrow(/bind mounts are not allowed/i);
  });

  it('rejects Docker socket mounts before rendering compose-publish applies', () => {
    const composeWithSocket = `services:
  app:
    image: example/app:1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - "8000:8000"
`;

    expect(() =>
      buildComposePublishApplyPayload(
        makeSubmission({ composeYaml: composeWithSocket, services: [] }),
        OPTS
      )
    ).toThrow(/docker socket mounts are not allowed/i);
  });

  it('rejects external named volumes before rendering compose-publish applies', () => {
    const composeWithExternalVolume = `services:
  app:
    image: example/app:1
    volumes:
      - data:/data
    ports:
      - "8000:8000"
volumes:
  data:
    external: true
`;

    expect(() =>
      buildComposePublishApplyPayload(
        makeSubmission({ composeYaml: composeWithExternalVolume, services: [] }),
        OPTS
      )
    ).toThrow(/external volumes are not allowed/i);
  });

  it('rejects local-driver top-level volume options that can bind host paths', () => {
    const composeWithDriverOpts = `services:
  app:
    image: example/app:1
    volumes:
      - data:/data
    ports:
      - "8000:8000"
volumes:
  data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /
`;

    expect(() =>
      buildComposePublishApplyPayload(
        makeSubmission({ composeYaml: composeWithDriverOpts, services: [] }),
        OPTS
      )
    ).toThrow(/driver_opts/i);
  });

  it('rejects service volume mounts that are not declared as top-level named volumes', () => {
    const composeWithUndeclaredVolume = `services:
  app:
    image: example/app:1
    volumes:
      - data:/data
    ports:
      - "8000:8000"
`;

    expect(() =>
      buildComposePublishApplyPayload(
        makeSubmission({ composeYaml: composeWithUndeclaredVolume, services: [] }),
        OPTS
      )
    ).toThrow(/not declared in top-level "volumes"/i);
  });

  it('throws when the captured composeYaml has no services mapping', () => {
    expect(() =>
      buildComposePublishApplyPayload(
        makeSubmission({ composeYaml: 'volumes:\n  data:\n', services: [] }),
        OPTS
      )
    ).toThrow(/no services mapping/i);
  });

  // Regression: the REAL `docker compose publish` artifact emits LONG-syntax
  // ports/volumes, a list-valued provider model, per-service networks:{default:null},
  // and named top-level networks/volumes. The short-syntax fixtures above did not
  // exercise this shape; this case mirrors the captured CrewAI release verbatim.
  it('transforms the real long-syntax CrewAI publish artifact', () => {
    const REAL_CREWAI = `name: crewai
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - mode: ingress
        target: 8000
        published: "8000"
        protocol: tcp
    environment:
      DATABASE_URL: postgres://db
    networks:
      default: null
  chat:
    provider:
      type: model
      options:
        model:
          - ai/gemma3:1B-Q4_K_M
    x-defang-llm: true
  embedding:
    provider:
      type: model
      options:
        model:
          - ai/mxbai-embed-large
    x-defang-llm: true
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_PASSWORD: secret
    volumes:
      - type: volume
        source: pgdata
        target: /var/lib/postgresql/data
        volume: {}
    networks:
      default: null
  redis:
    image: redis:7-alpine
    networks:
      default: null
  worker:
    build:
      context: .
    command:
      - sh
      - -c
      - echo worker started
    networks:
      default: null
networks:
  default:
    name: crewai_default
volumes:
  pgdata:
    name: crewai_pgdata
`;
    const submission = makeSubmission({
      composeYaml: REAL_CREWAI,
      services: [
        {
          serviceName: 'app',
          pushedRef: 'sam-registry.local:5050/proj/app@sha256:aaa',
          digest: 'sha256:aaa',
        },
        {
          serviceName: 'worker',
          pushedRef: 'sam-registry.local:5050/proj/worker@sha256:bbb',
          digest: 'sha256:bbb',
        },
      ],
    });
    const result = buildComposePublishApplyPayload(submission, OPTS);
    const doc = parseYaml(result.composeYaml) as Record<string, any>;
    const networkName = `sam-internal-${ENVIRONMENT_ID}`;

    // Both model-provider services survive verbatim and flag the runner.
    expect(result.hasModelProvider).toBe(true);
    expect(doc.services.chat.provider.options.model).toEqual(['ai/gemma3:1B-Q4_K_M']);
    expect(doc.services.embedding.provider.options.model).toEqual(['ai/mxbai-embed-large']);
    expect(doc.services.chat.networks).toBeUndefined();
    expect(doc.services.embedding.networks).toBeUndefined();

    // build services digest-pinned from pushedRef.
    expect(doc.services.app.build).toBeUndefined();
    expect(doc.services.app.image).toBe('sam-registry.local:5050/proj/app@sha256:aaa');
    expect(doc.services.worker.build).toBeUndefined();
    expect(doc.services.worker.image).toBe('sam-registry.local:5050/proj/worker@sha256:bbb');

    // The long-syntax port (target: 8000) becomes a single public route + loopback.
    expect(result.routes).toHaveLength(1);
    const route = result.routes[0]!;
    expect(route.service).toBe('app');
    expect(route.containerPort).toBe(8000);
    expect(route.hostname).toBe(`r1-app-8000-${ENVIRONMENT_ID}.apps.${BASE_DOMAIN}`);
    expect(doc.services.app.ports).toEqual([`127.0.0.1:${route.hostPort}:8000`]);

    // Every normal service is re-networked to the SAM bridge (per-service
    // networks:{default:null} is replaced, not merged).
    for (const name of ['app', 'postgres', 'redis', 'worker']) {
      expect(doc.services[name].networks).toEqual([networkName]);
      expect(doc.services[name].restart).toBe('unless-stopped');
      expect(doc.services[name].labels['sam.service']).toBe(name);
    }

    // Long-syntax volume mount preserved verbatim; Compose's global volume name
    // is stripped so the deploy node creates an environment-scoped local volume.
    expect(doc.services.postgres.volumes).toEqual([
      { type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} },
    ]);
    expect(doc.volumes).toEqual({ pgdata: null });

    // Top-level named network is stripped (warned) and replaced with SAM's bridge.
    expect(result.warnings.some((w) => w.field === 'networks')).toBe(true);
    expect(Object.keys(doc.networks)).toEqual([networkName]);
    expect(doc.networks[networkName]).toEqual({ driver: 'bridge' });
  });
});
