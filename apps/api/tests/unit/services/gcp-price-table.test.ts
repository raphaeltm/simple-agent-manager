/**
 * The installation-wide GCP price table: refreshed by a scheduled step from any connected Google
 * Cloud credential, read by catalog builds. Credentials live in a real SQLite engine; the token
 * exchange is replaced at `getGcpAccessToken` so the identity each credential is minted with can
 * be asserted (workload identity binds a project-scoped credential to its SAM project).
 */
import { Buffer } from 'node:buffer';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { encrypt } from '../../../src/services/encryption';
import {
  GCP_PRICE_TABLE_ATTEMPT_KV_KEY,
  GCP_PRICE_TABLE_KV_KEY,
  readGcpPriceTable,
  refreshGcpPriceTableIfDue,
} from '../../../src/services/gcp-price-table';
import { serializeGcpCredential } from '../../../src/services/provider-credential-codecs';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const tokenCalls: Array<{ userId: string; projectId: string; gcpProjectId: string }> = [];
vi.mock('../../../src/services/gcp-sts', () => ({
  getGcpAccessToken: async (
    userId: string,
    projectId: string,
    credential: { gcpProjectId: string }
  ) => {
    tokenCalls.push({ userId, projectId, gcpProjectId: credential.gcpProjectId });
    return `token-for-${credential.gcpProjectId}`;
  },
}));

const KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const NOW = new Date('2026-11-07T12:00:00.000Z');

let sqlite: Database.Database;
let env: Env;

function gcpCredential(gcpProjectId: string) {
  return serializeGcpCredential({
    version: 1,
    provider: 'gcp',
    authType: 'workload-identity',
    gcpProjectId,
    gcpProjectNumber: '123456',
    serviceAccountEmail: `sam@${gcpProjectId}.iam.gserviceaccount.com`,
    wifPoolId: 'sam-pool',
    wifProviderId: 'sam-provider',
    defaultZone: 'us-central1-a',
  });
}

async function seedPlatform(id: string, gcpProjectId: string, updatedAt: string) {
  const { ciphertext, iv } = await encrypt(gcpCredential(gcpProjectId), KEY);
  sqlite
    .prepare(
      `INSERT INTO platform_credentials (id, credential_type, provider, label, encrypted_token, iv, is_enabled, created_by, created_at, updated_at)
       VALUES (?, 'cloud-provider', 'gcp', 'gcp', ?, ?, 1, 'admin-1', ?, ?)`
    )
    .run(id, ciphertext, iv, updatedAt, updatedAt);
}

