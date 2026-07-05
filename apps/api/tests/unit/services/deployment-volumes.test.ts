/**
 * Vertical-slice tests for deployment volume lifecycle service.
 *
 * Mocks at two boundaries:
 * 1. Provider interface — vi.mock on createProviderForUser
 * 2. D1 database — vi.mock on drizzle operations via schema
 *
 * Tests exercise the real service functions end-to-end through these mocked boundaries.
 */
import type { Provider, VolumeCapabilities, VolumeInstance } from '@simple-agent-manager/providers';
import type { CredentialProvider } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  attachEnvironmentVolumes,
  buildVolumeMountDescriptors,
  createEnvironmentVolume,
  createMissingDeclaredVolumes,
  deleteEnvironmentVolume,
  detachEnvironmentVolumes,
  resolveLinkedDeploymentNodeVolumeTarget,
  resolveNamedVolumeBindSource,
  resolveNamedVolumeMountRoot,
  resolveVolumeMountRoot,
} from '../../../src/services/deployment-volumes';

// =============================================================================
// Mock setup
// =============================================================================

// Mock createProviderForUser at the module boundary
vi.mock('../../../src/services/provider-credentials', () => ({
  createProviderForUser: vi.fn(),
}));

// Mock ulid to return predictable IDs
vi.mock('../../../src/lib/ulid', () => ({
  ulid: vi.fn(() => 'vol-test-001'),
}));

// Mock getCredentialEncryptionKey
vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn(() => 'test-key'),
}));

// Import the mocked module so we can configure it per-test
import { createProviderForUser } from '../../../src/services/provider-credentials';

const mockCreateProviderForUser = vi.mocked(createProviderForUser);

// =============================================================================
// Helpers: mock Provider
// =============================================================================

function makeVolumeCapabilities(overrides?: Partial<VolumeCapabilities>): VolumeCapabilities {
  return {
    supported: true,
    minSizeGb: 10,
    growOnlyResize: true,
    requiresSameLocation: true,
    defaultFormat: 'ext4',
    lifecycle: {
      filesystem: 'ext4',
      mountPathTemplate: '/mnt/sam-env-{environmentId}/',
      fstabOptions: ['nofail'],
    },
    ...overrides,
  };
}

function makeVolumeInstance(overrides?: Partial<VolumeInstance>): VolumeInstance {
  return {
    id: 'prov-vol-1',
    name: 'sam-env-001-data',
    sizeGb: 10,
    location: 'nbg1',
    status: 'available',
    createdAt: '2026-06-12T00:00:00Z',
    labels: { 'sam-environment': 'env-001', 'sam-volume-name': 'data' },
    ...overrides,
  };
}

function makeMockProvider(overrides?: {
  caps?: Partial<VolumeCapabilities>;
  createResult?: VolumeInstance;
  attachResult?: VolumeInstance;
  detachResult?: VolumeInstance;
}): Provider {
  return {
    volumeCapabilities: makeVolumeCapabilities(overrides?.caps),
    createVolume: vi.fn().mockResolvedValue(overrides?.createResult ?? makeVolumeInstance()),
    attachVolume: vi.fn().mockResolvedValue(
      overrides?.attachResult ??
        makeVolumeInstance({
          status: 'in-use',
          attachedServerId: 'srv-1',
          linuxDevice: '/dev/sdb',
        })
    ),
    detachVolume: vi.fn().mockResolvedValue(undefined),
    deleteVolume: vi.fn().mockResolvedValue(undefined),
    resizeVolume: vi.fn(),
    getVolume: vi.fn(),
    listVolumes: vi.fn(),
    createVM: vi.fn(),
    deleteVM: vi.fn(),
    getVM: vi.fn(),
    listVMs: vi.fn(),
    listLocations: vi.fn(),
    listVMSizes: vi.fn(),
    getVMPricing: vi.fn(),
    listSSHKeys: vi.fn(),
    createSSHKey: vi.fn(),
    deleteSSHKey: vi.fn(),
  } as unknown as Provider;
}

function setupProvider(provider: Provider, providerName = 'hetzner') {
  mockCreateProviderForUser.mockResolvedValue({
    provider,
    providerName: providerName as CredentialProvider,
    credentialSource: 'user',
  });
}

// =============================================================================
// Helpers: mock Drizzle DB
// =============================================================================

