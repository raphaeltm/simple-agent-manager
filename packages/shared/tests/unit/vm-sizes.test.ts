import { describe, expect, it } from 'vitest';

import {
  canSatisfyVmSize,
  DEFAULT_VM_SIZE_VCPUS,
  getVcpuCount,
  PROVIDER_VM_SIZE_VCPUS,
} from '../../src/constants';

describe('VM Size vCPU Constants', () => {
  describe('DEFAULT_VM_SIZE_VCPUS', () => {
    it('defines vCPU counts for all standard sizes', () => {
      expect(DEFAULT_VM_SIZE_VCPUS).toEqual({ small: 2, medium: 4, large: 8 });
    });
  });

  describe('PROVIDER_VM_SIZE_VCPUS', () => {
    it('defines provider-specific vCPU counts for hetzner', () => {
      expect(PROVIDER_VM_SIZE_VCPUS['hetzner']).toEqual({ small: 2, medium: 4, large: 8 });
    });

    it('defines provider-specific vCPU counts for scaleway', () => {
      expect(PROVIDER_VM_SIZE_VCPUS['scaleway']).toEqual({ small: 3, medium: 4, large: 8 });
    });

    it('defines provider-specific vCPU counts for gcp', () => {
      expect(PROVIDER_VM_SIZE_VCPUS['gcp']).toEqual({ small: 1, medium: 2, large: 4 });
    });
  });

  describe('getVcpuCount', () => {
    it('returns default vCPU count when no provider specified', () => {
      expect(getVcpuCount('small')).toBe(2);
      expect(getVcpuCount('medium')).toBe(4);
      expect(getVcpuCount('large')).toBe(8);
    });

    it('returns default vCPU count when provider is null', () => {
      expect(getVcpuCount('small', null)).toBe(2);
      expect(getVcpuCount('medium', null)).toBe(4);
    });

    it('returns provider-specific vCPU count for hetzner', () => {
      expect(getVcpuCount('small', 'hetzner')).toBe(2);
      expect(getVcpuCount('medium', 'hetzner')).toBe(4);
      expect(getVcpuCount('large', 'hetzner')).toBe(8);
    });

    it('returns provider-specific vCPU count for scaleway', () => {
      expect(getVcpuCount('small', 'scaleway')).toBe(3);
      expect(getVcpuCount('medium', 'scaleway')).toBe(4);
      expect(getVcpuCount('large', 'scaleway')).toBe(8);
    });

    it('returns provider-specific vCPU count for gcp', () => {
      expect(getVcpuCount('small', 'gcp')).toBe(1);
      expect(getVcpuCount('medium', 'gcp')).toBe(2);
      expect(getVcpuCount('large', 'gcp')).toBe(4);
    });

    it('falls back to default for unknown provider', () => {
      expect(getVcpuCount('small', 'unknown-provider')).toBe(2);
      expect(getVcpuCount('large', 'unknown-provider')).toBe(8);
    });

    it('falls back to 2 for unknown VM size', () => {
      expect(getVcpuCount('xlarge')).toBe(2);
      expect(getVcpuCount('tiny', 'hetzner')).toBe(2);
    });

    it('falls back to default size when provider lacks that size', () => {
      // If a provider doesn't define a size but the default does
      expect(getVcpuCount('medium', 'unknown-provider')).toBe(4);
    });
  });

  describe('canSatisfyVmSize', () => {
    it('allows exact size matches', () => {
      expect(canSatisfyVmSize('small', 'small')).toBe(true);
      expect(canSatisfyVmSize('medium', 'medium')).toBe(true);
      expect(canSatisfyVmSize('large', 'large')).toBe(true);
    });

    it('allows larger nodes to satisfy smaller requested sizes', () => {
      expect(canSatisfyVmSize('medium', 'small')).toBe(true);
      expect(canSatisfyVmSize('large', 'small')).toBe(true);
      expect(canSatisfyVmSize('large', 'medium')).toBe(true);
    });

    it('rejects smaller nodes for larger requested sizes', () => {
      expect(canSatisfyVmSize('small', 'medium')).toBe(false);
      expect(canSatisfyVmSize('small', 'large')).toBe(false);
      expect(canSatisfyVmSize('medium', 'large')).toBe(false);
    });

    it('treats missing requested size as no minimum requirement', () => {
      expect(canSatisfyVmSize('small', null)).toBe(true);
      expect(canSatisfyVmSize('small', undefined)).toBe(true);
    });

    it('rejects unknown candidate sizes when a known minimum is requested', () => {
      expect(canSatisfyVmSize('tiny', 'small')).toBe(false);
      expect(canSatisfyVmSize(null, 'small')).toBe(false);
    });

    it('treats unknown requested sizes as no minimum requirement', () => {
      expect(canSatisfyVmSize('small', 'xlarge')).toBe(true);
    });
  });
});
