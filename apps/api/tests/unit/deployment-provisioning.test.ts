/**
 * Behavioral tests for deployment node provisioning.
 *
 * Tests the provisionDeploymentNode() service function which:
 * 1. Resolves cloud provider credentials (user → platform fallback)
 * 2. Creates a node record with nodeRole='deployment'
 * 3. Links the environment to the node with placement constraints
 * 4. Returns a provisioning promise for waitUntil()
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the dependencies before importing the module under test
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(),
}));

vi.mock('../../src/services/nodes', () => ({
  createNodeRecord: vi.fn(),
  provisionNode: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  serializeError: vi.fn((e: unknown) => ({ error: String(e) })),
}));

import { drizzle } from 'drizzle-orm/d1';

import { DEPLOYMENT_DEFAULT_VM_SIZE, provisionDeploymentNode } from '../../src/services/deployment-provisioning';
import { createNodeRecord, provisionNode } from '../../src/services/nodes';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockDb(options: {
  userCredProvider?: string | null;
  platformCredProvider?: string | null;
}) {
  // Build user credential rows
  const userCredRows = options.userCredProvider
    ? [{ provider: options.userCredProvider }]
    : [];

  // Build platform credential rows
  const platformCredRows = options.platformCredProvider
    ? [{ provider: options.platformCredProvider }]
    : [];

  // Track which update was called
  const updateCalls: { table: string; values: Record<string, unknown>; envId?: string }[] = [];

  const mockDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation((..._args: unknown[]) => ({
          limit: vi.fn().mockImplementation(() => {
            // First call returns user creds, second returns platform creds,
            // third returns env row for nodeId check
            const callCount = mockDb.select.mock.calls.length;
            if (callCount <= 1) return Promise.resolve(userCredRows);
            if (callCount <= 2) return Promise.resolve(platformCredRows);
            // Environment nodeId check — return empty nodeId
            return Promise.resolve([{ nodeId: null }]);
          }),
        })),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          updateCalls.push({ table: 'deploymentEnvironments', values: {} });
          return Promise.resolve();
        }),
      }),
    }),
    _updateCalls: updateCalls,
  };

  return mockDb;
}

function createMockEnv() {
  return {
    DATABASE: {} as D1Database,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provisionDeploymentNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a node with nodeRole=deployment using user cloud credential', async () => {
    const mockDb = createMockDb({ userCredProvider: 'hetzner' });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue({
      id: 'node-deploy-1',
      userId: 'user-1',
      name: 'deploy-env12345',
      status: 'creating',
      vmSize: 'small',
      vmLocation: 'fsn1',
      cloudProvider: 'hetzner',
      ipAddress: null,
      lastHeartbeatAt: null,
      healthStatus: 'stale',
      heartbeatStaleAfterSeconds: 300,
      errorMessage: null,
      createdAt: '2026-06-13T00:00:00Z',
      updatedAt: '2026-06-13T00:00:00Z',
    });
    vi.mocked(provisionNode).mockResolvedValue();

    const result = await provisionDeploymentNode(
      'env-12345678-abcd',
      'proj-1',
      'user-1',
      createMockEnv(),
    );

    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe('node-deploy-1');
    expect(result!.provisioningPromise).toBeInstanceOf(Promise);

    // Verify createNodeRecord was called with deployment role
    expect(createNodeRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        nodeRole: 'deployment',
        vmSize: DEPLOYMENT_DEFAULT_VM_SIZE,
        cloudProvider: 'hetzner',
        heartbeatStaleAfterSeconds: 300,
      }),
    );

    // Verify provisionNode was called with deployment context
    expect(provisionNode).toHaveBeenCalledWith(
      'node-deploy-1',
      expect.anything(),
      undefined, // no taskContext
      undefined, // no options
      { environmentId: 'env-12345678-abcd' }, // deployment context
    );
  });

  it('falls back to platform credentials when user has none', async () => {
    const mockDb = createMockDb({
      userCredProvider: null,
      platformCredProvider: 'scaleway',
    });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue({
      id: 'node-deploy-2',
      userId: 'user-1',
      name: 'deploy-env12345',
      status: 'creating',
      vmSize: 'small',
      vmLocation: 'par1',
      cloudProvider: 'scaleway',
      ipAddress: null,
      lastHeartbeatAt: null,
      healthStatus: 'stale',
      heartbeatStaleAfterSeconds: 300,
      errorMessage: null,
      createdAt: '2026-06-13T00:00:00Z',
      updatedAt: '2026-06-13T00:00:00Z',
    });
    vi.mocked(provisionNode).mockResolvedValue();

    const result = await provisionDeploymentNode(
      'env-abcdefgh',
      'proj-1',
      'user-1',
      createMockEnv(),
    );

    expect(result).not.toBeNull();
    expect(createNodeRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cloudProvider: 'scaleway',
        nodeRole: 'deployment',
      }),
    );
  });

  it('returns null when no cloud credentials exist', async () => {
    const mockDb = createMockDb({
      userCredProvider: null,
      platformCredProvider: null,
    });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);

    const result = await provisionDeploymentNode(
      'env-nocreds',
      'proj-1',
      'user-1',
      createMockEnv(),
    );

    expect(result).toBeNull();
    expect(createNodeRecord).not.toHaveBeenCalled();
  });

  it('uses DEPLOYMENT_DEFAULT_VM_SIZE (small)', () => {
    expect(DEPLOYMENT_DEFAULT_VM_SIZE).toBe('small');
  });

  it('provisioning promise catches errors without throwing', async () => {
    const mockDb = createMockDb({ userCredProvider: 'hetzner' });
    vi.mocked(drizzle).mockReturnValue(mockDb as any);
    vi.mocked(createNodeRecord).mockResolvedValue({
      id: 'node-deploy-err',
      userId: 'user-1',
      name: 'deploy-env12345',
      status: 'creating',
      vmSize: 'small',
      vmLocation: 'fsn1',
      cloudProvider: 'hetzner',
      ipAddress: null,
      lastHeartbeatAt: null,
      healthStatus: 'stale',
      heartbeatStaleAfterSeconds: 300,
      errorMessage: null,
      createdAt: '2026-06-13T00:00:00Z',
      updatedAt: '2026-06-13T00:00:00Z',
    });
    vi.mocked(provisionNode).mockRejectedValue(new Error('VM creation failed'));

    const result = await provisionDeploymentNode(
      'env-fail',
      'proj-1',
      'user-1',
      createMockEnv(),
    );

    expect(result).not.toBeNull();
    // The provisioning promise should not throw — it has a .catch()
    await expect(result!.provisioningPromise).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Provisioning trigger in deployment-releases route
// ---------------------------------------------------------------------------

describe('deployment release provisioning trigger (source contract)', () => {
  it('POST release route calls provisionDeploymentNode when env has no node', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const source = readFileSync(
      resolve(process.cwd(), 'src/routes/deployment-releases.ts'),
      'utf-8'
    );

    // The route imports provisionDeploymentNode
    expect(source).toContain("from '../services/deployment-provisioning'");

    // The route checks for missing nodeId and calls provisioning
    expect(source).toContain('provisionDeploymentNode');
    expect(source).toContain('waitUntil');

    // Provisioning failure is non-blocking (logged but doesn't fail the release)
    expect(source).toContain('provisioning_trigger_failed');
  });
});

// ---------------------------------------------------------------------------
// Deployment node DNS exemption (source contract)
// ---------------------------------------------------------------------------

describe('deployment node skips DNS record creation', () => {
  it('provisionNode skips DNS for deployment nodes', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const source = readFileSync(
      resolve(process.cwd(), 'src/services/nodes.ts'),
      'utf-8'
    );

    // The code checks isDeploymentNode before creating DNS records
    expect(source).toContain('isDeploymentNode');
    expect(source).toContain('!isDeploymentNode');
    expect(source).toContain('createNodeBackendDNSRecord');

    // The comment in the code documents why DNS is skipped for deployment nodes
    expect(source).toContain('pull-based release channel');
  });
});