interface MockRow {
  id: string;
  environmentId: string;
  name: string;
  providerVolumeId: string;
  providerName: string;
  sizeGb: number;
  location: string;
  status: string;
  attachedServerId: string | null;
  linuxDevice: string | null;
  createdAt: string;
  updatedAt: string;
}

function makeQueryResult<T>(rows: T[]) {
  return {
    orderBy: vi.fn(() => makeQueryResult(rows)),
    limit: vi.fn((n: number) => Promise.resolve(rows.slice(0, n))),
    then: (resolve: (v: T[]) => void) => resolve([...rows]),
  };
}

function createMockDb(initialRows: MockRow[] = [], releaseRows: Array<{ manifest: string }> = []) {
  const rows = [...initialRows];
  const rowsForTable = (table: unknown) =>
    table === schema.deploymentReleases ? releaseRows : rows;

  // Build a chainable mock that simulates Drizzle's query builder
  const db = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: MockRow) => {
        rows.push({ ...row });
        return Promise.resolve();
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi
          .fn()
          .mockImplementation((_condition: unknown) => makeQueryResult(rowsForTable(table))),
        orderBy: vi.fn(() => makeQueryResult(rowsForTable(table))),
      })),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          return Promise.resolve();
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => {
        return Promise.resolve();
      }),
    }),
    // Expose rows for assertion
    _rows: rows,
  };

  return db;
}

const mockEnv = {} as unknown as import('../../../src/env').Env;

// =============================================================================
// resolveVolumeMountRoot
// =============================================================================

