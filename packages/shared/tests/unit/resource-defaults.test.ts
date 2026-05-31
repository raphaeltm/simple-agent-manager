import { describe, expect, it } from 'vitest';

import {
  PLATFORM_RESOURCE_DEFAULTS,
  resolveResourceReservation,
  RESOURCE_RESERVATION_VERSION,
  selectVmSizeForRequirements,
  validateResourceRequirements,
} from '../../src/constants/resource-defaults';

describe('resolveResourceReservation', () => {
  it('returns platform defaults when no layers provide requirements', () => {
    const result = resolveResourceReservation({});
    expect(result).toEqual({
      cpuMillis: PLATFORM_RESOURCE_DEFAULTS.minVcpu * 1000,
      memoryMb: PLATFORM_RESOURCE_DEFAULTS.minMemoryMb,
      diskMb: PLATFORM_RESOURCE_DEFAULTS.minDiskMb,
      exclusiveNode: false,
      maxCoTenants: 4,
      requirements: {
        minVcpu: PLATFORM_RESOURCE_DEFAULTS.minVcpu,
        minMemoryMb: PLATFORM_RESOURCE_DEFAULTS.minMemoryMb,
        minDiskMb: PLATFORM_RESOURCE_DEFAULTS.minDiskMb,
        exclusiveNode: false,
        maxCoTenants: 4,
        preset: PLATFORM_RESOURCE_DEFAULTS.preset,
      },
      source: 'platform',
      sourceId: 'platform',
      fieldSources: {
        minVcpu: 'platform',
        minMemoryMb: 'platform',
        minDiskMb: 'platform',
        exclusiveNode: 'platform',
        maxCoTenants: 'platform',
        preset: 'platform',
      },
      version: RESOURCE_RESERVATION_VERSION,
    });
  });

  it('resolves task-level requirements as highest priority', () => {
    const result = resolveResourceReservation(
      {
        task: { minVcpu: 8, minMemoryMb: 16384 },
        project: { minVcpu: 2, minMemoryMb: 4096, minDiskMb: 81920 },
      },
      { taskId: 'task-1', projectId: 'proj-1' },
    );

    // task wins for minVcpu and minMemoryMb
    expect(result.cpuMillis).toBe(8000);
    expect(result.memoryMb).toBe(16 * 1024);
    // project fills in minDiskMb (task didn't set it)
    expect(result.diskMb).toBe(80 * 1024);
    // source is task (highest-priority contributor)
    expect(result.source).toBe('task');
    expect(result.sourceId).toBe('task-1');
  });

  it('performs per-field resolution across layers', () => {
    const result = resolveResourceReservation(
      {
        task: { minVcpu: 4 },
        agentProfile: { minMemoryMb: 8192, minDiskMb: 102400 },
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
      task: { minVcpu: 3, minMemoryMb: 12288, minDiskMb: 204800 },
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

  it('uses trigger layer as sole contributor with correct sourceId', () => {
    const result = resolveResourceReservation(
      { trigger: { minVcpu: 4, minMemoryMb: 8192 } },
      { triggerId: 'trig-1' },
    );

    expect(result.cpuMillis).toBe(4000);
    expect(result.memoryMb).toBe(8 * 1024);
    expect(result.source).toBe('trigger');
    expect(result.sourceId).toBe('trig-1');
  });

  it('uses project layer as sole contributor with correct sourceId', () => {
    const result = resolveResourceReservation(
      { project: { minVcpu: 4, minDiskMb: 81920 } },
      { projectId: 'proj-1' },
    );

    expect(result.cpuMillis).toBe(4000);
    expect(result.diskMb).toBe(80 * 1024);
    expect(result.source).toBe('project');
    expect(result.sourceId).toBe('proj-1');
  });

  it('rejects invalid numeric requirements', () => {
    const result = validateResourceRequirements({ maxCoTenants: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('maxCoTenants');
  });

  it('records per-field provenance', () => {
    const result = resolveResourceReservation({
      task: { minVcpu: 4 },
      project: { maxCoTenants: 2 },
    });

    expect(result.fieldSources.minVcpu).toBe('task');
    expect(result.fieldSources.maxCoTenants).toBe('project');
    expect(result.fieldSources.minMemoryMb).toBe('platform');
  });

  it('produces output safe for JSON.stringify (no undefined values)', () => {
    const result = resolveResourceReservation({});
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);

    // Every field survives round-trip (undefined would be dropped by JSON.stringify)
    expect(parsed.cpuMillis).toBe(result.cpuMillis);
    expect(parsed.memoryMb).toBe(result.memoryMb);
    expect(parsed.diskMb).toBe(result.diskMb);
    expect(parsed.exclusiveNode).toBe(result.exclusiveNode);
    expect(parsed.maxCoTenants).toBe(result.maxCoTenants);
    expect(parsed.source).toBe(result.source);
    expect(parsed.sourceId).toBe(result.sourceId);
    expect(parsed.version).toBe(result.version);
    expect(Object.keys(parsed).length).toBe(Object.keys(result).length);
  });
});

describe('selectVmSizeForRequirements', () => {
  it('selects small for requirements that fit small', () => {
    const size = selectVmSizeForRequirements({
      minVcpu: 2,
      minMemoryMb: 4096,
      minDiskMb: 40960,
      exclusiveNode: false,
      maxCoTenants: 4,
    });
    expect(size).toBe('small');
  });

  it('selects medium when small is too small', () => {
    const size = selectVmSizeForRequirements({
      minVcpu: 4,
      minMemoryMb: 8192,
      minDiskMb: 81920,
      exclusiveNode: false,
      maxCoTenants: 4,
    });
    expect(size).toBe('medium');
  });

  it('selects large when medium is too small', () => {
    const size = selectVmSizeForRequirements({
      minVcpu: 8,
      minMemoryMb: 16384,
      minDiskMb: 163840,
      exclusiveNode: false,
      maxCoTenants: 4,
    });
    expect(size).toBe('large');
  });

  it('returns large as best-effort when nothing fits', () => {
    const size = selectVmSizeForRequirements({
      minVcpu: 64,
      minMemoryMb: 262144,
      minDiskMb: 2048000,
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
        minMemoryMb: 10240,
        minDiskMb: 102400,
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
        minMemoryMb: 4096,
        minDiskMb: 40960,
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
        minMemoryMb: 4096,
        minDiskMb: 40960,
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
      minMemoryMb: 2048,
      minDiskMb: 61440,
      exclusiveNode: false,
      maxCoTenants: 4,
    });
    expect(size).toBe('medium'); // hetzner small has 40GB, medium has 80GB
  });
});
