import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkTailWorkerExists,
  detectArtifactsAvailable,
  ensureTomlMap,
  generateApiWorkerEnv,
  resolveArtifactsBindingEnabled,
} from '../deploy/sync-wrangler-config.js';
import type { PulumiOutputs, WranglerToml } from '../deploy/types.js';

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

    const envConfig = generateApiWorkerEnv(topLevel, outputs, 'prod', false, false, null);

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
    expect(() => generateApiWorkerEnv({}, outputs, 'prod', false, false, null)).toThrow(
      'RESOURCE_PREFIX or BASE_DOMAIN is required'
    );
  });

  it('derives deployment identity from BASE_DOMAIN when RESOURCE_PREFIX is not explicit', () => {
    vi.stubEnv('BASE_DOMAIN', 'example.com');

    const envConfig = generateApiWorkerEnv({}, outputs, 'prod', false, false, null);

    expect(envConfig.name).toBe('sa379a6-api-prod');
    expect(envConfig.vars).toMatchObject({
      AI_GATEWAY_ID: 'sa379a6',
      ANALYTICS_DATASET: 'sa379a6_analytics',
      WWW_PAGES_PROJECT_NAME: 'sa379a6-www',
    });
  });

  it('enables Cloudflare Container runtime by default and allows explicit opt-out', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');

    expect(generateApiWorkerEnv({}, outputs, 'prod', false, false, null).vars).toMatchObject({
      CF_CONTAINER_ENABLED: 'true',
    });

    expect(
      generateApiWorkerEnv(
        { vars: { CF_CONTAINER_ENABLED: 'false' } },
        outputs,
        'prod',
        false,
        false,
        null
      ).vars
    ).toMatchObject({
      CF_CONTAINER_ENABLED: 'false',
    });

    vi.stubEnv('CF_CONTAINER_ENABLED', 'false');
    expect(generateApiWorkerEnv({}, outputs, 'prod', false, false, null).vars).toMatchObject({
      CF_CONTAINER_ENABLED: 'false',
    });
  });

  it('passes cf-container clone/create tunables through from process env when set', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');

    const unset = generateApiWorkerEnv({}, outputs, 'prod', false, false, null).vars;
    expect(unset).not.toHaveProperty('CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS');
    expect(unset).not.toHaveProperty('CF_CONTAINER_CLONE_FILTER');

    vi.stubEnv('CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS', '180000');
    vi.stubEnv('CF_CONTAINER_CLONE_FILTER', 'off');
    expect(generateApiWorkerEnv({}, outputs, 'prod', false, false, null).vars).toMatchObject({
      CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS: '180000',
      CF_CONTAINER_CLONE_FILTER: 'off',
    });
  });

  it('omits Artifacts binding and disables runtime flag when Artifacts is not enabled', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');

    const topLevel: WranglerToml = {
      vars: { ARTIFACTS_ENABLED: 'true' },
      artifacts: [{ binding: 'ARTIFACTS', namespace: 'default' }],
    };

    const envConfig = generateApiWorkerEnv(topLevel, outputs, 'prod', false, false, null);

    expect(envConfig.artifacts).toBeUndefined();
    expect(envConfig.vars).toMatchObject({ ARTIFACTS_ENABLED: 'false' });
  });

  it('copies Artifacts binding and enables runtime flag when Artifacts is enabled', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');

    const artifacts = [{ binding: 'ARTIFACTS', namespace: 'default' }];
    const envConfig = generateApiWorkerEnv({ artifacts }, outputs, 'prod', false, true, null);

    expect(envConfig.artifacts).toEqual(artifacts);
    expect(envConfig.vars).toMatchObject({ ARTIFACTS_ENABLED: 'true' });
  });

  it('generates a plaintext setup token var without requiring an input secret', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');

    const envConfig = generateApiWorkerEnv({}, outputs, 'prod', false, false, null);

    expect(envConfig.vars?.SETUP_TOKEN).toEqual(expect.any(String));
    expect(String(envConfig.vars?.SETUP_TOKEN).length).toBeGreaterThan(20);
  });

  it('includes SETUP_FORCE only when explicitly requested', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');

    expect(generateApiWorkerEnv({}, outputs, 'prod', false, false, null).vars).not.toHaveProperty(
      'SETUP_FORCE'
    );

    vi.stubEnv('SETUP_FORCE', 'true');
    expect(generateApiWorkerEnv({}, outputs, 'prod', false, false, null).vars).toMatchObject({
      SETUP_FORCE: 'true',
    });
  });

  it('fails when Artifacts is enabled without a top-level binding declaration', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');

    expect(() => generateApiWorkerEnv({}, outputs, 'prod', false, true, null)).toThrow(
      'Artifacts is enabled but no top-level [[artifacts]] binding exists in wrangler.toml'
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

describe('detectArtifactsAvailable (Artifacts REST probe)', () => {
  it('returns true and hits the namespace list-repos endpoint when the probe returns 200', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"success":true,"result":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(detectArtifactsAvailable('account-id', 'default')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-id/artifacts/namespaces/default/repos?limit=1',
      { headers: { Authorization: 'Bearer token' } }
    );
  });

  it('fails closed when the token lacks the Artifacts permission (401/403)', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })));
    await expect(detectArtifactsAvailable('account-id', 'default')).resolves.toBe(false);
  });

  it('fails closed when the account has no Artifacts access (404)', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));
    await expect(detectArtifactsAvailable('account-id', 'default')).resolves.toBe(false);
  });

  it('fails closed on a network error', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(detectArtifactsAvailable('account-id', 'default')).resolves.toBe(false);
  });

  it('fails closed when no deploy token is available', async () => {
    await expect(detectArtifactsAvailable('account-id', 'default')).resolves.toBe(false);
  });
});

describe('resolveArtifactsBindingEnabled (auto-detect + override)', () => {
  it('auto-detects true from a 200 probe when no override is set', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(resolveArtifactsBindingEnabled('account-id', 'default')).resolves.toBe(true);
  });

  it('auto-detects false from a failing probe when no override is set', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    await expect(resolveArtifactsBindingEnabled('account-id', 'default')).resolves.toBe(false);
  });

  it('honors an explicit ARTIFACTS_BINDING_ENABLED=true override even when the probe fails', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    vi.stubEnv('ARTIFACTS_BINDING_ENABLED', 'true');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    await expect(resolveArtifactsBindingEnabled('account-id', 'default')).resolves.toBe(true);
  });

  it('honors an explicit ARTIFACTS_BINDING_ENABLED=false override even when the probe succeeds', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    vi.stubEnv('ARTIFACTS_BINDING_ENABLED', 'false');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(resolveArtifactsBindingEnabled('account-id', 'default')).resolves.toBe(false);
  });
});

describe('ensureTomlMap', () => {
  it('returns the original TOML map so generated env sections are persisted', () => {
    const config: { env: Record<string, unknown> } = { env: {} };

    const envConfig = ensureTomlMap(config.env, 'tail worker env config');
    envConfig.staging = { name: 'sam-tail-worker-staging' };

    expect(config.env).toEqual({
      staging: { name: 'sam-tail-worker-staging' },
    });
  });

  it('rejects non-table values', () => {
    expect(() => ensureTomlMap([], 'tail worker env config')).toThrow(
      'tail worker env config must be a TOML table'
    );
  });
});