describe('resolveVolumeMountRoot', () => {
  it('derives mount path from environment ID using provider template', () => {
    const result = resolveVolumeMountRoot('env-abc123');
    expect(result).toBe('/mnt/sam-env-env-abc123/volumes');
  });

  it('result starts with /mnt/ and ends with /volumes', () => {
    const result = resolveVolumeMountRoot('my-env');
    expect(result).toMatch(/^\/mnt\//);
    expect(result).toMatch(/\/volumes$/);
    expect(result).toContain('my-env');
  });
});

describe('resolveNamedVolumeMountRoot', () => {
  it('derives a distinct mountpoint for each named volume', () => {
    expect(resolveNamedVolumeMountRoot('env-abc123', 'data')).toBe(
      '/mnt/sam-env-env-abc123/volumes/data'
    );
    expect(resolveNamedVolumeMountRoot('env-abc123', 'uploads')).toBe(
      '/mnt/sam-env-env-abc123/volumes/uploads'
    );
  });
});

describe('resolveNamedVolumeBindSource', () => {
  it('binds containers to the post-mount data subdirectory', () => {
    expect(resolveNamedVolumeBindSource('env-abc123', 'pgdata')).toBe(
      '/mnt/sam-env-env-abc123/volumes/pgdata/data'
    );
  });
});

// =============================================================================
// buildVolumeMountDescriptors
// =============================================================================

describe('buildVolumeMountDescriptors', () => {
  it('uses the exact named volume mount root as each provider volume mountpoint', async () => {
    const db = createMockDb([
      {
        id: 'vol-1',
        environmentId: 'env-001',
        name: 'data',
        providerVolumeId: 'prov-vol-data',
        providerName: 'hetzner',
        sizeGb: 10,
        location: 'nbg1',
        status: 'attached',
        attachedServerId: 'srv-1',
        linuxDevice: '/dev/disk/by-id/scsi-0HC_Volume_1',
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
      {
        id: 'vol-2',
        environmentId: 'env-001',
        name: 'uploads',
        providerVolumeId: 'prov-vol-uploads',
        providerName: 'hetzner',
        sizeGb: 10,
        location: 'nbg1',
        status: 'attached',
        attachedServerId: 'srv-1',
        linuxDevice: '/dev/disk/by-id/scsi-0HC_Volume_2',
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
      {
        id: 'vol-3',
        environmentId: 'env-001',
        name: 'detached',
        providerVolumeId: 'prov-vol-detached',
        providerName: 'hetzner',
        sizeGb: 10,
        location: 'nbg1',
        status: 'available',
        attachedServerId: null,
        linuxDevice: null,
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
    ]);

    await expect(buildVolumeMountDescriptors(db as any, 'env-001')).resolves.toEqual([
      {
        name: 'data',
        mountRoot: '/mnt/sam-env-env-001/volumes/data',
        providerVolumeId: 'prov-vol-data',
        providerName: 'hetzner',
        linuxDevice: '/dev/disk/by-id/scsi-0HC_Volume_1',
        fsFormat: 'ext4',
      },
      {
        name: 'uploads',
        mountRoot: '/mnt/sam-env-env-001/volumes/uploads',
        providerVolumeId: 'prov-vol-uploads',
        providerName: 'hetzner',
        linuxDevice: '/dev/disk/by-id/scsi-0HC_Volume_2',
        fsFormat: 'ext4',
      },
    ]);
  });

  it('filters descriptors to the current attached provider server when provided', async () => {
    const db = createMockDb([
      {
        id: 'vol-1',
        environmentId: 'env-001',
        name: 'data',
        providerVolumeId: 'prov-vol-data',
        providerName: 'hetzner',
        sizeGb: 10,
        location: 'nbg1',
        status: 'attached',
        attachedServerId: 'srv-current',
        linuxDevice: '/dev/disk/by-id/scsi-0HC_Volume_1',
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
      {
        id: 'vol-2',
        environmentId: 'env-001',
        name: 'stale',
        providerVolumeId: 'prov-vol-stale',
        providerName: 'hetzner',
        sizeGb: 10,
        location: 'nbg1',
        status: 'attached',
        attachedServerId: 'srv-old',
        linuxDevice: '/dev/disk/by-id/scsi-0HC_Volume_2',
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
    ]);

    await expect(buildVolumeMountDescriptors(db as any, 'env-001', 'srv-current')).resolves.toEqual(
      [
        expect.objectContaining({
          name: 'data',
          providerVolumeId: 'prov-vol-data',
        }),
      ]
    );
  });
});

// =============================================================================
// createEnvironmentVolume
// =============================================================================

describe('createEnvironmentVolume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a volume through the provider and returns a row', async () => {
    const provider = makeMockProvider({
      createResult: makeVolumeInstance({ id: 'prov-vol-99', status: 'available' }),
    });
    setupProvider(provider);
    const db = createMockDb();

    const result = await createEnvironmentVolume(db as any, mockEnv, 'user-1', {
      environmentId: 'env-001',
      name: 'data',
      sizeGb: 10,
      location: 'nbg1',
    });

    // Provider was called with correct args
    expect(provider.createVolume).toHaveBeenCalledWith({
      name: 'sam-env-001-data',
      sizeGb: 10,
      location: 'nbg1',
      labels: { 'sam-environment': 'env-001', 'sam-volume-name': 'data' },
    });

    // D1 insert was called
    expect(db.insert).toHaveBeenCalled();

    // Returned row has correct fields
    expect(result.environmentId).toBe('env-001');
    expect(result.name).toBe('data');
    expect(result.providerVolumeId).toBe('prov-vol-99');
    expect(result.providerName).toBe('hetzner');
    expect(result.sizeGb).toBe(10);
    expect(result.location).toBe('nbg1');
    expect(result.status).toBe('available');
  });

  it('rejects unsafe volume names before calling the provider', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);
    const db = createMockDb();

    await expect(
      createEnvironmentVolume(db as any, mockEnv, 'user-1', {
        environmentId: 'env-001',
        name: '../data',
        sizeGb: 10,
        location: 'nbg1',
      })
    ).rejects.toThrow('Volume names must be lowercase alphanumeric');

    expect(provider.createVolume).not.toHaveBeenCalled();
  });

  it('rejects when provider does not support volumes', async () => {
    const provider = makeMockProvider({ caps: { supported: false } });
    setupProvider(provider);
    const db = createMockDb();

    await expect(
      createEnvironmentVolume(db as any, mockEnv, 'user-1', {
        environmentId: 'env-001',
        name: 'data',
        sizeGb: 10,
        location: 'nbg1',
      })
    ).rejects.toThrow('does not support block volumes');

    // Provider createVolume was NOT called
    expect(provider.createVolume).not.toHaveBeenCalled();
  });

  it('rejects when size is below minimum', async () => {
    const provider = makeMockProvider({ caps: { minSizeGb: 10 } });
    setupProvider(provider);
    const db = createMockDb();

    await expect(
      createEnvironmentVolume(db as any, mockEnv, 'user-1', {
        environmentId: 'env-001',
        name: 'data',
        sizeGb: 5,
        location: 'nbg1',
      })
    ).rejects.toThrow('Minimum volume size');

    expect(provider.createVolume).not.toHaveBeenCalled();
  });

  it('rejects when size exceeds maximum', async () => {
    const provider = makeMockProvider({ caps: { maxSizeGb: 100 } });
    setupProvider(provider);
    const db = createMockDb();

    await expect(
      createEnvironmentVolume(db as any, mockEnv, 'user-1', {
        environmentId: 'env-001',
        name: 'data',
        sizeGb: 200,
        location: 'nbg1',
      })
    ).rejects.toThrow('Maximum volume size');

    expect(provider.createVolume).not.toHaveBeenCalled();
  });

  it('rejects when no provider credential found', async () => {
    mockCreateProviderForUser.mockResolvedValue(null as any);
    const db = createMockDb();

    await expect(
      createEnvironmentVolume(db as any, mockEnv, 'user-1', {
        environmentId: 'env-001',
        name: 'data',
        sizeGb: 10,
        location: 'nbg1',
      })
    ).rejects.toThrow('No cloud provider credential found');
  });

  it('cleans up the provider volume and returns the existing row on a unique insert race', async () => {
    const existing: MockRow = {
      id: 'vol-existing',
      environmentId: 'env-001',
      name: 'data',
      providerVolumeId: 'prov-vol-existing',
      providerName: 'hetzner',
      sizeGb: 10,
      location: 'nbg1',
      status: 'available',
      attachedServerId: null,
      linuxDevice: null,
      createdAt: '2026-06-12T00:00:00Z',
      updatedAt: '2026-06-12T00:00:00Z',
    };
    const provider = makeMockProvider({
      createResult: makeVolumeInstance({ id: 'prov-vol-race', status: 'available' }),
    });
    setupProvider(provider);
    const db = createMockDb([existing]) as any;
    db.insert = vi.fn().mockReturnValue({
      values: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'UNIQUE constraint failed: deployment_volumes.environment_id, deployment_volumes.name'
          )
        ),
    });

    const result = await createEnvironmentVolume(db, mockEnv, 'user-1', {
      environmentId: 'env-001',
      name: 'data',
      sizeGb: 10,
      location: 'nbg1',
    });

    expect(provider.deleteVolume).toHaveBeenCalledWith({
      volumeId: 'prov-vol-race',
      location: 'nbg1',
    });
    expect(result).toMatchObject({
      id: 'vol-existing',
      providerVolumeId: 'prov-vol-existing',
    });
  });

  it('surfaces provider cleanup failure when insert fails after provider creation', async () => {
    const provider = makeMockProvider({
      createResult: makeVolumeInstance({ id: 'prov-vol-orphan-risk', status: 'available' }),
    });
    vi.mocked(provider.deleteVolume).mockRejectedValue(new Error('provider cleanup failed'));
    setupProvider(provider);
    const db = createMockDb() as any;
    db.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
    });

    await expect(
      createEnvironmentVolume(db, mockEnv, 'user-1', {
        environmentId: 'env-001',
        name: 'data',
        sizeGb: 10,
        location: 'nbg1',
      })
    ).rejects.toThrow('Manual provider cleanup is required');

    expect(provider.deleteVolume).toHaveBeenCalledWith({
      volumeId: 'prov-vol-orphan-risk',
      location: 'nbg1',
    });
  });
});

