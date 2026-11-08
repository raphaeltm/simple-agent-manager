/**
 * Which Google APIs a GCP credential is flagged for, and why. Covers the setup-drift record
 * (`enabledApis`), the observed-issue store and its expiry, the classifier that decides whether a
 * Google error is the owner's to fix, and the setup that writes `enabledApis` in the first place.
 */
import { ProviderError } from '@simple-agent-manager/providers';
import {
  GCP_CLOUD_BILLING_SERVICE,
  GCP_CREDENTIAL_VERSION,
  GCP_REQUIRED_APIS,
  type GcpCredential,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  classifyGcpApiError,
  confirmGcpApi,
  GCP_API_HEALTH_KV_PREFIX,
  listGcpApiIssues,
  recordGcpApiIssue,
} from '../../../src/services/gcp-api-health';
import { runGcpSetup } from '../../../src/services/gcp-setup';
import {
  parseGcpCredential,
  serializeGcpCredential,
} from '../../../src/services/provider-credential-codecs';
import { createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const ALL_REQUIRED = GCP_REQUIRED_APIS.map((api) => api.service);

const wif = (enabledApis?: string[]): GcpCredential => ({
  version: GCP_CREDENTIAL_VERSION,
  provider: 'gcp',
  authType: 'workload-identity',
  gcpProjectId: 'owner-project',
  gcpProjectNumber: '123456',
  serviceAccountEmail: 'sam@owner-project.iam.gserviceaccount.com',
  wifPoolId: 'sam-pool',
  wifProviderId: 'sam-provider',
  defaultZone: 'us-central1-a',
  ...(enabledApis ? { enabledApis } : {}),
});

const serviceAccountKey: GcpCredential = {
  version: GCP_CREDENTIAL_VERSION,
  provider: 'gcp',
  authType: 'service-account-key',
  gcpProjectId: 'owner-project',
  serviceAccountEmail: 'sam@owner-project.iam.gserviceaccount.com',
  privateKeyId: 'key-1',
  privateKey: 'not-a-real-key',
  defaultZone: 'us-central1-a',
};

let sqlite: Database.Database;
let env: Env;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(
    'CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);'
  );
  env = { DATABASE: createSqliteD1(sqlite), KV: createMemoryKv() } as unknown as Env;
});

afterEach(() => sqlite.close());

