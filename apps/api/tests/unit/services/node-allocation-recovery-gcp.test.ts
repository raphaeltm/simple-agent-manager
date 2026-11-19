/**
 * Durable allocation recovery against a provider whose inventory omits native hardware.
 *
 * Staging 2026-11-11 (GCP node 01M73Z88EPJGKF55AJ01TZCWR8): the create completed, the next
 * attempt found exactly one labelled VM, and recovery refused it with "Allocation inventory
 * identity or native hardware is inconsistent" on every attempt, because GCP list results carried
 * neither a location nor observed machine resources. Recovery now re-reads the exact match by id.
 */
import type { Provider, VMInstance } from '@simple-agent-manager/providers';
import { describe, expect, it, vi } from 'vitest';

import type * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  NodeAllocationUncertainError,
  recoverNodeAllocation,
} from '../../../src/services/node-allocation-recovery';
import { buildNodeProviderLabels } from '../../../src/services/node-provider-labels';

const INSTALLATION = '0123456789abcdef0123456789abcdef';
const env = { ENVIRONMENT: 'staging', SAM_INSTALLATION_ID: INSTALLATION } as unknown as Env;
const allocation = {
  createdAt: Date.parse('2026-11-11T00:13:47.000Z'),
  initialIncarnationId: 'initial',
  incarnationId: '269eeff0-fbea-49b7-87f0-5ce2873d7dde',
};
const node = {
  id: '01M73Z88EPJGKF55AJ01TZCWR8',
  providerInstanceId: null,
  vmLocation: 'europe-west1-b',
  providerInstanceType: 'e2-medium',
} as unknown as typeof schema.nodes.$inferSelect;

const labels = buildNodeProviderLabels({
  nodeId: node.id,
  isDeploymentNode: false,
  installationId: INSTALLATION,
  environmentLabel: 'staging',
  runtimeIncarnationId: allocation.incarnationId,
});

function gcpVm(overrides: Partial<VMInstance> = {}, observed = true): VMInstance {
  return {
    id: '1983044510201813583',
    name: 'node-01m73z88epjgkf55aj01tzcwr8',
    ip: '203.0.113.20',
    status: 'running',
    serverType: 'e2-medium',
    location: 'europe-west1-b',
    createdAt: '2026-11-11T00:15:10.000Z',
    labels: { 'sam-managed': 'true', ...labels },
    observedHardware: {
      serverType: { source: 'observed', value: 'e2-medium' },
      resources: observed
        ? { source: 'observed', value: { vcpuCount: 2, memoryMb: 4096, diskGb: 50 } }
        : { source: 'unknown', reason: 'listed without machine type' },
    },
    ...overrides,
  } as VMInstance;
}

function provider(listed: VMInstance[], byId: VMInstance | null) {
  return {
    listVMs: vi.fn().mockResolvedValue(listed),
    getVM: vi.fn().mockResolvedValue(byId),
  } as unknown as Provider & { getVM: ReturnType<typeof vi.fn> };
}

describe('durable allocation recovery with a hardware-less inventory', () => {
  it('re-reads the exact match by id and adopts it (the staging GCP case)', async () => {
    const p = provider([gcpVm({}, false)], gcpVm());
    const vm = await recoverNodeAllocation(p, node, env, allocation);
    expect(vm.id).toBe('1983044510201813583');
    expect(p.getVM).toHaveBeenCalledWith('1983044510201813583', undefined);
  });

  it('does not re-read when the inventory already carries observed hardware', async () => {
    const p = provider([gcpVm()], null);
    await expect(recoverNodeAllocation(p, node, env, allocation)).resolves.toMatchObject({
      id: '1983044510201813583',
    });
    expect(p.getVM).not.toHaveBeenCalled();
  });

  it.each([
    ['the instance disappeared', null],
    ['a different instance answered', gcpVm({ id: 'other' })],
    ['the labels no longer prove this incarnation', gcpVm({ labels: { 'sam-managed': 'true' } })],
  ])('stays uncertain when %s', async (_name, byId) => {
    const p = provider([gcpVm({}, false)], byId);
    await expect(recoverNodeAllocation(p, node, env, allocation)).rejects.toBeInstanceOf(
      NodeAllocationUncertainError
    );
  });

  it('still refuses a VM in another zone (control: the identity check is not relaxed)', async () => {
    const p = provider([gcpVm({}, false)], gcpVm({ location: 'europe-west1-c' }));
    await expect(recoverNodeAllocation(p, node, env, allocation)).rejects.toThrow(
      /identity or native hardware is inconsistent/
    );
  });
});
