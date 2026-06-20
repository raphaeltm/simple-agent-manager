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

function makeSubmission(overrides: Partial<ComposePublishSubmission> = {}): ComposePublishSubmission {
  return {
    reference: 'sam-registry.local:5050/crewai',
    composeYaml: CREWAI_COMPOSE,
    services: [
      { serviceName: 'app', pushedRef: 'sam-registry.local:5050/proj/app@sha256:aaa', digest: 'sha256:aaa' },
      { serviceName: 'worker', pushedRef: 'sam-registry.local:5050/proj/worker@sha256:bbb', digest: 'sha256:bbb' },
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

  it('warns when a build service has no pushed image and no fallback image', () => {
    const submission = makeSubmission({
      services: [
        // Only `worker` has a pushedRef; `app` (which uses build:) has none.
        { serviceName: 'worker', pushedRef: 'sam-registry.local:5050/proj/worker@sha256:bbb', digest: 'sha256:bbb' },
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
    expect(route.hostname).toBe(
      `r1-app-8000-${ENVIRONMENT_ID}.apps.${BASE_DOMAIN}`,
    );

    // app's ports are rewritten to a loopback binding agreeing with the route.
    expect(doc.services.app.ports).toEqual([`127.0.0.1:${route.hostPort}:8000`]);
    // worker had no ports → none assigned.
    expect(doc.services.worker.ports).toBeUndefined();
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
      OPTS,
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
      OPTS,
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
      OPTS,
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

  it('throws when the captured composeYaml has no services mapping', () => {
    expect(() =>
      buildComposePublishApplyPayload(
        makeSubmission({ composeYaml: 'volumes:\n  data:\n', services: [] }),
        OPTS,
      ),
    ).toThrow(/no services mapping/i);
  });
});