describe('listGcpApiIssues', () => {
  it('flags nothing for a Workload Identity setup that enabled every required API', async () => {
    expect(await listGcpApiIssues(env, 'c1', wif(ALL_REQUIRED), NOW)).toEqual([]);
  });

  it('flags Cloud Billing on a credential set up before SAM recorded its APIs', async () => {
    expect(await listGcpApiIssues(env, 'c1', wif(), NOW)).toEqual([
      {
        service: GCP_CLOUD_BILLING_SERVICE,
        label: 'Cloud Billing',
        reason: 'not_enabled_by_setup',
      },
    ]);
  });

  it('flags an API added to the required list after this credential was set up', async () => {
    const withoutBilling = ALL_REQUIRED.filter((service) => service !== GCP_CLOUD_BILLING_SERVICE);
    expect(await listGcpApiIssues(env, 'c1', wif(withoutBilling), NOW)).toMatchObject([
      { service: GCP_CLOUD_BILLING_SERVICE, reason: 'not_enabled_by_setup' },
    ]);
  });

  it('stops flagging setup drift once a call to the API has succeeded', async () => {
    await confirmGcpApi(env, 'c1', GCP_CLOUD_BILLING_SERVICE);
    expect(await listGcpApiIssues(env, 'c1', wif(), NOW)).toEqual([]);
  });

  it('never flags setup drift on a service-account key, which the owner set up by hand', async () => {
    expect(await listGcpApiIssues(env, 'c1', serviceAccountKey, NOW)).toEqual([]);
  });

  it('shows what Google reported instead of the drift entry, and drops it after the TTL', async () => {
    await recordGcpApiIssue(
      env,
      'c1',
      { service: GCP_CLOUD_BILLING_SERVICE, reason: 'api_disabled' },
      NOW
    );
    expect(await listGcpApiIssues(env, 'c1', serviceAccountKey, NOW)).toEqual([
      {
        service: GCP_CLOUD_BILLING_SERVICE,
        label: 'Cloud Billing',
        reason: 'api_disabled',
        observedAt: NOW.toISOString(),
      },
    ]);
    // One entry per service: the report replaces the drift entry rather than adding to it.
    expect(await listGcpApiIssues(env, 'c1', wif(), NOW)).toMatchObject([
      { service: GCP_CLOUD_BILLING_SERVICE, reason: 'api_disabled' },
    ]);

    const afterTtl = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000 + 1);
    expect(await listGcpApiIssues(env, 'c1', serviceAccountKey, afterTtl)).toEqual([]);
  });

  it('honors an admin-configured TTL', async () => {
    sqlite
      .prepare(
        `INSERT INTO platform_settings (key, value, updated_at) VALUES ('gcpCatalog.apiIssueTtlMinutes', '60', ?)`
      )
      .run(NOW.toISOString());
    await recordGcpApiIssue(
      env,
      'c1',
      { service: GCP_CLOUD_BILLING_SERVICE, reason: 'api_disabled' },
      NOW
    );
    const later = new Date(NOW.getTime() + 61 * 60 * 1000);
    expect(await listGcpApiIssues(env, 'c1', serviceAccountKey, later)).toEqual([]);
  });

  it('a new report withdraws an earlier confirmation, and a later success clears the report', async () => {
    await confirmGcpApi(env, 'c1', GCP_CLOUD_BILLING_SERVICE);
    await recordGcpApiIssue(
      env,
      'c1',
      { service: GCP_CLOUD_BILLING_SERVICE, reason: 'api_disabled' },
      NOW
    );
    expect(await listGcpApiIssues(env, 'c1', wif(), NOW)).toMatchObject([
      { reason: 'api_disabled' },
    ]);

    await confirmGcpApi(env, 'c1', GCP_CLOUD_BILLING_SERVICE);
    expect(await listGcpApiIssues(env, 'c1', wif(), NOW)).toEqual([]);
  });

  it('treats a malformed stored record as empty rather than failing', async () => {
    await env.KV.put(
      `${GCP_API_HEALTH_KV_PREFIX}c1`,
      JSON.stringify({ issues: [{ service: 1 }], confirmed: 'x' })
    );
    expect(await listGcpApiIssues(env, 'c1', serviceAccountKey, NOW)).toEqual([]);
  });

  it("keeps each credential's record separate", async () => {
    await recordGcpApiIssue(
      env,
      'c1',
      { service: GCP_CLOUD_BILLING_SERVICE, reason: 'api_disabled' },
      NOW
    );
    expect(await listGcpApiIssues(env, 'c2', serviceAccountKey, NOW)).toEqual([]);
  });
});

