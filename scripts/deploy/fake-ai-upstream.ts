/**
 * Staging deploys only: publish the test-only fake AI upstream Worker on workers.dev and point the
 * installation's AI Gateway custom provider at it.
 *
 * Why it exists: a self-hosted Cloudflare install prices AI spend from AI Gateway logs, so a test
 * call must go through the real gateway to be metered. The fake (`packages/ai-proxy/src/
 * ai-test-upstream-worker.ts`) lives on its own workers.dev address, outside the installation's
 * zone, so no zone security rule has to change. It has no bindings and no secrets.
 *
 * Steps, each idempotent:
 * 1. Refuse unless the plan allows this stack (`planFakeAiUpstream`; never production).
 * 2. `wrangler deploy` with a generated config: workers.dev only, no route, no bindings.
 * 3. Ensure the custom provider `<prefix>-test-upstream`: base URL = the Worker's workers.dev URL,
 *    with the fixed gating header in the provider's `headers`, enabled. Cloudflare documents no
 *    update call, so a provider that differs is deleted and recreated under the same slug.
 * 4. Smoke: the Worker answers 404 without the gating header and 200 with it.
 *
 * Secrets (rule 83): the deploy token comes from `secrets.CF_API_TOKEN` through env and goes
 * straight to wrangler (env) and to the Cloudflare API (an Authorization header). It is never
 * printed, transformed or passed on a command line. Nothing secret is read back.
 *
 * Usage (from the deploy workflow): pnpm tsx scripts/deploy/fake-ai-upstream.ts
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CREDENTIAL_ENVIRONMENT, DEPLOY_STACK,
 *      RESOURCE_PREFIX.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AI_TEST_UPSTREAM_GATE_HEADER,
  AI_TEST_UPSTREAM_GATE_VALUE,
} from '../../packages/ai-proxy/src/ai-test-upstream-contract';
import { Api, fetchRequest } from './cloudflare-rest';
import { type FakeAiUpstreamPlan, planFakeAiUpstream } from './fake-ai-upstream-plan';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORKER_ENTRY = join(REPO_ROOT, 'packages/ai-proxy/src/ai-test-upstream-worker.ts');
/** Matches the API and tail Workers' compatibility date. */
const COMPATIBILITY_DATE = '2026-01-01';

/** The generated wrangler config: workers.dev only, no routes, no bindings, no vars. */
export function fakeAiUpstreamWranglerConfig(
  plan: FakeAiUpstreamPlan,
  entry = WORKER_ENTRY
): string {
  return [
    `name = ${JSON.stringify(plan.workerName)}`,
    `main = ${JSON.stringify(entry)}`,
    `compatibility_date = ${JSON.stringify(COMPATIBILITY_DATE)}`,
    'compatibility_flags = ["nodejs_compat"]',
    'workers_dev = true',
    'preview_urls = false',
    '',
  ].join('\n');
}

export interface CustomProvider {
  id: string;
  slug: string;
  base_url?: string;
  headers?: string | null;
  enable?: boolean;
}

/** The provider body this deploy wants for `slug`. */
export function desiredCustomProvider(plan: FakeAiUpstreamPlan, baseUrl: string) {
  return {
    name: `SAM test upstream (${plan.workerName})`,
    slug: plan.providerSlug,
    base_url: baseUrl,
    headers: JSON.stringify({ [AI_TEST_UPSTREAM_GATE_HEADER]: AI_TEST_UPSTREAM_GATE_VALUE }),
    enable: true,
    description:
      'Staging-only fake AI upstream for spending-limit tests. Canned replies, no secrets.',
  };
}

function sameHeaders(actual: string | null | undefined, wanted: string): boolean {
  if (!actual) return false;
  try {
    return JSON.stringify(JSON.parse(actual)) === wanted;
  } catch {
    return false;
  }
}

/** Page size for the custom-providers list, and the page cap (5,000 providers) per run. */
const PROVIDER_PAGE_SIZE = 50;
const PROVIDER_MAX_PAGES = 100;

/** Every custom provider in the account: a slug on page 2 must not read as absent. */
async function listCustomProviders(api: Api, path: string): Promise<CustomProvider[]> {
  const all: CustomProvider[] = [];
  for (let page = 1; page <= PROVIDER_MAX_PAGES; page += 1) {
    const batch =
      (await api.call<CustomProvider[]>(
        'GET',
        `${path}?per_page=${PROVIDER_PAGE_SIZE}&page=${page}`
      )) ?? [];
    all.push(...batch);
    if (batch.length < PROVIDER_PAGE_SIZE) return all;
  }
  throw new Error(
    `More than ${PROVIDER_PAGE_SIZE * PROVIDER_MAX_PAGES} custom providers; refusing to guess`
  );
}

