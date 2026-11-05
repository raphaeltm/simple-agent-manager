/**
 * What a profile asks the scheduler for. Explicit requirements win, then the
 * legacy small/medium/large size (translated with the shared workload slices),
 * then the project/platform default. Instant profiles run in a container, so
 * they have no VM request at all.
 */
import {
  DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS,
  PLATFORM_RESOURCE_DEFAULTS,
  type ResourceRequirements,
  type VMSize,
} from '@simple-agent-manager/shared';

import type { MockProfile } from './mock-data';

export type ResourceSource = 'profile' | 'vm size' | 'default' | 'instant';

export interface ResolvedResources {
  source: ResourceSource;
  vcpu: number;
  memoryGb: number;
  diskGb: number;
  exclusive: boolean;
}

export function resolveResources(profile: MockProfile): ResolvedResources | null {
  if (profile.runtime === 'instant') return null;
  const base = PLATFORM_RESOURCE_DEFAULTS;
  let layer: ResourceRequirements = {};
  let source: ResourceSource = 'default';
  if (profile.resources) {
    layer = profile.resources;
    source = 'profile';
  } else if (profile.vmSize && profile.vmSize in DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS) {
    layer = DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS[profile.vmSize as VMSize];
    source = 'vm size';
  }
  return {
    source,
    vcpu: layer.minVcpu ?? base.minVcpu,
    memoryGb: layer.minMemoryGb ?? base.minMemoryGb,
    diskGb: layer.minDiskGb ?? base.minDiskGb,
    exclusive: layer.exclusiveNode ?? base.exclusiveNode,
  };
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

/** "2 vCPU · 3.6 GB" (disk only in the long form). */
export function resourceShort(r: ResolvedResources): string {
  return `${num(r.vcpu)} vCPU · ${num(r.memoryGb)} GB`;
}

export function resourceLong(r: ResolvedResources): string {
  return `${num(r.vcpu)} vCPU · ${num(r.memoryGb)} GB RAM · ${num(r.diskGb)} GB disk`;
}

export const RESOURCE_SOURCE_LABEL: Record<ResourceSource, string> = {
  profile: 'set on this profile',
  'vm size': 'from VM size',
  default: 'project default',
  instant: 'Instant container',
};
