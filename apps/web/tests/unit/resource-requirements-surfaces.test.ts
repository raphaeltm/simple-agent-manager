import { describe, expect, it } from 'vitest';

import {
  deserializeResourceRequirements,
  EMPTY_RESOURCE_STATE,
  formatHardwareDisplay,
  formatLegacyVmSize,
  hasAnyResourceValue,
  type ResourceRequirementsFormState,
  serializeResourceRequirements,
  toResourceRequirements,
} from '../../src/components/resource-requirements';
import { buildBaseSubmitRequest } from '../../src/pages/project-chat/submitRequest';

// ---------------------------------------------------------------------------
// Profile form payload simulation
// ---------------------------------------------------------------------------
describe('ProfileFormDialog payload construction', () => {
  function buildProfilePayload(
    resourceReqs: ResourceRequirementsFormState,
    vmSizeOverride: string
  ) {
    return {
      vmSizeOverride: hasAnyResourceValue(resourceReqs) ? null : vmSizeOverride || null,
      resourceRequirementsJson: serializeResourceRequirements(resourceReqs),
    };
  }

  it('legacy-only profile: no-op edit preserves vmSizeOverride', () => {
    const existing = deserializeResourceRequirements(null);
    const payload = buildProfilePayload(existing, 'medium');
    expect(payload.vmSizeOverride).toBe('medium');
    expect(payload.resourceRequirementsJson).toBeNull();
  });

  it('modern-only profile: no-op edit preserves resourceRequirementsJson', () => {
    const json = JSON.stringify({ minVcpu: 4, minMemoryGb: 8 });
    const existing = deserializeResourceRequirements(json);
    const payload = buildProfilePayload(existing, '');
    expect(payload.vmSizeOverride).toBeNull();
    expect(payload.resourceRequirementsJson).not.toBeNull();
    const parsed = JSON.parse(payload.resourceRequirementsJson!);
    expect(parsed.minVcpu).toBe(4);
    expect(parsed.minMemoryGb).toBe(8);
  });

  it('mixed legacy+modern: modern values null legacy', () => {
    const json = JSON.stringify({ minVcpu: 4 });
    const existing = deserializeResourceRequirements(json);
    const payload = buildProfilePayload(existing, 'large');
    expect(payload.vmSizeOverride).toBeNull();
    expect(payload.resourceRequirementsJson).not.toBeNull();
  });

  it('inherit clears both modern and legacy', () => {
    const cleared = { ...EMPTY_RESOURCE_STATE };
    const payload = buildProfilePayload(cleared, '');
    expect(payload.vmSizeOverride).toBeNull();
    expect(payload.resourceRequirementsJson).toBeNull();
  });

  it('exclusiveNode=false is preserved as a modern value', () => {
    const json = JSON.stringify({ exclusiveNode: false, maxCoTenants: 3 });
    const existing = deserializeResourceRequirements(json);
    const payload = buildProfilePayload(existing, 'medium');
    expect(payload.vmSizeOverride).toBeNull();
    const parsed = JSON.parse(payload.resourceRequirementsJson!);
    expect(parsed.exclusiveNode).toBe(false);
    expect(parsed.maxCoTenants).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Trigger form payload simulation
// ---------------------------------------------------------------------------
describe('TriggerForm payload construction', () => {
  function buildTriggerUpdatePayload(
    resourceReqs: ResourceRequirementsFormState,
    vmSizeOverride: string
  ) {
    return {
      vmSizeOverride: hasAnyResourceValue(resourceReqs) ? null : vmSizeOverride || null,
      resourceRequirementsJson: serializeResourceRequirements(resourceReqs),
    };
  }

  it('legacy trigger: no-op preserves vmSizeOverride', () => {
    const existing = deserializeResourceRequirements(null);
    const payload = buildTriggerUpdatePayload(existing, 'large');
    expect(payload.vmSizeOverride).toBe('large');
    expect(payload.resourceRequirementsJson).toBeNull();
  });

  it('modern trigger: round-trips through deserialize-serialize', () => {
    const json = JSON.stringify({ minVcpu: 2, exclusiveNode: true, maxCoTenants: 1 });
    const existing = deserializeResourceRequirements(json);
    const payload = buildTriggerUpdatePayload(existing, '');
    const parsed = JSON.parse(payload.resourceRequirementsJson!);
    expect(parsed.minVcpu).toBe(2);
    expect(parsed.exclusiveNode).toBe(true);
    expect(parsed.maxCoTenants).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Skill form payload simulation
// ---------------------------------------------------------------------------
describe('SkillFormDialog payload construction', () => {
  it('skill with only vmSizeOverride: no-op preserves both', () => {
    const existing = deserializeResourceRequirements(null);
    const payload = {
      vmSizeOverride: 'small' || null,
      resourceRequirementsJson: serializeResourceRequirements(existing),
    };
    expect(payload.vmSizeOverride).toBe('small');
    expect(payload.resourceRequirementsJson).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Project settings payload simulation
// ---------------------------------------------------------------------------
describe('ProjectSettings payload construction', () => {
  function buildProjectPayload(
    resourceReqs: ResourceRequirementsFormState,
    legacyVmSize: string | null
  ) {
    const json = serializeResourceRequirements(resourceReqs);
    return {
      defaultVmSize: hasAnyResourceValue(resourceReqs) ? null : (legacyVmSize ?? undefined),
      ...(json != null ? { resourceRequirementsJson: json } : {}),
    };
  }

  it('legacy project: no-op preserves defaultVmSize', () => {
    const existing = deserializeResourceRequirements(null);
    const payload = buildProjectPayload(existing, 'medium');
    expect(payload.defaultVmSize).toBe('medium');
    expect(payload).not.toHaveProperty('resourceRequirementsJson');
  });

  it('modern project: nulls defaultVmSize', () => {
    const json = JSON.stringify({ minVcpu: 8 });
    const existing = deserializeResourceRequirements(json);
    const payload = buildProjectPayload(existing, 'medium');
    expect(payload.defaultVmSize).toBeNull();
    expect(payload.resourceRequirementsJson).not.toBeNull();
  });

  it('empty project with no legacy: returns undefined defaultVmSize', () => {
    const existing = deserializeResourceRequirements(null);
    const payload = buildProjectPayload(existing, null);
    expect(payload.defaultVmSize).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chat submit (buildBaseSubmitRequest)
// ---------------------------------------------------------------------------
describe('buildBaseSubmitRequest', () => {
  const BASE_ARGS = {
    message: 'test message',
    agentProfileId: null as string | null,
    skillId: null as string | null,
    selectedAgentType: 'claude-code' as string | null,
    selectedWorkspaceProfile: 'full' as const,
    selectedDevcontainerConfigName: '',
    selectedTaskMode: 'task' as const,
    pendingDerived: null,
  };

  it('omits resource requirements when agentProfileId is set', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      agentProfileId: 'profile-123',
      selectedResourceRequirements: { minVcpu: 4 },
    });
    expect(result).not.toHaveProperty('resourceRequirements');
    expect(result.agentProfileId).toBe('profile-123');
  });

  it('includes resource requirements when no profile is selected', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      selectedResourceRequirements: { minVcpu: 4, minMemoryGb: 8 },
    });
    expect(result).toHaveProperty('resourceRequirements');
    expect((result as { resourceRequirements: { minVcpu: number } }).resourceRequirements.minVcpu).toBe(4);
  });

  it('omits resource requirements when selectedResourceRequirements is undefined', () => {
    const result = buildBaseSubmitRequest(BASE_ARGS);
    expect(result).not.toHaveProperty('resourceRequirements');
  });

  it('includes skillId alongside profile', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      agentProfileId: 'profile-123',
      skillId: 'skill-456',
    });
    expect(result.agentProfileId).toBe('profile-123');
    expect((result as { skillId: string }).skillId).toBe('skill-456');
  });

  it('omits devcontainerConfigName for lightweight profile', () => {
    const result = buildBaseSubmitRequest({
      ...BASE_ARGS,
      selectedWorkspaceProfile: 'lightweight',
      selectedDevcontainerConfigName: 'my-config',
    });
    expect(result).not.toHaveProperty('devcontainerConfigName');
  });
});

// ---------------------------------------------------------------------------
// TaskSubmitForm resource requirements (toResourceRequirements)
// ---------------------------------------------------------------------------
describe('TaskSubmitForm resource requirements via toResourceRequirements', () => {
  it('converts form state to ResourceRequirements for API', () => {
    const formState: ResourceRequirementsFormState = {
      minVcpu: '4',
      minMemoryGb: '8',
      minDiskGb: '',
      exclusiveNode: undefined,
      maxCoTenants: '',
    };
    const result = toResourceRequirements(formState);
    expect(result).toEqual({ minVcpu: 4, minMemoryGb: 8 });
  });

  it('returns undefined for empty form state', () => {
    const result = toResourceRequirements({ ...EMPTY_RESOURCE_STATE });
    expect(result).toBeUndefined();
  });

  it('preserves zero disk value', () => {
    const formState: ResourceRequirementsFormState = {
      ...EMPTY_RESOURCE_STATE,
      minDiskGb: '0',
    };
    const result = toResourceRequirements(formState);
    expect(result).toEqual({ minDiskGb: 0 });
  });

  it('rejects NaN values silently', () => {
    const formState: ResourceRequirementsFormState = {
      ...EMPTY_RESOURCE_STATE,
      minVcpu: 'abc',
    };
    const result = toResourceRequirements(formState);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Display formatting (all surfaces)
// ---------------------------------------------------------------------------
describe('formatHardwareDisplay for all display surfaces', () => {
  it('shows native instance details when available (SessionHeaderInfrastructure)', () => {
    const result = formatHardwareDisplay({
      providerInstanceType: 'cpx31',
      providerInstanceVcpuCount: 4,
      providerInstanceMemoryMb: 8192,
      providerInstanceDiskGb: 160,
      vmSize: 'medium',
    });
    expect(result).toBe('cpx31 · 4 vCPU · 8 GB · 160 GB disk');
  });

  it('falls back to legacy label for WorkspaceSidebar (vmSize only)', () => {
    const result = formatHardwareDisplay({ vmSize: 'large' });
    expect(result).toBe('Large (compatibility estimate)');
  });

  it('returns Unknown when no info available', () => {
    const result = formatHardwareDisplay({});
    expect(result).toBe('Unknown');
  });

  it('handles null provider fields gracefully', () => {
    const result = formatHardwareDisplay({
      providerInstanceType: null,
      providerInstanceVcpuCount: null,
      providerInstanceMemoryMb: null,
      providerInstanceDiskGb: null,
      vmSize: 'small',
    });
    expect(result).toBe('Small (compatibility estimate)');
  });

  it('shows partial native details', () => {
    const result = formatHardwareDisplay({
      providerInstanceType: 'n2-standard-4',
      providerInstanceVcpuCount: 4,
    });
    expect(result).toBe('n2-standard-4 · 4 vCPU');
  });
});

// ---------------------------------------------------------------------------
// Legacy VM size formatting
// ---------------------------------------------------------------------------
describe('formatLegacyVmSize edge cases', () => {
  it('handles empty string', () => {
    expect(formatLegacyVmSize('')).toBeNull();
  });

  it('passes through custom SKU names', () => {
    expect(formatLegacyVmSize('cpx21')).toBe('cpx21');
  });

  it('handles all standard sizes', () => {
    expect(formatLegacyVmSize('small')).toBe('Small');
    expect(formatLegacyVmSize('medium')).toBe('Medium');
    expect(formatLegacyVmSize('large')).toBe('Large');
  });
});

// ---------------------------------------------------------------------------
// hasAnyResourceValue edge cases
// ---------------------------------------------------------------------------
describe('hasAnyResourceValue edge cases', () => {
  it('returns false for all-empty strings with undefined exclusiveNode', () => {
    expect(hasAnyResourceValue({
      minVcpu: '',
      minMemoryGb: '',
      minDiskGb: '',
      exclusiveNode: undefined,
      maxCoTenants: '',
    })).toBe(false);
  });

  it('returns true for zero string value (truthy check)', () => {
    // '0' is truthy in JS, so this returns true
    expect(hasAnyResourceValue({ ...EMPTY_RESOURCE_STATE, minVcpu: '0' })).toBe(true);
  });
});