async function seedOwned(
  id: string,
  gcpProjectId: string,
  input: { projectId?: string | null; updatedAt: string; provider?: string; active?: 0 | 1 }
) {
  const { ciphertext, iv } = await encrypt(gcpCredential(gcpProjectId), KEY);
  sqlite
    .prepare(
      `INSERT INTO credentials (id, user_id, project_id, provider, credential_type, is_active, encrypted_token, iv, created_at, updated_at)
       VALUES (?, 'user-1', ?, ?, 'cloud-provider', ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.projectId ?? null,
      input.provider ?? 'gcp',
      input.active ?? 1,
      ciphertext,
      iv,
      input.updatedAt,
      input.updatedAt
    );
}

function sku(description: string, price: number) {
  return {
    description,
    category: { usageType: 'OnDemand' },
    serviceRegions: ['us-central1'],
    pricingInfo: [
      {
        pricingExpression: {
          usageUnit: description.includes('Ram') ? 'GiBy.h' : 'h',
          tieredRates: [
            {
              startUsageAmount: 0,
              unitPrice: { currencyCode: 'USD', units: '0', nanos: price * 1e9 },
            },
          ],
        },
      },
    ],
  };
}

/** Billing API answers per token: a project whose token is listed here has the API disabled. */
function stubBilling(disabledProjects: string[] = []) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.host).toBe('cloudbilling.googleapis.com');
    const auth = (init?.headers as Record<string, string>).Authorization ?? '';
    if (disabledProjects.some((project) => auth.endsWith(project))) {
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Cloud Billing API has not been used in project 123 before or it is disabled.',
            status: 'PERMISSION_DENIED',
          },
        }),
        { status: 403 }
      );
    }
    return new Response(
      JSON.stringify({
        skus: [
          sku('E2 Instance Core running in Americas', 0.021811),
          sku('E2 Instance Ram running in Americas', 0.002923),
        ],
      })
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('GCP price table', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tokenCalls.length = 0;
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('user-1', 'u@example.com', 'U', ?, ?)`
      )
      .run(NOW.toISOString(), NOW.toISOString());
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('admin-1', 'a@example.com', 'A', ?, ?)`
      )
      .run(NOW.toISOString(), NOW.toISOString());
    sqlite
      .prepare(
        `INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES ('project-9', 'user-1', 'P', ?, ?)`
      )
      .run(NOW.toISOString(), NOW.toISOString());
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      ENCRYPTION_KEY: KEY,
    } as unknown as Env;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    sqlite.close();
  });

  it('refreshes from a platform credential first and stores one table for the installation', async () => {
    await seedOwned('cred-user', 'user-gcp', { updatedAt: '2026-11-06T00:00:00Z' });
    await seedPlatform('cred-platform', 'platform-gcp', '2026-11-01T00:00:00Z');
    const fetchMock = stubBilling();

    const result = await refreshGcpPriceTableIfDue(env, NOW);

    expect(result).toMatchObject({ status: 'refreshed', credentialSource: 'platform', regions: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenCalls).toEqual([
      { userId: 'platform:admin-1', projectId: 'platform-gcp', gcpProjectId: 'platform-gcp' },
    ]);
    const table = await readGcpPriceTable(env);
    expect(table?.regions['us-central1']?.e2).toEqual({
      coreHourly: 0.021811,
      ramGibHourly: 0.002923,
    });
  });

  it('mints a project-scoped credential for its SAM project, as provisioning does', async () => {
    await seedOwned('cred-project', 'project-gcp', {
      projectId: 'project-9',
      updatedAt: '2026-11-06T00:00:00Z',
    });
    stubBilling();

    await refreshGcpPriceTableIfDue(env, NOW);

    expect(tokenCalls).toEqual([
      { userId: 'project:project-9:user-1', projectId: 'project-9', gcpProjectId: 'project-gcp' },
    ]);
  });

  it('moves to the next credential when one has the Cloud Billing API disabled', async () => {
    await seedOwned('cred-a', 'disabled-gcp', { updatedAt: '2026-11-06T00:00:00Z' });
    await seedOwned('cred-b', 'enabled-gcp', { updatedAt: '2026-11-05T00:00:00Z' });
    stubBilling(['disabled-gcp']);

    const result = await refreshGcpPriceTableIfDue(env, NOW);

    expect(result).toMatchObject({ status: 'refreshed', credentialSource: 'user' });
    expect(tokenCalls.map((call) => call.gcpProjectId)).toEqual(['disabled-gcp', 'enabled-gcp']);
  });

  it('skips while the table is fresh, and refreshes once it is past the TTL', async () => {
    await seedOwned('cred-a', 'enabled-gcp', { updatedAt: '2026-11-06T00:00:00Z' });
    const fetchMock = stubBilling();
    await refreshGcpPriceTableIfDue(env, NOW);

    const later = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    expect(await refreshGcpPriceTableIfDue(env, later)).toEqual({
      status: 'fresh',
      fetchedAt: NOW.toISOString(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stale = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    expect(await refreshGcpPriceTableIfDue(env, stale)).toMatchObject({ status: 'refreshed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('backs off after every credential fails, keeps the old table, then retries', async () => {
    await env.KV.put(
      GCP_PRICE_TABLE_KV_KEY,
      JSON.stringify({
        fetchedAt: '2026-11-01T00:00:00.000Z',
        table: {
          currency: 'USD',
          regions: { 'us-east1': { e2: { coreHourly: 0.02, ramGibHourly: 0.003 } } },
        },
      })
    );
    await seedOwned('cred-a', 'disabled-gcp', { updatedAt: '2026-11-06T00:00:00Z' });
    const fetchMock = stubBilling(['disabled-gcp']);

    expect(await refreshGcpPriceTableIfDue(env, NOW)).toEqual({ status: 'failed', attempts: 1 });
    expect(await env.KV.get(GCP_PRICE_TABLE_ATTEMPT_KV_KEY)).toBe(NOW.toISOString());
    // The previous table is still served.
    expect((await readGcpPriceTable(env))?.regions['us-east1']?.e2?.coreHourly).toBe(0.02);

    const soon = new Date(NOW.getTime() + 30 * 60 * 1000);
    expect(await refreshGcpPriceTableIfDue(env, soon)).toMatchObject({ status: 'backoff' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const afterRetry = new Date(NOW.getTime() + 61 * 60 * 1000);
    expect(await refreshGcpPriceTableIfDue(env, afterRetry)).toEqual({
      status: 'failed',
      attempts: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports no credential without recording a failure', async () => {
    await seedOwned('cred-hetzner', 'unused', {
      updatedAt: '2026-11-06T00:00:00Z',
      provider: 'hetzner',
    });
    await seedOwned('cred-inactive', 'inactive-gcp', {
      updatedAt: '2026-11-06T00:00:00Z',
      active: 0,
    });
    const fetchMock = stubBilling();

    expect(await refreshGcpPriceTableIfDue(env, NOW)).toEqual({ status: 'no-credential' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await env.KV.get(GCP_PRICE_TABLE_ATTEMPT_KV_KEY)).toBeNull();
  });

  it('treats a malformed stored table as absent', async () => {
    await env.KV.put(
      GCP_PRICE_TABLE_KV_KEY,
      JSON.stringify({ fetchedAt: 'not a date', table: {} })
    );
    expect(await readGcpPriceTable(env)).toBeNull();
  });
});
