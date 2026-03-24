import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GcpApiError, sanitizeGcpError } from '../../../src/services/gcp-errors';

/**
 * Tests for GCP error sanitization.
 * Verifies that raw GCP API errors are sanitized before client exposure —
 * no internal resource paths, IAM policies, or service account emails leak.
 */

// Patterns that should NEVER appear in sanitized error messages
const SENSITIVE_PATTERNS = [
  /projects\/\d+\//, // GCP project number paths
  /projects\/[a-z][-a-z0-9]*\//, // GCP project ID paths
  /workloadIdentityPools\//, // WIF pool resource paths
  /serviceAccounts\//, // Service account resource paths
  /@.*\.iam\.gserviceaccount\.com/, // Service account emails
  /etag/, // IAM policy details
  /bindings/, // IAM binding details
  /"error":\s*\{/, // Raw GCP JSON error objects
  /operations\//, // Operation names
];

function assertNoSensitiveData(message: string) {
  for (const pattern of SENSITIVE_PATTERNS) {
    expect(message).not.toMatch(pattern);
  }
}

describe('GcpApiError', () => {
  it('preserves step, statusCode, and rawBody for logging', () => {
    const err = new GcpApiError({
      step: 'create_wif_pool',
      message: 'Failed to create WIF pool (403)',
      statusCode: 403,
      rawBody: '{"error":{"code":403,"message":"Permission denied on projects/123456789"}}',
    });

    expect(err.step).toBe('create_wif_pool');
    expect(err.statusCode).toBe(403);
    expect(err.rawBody).toContain('projects/123456789');
    expect(err.name).toBe('GcpApiError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('sanitizeGcpError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('sanitizes GcpApiError with 403 status', () => {
    const err = new GcpApiError({
      step: 'create_wif_pool',
      message: 'Failed to create WIF pool (403)',
      statusCode: 403,
      rawBody: '{"error":{"code":403,"message":"Permission \'iam.workloadIdentityPools.create\' denied on \'projects/123456789/locations/global\'"}}',
    });

    const sanitized = sanitizeGcpError(err, 'test');
    assertNoSensitiveData(sanitized);
    expect(sanitized).toContain('Permission denied');
    expect(sanitized).toContain('workload identity');
  });

  it('sanitizes GcpApiError with 401 status', () => {
    const err = new GcpApiError({
      step: 'enable_apis',
      message: 'Failed to enable APIs (401)',
      statusCode: 401,
      rawBody: '{"error":{"code":401,"message":"Request had invalid authentication credentials"}}',
    });

    const sanitized = sanitizeGcpError(err, 'test');
    assertNoSensitiveData(sanitized);
    expect(sanitized).toContain('authentication expired');
  });

  it('sanitizes GcpApiError with 404 status', () => {
    const err = new GcpApiError({
      step: 'get_project_number',
      message: 'Failed to get project info (404)',
      statusCode: 404,
      rawBody: '{"error":{"code":404,"message":"Project my-secret-project not found"}}',
    });

    const sanitized = sanitizeGcpError(err, 'test');
    assertNoSensitiveData(sanitized);
    expect(sanitized).not.toContain('my-secret-project');
    expect(sanitized).toContain('not found');
  });

  it('sanitizes GcpApiError with 429 rate limit', () => {
    const err = new GcpApiError({
      step: 'grant_project_roles',
      message: 'Failed to set project IAM policy (429)',
      statusCode: 429,
      rawBody: '{"error":{"code":429,"message":"Quota exceeded for quota group \'ReadGroup\' and limit \'Reads per minute\'"}}',
    });

    const sanitized = sanitizeGcpError(err, 'test');
    assertNoSensitiveData(sanitized);
    expect(sanitized).toContain('rate limit');
  });

  it('sanitizes GcpApiError with no status code', () => {
    const err = new GcpApiError({
      step: 'create_service_account',
      message: 'Network error',
    });

    const sanitized = sanitizeGcpError(err, 'test');
    assertNoSensitiveData(sanitized);
    expect(sanitized).toContain('service account');
  });

  it('sanitizes STS exchange errors', () => {
    const err = new GcpApiError({
      step: 'sts_exchange',
      message: 'GCP STS token exchange failed (400)',
      statusCode: 400,
      rawBody: '{"error":"invalid_grant","error_description":"The audience in the identity token does not match the expected audience //iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/sam-pool/providers/sam-oidc"}',
    });

    const sanitized = sanitizeGcpError(err, 'test');
    assertNoSensitiveData(sanitized);
    expect(sanitized).not.toContain('123456789');
    expect(sanitized).not.toContain('sam-pool');
    expect(sanitized).toContain('token exchange');
  });

  it('sanitizes SA impersonation errors', () => {
    const err = new GcpApiError({
      step: 'sa_impersonation',
      message: 'GCP SA impersonation failed (403)',
      statusCode: 403,
      rawBody: '{"error":{"code":403,"message":"Permission \'iam.serviceAccounts.getAccessToken\' denied on resource (or it may not exist): projects/-/serviceAccounts/sam-vm@my-project.iam.gserviceaccount.com"}}',
    });

    const sanitized = sanitizeGcpError(err, 'test');
    assertNoSensitiveData(sanitized);
    expect(sanitized).not.toContain('sam-vm@my-project.iam.gserviceaccount.com');
  });

  it('handles AbortError (timeout)', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');

    const sanitized = sanitizeGcpError(err, 'test');
    assertNoSensitiveData(sanitized);
    expect(sanitized).toContain('timed out');
  });

  it('handles non-Error values gracefully', () => {
    const sanitized = sanitizeGcpError('some string error', 'test');
    assertNoSensitiveData(sanitized);
    expect(sanitized).not.toContain('some string error');
    expect(sanitized).toContain('Google Cloud');
  });

  it('handles null/undefined gracefully', () => {
    const sanitized = sanitizeGcpError(null, 'test');
    assertNoSensitiveData(sanitized);
    expect(sanitized).toContain('Google Cloud');
  });

  it('logs full error details server-side for GcpApiError', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = new GcpApiError({
      step: 'grant_wif_user',
      message: 'Failed to set SA IAM policy (403)',
      statusCode: 403,
      rawBody: '{"error":{"code":403,"details":"very sensitive iam policy stuff"}}',
    });

    sanitizeGcpError(err, 'test-context');

    expect(consoleSpy).toHaveBeenCalledWith('GCP API error:', expect.objectContaining({
      step: 'grant_wif_user',
      statusCode: 403,
      rawBody: expect.stringContaining('very sensitive iam policy stuff'),
      context: 'test-context',
    }));
  });
});

describe('end-to-end sanitization: raw GCP errors produce safe output', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a realistic GCP 403 with full resource path is fully sanitized', () => {
    // Simulate the error that gcp-setup.ts now throws
    const err = new GcpApiError({
      step: 'create_wif_pool',
      message: 'Failed to create WIF pool (403)',
      statusCode: 403,
      rawBody: JSON.stringify({
        error: {
          code: 403,
          message: "Permission 'iam.workloadIdentityPools.create' denied on 'projects/123456789/locations/global'",
          status: 'PERMISSION_DENIED',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'IAM_PERMISSION_DENIED',
            domain: 'iam.googleapis.com',
            metadata: { permission: 'iam.workloadIdentityPools.create' },
          }],
        },
      }),
    });

    const sanitized = sanitizeGcpError(err, 'setup');
    // Must not contain any sensitive data
    expect(sanitized).not.toContain('123456789');
    expect(sanitized).not.toContain('iam.workloadIdentityPools.create');
    expect(sanitized).not.toContain('IAM_PERMISSION_DENIED');
    expect(sanitized).not.toContain('ErrorInfo');
    // Must contain useful guidance
    expect(sanitized).toContain('Permission denied');
    expect(sanitized).toContain('workload identity');
  });

  it('a realistic STS audience mismatch error is fully sanitized', () => {
    const err = new GcpApiError({
      step: 'sts_exchange',
      message: 'GCP STS token exchange failed (400)',
      statusCode: 400,
      rawBody: JSON.stringify({
        error: 'invalid_grant',
        error_description: 'The audience in the identity token does not match the expected audience //iam.googleapis.com/projects/987654321/locations/global/workloadIdentityPools/sam-deploy-pool/providers/sam-oidc',
      }),
    });

    const sanitized = sanitizeGcpError(err, 'verify');
    expect(sanitized).not.toContain('987654321');
    expect(sanitized).not.toContain('sam-deploy-pool');
    expect(sanitized).not.toContain('sam-oidc');
    expect(sanitized).not.toContain('invalid_grant');
    expect(sanitized).toContain('token exchange');
  });

  it('a realistic SA impersonation denied error is fully sanitized', () => {
    const err = new GcpApiError({
      step: 'sa_impersonation',
      message: 'GCP SA impersonation failed (403)',
      statusCode: 403,
      rawBody: JSON.stringify({
        error: {
          code: 403,
          message: "Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist): projects/-/serviceAccounts/sam-vm-manager@customer-project.iam.gserviceaccount.com",
          status: 'PERMISSION_DENIED',
        },
      }),
    });

    const sanitized = sanitizeGcpError(err, 'token-exchange');
    expect(sanitized).not.toContain('sam-vm-manager');
    expect(sanitized).not.toContain('customer-project');
    expect(sanitized).not.toContain('.iam.gserviceaccount.com');
    expect(sanitized).not.toContain('iam.serviceAccounts.getAccessToken');
    expect(sanitized).toContain('service account');
    expect(sanitized).toContain('Permission denied');
  });

  it('a realistic IAM policy error with binding details is fully sanitized', () => {
    const err = new GcpApiError({
      step: 'grant_project_roles',
      message: 'Failed to set project IAM policy (400)',
      statusCode: 400,
      rawBody: JSON.stringify({
        error: {
          code: 400,
          message: "Policy update failed: bindings with condition are not allowed for role 'roles/compute.instanceAdmin.v1' because it is not supported by one of the resources in the policy",
          details: [{
            bindings: [{ role: 'roles/compute.instanceAdmin.v1', members: ['serviceAccount:sa@proj.iam.gserviceaccount.com'] }],
            etag: 'BwYM/abc=',
          }],
        },
      }),
    });

    const sanitized = sanitizeGcpError(err, 'iam-grant');
    expect(sanitized).not.toContain('sa@proj.iam.gserviceaccount.com');
    expect(sanitized).not.toContain('BwYM/abc=');
    expect(sanitized).not.toContain('compute.instanceAdmin');
    expect(sanitized).toContain('project permissions');
  });
});
