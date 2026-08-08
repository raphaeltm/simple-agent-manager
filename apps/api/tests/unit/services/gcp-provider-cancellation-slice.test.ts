import { ProviderError } from '@simple-agent-manager/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { createProviderForUser } from '../../../src/services/provider-credentials';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  getGcpAccessToken: vi.fn(),
  getPlatformCloudCredential: vi.fn(),
  lazyBackfillIfNeeded: vi.fn(),
  resolveForConsumer: vi.fn(),
}));

vi.mock('../../../src/services/encryption', () => ({ decrypt: mocks.decrypt }));
vi.mock('../../../src/services/gcp-sts', () => ({
  getGcpAccessToken: mocks.getGcpAccessToken,
}));
vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformCloudCredential: mocks.getPlatformCloudCredential,
}));
vi.mock('../../../src/services/composable-credentials/lazy-backfill', () => ({
  lazyBackfillIfNeeded: mocks.lazyBackfillIfNeeded,
}));
vi.mock('../../../src/services/composable-credentials/resolve', () => ({
  resolveForConsumer: mocks.resolveForConsumer,
}));

const USER_ID = 'gcp-cancel-user';
const PROJECT_ID = 'gcp-cancel-project';
const GCP_TOKEN = JSON.stringify({
  version: 1,
  provider: 'gcp',
  authType: 'workload-identity',
  gcpProjectId: 'sam-test-project',
  gcpProjectNumber: '123456789',
  serviceAccountEmail: 'sam-agent@sam-test-project.iam.gserviceaccount.com',
  wifPoolId: 'sam-pool',
  wifProviderId: 'sam-provider',
  defaultZone: 'us-central1-a',
});

function makeCredentialDbMock(row?: Record<string, unknown>) {
  function rowsFor(table: unknown, limited: boolean): unknown[] {
    return table === schema.credentials && limited && row ? [row] : [];
  }
  const makeBuilder = () => {
    let table: unknown;
    const builder = {
      from: (value: unknown) => {
        table = value;
        return builder;
      },
      where: () => builder,
      innerJoin: () => builder,
      leftJoin: () => builder,
      limit: () => Promise.resolve(rowsFor(table, true)),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason?: unknown) => unknown) =>
        Promise.resolve(rowsFor(table, false)).then(resolve, reject),
    };
    return builder;
  };
  return {
    select: () => makeBuilder(),
    insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve() }) }),
  } as unknown as Parameters<typeof createProviderForUser>[0];
}

function legacyGcpCredential() {
  return {
    id: 'legacy-gcp-credential',
    userId: USER_ID,
    projectId: null,
    credentialType: 'cloud-provider',
    credentialKind: 'api-key',
    agentType: null,
    provider: 'gcp',
    encryptedToken: 'ciphertext',
    iv: 'iv',
    isActive: true,
  };
}

function composableGcpResolution() {
  return {
    consumer: { kind: 'compute' as const, provider: 'gcp' },
    configuration: {
      id: 'gcp-configuration',
      ownerId: USER_ID,
      name: 'GCP compute',
      consumer: { kind: 'compute' as const, provider: 'gcp' },
      credentialId: 'gcp-credential',
      settings: {},
      isActive: true,
    },
    credential: {
      id: 'gcp-credential',
      ownerId: USER_ID,
      name: 'GCP credential',
      kind: 'cloud-provider' as const,
      secret: { kind: 'cloud-provider' as const, provider: 'gcp', token: GCP_TOKEN },
      isActive: true,
    },
    source: 'user-attachment' as const,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decrypt.mockResolvedValue(GCP_TOKEN);
  mocks.lazyBackfillIfNeeded.mockResolvedValue(false);
  mocks.resolveForConsumer.mockResolvedValue(null);
  mocks.getPlatformCloudCredential.mockResolvedValue(null);
});

describe('GCP provider credential cancellation wiring', () => {
  it.each([
    {
      name: 'composable credential',
      setup: () => {
        mocks.resolveForConsumer.mockResolvedValue(composableGcpResolution());
        return makeCredentialDbMock();
      },
      expectedCacheUserId: USER_ID,
      expectedSource: 'user',
    },
    {
      name: 'legacy user credential',
      setup: () => makeCredentialDbMock(legacyGcpCredential()),
      expectedCacheUserId: USER_ID,
      expectedSource: 'user',
    },
    {
      name: 'platform fallback credential',
      setup: () => {
        mocks.getPlatformCloudCredential.mockResolvedValue({
          decryptedToken: GCP_TOKEN,
          provider: 'gcp',
        });
        return makeCredentialDbMock();
      },
      expectedCacheUserId: `platform:${USER_ID}`,
      expectedSource: 'platform',
    },
  ])(
    'forwards caller cancellation through the $name token closure',
    async ({ setup, expectedCacheUserId, expectedSource }) => {
      const fetchMock = vi.fn();
      const kvPut = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      let receivedSignal: AbortSignal | undefined;
      mocks.getGcpAccessToken.mockImplementation(
        (
          _userId: string,
          _projectId: string,
          _credential: unknown,
          _env: unknown,
          context?: { signal?: AbortSignal }
        ) => {
          receivedSignal = context?.signal;
          return new Promise<string>((_resolve, reject) => {
            receivedSignal?.addEventListener('abort', () => reject(receivedSignal?.reason), {
              once: true,
            });
          });
        }
      );
      const providerResult = await createProviderForUser(
        setup(),
        USER_ID,
        'encryption-key',
        { KV: { put: kvPut } } as unknown as Parameters<typeof createProviderForUser>[3],
        'gcp',
        PROJECT_ID
      );
      if (!providerResult) {
        throw new Error(`Expected ${expectedSource} credentials to create a GCP provider`);
      }
      expect(providerResult?.credentialSource).toBe(expectedSource);
      const caller = new AbortController();
      const reason = new ProviderError('gcp', 503, `caller cancelled ${expectedSource} token`);

      const validation = providerResult.provider
        .validateToken({ signal: caller.signal })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(mocks.getGcpAccessToken).toHaveBeenCalledTimes(1));
      caller.abort(reason);

      expect(await validation).toBe(reason);
      expect(receivedSignal).toBe(caller.signal);
      expect(mocks.getGcpAccessToken).toHaveBeenCalledWith(
        expectedCacheUserId,
        PROJECT_ID,
        expect.objectContaining({ provider: 'gcp' }),
        expect.any(Object),
        { signal: caller.signal }
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(kvPut).not.toHaveBeenCalled();
    }
  );
});
