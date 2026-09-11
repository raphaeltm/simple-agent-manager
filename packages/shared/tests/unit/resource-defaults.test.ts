import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS,
  LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION,
  PLATFORM_RESOURCE_DEFAULTS,
  resolveResourceReservation,
  RESOURCE_RESERVATION_VERSION,
  selectVmSizeForRequirements,
} from '../../src/constants/resource-defaults';
import type { ResourceRequirements } from '../../src/types/resource';

describe('resolveResourceReservation', () => {
  it('returns platform defaults when no layers provide requirements', () => {
    const result = resolveResourceReservation({});
    expect(result).toMatchObject({
      cpuMillis: PLATFORM_RESOURCE_DEFAULTS.minVcpu * 1000,
      memoryMb: PLATFORM_RESOURCE_DEFAULTS.minMemoryGb * 1024,
      diskMb: PLATFORM_RESOURCE_DEFAULTS.minDiskGb * 1024,
      exclusiveNode: false,
      maxCoTenants: 4,
      source: 'platform',
      sourceId: 'platform',
      version: RESOURCE_RESERVATION_VERSION,
    });
    expect(result.fieldProvenance?.minVcpu?.source).toBe('platform');
  });

  it('resolves task-level requirements as highest priority', () => {
    const result = resolveResourceReservation(
      {
        task: { minVcpu: 8, minMemoryGb: 16 },
        project: { minVcpu: 2, minMemoryGb: 4, minDiskGb: 80 },
      },
      { taskId: 'task-1', projectId: 'proj-1' }
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
      { taskId: 't1', agentProfileId: 'ap1', projectId: 'p1' }
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
      { agentProfileId: 'ap-99' }
    );

    expect(result.cpuMillis).toBe(6000);
    expect(result.source).toBe('agent-profile');
    expect(result.sourceId).toBe('ap-99');
  });

  it('uses user layer when only user provides requirements', () => {
    const result = resolveResourceReservation(
      { user: { exclusiveNode: true, maxCoTenants: 1 } },
      { userId: 'u-42' }
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

  it('uses trigger layer as sole contributor with correct sourceId', () => {
    const result = resolveResourceReservation(
      { trigger: { minVcpu: 4, minMemoryGb: 8 } },
      { triggerId: 'trig-1' }
    );

    expect(result.cpuMillis).toBe(4000);
    expect(result.memoryMb).toBe(8 * 1024);
    expect(result.source).toBe('trigger');
    expect(result.sourceId).toBe('trig-1');
  });

  it('uses project layer as sole contributor with correct sourceId', () => {
    const result = resolveResourceReservation(
      { project: { minVcpu: 4, minDiskGb: 80 } },
      { projectId: 'proj-1' }
    );

    expect(result.cpuMillis).toBe(4000);
    expect(result.diskMb).toBe(80 * 1024);
    expect(result.source).toBe('project');
    expect(result.sourceId).toBe('proj-1');
  });

  it('rejects invalid zero tenant limits instead of silently accepting them', () => {
    expect(() =>
      resolveResourceReservation({
        task: { maxCoTenants: 0 },
        project: { maxCoTenants: 4 },
      })
    ).toThrow('resourceRequirements.maxCoTenants must be a positive safe integer');
  });

  it('requires complete platform defaults', () => {
    expect(() =>
      resolveResourceReservation(
        {},
        {},
        {
          platformDefaults: {
            minVcpu: 2,
            minMemoryGb: 4,
            minDiskGb: 40,
            exclusiveNode: false,
          } as Required<ResourceRequirements>,
        }
      )
    ).toThrow('resourceRequirements.maxCoTenants is required');
  });

  it('maps legacy sizes to distinct workload slices with per-field provenance', () => {
    const small = resolveResourceReservation({}, {}, { legacyVmSizes: { task: 'small' } });
    const medium = resolveResourceReservation({}, {}, { legacyVmSizes: { task: 'medium' } });
    const large = resolveResourceReservation({}, {}, { legacyVmSizes: { task: 'large' } });

    expect(small.cpuMillis).toBe(DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.small.minVcpu * 1000);
    expect(medium.cpuMillis).toBe(
      DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.medium.minVcpu * 1000
    );
    expect(large.cpuMillis).toBe(DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.large.minVcpu * 1000);
    expect(new Set([small.cpuMillis, medium.cpuMillis, large.cpuMillis]).size).toBe(3);
    expect(small.fieldProvenance?.minVcpu?.compatibility).toMatchObject({
      adapter: 'legacy-vm-size-workload',
      legacyVmSize: 'small',
    });
  });

  it('maps legacy sizes through adapter v2 to exact workload reservation units', () => {
    const cases = [
      ['small', 625, 1152, 13_312, 3],
      ['medium', 2_000, 3_712, 40_960, 2],
      ['large', 4_000, 7_808, 81_920, 2],
    ] as const;

    for (const [legacySize, cpuMillis, memoryMb, diskMb, maxCoTenants] of cases) {
      const result = resolveResourceReservation({}, {}, { legacyVmSizes: { task: legacySize } });
      expect(result).toMatchObject({
        cpuMillis,
        memoryMb,
        diskMb,
        exclusiveNode: false,
        maxCoTenants,
      });
      expect(result.fieldProvenance?.minVcpu?.compatibility).toMatchObject({
        adapter: 'legacy-vm-size-workload',
        version: LEGACY_VM_SIZE_WORKLOAD_ADAPTER_VERSION,
        legacyVmSize: legacySize,
      });
    }
  });

  it('keeps modern fields authoritative over legacy values within the same layer', () => {
    const result = resolveResourceReservation(
      { task: { minMemoryGb: 12 } },
      { taskId: 'task-modern' },
      { legacyVmSizes: { task: 'small' } }
    );

    expect(result.cpuMillis).toBe(
      DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.small.minVcpu * 1000
    );
    expect(result.memoryMb).toBe(12 * 1024);
    expect(result.fieldProvenance?.minMemoryGb).toMatchObject({
      source: 'task',
      sourceId: 'task-modern',
      value: 12,
    });
    expect(result.fieldProvenance?.minMemoryGb?.compatibility).toBeUndefined();
  });

  it('applies each layer legacy defaults before moving to lower-priority modern defaults', () => {
    const result = resolveResourceReservation(
      {
        project: { minVcpu: 1, minMemoryGb: 2 },
      },
      { taskId: 'task-legacy', projectId: 'project-modern' },
      { legacyVmSizes: { task: 'large' } }
    );

    expect(result.cpuMillis).toBe(4000);
    expect(result.memoryMb).toBe(
      DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.large.minMemoryGb * 1024
    );
    expect(result.fieldProvenance?.minVcpu).toMatchObject({
      source: 'task',
      sourceId: 'task-legacy',
      compatibility: { legacyVmSize: 'large' },
    });
    expect(result.fieldProvenance?.minMemoryGb?.source).toBe('task');
  });

  it('lets same-layer modern fields win while same-layer legacy fills the rest before project defaults', () => {
    const result = resolveResourceReservation(
      {
        task: { minMemoryGb: 12 },
        project: { minVcpu: 1 },
      },
      { taskId: 'task-modern-legacy', projectId: 'project-modern' },
      { legacyVmSizes: { task: 'large' } }
    );

    expect(result.cpuMillis).toBe(4000);
    expect(result.memoryMb).toBe(12 * 1024);
    expect(result.fieldProvenance?.minVcpu).toMatchObject({
      source: 'task',
      compatibility: { legacyVmSize: 'large' },
    });
    expect(result.fieldProvenance?.minMemoryGb).toMatchObject({
      source: 'task',
      value: 12,
    });
    expect(result.fieldProvenance?.minMemoryGb?.compatibility).toBeUndefined();
  });

  it('preserves precedence and provenance across task, trigger, skill, profile, project, user, and platform legacy layers', () => {
    const result = resolveResourceReservation(
      {
        task: { exclusiveNode: false },
        trigger: { minDiskGb: 33 },
        skill: { minMemoryGb: 9 },
        agentProfile: { maxCoTenants: 2 },
        project: { minVcpu: 1 },
        user: { minMemoryGb: 2 },
      },
      {
        taskId: 'task-id',
        triggerId: 'trigger-id',
        skillId: 'skill-id',
        agentProfileId: 'profile-id',
        projectId: 'project-id',
        userId: 'user-id',
      },
      {
        legacyVmSizes: {
          task: 'small',
          trigger: 'medium',
          skill: 'large',
          'agent-profile': 'medium',
          project: 'large',
          user: 'large',
        },
      }
    );

    expect(result).toMatchObject({
      cpuMillis: DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.small.minVcpu * 1000,
      memoryMb: DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.small.minMemoryGb * 1024,
      diskMb: DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.small.minDiskGb * 1024,
      exclusiveNode: false,
      maxCoTenants: DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.small.maxCoTenants,
      source: 'task',
      sourceId: 'task-id',
    });
    expect(result.fieldProvenance?.minVcpu?.source).toBe('task');
    expect(result.fieldProvenance?.minMemoryGb?.source).toBe('task');
    expect(result.fieldProvenance?.minDiskGb?.source).toBe('task');
    expect(result.fieldProvenance?.exclusiveNode?.source).toBe('task');
    expect(result.fieldProvenance?.maxCoTenants?.source).toBe('task');
  });

  it('fills missing fields from the same layer legacy VM size before lower modern layers', () => {
    const result = resolveResourceReservation(
      {
        skill: { minVcpu: 4 },
        agentProfile: { minMemoryGb: 64, minDiskGb: 500 },
        project: { exclusiveNode: true },
      },
      {
        skillId: 'skill-id',
        agentProfileId: 'profile-id',
        projectId: 'project-id',
      },
      {
        legacyVmSizes: {
          skill: 'large',
          'agent-profile': 'small',
        },
      }
    );

    expect(result).toMatchObject({
      cpuMillis: 4000,
      memoryMb: DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.large.minMemoryGb * 1024,
      diskMb: DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.large.minDiskGb * 1024,
      exclusiveNode: false,
      maxCoTenants: DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.large.maxCoTenants,
      source: 'skill',
      sourceId: 'skill-id',
    });
    expect(result.fieldProvenance?.minVcpu).toMatchObject({
      source: 'skill',
      value: 4,
    });
    expect(result.fieldProvenance?.minMemoryGb).toMatchObject({
      source: 'skill',
      value: DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.large.minMemoryGb,
      compatibility: { legacyVmSize: 'large' },
    });
    expect(result.fieldProvenance?.minDiskGb).toMatchObject({
      source: 'skill',
      value: 80,
      compatibility: { legacyVmSize: 'large' },
    });
    expect(result.fieldProvenance?.exclusiveNode).toMatchObject({
      source: 'skill',
      value: false,
      compatibility: { legacyVmSize: 'large' },
    });
  });

  it('emits bounded integer reservation units with conservative rounding', () => {
    const result = resolveResourceReservation({
      task: { minVcpu: 0.0001, minMemoryGb: 0.1, minDiskGb: 0, maxCoTenants: 1 },
    });

    expect(result.cpuMillis).toBe(1);
    expect(result.memoryMb).toBe(103);
    expect(result.diskMb).toBe(0);
    expect(result.maxCoTenants).toBe(1);
  });

  it('rejects reservation values that cannot be represented as safe integer units', () => {
    expect(() =>
      resolveResourceReservation({
        task: { minVcpu: Number.MAX_SAFE_INTEGER },
      })
    ).toThrow('resourceRequirements.minVcpu converts to unsafe reservation units');
    expect(() =>
      resolveResourceReservation(
        {},
        {},
        {
          legacyWorkloadMapping: {
            ...DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS,
            small: {
              ...DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS.small,
              minMemoryGb: Number.POSITIVE_INFINITY,
            },
          },
        }
      )
    ).toThrow('resourceRequirements.minMemoryGb must be a finite number');
  });

  it('applies field precedence across task, skill, profile, project, user, and platform layers', () => {
    const result = resolveResourceReservation(
      {
        task: { minDiskGb: 120 },
        skill: { minVcpu: 6 },
        agentProfile: { minMemoryGb: 10 },
        project: { exclusiveNode: true },
        user: { maxCoTenants: 2 },
      },
      {
        taskId: 'task-1',
        skillId: 'skill-1',
        agentProfileId: 'profile-1',
        projectId: 'project-1',
        userId: 'user-1',
      }
    );

    expect(result).toMatchObject({
      cpuMillis: 6000,
      memoryMb: 10 * 1024,
      diskMb: 120 * 1024,
      exclusiveNode: true,
      maxCoTenants: 2,
      source: 'task',
    });
    expect(result.fieldProvenance?.minVcpu?.source).toBe('skill');
    expect(result.fieldProvenance?.minMemoryGb?.source).toBe('agent-profile');
    expect(result.fieldProvenance?.exclusiveNode?.source).toBe('project');
    expect(result.fieldProvenance?.maxCoTenants?.source).toBe('user');
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
      'scaleway'
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
      'gcp'
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
      'unknown-provider'
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
