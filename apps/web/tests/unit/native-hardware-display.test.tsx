import { describe, expect, it } from 'vitest';

import { hardwareRows, requestedResources } from '../../src/components/hardware/HardwareDetails';
import { parsePlacementDecision } from '../../src/components/hardware/PlacementDecisionSummary';

describe('hardware provenance at the public display boundary', () => {
  it('keeps measured hardware distinct from the native offering and never fills it from a legacy label', () => {
    expect(
      hardwareRows({
        vmSize: 'large',
        providerInstanceType: 'custom',
        providerInstanceVcpuCount: 16,
        observedProviderInstanceVcpuCount: 12,
        observedProviderInstanceMemoryMb: 30720,
      })
    ).toEqual([
      ['Observed hardware', 'Type unknown · 12 vCPU · 30 GB RAM · GB disk unknown'],
      ['Configured offering', 'custom · 16 vCPU · GB RAM unknown · GB disk unknown'],
    ]);
  });
  it('labels a custom boot disk as configured, without inventing observed storage', () => {
    const rows = hardwareRows({
      providerInstanceType: 'e2-custom',
      providerInstanceBootDiskSizeGb: 40,
      providerInstanceArchitecture: 'x86_64',
    });
    expect(rows[0]?.[1]).toContain('40 GB boot disk');
    expect(rows[0]?.[1]).toContain('x86_64');
    expect(rows).toContainEqual(['Observed hardware', 'Unknown — no hardware report']);
  });
  it('does not imply configured capacity is measured while a host awaits a report', () => {
    expect(
      hardwareRows({ providerInstanceType: 'cx53', providerInstanceVcpuCount: 16 })
    ).toContainEqual(['Observed hardware', 'Unknown — no hardware report']);
  });
  it('labels legacy records without substituting a current catalog SKU or CPU count', () => {
    expect(hardwareRows({ vmSize: 'small' })).toEqual([
      ['Observed hardware', 'Unknown — no hardware report'],
      ['Compatibility estimate', 'small'],
    ]);
  });
  it('does not make up an offering for an unknown historical record', () => {
    expect(hardwareRows({})).toEqual([['Observed hardware', 'Unknown — no hardware report']]);
  });
  it('converts canonical request units and preserves an explicitly zero disk request', () => {
    expect(
      requestedResources({
        resolvedReservationJson: JSON.stringify({ cpuMillis: 2500, memoryMb: 5120, diskMb: 0 }),
      })
    ).toBe('2.5 vCPU · 5 GB RAM · 0 GB disk');
  });
  it('marks only translated fields as compatibility estimates', () => {
    expect(
      requestedResources({
        resolvedReservationJson: JSON.stringify({
          cpuMillis: 2000,
          memoryMb: 5120,
          diskMb: 0,
          fieldProvenance: { minVcpu: { compatibility: { legacyVmSize: 'small' } } },
        }),
      })
    ).toBe('2 vCPU (compatibility estimate) · 5 GB RAM · 0 GB disk');
  });
  it('preserves an explicit sharing request and its co-tenant limit', () => {
    expect(
      requestedResources({
        resourceRequirementsJson: JSON.stringify({ exclusiveNode: false, maxCoTenants: 2 }),
      })
    ).toBe('node sharing allowed · up to 2 workspaces per node');
  });
  it('never renders arbitrary persisted source identities or diagnostics', () => {
    expect(
      requestedResources({
        resourceRequirementsJson: JSON.stringify({
          minVcpu: 3,
          credentialId: 'private',
          sourceId: 'private',
          reason: 'private',
        }),
      })
    ).toBe('3 vCPU');
  });
  it.each(['{', 'null', '[]', '{"minVcpu":"2"}'])(
    'handles invalid historical request %s',
    (raw) => {
      expect(requestedResources({ resourceRequirementsJson: raw })).toBe(
        'Unknown — no saved resource request'
      );
    }
  );
  it('does not mistake a legacy placement explanation for canonical runtime diagnostics', () => {
    expect(
      parsePlacementDecision(
        JSON.stringify({ reason: 'legacy size chosen', selectedVmSize: 'small' })
      )
    ).toBeNull();
  });
  it('retains applied and evaluated strategies without requiring rollout on old payloads', () => {
    const base = {
      version: 1,
      selectedNodeId: null,
      authority: {
        strategy: 'balanced',
        strategyOrdering: null,
        revalidatedAgainstCurrentAuthority: false,
      },
      hosts: [],
      queue: { state: null, reason: null, nextRetryAt: null },
    };
    expect(parsePlacementDecision(JSON.stringify({ diagnostics: base }))).not.toBeNull();
    const decision = parsePlacementDecision(
      JSON.stringify({
        diagnostics: {
          ...base,
          rollout: {
            mode: 'shadow',
            configuredStrategy: 'pack',
            appliedStrategy: 'balanced',
            cohortPercent: 0,
          },
        },
      })
    );
    expect(decision?.rollout).toEqual({
      mode: 'shadow',
      configuredStrategy: 'pack',
      appliedStrategy: 'balanced',
    });
  });
  it('decodes a queued canonical decision and strips fields outside the display contract', () => {
    const diagnostics = {
      version: 1,
      selectedNodeId: null,
      authority: {
        strategy: 'pack',
        strategyOrdering: 'Existing compatible capacity first',
        revalidatedAgainstCurrentAuthority: false,
        credentialId: 'private',
      },
      queue: { state: 'waiting', nextRetryAt: null, reason: 'provider_account_capacity' },
      hosts: [],
      placementCredentialReference: 'private',
    };
    const result = parsePlacementDecision(JSON.stringify({ diagnostics }));
    expect(result?.queue.state).toBe('waiting');
    expect(result?.authority.revalidatedAgainstCurrentAuthority).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
