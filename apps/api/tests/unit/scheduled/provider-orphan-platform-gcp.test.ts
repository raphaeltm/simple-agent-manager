import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runProviderOrphanReconciliation } from '../../../src/scheduled/provider-orphan-reconciliation';
import { encrypt } from '../../../src/services/encryption';

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => state.rows }) }) }),
  }),
}));
vi.mock('../../../src/services/admin-settings-resolution', () => ({
  resolveAdminSetting: vi.fn(async () => undefined),
}));
vi.mock('../../../src/scheduled/provider-orphan-credentials', () => ({
  listInventoryCredentials: vi.fn(async () => []),
  markInventoryCredentialAttempted: vi.fn(),
  resolveInventoryProvider: vi.fn(),
}));
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));
vi.mock('../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/logger')>()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  listInventoryCredentials,
  resolveInventoryProvider,
} from '../../../src/scheduled/provider-orphan-credentials';

const INSTALLATION = '0123456789abcdef0123456789abcdef';
const FOREIGN = 'fedcba9876543210fedcba9876543210';
const NODE = '01kx84mcg1yn1tqvwr60b3g70a';
const KEY = btoa('0123456789abcdef0123456789abcdef');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const baseCredential = {
  version: 1,
  provider: 'gcp',
  gcpProjectId: 'test-project',
  gcpProjectNumber: '123456789',
  serviceAccountEmail: 'sweep@test-project.iam.gserviceaccount.com',
  defaultZone: 'us-central1-a',
};
const wifCredential = {
  ...baseCredential,
  authType: 'workload-identity',
  wifPoolId: 'test-pool',
  wifProviderId: 'test-provider',
};

function instance(id: string, installation: string | undefined) {
  return {
    id,
    name: `vm-${id}`,
    status: 'RUNNING',
    machineType: 'zones/us-central1-a/machineTypes/e2-medium',
    zone: 'https://www.googleapis.com/compute/v1/projects/test-project/zones/us-central1-a',
    creationTimestamp: '2026-01-01T00:00:00Z',
    labels: {
      managed: 'simple-agent-manager',
      'sam-managed': 'true',
      node: NODE,
      env: 'production',
      ...(installation ? { installation } : {}),
    },
  };
}

async function setup(credential: unknown = wifCredential) {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const pem = await exportPKCS8(privateKey);
  const encrypted = await encrypt(JSON.stringify(credential), KEY);
  state.rows = [
    {
      id: 'platform-gcp',
      provider: 'gcp',
      encryptedToken: encrypted.ciphertext,
      iv: encrypted.iv,
      createdBy: 'admin-owner',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  const cache = new Map<string, string>();
  const env = {
    ENVIRONMENT: 'production',
    SAM_INSTALLATION_ID: INSTALLATION,
    ENCRYPTION_KEY: KEY,
    JWT_PRIVATE_KEY: pem,
    BASE_DOMAIN: 'example.test',
    KV: {
      get: vi.fn(async (key: string) => cache.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        cache.set(key, value);
      }),
    },
    DATABASE: {
      prepare: vi.fn(() => ({
        bind: (...ids: string[]) => ({
          all: async () => ({
            success: true,
            results: ids.map((requested_id) => ({
              requested_id,
              id: null,
              status: null,
              provider_instance_id: null,
            })),
          }),
        }),
      })),
    },
  } as unknown as Env;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('sts.googleapis.com'))
      return json({ access_token: 'test-sts-token', token_type: 'Bearer', expires_in: 3600 });
    if (url.includes(':generateAccessToken'))
      return json({
        accessToken: 'test-access-token',
        expireTime: new Date(Date.now() + 3600000).toISOString(),
      });
    if (url.includes('oauth2.googleapis.com/token'))
      return json({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 3600 });
    if (url.includes('/aggregated/instances'))
      return json({
        items: {
          'zones/us-central1-a': {
            instances: [
              instance('123', INSTALLATION),
              instance('456', FOREIGN),
              instance('789', undefined),
            ],
          },
        },
      });
    if (init?.method === 'DELETE' && url.endsWith('/instances/vm-123'))
      return json({ name: 'delete-operation', status: 'DONE' });
    if (url.endsWith('/operations/delete-operation'))
      return json({ name: 'delete-operation', status: 'DONE' });
    // Real GCP `instances.get` accepts the numeric id, in the instance's own zone only.
    if (url.endsWith('/zones/us-central1-a/instances/123'))
      return json(instance('123', INSTALLATION));
    if (/\/instances\/\d+$/.test(url)) return json({}, 404);
    if (url.endsWith('/instances/vm-123')) return json(instance('123', INSTALLATION));
    throw new Error(`Unexpected provider request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { env, fetchMock, pem };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listInventoryCredentials).mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe('platform GCP orphan sweep configuration and authentication', () => {
  it('exchanges platform workload identity and deletes only the exact-install orphan', async () => {
    const { env, fetchMock } = await setup();
    const result = await runProviderOrphanReconciliation(env);

    expect(result.errors).toBe(0);
    expect(result.deletionRequested).toBe(1);
    expect(result.destroyed).toBe(0);
    const sts = fetchMock.mock.calls.find(([url]) => String(url).includes('sts.googleapis.com'));
    expect(sts).toBeDefined();
    const body = JSON.parse(sts![1]!.body as string);
    const claims = JSON.parse(
      atob(body.subjectToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    );
    expect(claims).toMatchObject({ user_id: 'platform:admin-owner', project_id: 'test-project' });
    const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect(deletes.map(([url]) => String(url))).toEqual([
      'https://compute.googleapis.com/compute/v1/projects/test-project/zones/us-central1-a/instances/vm-123',
    ]);
    expect(env.KV.put).toHaveBeenCalledWith(
      'cleanup:provider-orphan-reconciliation:last-run',
      expect.any(String)
    );
  });

  it('also exchanges a platform service-account key through the existing GCP token path', async () => {
    const { pem } = await setup();
    const { env, fetchMock } = await setup({
      ...baseCredential,
      authType: 'service-account-key',
      privateKeyId: 'test-key-id',
      privateKey: pem,
      tokenUri: 'https://oauth2.googleapis.com/token',
    });
    const result = await runProviderOrphanReconciliation(env);
    expect(result.errors).toBe(0);
    expect(result.deletionRequested).toBe(1);
    expect(result.destroyed).toBe(0);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('oauth2.googleapis.com/token'))
    ).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('sts.googleapis.com'))).toBe(
      false
    );
  });

  it('continues inventory after platform configuration and one account fail', async () => {
    const { env } = await setup({ invalid: true });
    const credentials = [{ id: 'bad' }, { id: 'good' }];
    vi.mocked(listInventoryCredentials).mockResolvedValue(credentials as never);
    const listVMs = vi.fn().mockResolvedValue([]);
    const deleteVM = vi.fn();
    vi.mocked(resolveInventoryProvider)
      .mockRejectedValueOnce(new Error('credential unavailable'))
      .mockResolvedValueOnce({ provider: { listVMs, deleteVM } } as never);

    const result = await runProviderOrphanReconciliation(env);
    // Platform configuration failure fails the sweep; the account failure is account-scoped.
    expect(result.errors).toBe(1);
    expect(result.accountErrors).toBe(1);
    expect(result.skipped).toBe(false);
    expect(resolveInventoryProvider).toHaveBeenCalledTimes(2);
    expect(listVMs).toHaveBeenCalledWith(
      {
        managed: 'simple-agent-manager',
        env: 'production',
        installation: INSTALLATION,
      },
      expect.any(Object)
    );
    expect(deleteVM).not.toHaveBeenCalled();
  });
});
