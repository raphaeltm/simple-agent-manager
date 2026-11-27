/**
 * The staging-only fake AI upstream in the deploy pipeline (`scripts/deploy/fake-ai-upstream*.ts`):
 * where it may exist, the API Worker vars that point at it, the generated Worker config, the
 * custom provider ensure, and the workflow step that runs it.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import {
  AI_TEST_UPSTREAM_GATE_HEADER,
  AI_TEST_UPSTREAM_GATE_VALUE,
} from '../../packages/ai-proxy/src/ai-test-upstream-contract';
import { Api, type CloudflareRequest } from '../deploy/cloudflare-rest';
import {
  type CustomProvider,
  ensureCustomProvider,
  fakeAiUpstreamWranglerConfig,
} from '../deploy/fake-ai-upstream';
import {
  credentialEnvironmentForStack,
  FakeAiUpstreamRefusedError,
  fakeAiUpstreamWorkerVars,
  planFakeAiUpstream,
} from '../deploy/fake-ai-upstream-plan';

describe('planFakeAiUpstream', () => {
  it('names the Worker and provider for both staging installations', () => {
    expect(
      planFakeAiUpstream({ credentialEnvironment: 'staging', stack: 'staging', prefix: 'sam' })
    ).toEqual({
      workerName: 'sam-fake-ai-staging',
      providerSlug: 'sam-test-upstream',
      gatewayProvider: 'custom-sam-test-upstream',
    });
    expect(
      planFakeAiUpstream({ credentialEnvironment: 'staging', stack: 'staging2', prefix: 'sam2' })
    ).toMatchObject({ workerName: 'sam2-fake-ai-staging2', providerSlug: 'sam2-test-upstream' });
  });

  it.each([
    [
      'the production environment',
      { credentialEnvironment: 'production', stack: 'prod', prefix: 'sam' },
    ],
    [
      'a production stack under staging credentials',
      { credentialEnvironment: 'staging', stack: 'prod', prefix: 'sam' },
    ],
    [
      'a production-looking prefix',
      { credentialEnvironment: 'staging', stack: 'staging', prefix: 'sam-prod' },
    ],
    [
      'a fork production stack with an unmapped name',
      { credentialEnvironment: 'main', stack: 'main', prefix: 'fork' },
    ],
    [
      'an unknown stack under staging credentials',
      { credentialEnvironment: 'staging', stack: 'staging3', prefix: 'sam3' },
    ],
    [
      'a staging stack under other credentials',
      { credentialEnvironment: 'development', stack: 'staging', prefix: 'sam' },
    ],
    [
      'a prefix that is not a plain name',
      { credentialEnvironment: 'staging', stack: 'staging', prefix: 'sam"; x' },
    ],
  ])('refuses %s', (_label, input) => {
    expect(() => planFakeAiUpstream(input)).toThrow(FakeAiUpstreamRefusedError);
  });
});

describe('fakeAiUpstreamWorkerVars', () => {
  it('opens the lock and names the provider on staging stacks only', () => {
    expect(credentialEnvironmentForStack('staging2')).toBe('staging');
    expect(fakeAiUpstreamWorkerVars('staging', 'sam')).toEqual({
      AI_TEST_UPSTREAM_ENABLED: 'true',
      AI_TEST_UPSTREAM_GATEWAY_PROVIDER: 'custom-sam-test-upstream',
    });
    expect(fakeAiUpstreamWorkerVars('staging2', 'sam2')).toMatchObject({
      AI_TEST_UPSTREAM_GATEWAY_PROVIDER: 'custom-sam2-test-upstream',
    });
    for (const stack of ['prod', 'production', 'dev', 'main', 'staging3']) {
      expect(fakeAiUpstreamWorkerVars(stack, 'sam')).toEqual({});
    }
  });
});

describe('fakeAiUpstreamWranglerConfig', () => {
  it('is workers.dev only: no routes, no bindings, no vars', () => {
    const config = fakeAiUpstreamWranglerConfig(
      {
        workerName: 'sam-fake-ai-staging',
        providerSlug: 'sam-test-upstream',
        gatewayProvider: 'x',
      },
      '/repo/packages/ai-proxy/src/ai-test-upstream-worker.ts'
    );
    expect(config).toContain('name = "sam-fake-ai-staging"');
    expect(config).toContain('workers_dev = true');
    expect(config).toContain('preview_urls = false');
    expect(config).not.toMatch(/route|\[\[|\[vars\]|\[env/u);
  });
});

/** A fake custom-providers API keyed by slug, so ensure's effect is read from state. */
function providerStore(initial: CustomProvider[]) {
  let providers = [...initial];
  let next = 1;
  const request: CloudflareRequest = async (method, path, body) => {
    if (method === 'GET') {
      const query = new URL(`https://x${path}`).searchParams;
      const perPage = Number(query.get('per_page'));
      const page = Number(query.get('page'));
      const result = providers.slice((page - 1) * perPage, page * perPage);
      return { status: 200, body: { success: true, result } };
    }
    if (method === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop() ?? '');
      providers = providers.filter((provider) => provider.id !== id);
      return { status: 200, body: { success: true, result: { id } } };
    }
    if (method === 'POST') {
      const created = { id: `new-${next++}`, ...(body as Omit<CustomProvider, 'id'>) };
      providers.push(created);
      return { status: 200, body: { success: true, result: created } };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { api: new Api(request), providers: () => providers };
}

const PLAN = planFakeAiUpstream({
  credentialEnvironment: 'staging',
  stack: 'staging',
  prefix: 'sam',
});
const URL_ = 'https://sam-fake-ai-staging.acct.workers.dev';

describe('ensureCustomProvider', () => {
  it('replaces the spike provider (zone URL, disabled, no gate) and is idempotent after', async () => {
    const store = providerStore([
      {
        id: 'spike',
        slug: 'sam-test-upstream',
        base_url: 'https://api.sammy.party/ai/_test-upstream',
        enable: false,
      },
      { id: 'other', slug: 'someone-else', base_url: 'https://example.com', enable: true },
    ]);
    expect(await ensureCustomProvider(store.api, 'acct', PLAN, URL_)).toBe('replaced');
    const mine = store.providers().filter((provider) => provider.slug === 'sam-test-upstream');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ base_url: URL_, enable: true });
    expect(JSON.parse(mine[0]!.headers ?? '{}')).toEqual({
      [AI_TEST_UPSTREAM_GATE_HEADER]: AI_TEST_UPSTREAM_GATE_VALUE,
    });
    // Another slug is never touched.
    expect(store.providers().some((provider) => provider.id === 'other')).toBe(true);

    const writes = store.api.writes;
    expect(await ensureCustomProvider(store.api, 'acct', PLAN, URL_)).toBe('unchanged');
    expect(store.api.writes).toBe(writes);
  });

  it('finds its provider on a later page instead of creating a duplicate', async () => {
    const others = Array.from({ length: 60 }, (_, index) => ({
      id: `o${index}`,
      slug: `other-${index}`,
      base_url: 'https://example.com',
      enable: true,
    }));
    const store = providerStore([
      ...others,
      { id: 'spike', slug: 'sam-test-upstream', enable: false },
    ]);
    expect(await ensureCustomProvider(store.api, 'acct', PLAN, URL_)).toBe('replaced');
    expect(store.providers().filter((p) => p.slug === 'sam-test-upstream')).toHaveLength(1);
    expect(store.providers()).toHaveLength(61);
  });

  it('creates the provider when none exists', async () => {
    const store = providerStore([]);
    expect(await ensureCustomProvider(store.api, 'acct', PLAN, URL_)).toBe('created');
    expect(store.providers()).toHaveLength(1);
  });

  it('surfaces a Cloudflare error instead of reporting success', async () => {
    const api = new Api(
      vi.fn(async () => ({
        status: 403,
        body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
      }))
    );
    await expect(ensureCustomProvider(api, 'acct', PLAN, URL_)).rejects.toThrow('HTTP 403');
  });
});

describe('deploy workflow step', () => {
  it('runs only for staging deploys, hands the token to the script through env, and never blocks', () => {
    const workflow = parse(
      readFileSync(new URL('../../.github/workflows/deploy-reusable.yml', import.meta.url), 'utf8')
    ) as { jobs: Record<string, { steps?: Array<Record<string, unknown>> }> };
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const step = steps.find((candidate) => candidate.name === 'Deploy staging fake AI upstream');
    expect(step).toBeDefined();
    expect(String(step!.if)).toContain("inputs.environment == 'staging'");
    expect(step!.run).toBe('pnpm tsx scripts/deploy/fake-ai-upstream.ts');
    expect(step!['continue-on-error']).toBe(true);
    const env = step!.env as Record<string, string>;
    expect(env.CLOUDFLARE_API_TOKEN).toBe('${{ secrets.CF_API_TOKEN }}');
    expect(env.CREDENTIAL_ENVIRONMENT).toBe('${{ inputs.environment }}');
  });
});
