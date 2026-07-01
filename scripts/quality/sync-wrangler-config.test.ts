import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PulumiOutputs, WranglerToml } from '../deploy/types.js';
import { checkTailWorkerExists, generateApiWorkerEnv } from '../deploy/sync-wrangler-config.js';

const outputs: PulumiOutputs = {
  d1DatabaseId: 'd1-id',
  d1DatabaseName: 'prefix-prod',
  observabilityD1DatabaseId: 'obs-d1-id',
  observabilityD1DatabaseName: 'prefix-observability-prod',
  kvId: 'kv-id',
  kvName: 'prefix-prod-sessions',
  r2Name: 'prefix-prod-assets',
  dnsIds: {
    api: 'api-dns-id',
    app: 'app-dns-id',
    wildcard: 'wildcard-dns-id',
  },
  hostnames: {
    api: 'api.example.com',
    app: 'app.example.com',
  },
  stackSummary: {
    stack: 'prod',
    baseDomain: 'example.com',
    resources: {
      d1: 'prefix-prod',
      kv: 'prefix-prod-sessions',
      r2: 'prefix-prod-assets',
    },
  },
  cloudflareAccountId: 'account-id',
  pagesName: 'prefix-web-prod',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('sync wrangler config', () => {
  it('keeps Analytics Engine binding dataset aligned with generated query dataset', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');

    const topLevel: WranglerToml = {
      analytics_engine_datasets: [{ binding: 'ANALYTICS', dataset: 'legacy_analytics' }],
    };

    const envConfig = generateApiWorkerEnv(topLevel, outputs, 'prod', false);

    expect(envConfig.vars).toMatchObject({
      ANALYTICS_DATASET: 's123abc_analytics',
      AI_GATEWAY_ID: 's123abc',
      WWW_PAGES_PROJECT_NAME: 's123abc-www',
      BASE_DOMAIN: 'example.com',
      PAGES_PROJECT_NAME: 'prefix-web-prod',
    });
    expect(envConfig.analytics_engine_datasets).toEqual([
      { binding: 'ANALYTICS', dataset: 's123abc_analytics' },
    ]);
  });

  it('fails instead of falling back to sam when deployment identity is missing', () => {
    expect(() => generateApiWorkerEnv({}, outputs, 'prod', false)).toThrow(
      'RESOURCE_PREFIX or BASE_DOMAIN is required'
    );
  });

  it('derives deployment identity from BASE_DOMAIN when RESOURCE_PREFIX is not explicit', () => {
    vi.stubEnv('BASE_DOMAIN', 'example.com');

    const envConfig = generateApiWorkerEnv({}, outputs, 'prod', false);

    expect(envConfig.name).toBe('sa379a6-api-prod');
    expect(envConfig.vars).toMatchObject({
      AI_GATEWAY_ID: 'sa379a6',
      ANALYTICS_DATASET: 'sa379a6_analytics',
      WWW_PAGES_PROJECT_NAME: 'sa379a6-www',
    });
  });

  it('omits Artifacts binding and disables runtime flag by default', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');

    const topLevel: WranglerToml = {
      vars: { ARTIFACTS_ENABLED: 'true' },
      artifacts: [{ binding: 'ARTIFACTS', namespace: 'default' }],
    };

    const envConfig = generateApiWorkerEnv(topLevel, outputs, 'prod', false);

    expect(envConfig.artifacts).toBeUndefined();
    expect(envConfig.vars).toMatchObject({ ARTIFACTS_ENABLED: 'false' });
  });

  it('copies Artifacts binding and enables runtime flag only when explicitly opted in', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');
    vi.stubEnv('ARTIFACTS_BINDING_ENABLED', 'true');

    const artifacts = [{ binding: 'ARTIFACTS', namespace: 'default' }];
    const envConfig = generateApiWorkerEnv({ artifacts }, outputs, 'prod', false);

    expect(envConfig.artifacts).toEqual(artifacts);
    expect(envConfig.vars).toMatchObject({ ARTIFACTS_ENABLED: 'true' });
  });

  it('fails when Artifacts binding is enabled without a top-level binding declaration', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');
    vi.stubEnv('ARTIFACTS_BINDING_ENABLED', 'true');

    expect(() => generateApiWorkerEnv({}, outputs, 'prod', false)).toThrow(
      'ARTIFACTS_BINDING_ENABLED=true requires a top-level [[artifacts]] binding'
    );
  });

  it('distinguishes a missing tail worker from Cloudflare API failures', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkTailWorkerExists('account-id', 'tail-worker')).resolves.toBe(true);
    await expect(checkTailWorkerExists('account-id', 'tail-worker')).resolves.toBe(false);
    await expect(checkTailWorkerExists('account-id', 'tail-worker')).rejects.toThrow('HTTP 403');
  });

  it('requires a Cloudflare API token before checking tail worker status', async () => {
    await expect(checkTailWorkerExists('account-id', 'tail-worker')).rejects.toThrow(
      'CF_API_TOKEN or CLOUDFLARE_API_TOKEN is required'
    );
  });
});
