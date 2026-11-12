import { describe, expect, it } from 'vitest';

import { evaluateReusableNodeCandidate } from '../../src/durable-objects/task-runner/node-placement-candidate';
import {
  DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB,
  resolveWorkspaceAdmissionPolicy,
} from '../../src/scheduler-core';

function evaluate(memoryMb: number) {
  return evaluateReusableNodeCandidate({
    node: {
      id: 'host',
      vmSize: 'small',
      vmLocation: 'fsn1',
      cloudProvider: 'hetzner',
      nodeClass: 'managed',
      providerInstanceId: 'provider-1',
      observedHardwareSource: 'observed',
      observedProviderInstanceVcpuCount: 2,
      observedProviderInstanceMemoryMb: 4096,
      observedProviderInstanceDiskGb: 40,
      providerInstanceVcpuCount: 2,
      providerInstanceMemoryMb: 4096,
      providerInstanceDiskGb: 40,
      providerInstanceType: 'cx23',
      agentVersion: 'current-agent',
    },
    policy: resolveWorkspaceAdmissionPolicy({}),
    selection: null,
    usage: undefined,
    requestedReservation: {
      version: 3,
      cpuMillis: 500,
      memoryMb,
      diskMb: 1024,
      exclusiveNode: false,
      source: 'task',
      sourceId: 'task',
    },
    agentCompatible: true,
    satisfiesTaskResources: true,
    authoritative: false,
  });
}

describe('resource rejection reason before allocation authority', () => {
  it('identifies insufficient usable memory on a 4 GB host for a 3712 MB request', () => {
    expect(evaluate(3712).diagnosticHost.reasons).toEqual([
      'Host memory cannot satisfy the requested resources after host reserve',
    ]);
  });
  it('retains authority reason when hardware including reserve is sufficient', () => {
    // Exact fit: 4096 MB minus the default host reserve.
    expect(
      evaluate(4096 - DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB).diagnosticHost.reasons
    ).toEqual(['Host is outside the current pool allocation authority']);
  });
});
