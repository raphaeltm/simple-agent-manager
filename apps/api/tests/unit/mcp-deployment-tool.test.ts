import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the get_deployment_credentials MCP tool handler.
 * Tests that correct external_account credential config is returned.
 */

// Mock drizzle
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: mockSelect,
  }),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
}));

vi.mock('../../src/db/schema', () => ({
  projectDeploymentCredentials: { projectId: 'projectId', provider: 'provider' },
}));

const { handleGetDeploymentCredentials } = await import(
  '../../src/routes/mcp/deployment-tools'
);

function mockTokenData(overrides = {}) {
  return {
    taskId: 'task-1',
    projectId: 'proj-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockEnv(overrides = {}) {
  return {
    BASE_DOMAIN: 'example.com',
    DATABASE: {},
    ...overrides,
  } as any;
}

describe('handleGetDeploymentCredentials', () => {
  beforeEach(() => {
    mockSelect.mockReset();
    mockFrom.mockReset();
    mockWhere.mockReset();
    mockLimit.mockReset();

    // Chain setup
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
  });

  it('returns error when no deployment credential exists', async () => {
    mockLimit.mockResolvedValue([]);

    const result = await handleGetDeploymentCredentials(
      'req-1',
      mockTokenData(),
      mockEnv(),
      'mcp-token-abc',
    );

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('No GCP deployment credential configured');
  });

  it('returns valid external_account credential config', async () => {
    mockLimit.mockResolvedValue([
      {
        id: 'cred-1',
        projectId: 'proj-1',
        provider: 'gcp',
        gcpProjectId: 'my-gcp-project',
        gcpProjectNumber: '123456',
        serviceAccountEmail: 'sam-deployer@my-gcp-project.iam.gserviceaccount.com',
        wifPoolId: 'sam-deploy-pool',
        wifProviderId: 'sam-oidc',
      },
    ]);

    const result = await handleGetDeploymentCredentials(
      'req-1',
      mockTokenData(),
      mockEnv(),
      'mcp-token-abc',
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();

    const content = (result.result as any).content[0].text;
    const parsed = JSON.parse(content);

    // Verify credential config structure
    const config = parsed.credentialConfig;
    expect(config.type).toBe('external_account');
    expect(config.subject_token_type).toBe('urn:ietf:params:oauth:token-type:jwt');
    expect(config.token_url).toBe('https://sts.googleapis.com/v1/token');

    // Verify audience uses protocol-relative format
    expect(config.audience).toMatch(/^\/\/iam\.googleapis\.com\/projects\/123456/);
    expect(config.audience).toContain('sam-deploy-pool');
    expect(config.audience).toContain('sam-oidc');

    // Verify credential_source points to SAM's identity token endpoint
    expect(config.credential_source.url).toBe(
      'https://api.example.com/api/projects/proj-1/deployment-identity-token',
    );

    // Verify MCP token is embedded in Authorization header
    expect(config.credential_source.headers.Authorization).toBe('Bearer mcp-token-abc');

    // Verify JSON response format for GCP libraries
    expect(config.credential_source.format.type).toBe('json');
    expect(config.credential_source.format.subject_token_field_name).toBe('token');

    // Verify SA impersonation URL
    expect(config.service_account_impersonation_url).toContain(
      'sam-deployer@my-gcp-project.iam.gserviceaccount.com',
    );

    // Verify metadata
    expect(parsed.gcpProjectId).toBe('my-gcp-project');
    expect(parsed.serviceAccountEmail).toBe(
      'sam-deployer@my-gcp-project.iam.gserviceaccount.com',
    );
    expect(parsed.instructions).toBeInstanceOf(Array);
    expect(parsed.instructions.length).toBeGreaterThan(0);
  });
});