describe('createMissingDeclaredVolumes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses an existing volume row when automatic creation loses a duplicate race', async () => {
    const existing: MockRow = {
      id: 'vol-existing',
      environmentId: 'env-001',
      name: 'data',
      providerVolumeId: 'prov-vol-existing',
      providerName: 'hetzner',
      sizeGb: 10,
      location: 'nbg1',
      status: 'available',
      attachedServerId: null,
      linuxDevice: null,
      createdAt: '2026-06-12T00:00:00Z',
      updatedAt: '2026-06-12T00:00:00Z',
    };
    const provider = makeMockProvider({
      createResult: makeVolumeInstance({ id: 'prov-vol-race', status: 'available' }),
    });
    setupProvider(provider);
    const db = createMockDb([]) as any;
    let volumeSelectCount = 0;
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockImplementation(() => {
          if (table === schema.deploymentReleases) {
            return makeQueryResult([]);
          }
          volumeSelectCount += 1;
          return makeQueryResult(volumeSelectCount === 1 ? [] : [existing]);
        }),
        orderBy: vi.fn(() => makeQueryResult([])),
      })),
    });
    db.insert = vi.fn().mockReturnValue({
      values: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'UNIQUE constraint failed: deployment_volumes.environment_id, deployment_volumes.name'
          )
        ),
    });

    const result = await createMissingDeclaredVolumes(db, mockEnv, 'user-1', {
      environmentId: 'env-001',
      volumes: { data: { sizeHintMb: 1024 } },
      location: 'nbg1',
      targetProvider: 'hetzner',
    });

    expect(provider.deleteVolume).toHaveBeenCalledWith({
      volumeId: 'prov-vol-race',
      location: 'nbg1',
    });
    expect(result).toHaveLength(1);
    expect(result[0].providerVolumeId).toBe('prov-vol-existing');
  });
});

