import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security tests for WIF provider conditions and service-account bindings.
 * Every provider and binding is scoped to one SAM project (deployment setup) or one SAM user
 * (user-level guided setup); there is no issuer-only scope, so a token SAM signs for one user
 * or project cannot impersonate another's service account.
 */

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { createOidcProvider, updateOidcProvider, grantWifUserOnSa } =
  await import('../../../src/services/gcp-setup');
const { wifAttributeCondition, wifServiceAccountMember, legacyPoolWideMember } =
  await import('../../../src/services/gcp-wif-setup');

const ISSUER = 'https://api.example.com';
const POOL_PATH =
  'iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/sam-pool';
const PROVIDER_NAME =
  'projects/123456/locations/global/workloadIdentityPools/sam-pool/providers/sam-oidc';
const USER_SCOPE = { kind: 'user', userId: 'user-a' } as const;
const PROJECT_SCOPE = { kind: 'project', samProjectId: 'proj-abc-123' } as const;
const WIF_ROLE = 'roles/iam.workloadIdentityUser';

function mockGcpResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function requestBody(index: number): Record<string, unknown> {
  const call = mockFetch.mock.calls[index];
  return JSON.parse(call![1]!.body as string) as Record<string, unknown>;
}

interface PolicyBinding {
  role: string;
  members: string[];
}

function setPolicyBindings(index: number): PolicyBinding[] {
  const body = requestBody(index) as { policy: { bindings: PolicyBinding[] } };
  return body.policy.bindings;
}

