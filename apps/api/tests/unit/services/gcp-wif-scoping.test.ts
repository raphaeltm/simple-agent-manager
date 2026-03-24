import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Security tests for WIF pool IAM binding scoping.
 * Verifies that identity tokens are scoped to specific SAM projects,
 * preventing cross-project impersonation within the same WIF pool.
 */

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { createOidcProvider, updateOidcProvider, grantWifUserOnSa } = await import(
  '../../../src/services/gcp-setup'
);

function mockGcpResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('WIF pool scoping (cross-project impersonation prevention)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('createOidcProvider', () => {
    it('enforces project-scoped attributeCondition when samProjectId is provided', async () => {
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      await createOidcProvider(
        'token',
        '123456',
        'sam-pool',
        'sam-oidc',
        'https://api.example.com',
        5000,
        'proj-abc-123',
      );

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call![1]!.body as string);
      expect(body.attributeCondition).toBe(
        "assertion.iss == 'https://api.example.com' && assertion.project_id == 'proj-abc-123'",
      );
    });

    it('uses issuer-only attributeCondition when samProjectId is not provided', async () => {
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      await createOidcProvider(
        'token',
        '123456',
        'sam-pool',
        'sam-oidc',
        'https://api.example.com',
        5000,
      );

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call![1]!.body as string);
      expect(body.attributeCondition).toBe("assertion.iss == 'https://api.example.com'");
    });

    it('passes samProjectId to updateOidcProvider on 409 conflict', async () => {
      // First call returns 409 (already exists)
      mockFetch.mockResolvedValueOnce(mockGcpResponse({}, 409));
      // Second call is the PATCH update
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      await createOidcProvider(
        'token',
        '123456',
        'sam-pool',
        'sam-oidc',
        'https://api.example.com',
        5000,
        'proj-abc-123',
      );

      // The update call (second fetch) should have project-scoped condition
      const updateCall = mockFetch.mock.calls[1];
      const updateBody = JSON.parse(updateCall![1]!.body as string);
      expect(updateBody.attributeCondition).toBe(
        "assertion.iss == 'https://api.example.com' && assertion.project_id == 'proj-abc-123'",
      );
    });
  });

  describe('updateOidcProvider', () => {
    it('enforces project-scoped attributeCondition when samProjectId is provided', async () => {
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      await updateOidcProvider(
        'token',
        '123456',
        'sam-pool',
        'sam-oidc',
        'https://api.example.com',
        5000,
        'proj-xyz-789',
      );

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call![1]!.body as string);
      expect(body.attributeCondition).toBe(
        "assertion.iss == 'https://api.example.com' && assertion.project_id == 'proj-xyz-789'",
      );
    });

    it('uses issuer-only attributeCondition when samProjectId is not provided', async () => {
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      await updateOidcProvider(
        'token',
        '123456',
        'sam-pool',
        'sam-oidc',
        'https://api.example.com',
        5000,
      );

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call![1]!.body as string);
      expect(body.attributeCondition).toBe("assertion.iss == 'https://api.example.com'");
    });
  });

  describe('grantWifUserOnSa', () => {
    it('uses subject-scoped principal when samProjectId is provided', async () => {
      // getIamPolicy
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ bindings: [], etag: 'abc' }));
      // setIamPolicy
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ etag: 'def' }));

      await grantWifUserOnSa(
        'token',
        'my-gcp-project',
        '123456',
        'sa@my-gcp-project.iam.gserviceaccount.com',
        'sam-pool',
        5000,
        'proj-abc-123',
      );

      const setCall = mockFetch.mock.calls[1];
      const setBody = JSON.parse(setCall![1]!.body as string);
      const binding = setBody.policy.bindings.find(
        (b: { role: string }) => b.role === 'roles/iam.workloadIdentityUser',
      );

      // Must be subject-scoped principal, NOT pool-wide wildcard
      expect(binding.members[0]).toBe(
        'principal://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/sam-pool/subject/project:proj-abc-123',
      );
      expect(binding.members[0]).not.toContain('/*');
    });

    it('uses pool-wide wildcard when samProjectId is not provided (user-level setup)', async () => {
      // getIamPolicy
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ bindings: [], etag: 'abc' }));
      // setIamPolicy
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ etag: 'def' }));

      await grantWifUserOnSa(
        'token',
        'my-gcp-project',
        '123456',
        'sa@my-gcp-project.iam.gserviceaccount.com',
        'sam-pool',
        5000,
      );

      const setCall = mockFetch.mock.calls[1];
      const setBody = JSON.parse(setCall![1]!.body as string);
      const binding = setBody.policy.bindings.find(
        (b: { role: string }) => b.role === 'roles/iam.workloadIdentityUser',
      );

      expect(binding.members[0]).toBe(
        'principalSet://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/sam-pool/*',
      );
    });

    it('two projects sharing a GCP project get non-overlapping principals', async () => {
      // Call grantWifUserOnSa for two different SAM projects and verify
      // the IAM binding members are distinct (not wildcards).
      const members: string[] = [];

      for (const projectId of ['project-a', 'project-b']) {
        mockFetch.mockResolvedValueOnce(mockGcpResponse({ bindings: [], etag: 'abc' }));
        mockFetch.mockResolvedValueOnce(mockGcpResponse({ etag: 'def' }));

        await grantWifUserOnSa(
          'token',
          'my-gcp-project',
          '123456',
          'sa@my-gcp-project.iam.gserviceaccount.com',
          'sam-pool',
          5000,
          projectId,
        );

        const setCall = mockFetch.mock.calls.at(-1);
        const setBody = JSON.parse(setCall![1]!.body as string);
        const binding = setBody.policy.bindings.find(
          (b: { role: string }) => b.role === 'roles/iam.workloadIdentityUser',
        );
        members.push(binding.members[0]);
      }

      // Principals must be different and neither must be a wildcard
      expect(members[0]).not.toBe(members[1]);
      expect(members[0]).not.toContain('/*');
      expect(members[1]).not.toContain('/*');
      // Each must contain the respective project ID in the subject
      expect(members[0]).toContain('subject/project:project-a');
      expect(members[1]).toContain('subject/project:project-b');
    });
  });

  describe('CEL injection prevention', () => {
    it('rejects samProjectId with single quotes (CEL injection)', async () => {
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      await expect(
        createOidcProvider(
          'token',
          '123456',
          'sam-pool',
          'sam-oidc',
          'https://api.example.com',
          5000,
          "x' || true || 'y",
        ),
      ).rejects.toThrow('unsafe for CEL interpolation');
    });

    it('rejects samProjectId with spaces', async () => {
      await expect(
        grantWifUserOnSa(
          'token',
          'my-gcp-project',
          '123456',
          'sa@x.com',
          'sam-pool',
          5000,
          'project with spaces',
        ),
      ).rejects.toThrow('unsafe for CEL interpolation');
    });

    it('accepts valid ULID-format samProjectId', async () => {
      mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'op/1', done: true }));

      // Should not throw — ULIDs are alphanumeric
      await expect(
        createOidcProvider(
          'token',
          '123456',
          'sam-pool',
          'sam-oidc',
          'https://api.example.com',
          5000,
          '01KHRJGANBBWGDY1NZ0KVF0D4J',
        ),
      ).resolves.toBeUndefined();
    });
  });
});