// =============================================================================
// deleteEnvironmentVolume
// =============================================================================

describe('deleteEnvironmentVolume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes a volume through the provider and removes D1 row', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);

    const existingRow: MockRow = {
      id: 'vol-1',
      environmentId: 'env-001',
      name: 'data',
      providerVolumeId: 'prov-vol-1',
      providerName: 'hetzner',
      sizeGb: 10,
      location: 'nbg1',
      status: 'available',
      attachedServerId: null,
      linuxDevice: null,
      createdAt: '2026-06-12T00:00:00Z',
      updatedAt: '2026-06-12T00:00:00Z',
    };
    const db = createMockDb([existingRow]);

    await deleteEnvironmentVolume(db as any, mockEnv, 'user-1', 'vol-1', 'env-001');

    // Provider deleteVolume was called with correct args
    expect(provider.deleteVolume).toHaveBeenCalledWith({
      volumeId: 'prov-vol-1',
      location: 'nbg1',
    });

    // D1 delete was called
    expect(db.delete).toHaveBeenCalled();
  });

  it('rejects deleting a detached volume that the latest release still declares', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);

    const existingRow: MockRow = {
      id: 'vol-1',
      environmentId: 'env-001',
      name: 'data',
      providerVolumeId: 'prov-vol-1',
      providerName: 'hetzner',
      sizeGb: 10,
      location: 'nbg1',
      status: 'available',
      attachedServerId: null,
      linuxDevice: null,
      createdAt: '2026-06-12T00:00:00Z',
      updatedAt: '2026-06-12T00:00:00Z',
    };
    const db = createMockDb(
      [existingRow],
      [{ manifest: JSON.stringify({ version: 1, volumes: { data: null } }) }]
    );

    await expect(
      deleteEnvironmentVolume(db as any, mockEnv, 'user-1', 'vol-1', 'env-001')
    ).rejects.toThrow('latest release still declares it');

    expect(provider.deleteVolume).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('allows destructive environment cleanup to delete a latest-release declared volume', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);

    const existingRow: MockRow = {
      id: 'vol-1',
      environmentId: 'env-001',
      name: 'data',
      providerVolumeId: 'prov-vol-1',
      providerName: 'hetzner',
      sizeGb: 10,
      location: 'nbg1',
      status: 'available',
      attachedServerId: null,
      linuxDevice: null,
      createdAt: '2026-06-12T00:00:00Z',
      updatedAt: '2026-06-12T00:00:00Z',
    };
    const db = createMockDb(
      [existingRow],
      [{ manifest: JSON.stringify({ version: 1, volumes: { data: null } }) }]
    );

    await deleteEnvironmentVolume(db as any, mockEnv, 'user-1', 'vol-1', 'env-001', {
      allowLatestReleaseDeclaredVolume: true,
    });

    expect(provider.deleteVolume).toHaveBeenCalledWith({
      volumeId: 'prov-vol-1',
      location: 'nbg1',
    });
    expect(db.delete).toHaveBeenCalled();
  });

  it('rejects deleting an attached volume', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);

    const attachedRow: MockRow = {
      id: 'vol-1',
      environmentId: 'env-001',
      name: 'data',
      providerVolumeId: 'prov-vol-1',
      providerName: 'hetzner',
      sizeGb: 10,
      location: 'nbg1',
      status: 'in-use',
      attachedServerId: 'srv-1',
      linuxDevice: '/dev/sdb',
      createdAt: '2026-06-12T00:00:00Z',
      updatedAt: '2026-06-12T00:00:00Z',
    };
    const db = createMockDb([attachedRow]);

    await expect(
      deleteEnvironmentVolume(db as any, mockEnv, 'user-1', 'vol-1', 'env-001')
    ).rejects.toThrow('Cannot delete an attached volume');

    // Provider was NOT called
    expect(provider.deleteVolume).not.toHaveBeenCalled();
    // D1 delete was NOT called
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('rejects when volume not found', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);
    const db = createMockDb([]); // empty

    await expect(
      deleteEnvironmentVolume(db as any, mockEnv, 'user-1', 'vol-nonexistent', 'env-001')
    ).rejects.toThrow('Volume not found');
  });
});

