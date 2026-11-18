import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOidcProvider, updateOidcProvider } from '../../../src/services/gcp-setup';

const name = 'projects/123456/locations/global/workloadIdentityPools/shared/providers/sam-oidc';
const issuer = 'https://api.primary.example';
let fetchMock: ReturnType<typeof vi.fn>;

function existingProvider(body: unknown) {
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') return Response.json({}, { status: 409 });
    if (init?.method === 'PATCH') return Response.json({ name: 'operations/update', done: true });
    return Response.json(body);
  });
}

async function create() {
  return createOidcProvider('oauth-token', '123456', 'shared', 'sam-oidc', issuer, 5000);
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('OIDC provider conflicts preserve the other installation', () => {
  it('refuses the staging2 issuer after a create conflict without sending a PATCH', async () => {
    existingProvider({ name, oidc: { issuerUri: 'https://api.secondary.example' } });
    await expect(create()).rejects.toMatchObject({
      name: 'GcpApiError',
      step: 'oidc_provider_issuer_mismatch',
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['POST', 'GET']);
  });

  it('also protects a direct update caller from changing another issuer', async () => {
    existingProvider({ name, oidc: { issuerUri: 'https://api.secondary.example' } });
    await expect(
      updateOidcProvider('oauth-token', '123456', 'shared', 'sam-oidc', issuer, 5000)
    ).rejects.toMatchObject({ step: 'oidc_provider_issuer_mismatch' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('updates an existing provider for the same installation (upgrade control)', async () => {
    existingProvider({ name, oidc: { issuerUri: issuer } });
    await expect(create()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'POST',
      'GET',
      'PATCH',
    ]);
    const patch = JSON.parse(fetchMock.mock.calls[2]![1].body);
    expect(patch.oidc.issuerUri).toBe(issuer);
  });

  it('creates a new provider without an extra lookup (clean-install control)', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ name: 'operations/create', done: true }));
    await expect(create()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name },
    { name, oidc: {} },
    { name, oidc: { issuerUri: null } },
    { name: 'projects/foreign/provider', oidc: { issuerUri: issuer } },
  ])('refuses malformed or different provider identity without PATCH: %j', async (body) => {
    existingProvider(body);
    await expect(create()).rejects.toThrow();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('preserves a failed lookup instead of updating an unknown provider', async () => {
    fetchMock.mockImplementation(async (_url, init) =>
      Response.json({}, { status: init?.method === 'POST' ? 409 : 403 })
    );
    await expect(create()).rejects.toThrow();
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['POST', 'GET']);
  });
});
