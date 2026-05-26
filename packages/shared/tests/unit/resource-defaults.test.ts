import { describe, expect, it } from 'vitest';

import {
  PLATFORM_RESOURCE_DEFAULTS,
  resolveResourceReservation,
  RESOURCE_RESERVATION_VERSION,
  selectVmSizeForRequirements,
} from '../../src/constants/resource-defaults';

describe('resolveResourceReservation', () => {
  it('returns platform defaults when no layers provide requirements', () => {
    const result = resolveResourceReservation({});
    expect(result).toEqual({
      cpuMillis: PLATFORM_RESOURCE_DEFAULTS.minVcpu * 1000,
      memoryMb: PLATFORM_RESOURCE_DEFAULTS.minMemoryGb * 1024,
      diskMb: PLATFORM_RESOURCE_DEFAULTS.minDiskGb * 1024,
      exclusiveNode: false,
      maxCoTenants: 4,
      source: 'platform',
      sourceId: 'platform',
      version: RESOURCE_RESERVATION_VERSION,
    });
  });

  it('resolves task-level requirements as highest priority', () => {
    const result = resolveResourceReservation(
      {
        task: { minVcpu: 8, minMemoryGb: 16 },
        project: { minVcpu: 2, minMemoryGb: 4, minDiskGb: 80 },
      },
      { taskId: 'task-1', projectId: 'proj-1' },
    );

    // task wins for minVcpu and minMemoryGb
    expect(result.cpuMillis).toBe(8000);
    expect(result.memoryMb).toBe(16 * 1024);
    // project fills in minDiskGb (task didn't set it)
    expect(result.diskMb).toBe(80 * 1024);
    // source is task (highest-priority contributor)
    expect(result.source).toBe('task');
    expect(result.sourceId).toBe('task-1');
  });

  it('performs per-field resolution across layers', () => {
    const result = resolveResourceReservation(
      {
        task: { minVcpu: 4 },
        agentProfile: { minMemoryGb: 8, minDiskGb: 100 },
        project: { exclusiveNode: true },
      },
      { taskId: 't1', agentProfileId: 'ap1', projectId: 'p1' },
    );

    expect(result.cpuMillis).toBe(4000); // from task
    expect(result.memoryMb).toBe(8 * 1024); // from agent-profile
    expect(result.diskMb).toBe(100 * 1024); // from agent-profile
    expect(result.exclusiveNode).toBe(true); // from project
    expect(result.maxCoTenants).toBe(4); // platform default (no layer set it)
    expect(result.source).toBe('task'); // first layer to contribute
  });

  it('higher-priority layer wins when multiple layers set the same field', () => {
    const result = resolveResourceReservation({
      trigger: { minVcpu: 4 },
      agentProfile: { minVcpu: 8 },
      project: { minVcpu: 2 },
    });

    // trigger (priority 2) beats agent-profile (3) and project (4)
    expect(result.cpuMillis).toBe(4000);
    expect(result.source).toBe('trigger');
  });

  it('skips layers with undefined requirements', () => {
    const result = resolveResourceReservation(
      {
        task: undefined,
        trigger: undefined,
        agentProfile: { minVcpu: 6 },
      },
      { agentProfileId: 'ap-99' },
    );

    expect(result.cpuMillis).toBe(6000);
    expect(result.source).toBe('agent-profile');
    expect(result.sourceId).toBe('ap-99');
  });

  it('uses user layer when only user provides requirements', () => {
    const result = resolveResourceReservation(
      { user: { exclusiveNode: true, maxCoTenants: 1 } },
      { userId: 'u-42' },
    );

    expect(result.exclusiveNode).toBe(true);
    expect(result.maxCoTenants).toBe(1);
    expect(result.source).toBe('user');
    expect(result.sourceId).toBe('u-42');
  });

  it('converts units correctly (vcpu→millis, gb→mb)', () => {
    const result = resolveResourceReservation({
      task: { minVcpu: 3, minMemoryGb: 12, minDiskGb: 200 },
    });

    expect(result.cpuMillis).toBe(3000);
    expect(result.memoryMb).toBe(12288); // 12 * 1024
    expect(result.diskMb).toBe(204800); // 200 * 1024
  });

  it('includes the current version number', () => {
    const result = resolveResourceReservation({});
    expect(result.version).toBe(RESOURCE_RESERVATION_VERSION);
    expect(typeof result.version).toBe('number');
  });

  it('defaults sourceId to empty string when id not provided', () => {
    const result = resolveResourceReservation({
      task: { minVcpu: 4 },
    });
    expect(result.source).toBe('task');
    expect(result.sourceId).toBe('');
  });
});

describe('selectVmSizeForRequirements', () => {
  it('selects small for requirements that fit small', () => {
    const size = selectVmSizeForRequirements({
      minVcpu: 2,
      minMemoryGb: 4,
      minDiskGb: 40,
      exclusiveNode: false,
      maxCoTenants: 4,
    });
    expect(size).toBe('small');
  });

  it('selects medium when small is too small', () => {
    const size = selectVmSizeForRequirements({
      minVcpu: 4,
      minMemoryGb: 8,
      minDiskGb: 80,
      exclusiveNode: false,
      maxCoTenants: 4,
    });
    expect(size).toBe('medium');
  });

  it('selects large when medium is too small', () => {
    const size = selectVmSizeForRequirements({
      minVcpu: 8,
      minMemoryGb: 16,
      minDiskGb: 160,
      exclusiveNode: false,
      maxCoTenants: 4,
    });
    expect(size).toBe('large');
  });

  it('returns large as best-effort when nothing fits', () => {
    const size = selectVmSizeForRequirements({
      minVcpu: 64,
      minMemoryGb: 256,
      minDiskGb: 2000,
      exclusiveNode: false,
      maxCoTenants: 1,
    });
    expect(size).toBe('large');
  });

  it('uses provider-specific capacities for scaleway', () => {
    // Scaleway medium: vcpu=4, ram=12, storage=120
    const size = selectVmSizeForRequirements(
      {
        minVcpu: 4,
        minMemoryGb: 10,
        minDiskGb: 100,
        exclusiveNode: false,
        maxCoTenants: 4,
      },
      'scaleway',
    );
    expect(size).toBe('medium');
  });

  it('uses provider-specific capacities for gcp', () => {
    // GCP small: vcpu=1, ram=4, storage=50
    // Needs 2 vcpu → must go to medium (vcpu=2)
    const size = selectVmSizeForRequirements(
      {
        minVcpu: 2,
        minMemoryGb: 4,
        minDiskGb: 40,
        exclusiveNode: false,
        maxCoTenants: 4,
      },
      'gcp',
    );
    expect(size).toBe('medium');
  });

  it('falls back to hetzner capacity for unknown provider', () => {
    const size = selectVmSizeForRequirements(
      {
        minVcpu: 2,
        minMemoryGb: 4,
        minDiskGb: 40,
        exclusiveNode: false,
        maxCoTenants: 4,
      },
      'unknown-provider',
    );
    expect(size).toBe('small'); // same as hetzner small
  });

  it('selects based on the bottleneck dimension', () => {
    // CPU and RAM fit small, but disk needs medium
    const size = selectVmSizeForRequirements({
      minVcpu: 1,
      minMemoryGb: 2,
      minDiskGb: 60,
      exclusiveNode: false,
      maxCoTenants: 4,
    });
    expect(size).toBe('medium'); // hetzner small has 40GB, medium has 80GB
  });
});
