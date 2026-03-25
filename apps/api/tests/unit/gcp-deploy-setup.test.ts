import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GcpApiError, sanitizeGcpError } from '../../src/services/gcp-errors';

/**
 * Unit tests for GCP deployment setup service.
 * Tests the runGcpDeploySetup orchestrator with mocked GCP API calls.
 */

// Mock fetch for GCP API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocking
const { runGcpDeploySetup } = await import('../../src/services/gcp-deploy-setup');

function mockEnv(overrides: Record<string, string> = {}) {
  return {
    BASE_DOMAIN: 'example.com',
    GCP_API_TIMEOUT_MS: '5000',
    ...overrides,
  } as any;
}

function mockGcpResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('runGcpDeploySetup', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('orchestrates full GCP deployment setup with correct parameters', async () => {
    const progressSteps: Array<{ step: string; status: string }> = [];

    // Mock responses in order:
    // 1. getProjectNumber
    mockFetch.mockResolvedValueOnce(
      mockGcpResponse({ projectId: 'my-project', projectNumber: '123456789' }),
    );
    // 2. enableApis (returns done operation)
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'operations/op1', done: true }));
    // 3. createWifPool (returns done operation)
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'operations/op2', done: true }));
    // 4. createOidcProvider (returns done operation)
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ name: 'operations/op3', done: true }));
    // 5. createServiceAccount
    mockFetch.mockResolvedValueOnce(
      mockGcpResponse({ email: 'sam-deployer@my-project.iam.gserviceaccount.com' }),
    );
    // 6. grantWifUserOnSa - getIamPolicy
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ bindings: [], etag: 'abc' }));
    // 7. grantWifUserOnSa - setIamPolicy
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ bindings: [], etag: 'def' }));
    // 8. grantProjectRoles - getIamPolicy
    mockFetch.mockResolvedValueOnce(
      mockGcpResponse({ bindings: [], etag: 'ghi', version: 3 }),
    );
    // 9. grantProjectRoles - setIamPolicy
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ bindings: [], etag: 'jkl' }));

    const result = await runGcpDeploySetup(
      'fake-oauth-token',
      'my-project',
      mockEnv(),
      (step, status) => progressSteps.push({ step, status }),
      'sam-project-123',
    );

    // Verify result
    expect(result.provider).toBe('gcp');
    expect(result.gcpProjectId).toBe('my-project');
    expect(result.gcpProjectNumber).toBe('123456789');
    expect(result.serviceAccountEmail).toBe('sam-deployer@my-project.iam.gserviceaccount.com');
    expect(result.wifPoolId).toBe('sam-deploy-pool');
    expect(result.wifProviderId).toBe('sam-oidc');

    // Verify all progress steps completed
    const completedSteps = progressSteps
      .filter((s) => s.status === 'done')
      .map((s) => s.step);
    expect(completedSteps).toEqual([
      'get_project_number',
      'enable_apis',
      'create_wif_pool',
      'create_oidc_provider',
      'create_service_account',
      'grant_wif_user',
      'grant_project_roles',
    ]);

    // Verify deployment-specific APIs are enabled (check the enableApis call)
    const enableApisCall = mockFetch.mock.calls[1];
    const enableApisBody = JSON.parse(enableApisCall![1]!.body as string);
    expect(enableApisBody.serviceIds).toContain('run.googleapis.com');
    expect(enableApisBody.serviceIds).toContain('cloudbuild.googleapis.com');
    expect(enableApisBody.serviceIds).toContain('artifactregistry.googleapis.com');
    expect(enableApisBody.serviceIds).toContain('storage.googleapis.com');

    // Verify SA display name is deployment-specific
    const createSaCall = mockFetch.mock.calls[4];
    const createSaBody = JSON.parse(createSaCall![1]!.body as string);
    expect(createSaBody.serviceAccount.displayName).toBe('SAM Deployer');

    // Verify OIDC provider uses project-scoped attributeCondition
    const oidcProviderCall = mockFetch.mock.calls[3];
    const oidcBody = JSON.parse(oidcProviderCall![1]!.body as string);
    expect(oidcBody.attributeCondition).toBe(
      "assertion.iss == 'https://api.example.com' && assertion.project_id == 'sam-project-123'",
    );

    // Verify IAM binding uses subject-scoped principal (not wildcard)
    const setIamCall = mockFetch.mock.calls[6];
    const iamBody = JSON.parse(setIamCall![1]!.body as string);
    const wifBinding = iamBody.policy.bindings.find(
      (b: { role: string }) => b.role === 'roles/iam.workloadIdentityUser',
    );
    expect(wifBinding.members[0]).toContain('subject/project:sam-project-123');
    expect(wifBinding.members[0]).not.toContain('/*');

    // Verify deployment SA gets roles/owner (Defang requires broad access)
    const grantRolesSetIamCall = mockFetch.mock.calls[8];
    const grantRolesBody = JSON.parse(grantRolesSetIamCall![1]!.body as string);
    const ownerBinding = grantRolesBody.policy.bindings.find(
      (b: { role: string }) => b.role === 'roles/owner',
    );
    expect(ownerBinding).toBeDefined();
    expect(ownerBinding.members).toContain(`serviceAccount:sam-deployer@my-project.iam.gserviceaccount.com`);
  });

  it('uses configurable env vars for pool/provider/sa IDs', async () => {
    // Mock all responses as before
    mockFetch.mockResolvedValueOnce(
      mockGcpResponse({ projectId: 'p1', projectNumber: '111' }),
    );
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ done: true }));
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ done: true }));
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ done: true }));
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ email: 'custom@p1.iam.gserviceaccount.com' }));
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ bindings: [], etag: 'a' }));
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ etag: 'b' }));
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ bindings: [], etag: 'c' }));
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ etag: 'd' }));

    const result = await runGcpDeploySetup(
      'tok',
      'p1',
      mockEnv({
        GCP_DEPLOY_WIF_POOL_ID: 'custom-pool',
        GCP_DEPLOY_WIF_PROVIDER_ID: 'custom-provider',
        GCP_DEPLOY_SERVICE_ACCOUNT_ID: 'custom',
      }),
    );

    expect(result.wifPoolId).toBe('custom-pool');
    expect(result.wifProviderId).toBe('custom-provider');
    expect(result.serviceAccountEmail).toBe('custom@p1.iam.gserviceaccount.com');
  });

  it('propagates GcpApiError when getProjectNumber fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rawBody = JSON.stringify({
      error: { code: 403, message: "Permission denied on projects/secret-project-id" },
    });
    mockFetch.mockResolvedValueOnce(mockGcpResponse(JSON.parse(rawBody), 403));

    try {
      await runGcpDeploySetup('fake-token', 'my-project', mockEnv());
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GcpApiError);
      const gcpErr = err as GcpApiError;
      expect(gcpErr.step).toBe('get_project_number');
      expect(gcpErr.statusCode).toBe(403);
      // rawBody preserves sensitive data for server-side logging
      expect(gcpErr.rawBody).toContain('secret-project-id');
      // sanitizeGcpError strips sensitive data for client
      const sanitized = sanitizeGcpError(gcpErr);
      expect(sanitized).not.toContain('secret-project-id');
    }
  });

  it('propagates GcpApiError when mid-flow step (createWifPool) fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 1. getProjectNumber succeeds
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ projectId: 'p1', projectNumber: '999' }));
    // 2. enableApis succeeds
    mockFetch.mockResolvedValueOnce(mockGcpResponse({ done: true }));
    // 3. createWifPool fails with 403
    const rawBody = JSON.stringify({
      error: { code: 403, message: "Permission 'iam.workloadIdentityPools.create' denied on 'projects/999/locations/global'" },
    });
    mockFetch.mockResolvedValueOnce(mockGcpResponse(JSON.parse(rawBody), 403));

    try {
      await runGcpDeploySetup('fake-token', 'p1', mockEnv());
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GcpApiError);
      const gcpErr = err as GcpApiError;
      expect(gcpErr.step).toBe('create_wif_pool');
      expect(gcpErr.statusCode).toBe(403);
      expect(gcpErr.rawBody).toContain('projects/999');
      const sanitized = sanitizeGcpError(gcpErr);
      expect(sanitized).not.toContain('999');
      expect(sanitized).not.toContain('projects/');
    }
  });
});