// =============================================================================
// attachEnvironmentVolumes
// =============================================================================

describe('attachEnvironmentVolumes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attaches all environment volumes to a server', async () => {
    const provider = makeMockProvider({
      attachResult: makeVolumeInstance({
        status: 'in-use',
        attachedServerId: 'srv-target',
        linuxDevice: '/dev/sdb',
      }),
    });
    setupProvider(provider);

    const volumeRows: MockRow[] = [
      {
        id: 'vol-1',
        environmentId: 'env-001',
        name: 'data',
        providerVolumeId: 'prov-vol-1',
        providerName: 'hetzner',
        sizeGb: 10,
        location: 'nbg1',
        status: 'available',
        attachedServerId: null,
        linuxDevice: null,
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
    ];
    const db = createMockDb(volumeRows);

    const results = await attachEnvironmentVolumes(
      db as any,
      mockEnv,
      'user-1',
      'env-001',
      'srv-target',
      'nbg1'
    );

    // Provider attachVolume was called
    expect(provider.attachVolume).toHaveBeenCalledWith({
      volumeId: 'prov-vol-1',
      serverId: 'srv-target',
      location: 'nbg1',
    });

    // D1 was updated
    expect(db.update).toHaveBeenCalled();

    // Returned results reflect attached state
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('in-use');
    expect(results[0].attachedServerId).toBe('srv-target');
    expect(results[0].linuxDevice).toBe('/dev/sdb');
  });

  it('resolves the provider from volume rows when attaching non-default provider volumes', async () => {
    const provider = makeMockProvider();
    setupProvider(provider, 'scaleway');
    const volumeRows: MockRow[] = [
      {
        id: 'vol-1',
        environmentId: 'env-001',
        name: 'data',
        providerVolumeId: 'scw-vol-1',
        providerName: 'scaleway',
        sizeGb: 10,
        location: 'fr-par-1',
        status: 'available',
        attachedServerId: null,
        linuxDevice: null,
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
    ];
    const db = createMockDb(volumeRows);

    await attachEnvironmentVolumes(
      db as any,
      mockEnv,
      'user-1',
      'env-001',
      'scw-server-1',
      'fr-par-1'
    );

    expect(mockCreateProviderForUser).toHaveBeenCalledWith(
      db,
      'user-1',
      'test-key',
      mockEnv,
      'scaleway',
      null
    );
    expect(provider.attachVolume).toHaveBeenCalledWith({
      volumeId: 'scw-vol-1',
      serverId: 'scw-server-1',
      location: 'fr-par-1',
    });
  });

  it('returns empty array when no volumes exist', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);
    const db = createMockDb([]);

    const results = await attachEnvironmentVolumes(
      db as any,
      mockEnv,
      'user-1',
      'env-001',
      'srv-1',
      'nbg1'
    );

    expect(results).toEqual([]);
    expect(provider.attachVolume).not.toHaveBeenCalled();
  });

  it('rejects when volume location differs from server location (co-location)', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);

    const volumeRows: MockRow[] = [
      {
        id: 'vol-1',
        environmentId: 'env-001',
        name: 'data',
        providerVolumeId: 'prov-vol-1',
        providerName: 'hetzner',
        sizeGb: 10,
        location: 'nbg1', // Volume is in Nuremberg
        status: 'available',
        attachedServerId: null,
        linuxDevice: null,
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
    ];
    const db = createMockDb(volumeRows);

    // Server is in Falkenstein — different from volume
    await expect(
      attachEnvironmentVolumes(db as any, mockEnv, 'user-1', 'env-001', 'srv-1', 'fsn1')
    ).rejects.toThrow('Volumes and servers must be co-located');

    // Provider was NOT called
    expect(provider.attachVolume).not.toHaveBeenCalled();
  });

  it('rejects when volume is already attached to a different server', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);

    const volumeRows: MockRow[] = [
      {
        id: 'vol-1',
        environmentId: 'env-001',
        name: 'data',
        providerVolumeId: 'prov-vol-1',
        providerName: 'hetzner',
        sizeGb: 10,
        location: 'nbg1',
        status: 'in-use',
        attachedServerId: 'srv-other', // attached to a different server
        linuxDevice: '/dev/sdb',
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
    ];
    const db = createMockDb(volumeRows);

    await expect(
      attachEnvironmentVolumes(db as any, mockEnv, 'user-1', 'env-001', 'srv-target', 'nbg1')
    ).rejects.toThrow('already attached to server');

    expect(provider.attachVolume).not.toHaveBeenCalled();
  });

  it('skips volumes already attached to the target server', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);

    const volumeRows: MockRow[] = [
      {
        id: 'vol-1',
        environmentId: 'env-001',
        name: 'data',
        providerVolumeId: 'prov-vol-1',
        providerName: 'hetzner',
        sizeGb: 10,
        location: 'nbg1',
        status: 'in-use',
        attachedServerId: 'srv-target', // already attached to target
        linuxDevice: '/dev/sdb',
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
    ];
    const db = createMockDb(volumeRows);

    const results = await attachEnvironmentVolumes(
      db as any,
      mockEnv,
      'user-1',
      'env-001',
      'srv-target',
      'nbg1'
    );

    // Volume was skipped — provider was NOT called
    expect(provider.attachVolume).not.toHaveBeenCalled();
    // But the volume is still returned in the results
    expect(results).toHaveLength(1);
    expect(results[0].attachedServerId).toBe('srv-target');
  });
});

