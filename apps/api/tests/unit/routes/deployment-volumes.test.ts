import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const deploymentEnvironments = {
  id: 'deploymentEnvironments.id',
  projectId: 'deploymentEnvironments.projectId',
  provider: 'deploymentEnvironments.provider',
  location: 'deploymentEnvironments.location',
};

type Condition =
  | { op: 'eq'; col: unknown; val: unknown }
  | { op: 'and'; conds: Condition[] }
  | undefined;

interface EnvironmentRow {
  id: string;
  projectId: string;
  provider: string | null;
  location: string | null;
}

interface VolumeRow {
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

const mockRequireOwnedProject = vi.hoisted(() => vi.fn(async () => undefined));
const mockCreateEnvironmentVolume = vi.hoisted(() => vi.fn());
const mockDeleteEnvironmentVolume = vi.hoisted(() => vi.fn());
const mockAttachEnvironmentVolumesToLinkedNode = vi.hoisted(() => vi.fn());
const mockDetachEnvironmentVolumesFromLinkedNode = vi.hoisted(() => vi.fn());
const mockListEnvironmentVolumes = vi.hoisted(() => vi.fn());

let envRows: EnvironmentRow[] = [];

vi.mock('drizzle-orm', () => ({
  and: (...conds: Condition[]) => ({ op: 'and', conds }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  sql: (strings: TemplateStringsArray, ...exprs: unknown[]) => ({ strings, exprs }),
}));

vi.mock('../../../src/db/schema', () => ({
  deploymentEnvironments,
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: (...args: unknown[]) => mockRequireOwnedProject(...args),
}));

vi.mock('../../../src/services/deployment-volumes', () => ({
  attachEnvironmentVolumesToLinkedNode: (...args: unknown[]) =>
    mockAttachEnvironmentVolumesToLinkedNode(...args),
  createEnvironmentVolume: (...args: unknown[]) => mockCreateEnvironmentVolume(...args),
  deleteEnvironmentVolume: (...args: unknown[]) => mockDeleteEnvironmentVolume(...args),
  detachEnvironmentVolumesFromLinkedNode: (...args: unknown[]) =>
    mockDetachEnvironmentVolumesFromLinkedNode(...args),
  listEnvironmentVolumes: (...args: unknown[]) => mockListEnvironmentVolumes(...args),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => createMockDb(),
}));

const { deploymentVolumeRoutes } = await import('../../../src/routes/deployment-volumes');

function eqValue(condition: Condition, col: unknown): unknown {
  if (!condition) return undefined;
  if (condition.op === 'eq') {
    return condition.col === col ? condition.val : undefined;
  }
  for (const child of condition.conds) {
    const value = eqValue(child, col);
    if (value !== undefined) return value;
  }
  return undefined;
}

function createMockDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((condition: Condition) => ({
          limit: vi.fn(async () => {
            if (table !== deploymentEnvironments) return [];
            const id = eqValue(condition, deploymentEnvironments.id);
            const projectId = eqValue(condition, deploymentEnvironments.projectId);
            return envRows.filter(
              (row) =>
                (id === undefined || row.id === id) &&
                (projectId === undefined || row.projectId === projectId)
            );
          }),
        })),
      })),
    })),
  };
}

function makeVolume(overrides: Partial<VolumeRow> = {}): VolumeRow {
  return {
    id: 'vol-1',
    environmentId: 'env-1',
    name: 'data',
    providerVolumeId: 'provider-vol-1',
    providerName: 'hetzner',
    sizeGb: 10,
    location: 'fsn1',
    status: 'available',
    attachedServerId: null,
    linuxDevice: null,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects', deploymentVolumeRoutes);
  return app;
}

function request(body: unknown) {
  return createApp().request(
    '/api/projects/proj-1/environments/env-1/volumes',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DATABASE: {} } as Env
  );
}

describe('deployment volume routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envRows = [{ id: 'env-1', projectId: 'proj-1', provider: null, location: null }];
    mockListEnvironmentVolumes.mockResolvedValue([]);
    mockCreateEnvironmentVolume.mockImplementation(async (_db, _env, _userId, opts) =>
      makeVolume({
        name: opts.name,
        sizeGb: opts.sizeGb,
        location: opts.location,
        providerName: opts.targetProvider ?? 'hetzner',
      })
    );
  });

  it('creates manual volumes on the existing environment volume provider', async () => {
    mockListEnvironmentVolumes.mockResolvedValue([
      makeVolume({ providerName: 'scaleway', location: 'fr-par-1' }),
    ]);

    const res = await request({ name: 'cache', sizeGb: 2, location: 'fr-par-1' });

    expect(res.status).toBe(201);
    expect(mockCreateEnvironmentVolume).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user-1',
      expect.objectContaining({
        environmentId: 'env-1',
        name: 'cache',
        sizeGb: 2,
        location: 'fr-par-1',
        targetProvider: 'scaleway',
      })
    );
  });

  it('uses the environment placement provider when no volumes exist yet', async () => {
    envRows = [{ id: 'env-1', projectId: 'proj-1', provider: 'hetzner', location: 'fsn1' }];

    const res = await request({ name: 'data', sizeGb: 10, location: 'fsn1' });

    expect(res.status).toBe(201);
    expect(mockCreateEnvironmentVolume).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user-1',
      expect.objectContaining({
        location: 'fsn1',
        targetProvider: 'hetzner',
      })
    );
  });

  it('rejects manual volume creation in a conflicting environment volume location', async () => {
    mockListEnvironmentVolumes.mockResolvedValue([makeVolume({ location: 'fsn1' })]);

    const res = await request({ name: 'cache', sizeGb: 2, location: 'nbg1' });
    const body = (await res.json()) as { message?: string };

    expect(res.status).toBe(400);
    expect(body.message).toMatch(/must match existing environment volume location "fsn1"/);
    expect(mockCreateEnvironmentVolume).not.toHaveBeenCalled();
  });
});
