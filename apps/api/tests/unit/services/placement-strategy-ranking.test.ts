/**
 * Discriminating tests for strategy-aware placement ranking.
 *
 * The load-bearing assertion is that the four strategies pick FOUR DIFFERENT
 * hosts from one fixture. Before this change both reuse paths ranked on
 * `vmSize` equality and then on the least-loaded score, so every strategy
 * resolved to the same host and this file's `expect(winners).toHaveLength(4)`
 * could not pass. `spread` and `balanced` shared one weighted score in the
 * offering comparator for the same reason.
 */
import type {
  CapacityPoolPlacementSettings,
  CapacityPoolStrategy,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  buildPlacementLocationInventory,
  comparePlacementHostsByStrategy,
  comparePlacementLocationsByStrategy,
  normalizePlacementHostSignals,
  type PlacementHostSignals,
  placementLocationKey,
} from '../../../src/services/placement-strategy';
import {
  type ActiveWorkspaceReservationUsage,
  emptyUsage,
  resolveWorkspaceAdmissionPolicy,
  type WorkspaceAdmissionPolicy,
} from '../../../src/services/workspace-resource-capacity';

const POLICY: WorkspaceAdmissionPolicy = resolveWorkspaceAdmissionPolicy(
  {} as Parameters<typeof resolveWorkspaceAdmissionPolicy>[0],
  null
);

/** The pending workload every host in the fixture is ranked against. */
const REQUEST = { cpuMillis: 1000, memoryMb: 1024, diskMb: 2048 };

const STRATEGIES: CapacityPoolStrategy[] = ['pack', 'balanced', 'spread', 'smallest-fit'];

interface HostFixture {
  id: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  usage: Partial<ActiveWorkspaceReservationUsage>;
  location?: string;
}

/**
 * A node row with VERIFIED observed hardware. `resolveTrustedWorkspaceNodeCapacity`
 * only trusts a row that carries a provider instance id AND
 * `observed_hardware_source = 'observed'`, so the fixture must supply both or
 * every host would rank as untrusted and the test would prove nothing.
 */
function observedNode(fixture: HostFixture) {
  return {
    id: fixture.id,
    nodeClass: 'managed',
    providerInstanceId: `pi-${fixture.id}`,
    observedProviderInstanceType: 'cx-observed',
    observedProviderInstanceVcpuCount: fixture.vcpu,
    observedProviderInstanceMemoryMb: fixture.memoryMb,
    observedProviderInstanceDiskGb: fixture.diskGb,
    observedHardwareSource: 'observed',
    cloudProvider: 'hetzner',
    vmLocation: fixture.location ?? 'nbg1',
    lastMetrics: null,
    lastHeartbeatAt: null,
  };
}

function signalsFor(fixture: HostFixture): PlacementHostSignals {
  return normalizePlacementHostSignals({
    node: observedNode(fixture),
    usage: { ...emptyUsage(), ...fixture.usage },
    request: REQUEST,
    policy: POLICY,
  });
}

/**
 * Four hosts engineered so each strategy has a UNIQUE winner:
 *
 *   host          cpu budget  projected util  co-tenants
 *   packHost         16000        0.8125          2       <- pack (fullest)
 *   smallestHost      4000        0.375           1       <- smallest-fit
 *   spreadHost       32000        0.28125         0       <- spread (fewest neighbours)
 *   balancedHost      8000        0.175           3       <- balanced (least loaded)
 */
const FIXTURE: HostFixture[] = [
  {
    id: 'packHost',
    vcpu: 16,
    memoryMb: 32768,
    diskGb: 200,
    usage: { cpuMillis: 12000, memoryMb: 8000, diskMb: 20480, activeCount: 2 },
  },
  {
    id: 'smallestHost',
    vcpu: 4,
    memoryMb: 8192,
    diskGb: 80,
    usage: { cpuMillis: 500, memoryMb: 512, diskMb: 4096, activeCount: 1 },
  },
  {
    id: 'spreadHost',
    vcpu: 32,
    memoryMb: 65536,
    diskGb: 400,
    usage: { cpuMillis: 8000, memoryMb: 4096, diskMb: 8192, activeCount: 0 },
  },
  {
    id: 'balancedHost',
    vcpu: 8,
    memoryMb: 16384,
    diskGb: 160,
    usage: { cpuMillis: 400, memoryMb: 512, diskMb: 2048, activeCount: 3 },
  },
];

function rank(
  strategy: CapacityPoolStrategy,
  fixtures: HostFixture[] = FIXTURE,
  settings?: CapacityPoolPlacementSettings
): string[] {
  return fixtures
    .map(signalsFor)
    .sort((a, b) => comparePlacementHostsByStrategy(a, b, strategy, settings))
    .map((signals) => signals.nodeId);
}