describe('classifyGcpApiError', () => {
  const gcpError = (googleErrorInfo?: Record<string, string>) =>
    new ProviderError('gcp', 403, 'gcp API error (403): denied', {
      providerCode: 'PERMISSION_DENIED',
      ...(googleErrorInfo ? { context: { googleErrorInfo } } : {}),
    });

  it('reads SERVICE_DISABLED as the API being off, naming the service Google reported', () => {
    expect(
      classifyGcpApiError(
        gcpError({ reason: 'SERVICE_DISABLED', service: 'compute.googleapis.com' }),
        GCP_CLOUD_BILLING_SERVICE
      )
    ).toEqual({ service: 'compute.googleapis.com', reason: 'api_disabled' });
  });

  it('falls back to the called service when Google names a non-service string', () => {
    expect(
      classifyGcpApiError(
        gcpError({ reason: 'SERVICE_DISABLED', service: 'not a service' }),
        GCP_CLOUD_BILLING_SERVICE
      )
    ).toEqual({ service: GCP_CLOUD_BILLING_SERVICE, reason: 'api_disabled' });
  });

  it.each(['IAM_PERMISSION_DENIED', 'USER_PROJECT_DENIED'])(
    'reads %s as an owner-fixable denial',
    (reason) => {
      expect(classifyGcpApiError(gcpError({ reason }), GCP_CLOUD_BILLING_SERVICE)).toEqual({
        service: GCP_CLOUD_BILLING_SERVICE,
        reason: 'permission_denied',
      });
    }
  );

  it.each([
    ['a scope SAM failed to request', gcpError({ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' })],
    ['a 403 with no ErrorInfo', gcpError()],
    [
      'another provider',
      new ProviderError('hetzner', 403, 'x', {
        context: { googleErrorInfo: { reason: 'SERVICE_DISABLED' } },
      }),
    ],
    ['a non-provider error', new Error('boom')],
  ])('keeps %s a fault', (_name, error) => {
    expect(classifyGcpApiError(error, GCP_CLOUD_BILLING_SERVICE)).toBeNull();
  });
});

describe('enabledApis on stored credentials', () => {
  it('round-trips through the stored encoding', () => {
    expect(parseGcpCredential(serializeGcpCredential(wif(ALL_REQUIRED)))).toMatchObject({
      enabledApis: ALL_REQUIRED,
    });
  });

  it('reads a credential without the record as predating it', () => {
    expect(parseGcpCredential(serializeGcpCredential(wif()))).not.toHaveProperty('enabledApis');
  });

  it('drops a malformed record instead of making the credential unreadable', () => {
    const malformed = JSON.stringify({ ...wif(), enabledApis: 'compute.googleapis.com' });
    expect(parseGcpCredential(malformed)).not.toHaveProperty('enabledApis');
    const mixed = JSON.stringify({ ...wif(), enabledApis: ['compute.googleapis.com', 7] });
    expect(
      parseGcpCredential(mixed).authType === 'workload-identity' && parseGcpCredential(mixed)
    ).toMatchObject({
      enabledApis: ['compute.googleapis.com'],
    });
  });
});

describe('runGcpSetup', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Google's setup APIs; `existing` answers every create with 409 as on a re-run. */
  function stubGoogleSetup(existing: boolean, enableError = false) {
    const enabledServices: string[][] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(':batchEnable')) {
        enabledServices.push(
          (JSON.parse(String(init?.body)) as { serviceIds: string[] }).serviceIds
        );
        return enableError
          ? json({ done: true, error: { code: 7, message: 'Billing account required' } })
          : json({ done: true });
      }
      if (url.endsWith('cloudresourcemanager.googleapis.com/v1/projects/owner-project')) {
        return json({ projectNumber: '123456' });
      }
      if (
        url.includes('/workloadIdentityPools?') ||
        url.includes('/providers?') ||
        url.endsWith('/serviceAccounts')
      ) {
        return existing ? json({ error: { code: 409 } }, 409) : json({ done: true });
      }
      if (init?.method === 'PATCH') return json({ done: true });
      if (url.endsWith(':getIamPolicy')) return json({ bindings: [], etag: 'etag-1' });
      if (url.endsWith(':setIamPolicy')) return json({ etag: 'etag-2' });
      throw new Error(`Unexpected setup request: ${init?.method ?? 'GET'} ${url}`);
    }) as unknown as typeof fetch;
    return enabledServices;
  }

  const setupEnv = { BASE_DOMAIN: 'example.com' } as unknown as Env;

  it.each([
    ['a first connection', false],
    ['a re-run over existing resources', true],
  ])(
    'enables every required API and records them on the credential for %s',
    async (_name, existing) => {
      const enabledServices = stubGoogleSetup(existing);

      const credential = await runGcpSetup(
        'oauth-token',
        'owner-project',
        'us-central1-a',
        setupEnv
      );

      expect(enabledServices).toEqual([ALL_REQUIRED]);
      expect(credential.enabledApis).toEqual(ALL_REQUIRED);
      expect(await listGcpApiIssues(env, 'fresh', credential, NOW)).toEqual([]);
    }
  );

  it('refuses to record APIs as enabled when Google finished the enable with an error', async () => {
    stubGoogleSetup(false, true);

    await expect(
      runGcpSetup('oauth-token', 'owner-project', 'us-central1-a', setupEnv)
    ).rejects.toMatchObject({ step: 'enable_apis' });
  });
});
