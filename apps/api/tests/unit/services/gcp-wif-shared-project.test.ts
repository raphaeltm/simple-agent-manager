/**
 * Two SAM installations connecting one Google Cloud project.
 *
 * Reproduces the 2026-11-17 incident: staging2's setup PATCHed the shared `sam-pool/sam-oidc`
 * provider to its own issuer and primary staging's STS exchange failed. Setup now names a
 * provider per installation, so both installations coexist in one pool. The fake below keeps
 * Google's provider state, answers create conflicts with 409 and records every PATCH.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runGcpDeploySetup } from '../../../src/services/gcp-deploy-setup';
import { installationWifProviderId, runGcpSetup } from '../../../src/services/gcp-setup';

const PROJECT_NUMBER = '353771248703';
const PRIMARY = 'sammy.party';
const STAGING2 = 'sammy2.party';

interface FakeProvider {
  issuerUri: string;
}

let providers: Map<string, FakeProvider>;
let patched: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Google IAM with real provider state for the endpoints setup calls. */
function fakeGoogle(input: string | URL, init?: RequestInit): Response {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if (url.includes('cloudresourcemanager.googleapis.com/v1/projects/') && method === 'GET') {
    return json({ projectNumber: PROJECT_NUMBER });
  }
  if (url.endsWith(':batchEnable')) return json({ done: true });
  if (url.endsWith(':getIamPolicy')) return json({ bindings: [], etag: 'etag-1' });
  if (url.endsWith(':setIamPolicy')) return json({ etag: 'etag-2' });
  if (url.includes('/workloadIdentityPools?') || url.endsWith('/serviceAccounts')) {
    return json({ error: { code: 409 } }, 409);
  }
  const create = url.match(/\/(projects\/.+\/providers)\?workloadIdentityPoolProviderId=([^&]+)/);
  if (create && method === 'POST') {
    const name = `${create[1]}/${create[2]}`;
    if (providers.has(name)) return json({ error: { code: 409 } }, 409);
    const body = JSON.parse(String(init?.body)) as { oidc: FakeProvider };
    providers.set(name, { issuerUri: body.oidc.issuerUri });
    return json({ done: true });
  }
  const resource = url.match(/\/v1\/(projects\/[^?]+\/providers\/[^?/]+)/);
  if (resource) {
    const name = resource[1]!;
    const existing = providers.get(name);
    if (!existing) return json({ error: { code: 404 } }, 404);
    if (method === 'GET') return json({ name, oidc: existing });
    if (method === 'PATCH') {
      patched.push(name);
      const body = JSON.parse(String(init?.body)) as { oidc: FakeProvider };
      providers.set(name, { issuerUri: body.oidc.issuerUri });
      return json({ done: true });
    }
  }
  throw new Error(`Unexpected Google request: ${method} ${url}`);
}

function providerName(pool: string, provider: string): string {
  return `projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`;
}

function envFor(baseDomain: string, extra: Partial<Env> = {}): Env {
  return { BASE_DOMAIN: baseDomain, ...extra } as unknown as Env;
}

async function connect(baseDomain: string, extra: Partial<Env> = {}) {
  return runGcpSetup(
    'oauth-token',
    'sam-staging-infra',
    'us-central1-a',
    envFor(baseDomain, extra),
    { userId: 'user-1' }
  );
}