/**
 * Make the custom provider match. Returns what it did. Never touches a provider with another slug.
 * Cloudflare documents no update call, so a differing provider is deleted, then recreated: a
 * failure between the two leaves no provider, and faked calls fail at the gateway (no real key
 * is ever sent) until the next staging deploy recreates it.
 */
export async function ensureCustomProvider(
  api: Api,
  accountId: string,
  plan: FakeAiUpstreamPlan,
  baseUrl: string
): Promise<'unchanged' | 'created' | 'replaced'> {
  const path = `/accounts/${accountId}/ai-gateway/custom-providers`;
  const wanted = desiredCustomProvider(plan, baseUrl);
  const matches = (await listCustomProviders(api, path)).filter(
    (provider) => provider.slug === plan.providerSlug
  );
  const current = matches[0];
  if (
    matches.length === 1 &&
    current?.base_url === wanted.base_url &&
    current.enable === true &&
    sameHeaders(current.headers, wanted.headers)
  ) {
    return 'unchanged';
  }
  for (const provider of matches) {
    await api.call('DELETE', `${path}/${encodeURIComponent(provider.id)}`);
  }
  await api.call('POST', path, wanted);
  return matches.length > 0 ? 'replaced' : 'created';
}

async function smoke(url: string, gated: boolean): Promise<number> {
  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(gated ? { [AI_TEST_UPSTREAM_GATE_HEADER]: AI_TEST_UPSTREAM_GATE_VALUE } : {}),
    },
    body: JSON.stringify({ model: 'smoke', max_tokens: 1, messages: [] }),
  });
  await response.body?.cancel();
  return response.status;
}

/** Workers.dev can take a few seconds to serve a new script; retry the gated smoke briefly. */
async function smokeWithRetry(url: string): Promise<void> {
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ungated = await smoke(url, false);
    const gated = await smoke(url, true);
    console.log(`smoke ${attempt}/${attempts}: ungated HTTP ${ungated}, gated HTTP ${gated}`);
    if (ungated === 404 && gated === 200) return;
    await new Promise((done) => setTimeout(done, 5000));
  }
  throw new Error('The fake AI upstream did not answer 404 ungated and 200 gated');
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const plan = planFakeAiUpstream({
    credentialEnvironment: required('CREDENTIAL_ENVIRONMENT'),
    stack: required('DEPLOY_STACK'),
    prefix: required('RESOURCE_PREFIX'),
  });
  const accountId = required('CLOUDFLARE_ACCOUNT_ID');
  const api = new Api(fetchRequest(required('CLOUDFLARE_API_TOKEN')));
  console.log(`Fake AI upstream: worker ${plan.workerName}, provider ${plan.gatewayProvider}`);

  const dir = mkdtempSync(join(tmpdir(), 'sam-fake-ai-'));
  try {
    const config = join(dir, 'wrangler.toml');
    writeFileSync(config, fakeAiUpstreamWranglerConfig(plan));
    // The token reaches wrangler only through its inherited env (CLOUDFLARE_API_TOKEN).
    execFileSync(
      'pnpm',
      ['--filter', '@simple-agent-manager/api', 'exec', 'wrangler', 'deploy', '--config', config],
      { cwd: REPO_ROOT, stdio: 'inherit' }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const subdomain = await api.call<{ subdomain?: string }>(
    'GET',
    `/accounts/${accountId}/workers/subdomain`
  );
  if (!subdomain?.subdomain) throw new Error('The account has no workers.dev subdomain');
  // Not printed: the address is not secret, but there is no reason to advertise it in logs.
  const baseUrl = `https://${plan.workerName}.${subdomain.subdomain}.workers.dev`;

  await smokeWithRetry(baseUrl);
  const outcome = await ensureCustomProvider(api, accountId, plan, baseUrl);
  console.log(`Custom provider ${plan.providerSlug}: ${outcome}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    // Messages can carry text from remote responses; never let it form a workflow command.
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(
      '::',
      ': :'
    );
    console.error(`::error::${message}`);
    process.exit(1);
  });
}