// =============================================================================
// detachEnvironmentVolumes
// =============================================================================

describe('detachEnvironmentVolumes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detaches all volumes attached to the target server', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);

    const volumeRows: MockRow[] = [
      {
        id: 'vol-1',
        environmentId: 'env-001',
        name: 'data',
        providerVolumeId: 'prov-vol-1',
        providerName: 'hetzner',
        sizeGb: 10,
        location: 'nbg1',
        status: 'in-use',
        attachedServerId: 'srv-1',
        linuxDevice: '/dev/sdb',
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
    ];
    const db = createMockDb(volumeRows);

    const results = await detachEnvironmentVolumes(
      db as any,
      mockEnv,
      'user-1',
      'env-001',
      'srv-1'
    );

    // Provider detachVolume was called
    expect(provider.detachVolume).toHaveBeenCalledWith({
      volumeId: 'prov-vol-1',
      serverId: 'srv-1',
      location: 'nbg1',
    });

    // D1 was updated
    expect(db.update).toHaveBeenCalled();

    // Returned results reflect detached state
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('available');
    expect(results[0].attachedServerId).toBeNull();
    expect(results[0].linuxDevice).toBeNull();
  });

  it('resolves the provider from volume rows when detaching non-default provider volumes', async () => {
    const provider = makeMockProvider();
    setupProvider(provider, 'scaleway');
    const volumeRows: MockRow[] = [
      {
        id: 'vol-1',
        environmentId: 'env-001',
        name: 'data',
        providerVolumeId: 'scw-vol-1',
        providerName: 'scaleway',
        sizeGb: 10,
        location: 'fr-par-1',
        status: 'in-use',
        attachedServerId: 'scw-server-1',
        linuxDevice: '/dev/sdb',
        createdAt: '2026-06-12T00:00:00Z',
        updatedAt: '2026-06-12T00:00:00Z',
      },
    ];
    const db = createMockDb(volumeRows);

    await detachEnvironmentVolumes(db as any, mockEnv, 'user-1', 'env-001', 'scw-server-1');

    expect(mockCreateProviderForUser).toHaveBeenCalledWith(
      db,
      'user-1',
      'test-key',
      mockEnv,
      'scaleway',
      null
    );
    expect(provider.detachVolume).toHaveBeenCalledWith({
      volumeId: 'scw-vol-1',
      serverId: 'scw-server-1',
      location: 'fr-par-1',
    });
  });

  it('returns empty array when no volumes are attached to the server', async () => {
    const provider = makeMockProvider();
    setupProvider(provider);
    const db = createMockDb([]); // no attached volumes

    const results = await detachEnvironmentVolumes(
      db as any,
      mockEnv,
      'user-1',
      'env-001',
      'srv-1'
    );

    expect(results).toEqual([]);
    expect(provider.detachVolume).not.toHaveBeenCalled();
  });
});

// =============================================================================
// resolveLinkedDeploymentNodeVolumeTarget
// =============================================================================

interface PlacementRow {
  nodeId: string | null;
  location: string | null;
  providerInstanceId: string | null;
  vmLocation: string | null;
  nodeRole: string | null;
}

