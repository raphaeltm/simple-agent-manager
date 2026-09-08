import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createNodeRecord, provisionNode } from '../../../src/services/nodes';
import { cleanupFreshProvisioningNode } from '../../../src/services/provisioning-authority';
import { deleteNodeResourcesStrict } from '../../../src/services/strict-node-deletion';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  assertPlan: vi.fn(),
  createProvider: vi.fn(),
  createVM: vi.fn(),
  deleteVM: vi.fn(),
}));
vi.mock('../../../src/services/node-allocation-validation', () => ({
  assertNodeAllocationPlanCurrent: mocks.assertPlan,
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  createProviderForUser: mocks.createProvider,
  exactProviderCredentialBindingFromPlacementSnapshot: () => null,
}));
vi.mock('../../../src/services/jwt', () => ({ signNodeCallbackToken: async () => 'test-token' }));
vi.mock('../../../src/lib/secrets', () => ({ getCredentialEncryptionKey: () => 'test-key' }));
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));
vi.mock('@simple-agent-manager/cloud-init', () => ({
  generateCloudInit: () => 'cloud-init',
  validateCloudInitSize: () => true,
}));
vi.mock('../../../src/services/dns', () => ({
  createNodeBackendDNSRecord: vi.fn(),
  deleteDNSRecord: vi.fn(),
}));

let sqlite: Database.Database;
let env: Env;
const provider = {
  provider: { createVM: mocks.createVM, deleteVM: mocks.deleteVM },
  providerName: 'hetzner',
  credentialSource: 'user',
};

async function freshNode(runtime: 'vm' | 'cf-container' = 'vm') {
  return createNodeRecord(env, {
    userId: 'user-1',
    name: 'Recovery attempt',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    heartbeatStaleAfterSeconds: 180,
    cloudProvider: 'hetzner',
    runtime,
    providerInstanceType: 'cx33',
  });
}
function readNode(id: string) {
  return sqlite
    .prepare(
      `SELECT status, provider_instance_id AS providerId,
    runtime_incarnation_id AS incarnation, runtime_termination_confirmed_at AS proof
    FROM nodes WHERE id = ?`
    )
    .get(id) as {
    status: string;
    providerId: string | null;
    incarnation: string;
    proof: string | null;
  };
}
function cleanup(id: string) {
  return cleanupFreshProvisioningNode(env, {
    nodeId: id,
    userId: 'user-1',
    nodeRole: 'workspace',
    reason: 'failed recovery',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPlan.mockResolvedValue(undefined);
  mocks.createProvider.mockResolvedValue(provider);
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'example.test',
    ENVIRONMENT: 'test',
    SAM_INSTALLATION_ID: '0123456789abcdef0123456789abcdef',
  } as unknown as Env;
});
afterEach(() => sqlite.close());

describe('fresh VM absence proof through real provisioning and cleanup SQL', () => {
  it('lets ordinary cleanup confirm a recovery allocation rejected before provider resolution', async () => {
    const node = await freshNode();
    mocks.assertPlan.mockRejectedValueOnce(new Error('Node allocation plan is no longer current'));
    await expect(
      provisionNode(node.id, env, undefined, { rethrowProviderError: true })
    ).rejects.toThrow('Node allocation plan is no longer current');
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.createVM).not.toHaveBeenCalled();
    expect(readNode(node.id).status).toBe('error');
    await expect(deleteNodeResourcesStrict(node.id, 'user-1', env)).resolves.toMatchObject({
      providerVm: 'no-instance',
      runtimeTerminationConfirmedAt: expect.any(String),
    });
    expect(mocks.deleteVM).not.toHaveBeenCalled();
  });

  it('fences a provider claim that was waiting when placeholder deletion accepted its proof', async () => {
    const node = await freshNode();
    let resolveProvider!: (value: typeof provider) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mocks.createProvider.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        resolveProvider = resolve;
      });
    });
    const provisioning = provisionNode(node.id, env, undefined, { rethrowProviderError: true });
    const failed = expect(provisioning).rejects.toThrow('lifecycle changed');
    await ready;
    const deleted = await deleteNodeResourcesStrict(node.id, 'user-1', env);
    expect(deleted.runtimeTerminationConfirmedAt).toEqual(expect.any(String));
    expect(readNode(node.id).status).toBe('destroying');
    resolveProvider(provider);
    await failed;
    expect(mocks.createVM).not.toHaveBeenCalled();
  });

  it('clears the proof before createVM and retains an in-flight allocation with no provider ID', async () => {
    const node = await freshNode();
    const original = readNode(node.id);
    expect(original.proof).toEqual(expect.any(String));
    let rejectCreate!: (error: Error) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mocks.createVM.mockImplementationOnce(() => {
      entered();
      return new Promise((_resolve, reject) => {
        rejectCreate = reject;
      });
    });
    const provisioning = provisionNode(node.id, env, undefined, { rethrowProviderError: true });
    const failed = expect(provisioning).rejects.toThrow('ambiguous provider timeout');
    await ready;
    expect(readNode(node.id)).toMatchObject({ status: 'creating', providerId: null, proof: null });
    expect(readNode(node.id).incarnation).not.toBe(original.incarnation);
    expect(await cleanup(node.id)).toBe('skipped');
    expect(readNode(node.id)).toBeDefined();
    rejectCreate(new Error('ambiguous provider timeout'));
    await failed;
    await expect(deleteNodeResourcesStrict(node.id, 'user-1', env)).rejects.toThrow(
      'identity is missing'
    );
    expect(mocks.deleteVM).not.toHaveBeenCalled();
  });

  it('deletes a pristine unreferenced VM placeholder using its insertion proof', async () => {
    const node = await freshNode();
    expect(await cleanup(node.id)).toBe('placeholder-deleted');
    expect(readNode(node.id)).toBeUndefined();
  });

  it('does not infer absence from an older NULL provider ID without proof', async () => {
    const node = await freshNode();
    sqlite
      .prepare('UPDATE nodes SET runtime_termination_confirmed_at = NULL WHERE id = ?')
      .run(node.id);
    expect(await cleanup(node.id)).toBe('skipped');
    await expect(deleteNodeResourcesStrict(node.id, 'user-1', env)).rejects.toThrow(
      'identity is missing'
    );
    expect(readNode(node.id).proof).toBeNull();
  });

  it('does not initialize a VM absence proof for the container allocation path', async () => {
    const node = await freshNode('cf-container');
    expect(readNode(node.id).proof).toBeNull();
  });

  it('retains an existing stopped incarnation proof without requesting provider deletion', async () => {
    const node = await freshNode();
    const confirmedAt = '2026-09-07T12:00:00.000Z';
    sqlite
      .prepare(
        `UPDATE nodes SET status = 'stopped', provider_instance_id = 'old-vm',
      runtime_termination_confirmed_at = ? WHERE id = ?`
      )
      .run(confirmedAt, node.id);
    await expect(deleteNodeResourcesStrict(node.id, 'user-1', env)).resolves.toMatchObject({
      providerVm: 'already-absent',
      runtimeTerminationConfirmedAt: confirmedAt,
      runtimeIncarnationId: readNode(node.id).incarnation,
    });
    expect(readNode(node.id).status).toBe('destroying');
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.deleteVM).not.toHaveBeenCalled();
  });
});