function winner(
  strategy: CapacityPoolStrategy,
  fixtures?: HostFixture[],
  settings?: CapacityPoolPlacementSettings
): string {
  const [first] = rank(strategy, fixtures, settings);
  if (!first) throw new Error('ranking produced no candidate');
  return first;
}

describe('placement strategy host ranking', () => {
  it('gives every strategy a distinct winner from one fixture', () => {
    const winners = STRATEGIES.map((strategy) => winner(strategy));

    // The discriminating assertion. Pre-fix, all four reuse rankings collapsed
    // to the same least-loaded host and this set had size 1.
    expect(new Set(winners).size).toBe(4);
    expect(winners).toEqual(['packHost', 'balancedHost', 'spreadHost', 'smallestHost']);
  });

  it('packs onto the fullest host that still fits', () => {
    expect(winner('pack')).toBe('packHost');
    // and ranks the emptiest host last
    expect(rank('pack').at(-1)).toBe('balancedHost');
  });

  it('balances onto the least-utilized host', () => {
    expect(winner('balanced')).toBe('balancedHost');
    expect(rank('balanced').at(-1)).toBe('packHost');
  });

  it('spreads onto the host with the fewest co-tenants regardless of load', () => {
    // spreadHost is NOT the least loaded (balancedHost is) and NOT the smallest.
    // Only the co-tenant count selects it, which is what separates spread from balanced.
    expect(winner('spread')).toBe('spreadHost');
    expect(rank('spread')).toEqual(['spreadHost', 'smallestHost', 'packHost', 'balancedHost']);
  });

  it('smallest-fit takes the smallest sufficient host', () => {
    expect(winner('smallest-fit')).toBe('smallestHost');
    expect(rank('smallest-fit')).toEqual([
      'smallestHost',
      'balancedHost',
      'packHost',
      'spreadHost',
    ]);
  });

  it('keeps strategies distinct under a weight configuration that would collapse them', () => {
    // `fit` at 1e6 vs `capacity` at 1 is the shipped default ratio. If the
    // defining signal were folded into the weighted score, `fit` would dominate
    // and every strategy would agree. The defining key is compared first, so it
    // cannot.
    const skewed = {
      version: 1,
      sourceGeneration: 1,
      legacyWorkloadAdapterVersion: 1,
      selectionWeights: {
        priority: 100_000_000,
        price: 1,
        fit: 1_000_000,
        capacity: 1,
        candidateOrder: 1,
      },
      rolloutCohortPercent: 100,
      source: { legacyWorkloadMapping: 'default', selection: 'default' },
      diagnostics: [],
    } satisfies CapacityPoolPlacementSettings;

    const winners = STRATEGIES.map((strategy) => winner(strategy, FIXTURE, skewed));
    expect(new Set(winners).size).toBe(4);

    // Also with the weights zeroed out entirely.
    const zeroed = {
      ...skewed,
      selectionWeights: { priority: 0, price: 0, fit: 0, capacity: 0, candidateOrder: 0 },
    } satisfies CapacityPoolPlacementSettings;
    expect(new Set(STRATEGIES.map((s) => winner(s, FIXTURE, zeroed))).size).toBe(4);
  });

  it('is deterministic across repeated identical calls', () => {
    for (const strategy of STRATEGIES) {
      const first = rank(strategy);
      expect(rank(strategy)).toEqual(first);
      // Input order must not change the result either.
      expect(rank(strategy, [...FIXTURE].reverse())).toEqual(first);
    }
  });

  it('breaks exact ties to a total order on node id', () => {
    const twins: HostFixture[] = [
      { id: 'nodeB', vcpu: 8, memoryMb: 16384, diskGb: 160, usage: { activeCount: 1 } },
      { id: 'nodeA', vcpu: 8, memoryMb: 16384, diskGb: 160, usage: { activeCount: 1 } },
    ];
    for (const strategy of STRATEGIES) {
      expect(rank(strategy, twins)).toEqual(['nodeA', 'nodeB']);
    }
  });
});