beforeEach(() => {
  providers = new Map();
  patched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => fakeGoogle(input, init))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('installations sharing one Google Cloud project', () => {
  it('connects primary while the legacy shared provider trusts staging2 (incident shape)', async () => {
    // State after 2026-11-17 12:00:31Z: staging2's setup owns the legacy provider name.
    providers.set(providerName('sam-pool', 'sam-oidc'), { issuerUri: `https://api.${STAGING2}` });

    const credential = await connect(PRIMARY);

    expect(credential.wifProviderId).toBe(await installationWifProviderId(PRIMARY));
    expect(credential.wifProviderId).not.toBe('sam-oidc');
    expect(providers.get(providerName('sam-pool', credential.wifProviderId))).toEqual({
      issuerUri: `https://api.${PRIMARY}`,
    });
    // staging2's trust is untouched.
    expect(providers.get(providerName('sam-pool', 'sam-oidc'))).toEqual({
      issuerUri: `https://api.${STAGING2}`,
    });
    expect(patched).toEqual([]);
  });

  it('keeps both installations trusted when each connects and then re-runs setup', async () => {
    const primary = await connect(PRIMARY);
    const staging2 = await connect(STAGING2);
    // A re-run (for example after a new required API) updates only its own provider.
    const primaryAgain = await connect(PRIMARY);

    expect(primary.wifPoolId).toBe(staging2.wifPoolId);
    expect(primary.wifProviderId).not.toBe(staging2.wifProviderId);
    expect(primaryAgain.wifProviderId).toBe(primary.wifProviderId);
    expect(providers.get(providerName('sam-pool', primary.wifProviderId))?.issuerUri).toBe(
      `https://api.${PRIMARY}`
    );
    expect(providers.get(providerName('sam-pool', staging2.wifProviderId))?.issuerUri).toBe(
      `https://api.${STAGING2}`
    );
    expect(patched).toEqual([providerName('sam-pool', primary.wifProviderId)]);
  });

  it('names deployment providers per installation too', async () => {
    const primary = await runGcpDeploySetup(
      'oauth-token',
      'sam-staging-infra',
      envFor(PRIMARY),
      'sam-project-1'
    );
    const staging2 = await runGcpDeploySetup(
      'oauth-token',
      'sam-staging-infra',
      envFor(STAGING2),
      'sam-project-1'
    );

    expect(primary.wifPoolId).toBe('sam-deploy-pool');
    expect(primary.wifProviderId).not.toBe(staging2.wifProviderId);
    expect(providers.get(providerName('sam-deploy-pool', primary.wifProviderId))?.issuerUri).toBe(
      `https://api.${PRIMARY}`
    );
    expect(providers.get(providerName('sam-deploy-pool', staging2.wifProviderId))?.issuerUri).toBe(
      `https://api.${STAGING2}`
    );
  });

  it('honours an explicit provider override', async () => {
    const credential = await connect(PRIMARY, { GCP_WIF_PROVIDER_ID: 'operator-chosen' });
    expect(credential.wifProviderId).toBe('operator-chosen');
  });

  it('still refuses to take over a foreign provider that has the derived name', async () => {
    const derived = await installationWifProviderId(PRIMARY);
    providers.set(providerName('sam-pool', derived), {
      issuerUri: 'https://api.elsewhere.example',
    });

    await expect(connect(PRIMARY)).rejects.toMatchObject({ step: 'oidc_provider_issuer_mismatch' });
    expect(patched).toEqual([]);
  });
});

describe('installationWifProviderId', () => {
  const GOOGLE_PROVIDER_ID = /^[a-z0-9-]{4,32}$/;

  it.each([
    'sammy.party',
    'sammy2.party',
    'simple-agent-manager.org',
    'a.very.long.self-hosted.subdomain.of.some-company.example.co.uk',
    'X',
    '...',
  ])('produces a valid Google provider ID for %s', async (domain) => {
    const id = await installationWifProviderId(domain);
    expect(id).toMatch(GOOGLE_PROVIDER_ID);
    expect(id.startsWith('gcp-')).toBe(false);
    expect(id.endsWith('-')).toBe(false);
  });

  it('is readable, deterministic and case-insensitive', async () => {
    const id = await installationWifProviderId('sammy2.party');
    expect(id).toMatch(/^sam-sammy2-party-[0-9a-f]{6}$/);
    expect(await installationWifProviderId('SAMMY2.party')).toBe(id);
  });

  it('separates domains whose slugs collide', async () => {
    expect(await installationWifProviderId('a-b.org')).not.toBe(
      await installationWifProviderId('a.b.org')
    );
  });

  it('refuses an empty base domain instead of naming a shared provider', async () => {
    await expect(installationWifProviderId('  ')).rejects.toThrow(/BASE_DOMAIN/);
  });
});