// resolveLinkedDeploymentNodeVolumeTarget queries the joined
// deployment_environments + nodes row via
// .select({...}).from(...).leftJoin(...).where(...).limit(1). The shared
// createMockDb above has no leftJoin support, so build a purpose-specific mock
// returning a single configurable placement row.
function createPlacementDb(placement: PlacementRow | undefined) {
  const limit = vi.fn(() => Promise.resolve(placement ? [placement] : []));
  const where = vi.fn(() => ({ limit }));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin }));
  const db = {
    select: vi.fn(() => ({ from })),
    _spies: { from, leftJoin, where, limit },
  };
  return db;
}

describe('resolveLinkedDeploymentNodeVolumeTarget', () => {
  it('throws when the environment is not linked to a node', async () => {
    const db = createPlacementDb({
      nodeId: null,
      location: null,
      providerInstanceId: null,
      vmLocation: null,
      nodeRole: null,
    });

    await expect(resolveLinkedDeploymentNodeVolumeTarget(db as any, 'env-1')).rejects.toThrow(
      'Deployment environment "env-1" is not linked to a node'
    );
  });

  it('throws when no placement row is returned at all', async () => {
    const db = createPlacementDb(undefined);

    await expect(resolveLinkedDeploymentNodeVolumeTarget(db as any, 'env-1')).rejects.toThrow(
      'Deployment environment "env-1" is not linked to a node'
    );
  });

  it('throws when the linked node is not a deployment node', async () => {
    const db = createPlacementDb({
      nodeId: 'node-1',
      location: 'nbg1',
      providerInstanceId: 'srv-1',
      vmLocation: 'nbg1',
      nodeRole: 'workspace',
    });

    await expect(resolveLinkedDeploymentNodeVolumeTarget(db as any, 'env-1')).rejects.toThrow(
      'Node "node-1" is not a deployment node'
    );
  });

  it('throws when the deployment node has no provider instance id yet', async () => {
    const db = createPlacementDb({
      nodeId: 'node-1',
      location: 'nbg1',
      providerInstanceId: null,
      vmLocation: 'nbg1',
      nodeRole: 'deployment',
    });

    await expect(resolveLinkedDeploymentNodeVolumeTarget(db as any, 'env-1')).rejects.toThrow(
      'Deployment node "node-1" does not have a provider instance id yet'
    );
  });

  it('throws when neither the environment nor the node has a location', async () => {
    const db = createPlacementDb({
      nodeId: 'node-1',
      location: null,
      providerInstanceId: 'srv-1',
      vmLocation: null,
      nodeRole: 'deployment',
    });

    await expect(resolveLinkedDeploymentNodeVolumeTarget(db as any, 'env-1')).rejects.toThrow(
      'Deployment node "node-1" does not have a volume attachment location'
    );
  });

  it('resolves the target with the environment location preferred over node vmLocation', async () => {
    const db = createPlacementDb({
      nodeId: 'node-1',
      location: 'env-nbg1',
      providerInstanceId: 'srv-1',
      vmLocation: 'node-fsn1',
      nodeRole: 'deployment',
    });

    const target = await resolveLinkedDeploymentNodeVolumeTarget(db as any, 'env-1');

    expect(target).toEqual({
      nodeId: 'node-1',
      serverId: 'srv-1',
      location: 'env-nbg1',
    });
  });

  it('falls back to the node vmLocation when the environment has no location', async () => {
    const db = createPlacementDb({
      nodeId: 'node-1',
      location: null,
      providerInstanceId: 'srv-1',
      vmLocation: 'node-fsn1',
      nodeRole: 'deployment',
    });

    const target = await resolveLinkedDeploymentNodeVolumeTarget(db as any, 'env-1');

    expect(target).toEqual({
      nodeId: 'node-1',
      serverId: 'srv-1',
      location: 'node-fsn1',
    });
  });

  it('accepts a null nodeRole (unjoined role) as a deployment node', async () => {
    const db = createPlacementDb({
      nodeId: 'node-1',
      location: 'nbg1',
      providerInstanceId: 'srv-1',
      vmLocation: 'nbg1',
      nodeRole: null,
    });

    const target = await resolveLinkedDeploymentNodeVolumeTarget(db as any, 'env-1');

    expect(target).toEqual({
      nodeId: 'node-1',
      serverId: 'srv-1',
      location: 'nbg1',
    });
  });
});