describe('placement strategy fail-closed ranking', () => {
  const untrustedCases: Array<{ name: string; node: Record<string, unknown> }> = [
    {
      name: 'no provider runtime identity',
      node: {
        id: 'noIdentity',
        nodeClass: 'managed',
        providerInstanceId: null,
        observedProviderInstanceVcpuCount: 8,
        observedProviderInstanceMemoryMb: 16384,
        observedProviderInstanceDiskGb: 160,
        observedHardwareSource: 'observed',
      },
    },
    {
      name: 'unverified observed hardware source',
      node: {
        id: 'unverified',
        nodeClass: 'managed',
        providerInstanceId: 'pi-unverified',
        observedProviderInstanceVcpuCount: 8,
        observedProviderInstanceMemoryMb: 16384,
        observedProviderInstanceDiskGb: 160,
        observedHardwareSource: 'planned',
      },
    },
    {
      name: 'no observed capacity at all',
      node: {
        id: 'noCapacity',
        nodeClass: 'managed',
        providerInstanceId: 'pi-noCapacity',
        observedProviderInstanceVcpuCount: null,
        observedProviderInstanceMemoryMb: null,
        observedProviderInstanceDiskGb: null,
        observedHardwareSource: 'observed',
      },
    },
  ];

  for (const testCase of untrustedCases) {
    it(`ranks a host with ${testCase.name} behind every trusted host`, () => {
      const untrusted = normalizePlacementHostSignals({
        node: testCase.node as Parameters<typeof normalizePlacementHostSignals>[0]['node'],
        usage: emptyUsage(),
        request: REQUEST,
        policy: POLICY,
      });
      expect(untrusted.capacitySource).toBeNull();
      expect(untrusted.projectedUtilization).toBeNull();

      for (const strategy of STRATEGIES) {
        // Even against the fixture's WORST trusted host, the untrusted one loses.
        for (const fixture of FIXTURE) {
          const trusted = signalsFor(fixture);
          expect(comparePlacementHostsByStrategy(untrusted, trusted, strategy)).toBeGreaterThan(0);
          expect(comparePlacementHostsByStrategy(trusted, untrusted, strategy)).toBeLessThan(0);
        }
      }
    });
  }

  it('treats a zero-capacity dimension as saturated rather than producing a non-finite ratio', () => {
    // hostMemoryReserveMb (512 by default) fully consumes a 512 MiB host, so
    // usable memory is 0. A naive committed/capacity would be Infinity or NaN
    // and would silently sort first under `balanced`.
    const saturated = signalsFor({
      id: 'saturated',
      vcpu: 4,
      memoryMb: 512,
      diskGb: 40,
      usage: { activeCount: 0 },
    });
    expect(saturated.memoryMbCapacity).toBe(0);
    expect(saturated.projectedUtilization).toBe(1);
    expect(Number.isFinite(saturated.projectedUtilization)).toBe(true);

    // It must never beat a healthy host under balanced.
    const healthy = signalsFor(FIXTURE[3] as HostFixture);
    expect(comparePlacementHostsByStrategy(saturated, healthy, 'balanced')).toBeGreaterThan(0);
  });
});

describe('placement location inventory', () => {
  const inventory = buildPlacementLocationInventory([
    { cloudProvider: 'hetzner', vmLocation: 'nbg1' },
    { cloudProvider: 'hetzner', vmLocation: 'nbg1' },
    { cloudProvider: 'hetzner', vmLocation: 'hel1' },
  ]);

  const busy = { provider: 'hetzner', location: 'nbg1' };
  const quiet = { provider: 'hetzner', location: 'hel1' };
  const empty = { provider: 'hetzner', location: 'fsn1' };

  it('counts live hosts per provider/location', () => {
    expect(inventory.countFor('hetzner', 'nbg1')).toBe(2);
    expect(inventory.countFor('hetzner', 'hel1')).toBe(1);
    expect(inventory.countFor('hetzner', 'fsn1')).toBe(0);
    expect(inventory.totalHosts).toBe(3);
    expect(placementLocationKey(null, null)).toBe('unknown:unknown');
  });

  it('pack concentrates onto the busiest location and spread moves away from it', () => {
    expect(comparePlacementLocationsByStrategy(busy, quiet, 'pack', inventory)).toBeLessThan(0);
    expect(comparePlacementLocationsByStrategy(busy, quiet, 'spread', inventory)).toBeGreaterThan(
      0
    );
    expect(comparePlacementLocationsByStrategy(empty, busy, 'spread', inventory)).toBeLessThan(0);
  });

  it('is inert for balanced/smallest-fit and when no inventory is supplied', () => {
    // Absent inventory must be a no-op so resolve-time ordering is unchanged.
    expect(comparePlacementLocationsByStrategy(busy, quiet, 'pack', undefined)).toBe(0);
    expect(comparePlacementLocationsByStrategy(busy, quiet, 'spread', undefined)).toBe(0);
    expect(comparePlacementLocationsByStrategy(busy, quiet, 'balanced', inventory)).toBe(0);
    expect(comparePlacementLocationsByStrategy(busy, quiet, 'smallest-fit', inventory)).toBe(0);
  });
});
