import { describe, expect, it } from 'vitest';

import { defaultWorkspaceFitWarning } from '../../../src/lib/compute-pool-default-fit';
import { resolveWizardRuntime } from '../../../src/pages/project-chat/profileWizardHelpers';

function machine(vcpu: number | null, ramGb: number | null, diskGb: number | null = 40) {
  return { vcpu, memoryMb: ramGb === null ? null : ramGb * 1024, diskGb };
}

/** The allowed machines, as both callers pass them. */
function groups(...machines: ReturnType<typeof machine>[]) {
  return machines;
}

function settings(minVcpu: number, minMemoryGb: number, hostMemoryReserveMb?: number) {
  return {
    resourceDefaults: {
      legacyWorkloadMapping: {} as never,
      platformDefaults: { minVcpu, minMemoryGb, minDiskGb: 15, exclusiveNode: false },
    },
    hostMemoryReserveMb,
  };
}

describe('defaultWorkspaceFitWarning', () => {
  it('stays quiet on an exact fit and warns one MB short of it', () => {
    // 5 GB machine, 1 GB reserve, 4 GB needed: exactly enough.
    expect(defaultWorkspaceFitWarning(groups(machine(2, 5)), settings(2, 4, 1024))).toBeNull();
    expect(defaultWorkspaceFitWarning(groups(machine(2, 5)), settings(2, 4, 1025))).toMatch(
      /^No allowed machine can run a default workspace/
    );
  });

  it('warns when memory fits but vCPU does not', () => {
    expect(defaultWorkspaceFitWarning(groups(machine(1, 32)), settings(2, 4, 1024))).toContain(
      'at least 2 vCPU, 5 GB of memory and 15 GB of disk'
    );
  });

  it('warns when vCPU and memory fit but the known disk is too small, as placement refuses it', () => {
    expect(defaultWorkspaceFitWarning(groups(machine(4, 8, 10)), settings(2, 4, 1024))).toContain(
      '15 GB of disk'
    );
    // Unknown disk is not checked, as in placement.
    expect(
      defaultWorkspaceFitWarning(groups(machine(4, 8, null)), settings(2, 4, 1024))
    ).toBeNull();
    expect(defaultWorkspaceFitWarning(groups(machine(4, 8, 15)), settings(2, 4, 1024))).toBeNull();
  });

  it('says nothing when an allowed machine has an unknown size', () => {
    expect(
      defaultWorkspaceFitWarning(groups(machine(2, 4), machine(null, 8)), settings(2, 4, 1024))
    ).toBeNull();
    expect(
      defaultWorkspaceFitWarning(groups(machine(2, 4), machine(4, null)), settings(2, 4, 1024))
    ).toBeNull();
  });

  it('says nothing without the installation settings or without allowed machines', () => {
    expect(defaultWorkspaceFitWarning(groups(machine(2, 4)), undefined)).toBeNull();
    expect(defaultWorkspaceFitWarning(groups(machine(2, 4)), null)).toBeNull();
    // An older server sends the defaults but no host reserve.
    expect(defaultWorkspaceFitWarning(groups(machine(2, 4)), settings(2, 4))).toBeNull();
    expect(defaultWorkspaceFitWarning([], settings(2, 4, 1024))).toBeNull();
  });

  it('uses the installation reserve as given, including none and fractions of a GB', () => {
    expect(defaultWorkspaceFitWarning(groups(machine(2, 4)), settings(2, 4, 0))).toBeNull();
    expect(defaultWorkspaceFitWarning(groups(machine(2, 4)), settings(2, 4, 512))).toContain(
      'keeps 0.5 GB of memory for itself. Allow a machine with at least 2 vCPU, 4.5 GB of memory'
    );
  });
});

describe('resolveWizardRuntime', () => {
  it.each([
    ['conversation', null, true, 'cf-container'],
    ['conversation', null, false, 'vm'],
    ['task', null, true, 'vm'],
    ['conversation', 'vm', true, 'vm'],
    ['conversation', 'cf-container', false, 'cf-container'],
  ] as const)('%s with runtime %s and instant=%s gives %s', (work, runtime, instant, expected) => {
    expect(resolveWizardRuntime(work, runtime, instant)).toBe(expected);
  });
});