describe('WIF trust scoping (cross-owner impersonation prevention)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('condition and member strings', () => {
    it('scopes a user-level provider to the user_id claim', () => {
      expect(wifAttributeCondition(ISSUER, USER_SCOPE)).toBe(
        "assertion.iss == 'https://api.example.com' && assertion.user_id == 'user-a'"
      );
    });

    it('scopes a deployment provider to the project_id claim', () => {
      expect(wifAttributeCondition(ISSUER, PROJECT_SCOPE)).toBe(
        "assertion.iss == 'https://api.example.com' && assertion.project_id == 'proj-abc-123'"
      );
    });

    it('binds a user to attribute.sam_user and a project to its subject', () => {
      expect(wifServiceAccountMember('123456', 'sam-pool', USER_SCOPE)).toBe(
        `principalSet://${POOL_PATH}/attribute.sam_user/user-a`
      );
      expect(wifServiceAccountMember('123456', 'sam-pool', PROJECT_SCOPE)).toBe(
        `principal://${POOL_PATH}/subject/project:proj-abc-123`
      );
      expect(legacyPoolWideMember('123456', 'sam-pool')).toBe(`principalSet://${POOL_PATH}/*`);
    });

    it('two users sharing a GCP project get non-overlapping members and conditions', () => {
      const userB = { kind: 'user', userId: 'user-b' } as const;
      expect(wifServiceAccountMember('123456', 'sam-pool', USER_SCOPE)).not.toBe(
        wifServiceAccountMember('123456', 'sam-pool', userB)
      );
      expect(wifAttributeCondition(ISSUER, USER_SCOPE)).not.toBe(
        wifAttributeCondition(ISSUER, userB)
      );
    });
  });

  describe('createOidcProvider', () => {
    it('creates a user-level provider with the user-scoped condition', async () => {
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      await createOidcProvider('token', '123456', 'sam-pool', 'sam-oidc', ISSUER, 5000, USER_SCOPE);

      const body = requestBody(0);
      expect(body.attributeCondition).toBe(
        "assertion.iss == 'https://api.example.com' && assertion.user_id == 'user-a'"
      );
      expect(body.attributeMapping).toMatchObject({ 'attribute.sam_user': 'assertion.user_id' });
    });

    it('creates a deployment provider with the project-scoped condition', async () => {
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      await createOidcProvider(
        'token',
        '123456',
        'sam-pool',
        'sam-oidc',
        ISSUER,
        5000,
        PROJECT_SCOPE
      );

      expect(requestBody(0).attributeCondition).toBe(
        "assertion.iss == 'https://api.example.com' && assertion.project_id == 'proj-abc-123'"
      );
    });

    it('narrows an existing issuer-only provider to the user on a 409 re-run', async () => {
      mockFetch.mockResolvedValueOnce(mockGcpResponse({}, 409));
      mockFetch.mockResolvedValueOnce(
        mockGcpResponse({ name: PROVIDER_NAME, oidc: { issuerUri: ISSUER } })
      );
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      await createOidcProvider('token', '123456', 'sam-pool', 'sam-oidc', ISSUER, 5000, USER_SCOPE);

      expect(mockFetch.mock.calls[2]![1]!.method).toBe('PATCH');
      expect(requestBody(2).attributeCondition).toBe(
        "assertion.iss == 'https://api.example.com' && assertion.user_id == 'user-a'"
      );
    });
  });

  describe('updateOidcProvider', () => {
    it.each([
      ['user', USER_SCOPE, "assertion.user_id == 'user-a'"],
      ['project', PROJECT_SCOPE, "assertion.project_id == 'proj-abc-123'"],
    ] as const)('patches the %s-scoped condition', async (_name, scope, claim) => {
      mockFetch.mockResolvedValueOnce(
        mockGcpResponse({ name: PROVIDER_NAME, oidc: { issuerUri: ISSUER } })
      );
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      await updateOidcProvider('token', '123456', 'sam-pool', 'sam-oidc', ISSUER, 5000, scope);

      expect(mockFetch.mock.calls[1]![1]!.method).toBe('PATCH');
      expect(requestBody(1).attributeCondition).toBe(
        `assertion.iss == 'https://api.example.com' && ${claim}`
      );
    });
  });

  describe('grantWifUserOnSa', () => {
    async function grant(
      bindings: PolicyBinding[],
      scope: typeof USER_SCOPE | typeof PROJECT_SCOPE = USER_SCOPE
    ) {
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ bindings, etag: 'abc' }));
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ etag: 'def' }));
      await grantWifUserOnSa(
        'token',
        'my-gcp-project',
        '123456',
        'sa@my-gcp-project.iam.gserviceaccount.com',
        'sam-pool',
        5000,
        scope
      );
    }

    it('grants a user-level setup the sam_user member, never the pool-wide wildcard', async () => {
      await grant([]);

      const binding = setPolicyBindings(1).find((b) => b.role === WIF_ROLE);
      expect(binding?.members).toEqual([`principalSet://${POOL_PATH}/attribute.sam_user/user-a`]);
    });

    it('grants a deployment setup the subject-scoped principal', async () => {
      await grant([], PROJECT_SCOPE);

      const binding = setPolicyBindings(1).find((b) => b.role === WIF_ROLE);
      expect(binding?.members).toEqual([`principal://${POOL_PATH}/subject/project:proj-abc-123`]);
    });

    it('re-running setup removes the pool-wide member an earlier setup granted', async () => {
      const otherPoolWide =
        'principalSet://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/other-pool/*';
      await grant([
        { role: WIF_ROLE, members: [`principalSet://${POOL_PATH}/*`, otherPoolWide] },
        { role: 'roles/viewer', members: ['user:owner@example.com'] },
      ]);

      const bindings = setPolicyBindings(1);
      expect(bindings.find((b) => b.role === WIF_ROLE)?.members).toEqual([
        // Only this pool's wildcard is removed; another pool's binding is not SAM's to change.
        otherPoolWide,
        `principalSet://${POOL_PATH}/attribute.sam_user/user-a`,
      ]);
      expect(bindings.find((b) => b.role === 'roles/viewer')?.members).toEqual([
        'user:owner@example.com',
      ]);
    });

    it('removes the pool-wide member even when the scoped member is already granted', async () => {
      await grant([
        {
          role: WIF_ROLE,
          members: [
            `principalSet://${POOL_PATH}/*`,
            `principalSet://${POOL_PATH}/attribute.sam_user/user-a`,
          ],
        },
      ]);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(setPolicyBindings(1)).toEqual([
        { role: WIF_ROLE, members: [`principalSet://${POOL_PATH}/attribute.sam_user/user-a`] },
      ]);
    });

    it('drops a binding left empty after removing the pool-wide member', async () => {
      await grant([
        { role: WIF_ROLE, members: [`principalSet://${POOL_PATH}/*`] },
        { role: WIF_ROLE, members: [`principalSet://${POOL_PATH}/attribute.sam_user/user-a`] },
      ]);

      expect(setPolicyBindings(1)).toEqual([
        { role: WIF_ROLE, members: [`principalSet://${POOL_PATH}/attribute.sam_user/user-a`] },
      ]);
    });

    it('reads the policy as version 3 and removes a conditional pool-wide grant', async () => {
      const keepCondition = {
        title: 'business-hours',
        expression: 'request.time < timestamp("2030-01-01T00:00:00Z")',
      };
      mockFetch.mockResolvedValueOnce(
        mockGcpResponse({
          version: 3,
          etag: 'abc',
          bindings: [
            {
              role: WIF_ROLE,
              members: [`principalSet://${POOL_PATH}/*`],
              condition: { title: 'legacy', expression: 'true' },
            },
            { role: WIF_ROLE, members: ['user:ops@example.com'], condition: keepCondition },
          ],
        })
      );
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ etag: 'def' }));

      await grantWifUserOnSa(
        'token',
        'my-gcp-project',
        '123456',
        'sa@my-gcp-project.iam.gserviceaccount.com',
        'sam-pool',
        5000,
        USER_SCOPE
      );

      expect(requestBody(0)).toEqual({ options: { requestedPolicyVersion: 3 } });
      const policy = (requestBody(1) as { policy: Record<string, unknown> }).policy;
      expect(policy.version).toBe(3);
      expect(policy.bindings).toEqual([
        { role: WIF_ROLE, members: ['user:ops@example.com'], condition: keepCondition },
        // Never added under another binding's condition.
        { role: WIF_ROLE, members: [`principalSet://${POOL_PATH}/attribute.sam_user/user-a`] },
      ]);
    });

    it('leaves the policy untouched when already scoped and no wildcard remains', async () => {
      mockFetch.mockResolvedValueOnce(
        mockGcpResponse({
          bindings: [
            { role: WIF_ROLE, members: [`principalSet://${POOL_PATH}/attribute.sam_user/user-a`] },
          ],
          etag: 'abc',
        })
      );

      await grantWifUserOnSa(
        'token',
        'my-gcp-project',
        '123456',
        'sa@my-gcp-project.iam.gserviceaccount.com',
        'sam-pool',
        5000,
        USER_SCOPE
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('CEL injection prevention', () => {
    it('rejects a samProjectId with single quotes', async () => {
      await expect(
        createOidcProvider('token', '123456', 'sam-pool', 'sam-oidc', ISSUER, 5000, {
          kind: 'project',
          samProjectId: "x' || true || 'y",
        })
      ).rejects.toThrow('unsafe for CEL interpolation');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a userId with single quotes before any request', async () => {
      await expect(
        createOidcProvider('token', '123456', 'sam-pool', 'sam-oidc', ISSUER, 5000, {
          kind: 'user',
          userId: "u' || true || 'v",
        })
      ).rejects.toThrow('unsafe for CEL interpolation');
      await expect(
        grantWifUserOnSa('token', 'p', '123456', 'sa@x.com', 'sam-pool', 5000, {
          kind: 'user',
          userId: 'user with spaces',
        })
      ).rejects.toThrow('unsafe for CEL interpolation');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a missing scope value instead of interpolating "undefined"', () => {
      expect(() =>
        wifAttributeCondition(ISSUER, { kind: 'user', userId: undefined as unknown as string })
      ).toThrow('unsafe for CEL interpolation');
    });

    it('accepts ULID and Better Auth id formats', async () => {
      mockFetch.mockResolvedValue(mockGcpResponse({ name: 'op/1', done: true }));
      await expect(
        createOidcProvider('token', '123456', 'sam-pool', 'sam-oidc', ISSUER, 5000, {
          kind: 'project',
          samProjectId: '01KHRJGANBBWGDY1NZ0KVF0D4J',
        })
      ).resolves.toBeUndefined();
      await expect(
        createOidcProvider('token', '123456', 'sam-pool', 'sam-oidc', ISSUER, 5000, {
          kind: 'user',
          userId: '4bw1FJlXCOgSGq0TsQgpiMAhQKjGOSXx',
        })
      ).resolves.toBeUndefined();
    });
  });
});
