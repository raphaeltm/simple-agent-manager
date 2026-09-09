import { describe, expect, it } from 'vitest';

import { PROVIDER_CATALOG, type ProviderCatalog } from '../src/components/placement/catalog';
import {
  admissionRefusal,
  createLab,
  defaultSeedFleet,
  HOST_MEMORY_RESERVE_MB,
  LAB,
  MAX_CO_TENANTS,
  MAX_WORKSPACES_PER_NODE,
  rankOfferings,
  simulate,
  step,
  STRATEGIES,
  submit,
  usageOf,
  type LabNode,
  type Strategy,
  type WorkloadShape,
} from '../src/components/placement/model';

const hetzner = PROVIDER_CATALOG.hetzner;
const EU = ['fsn1', 'nbg1', 'hel1'];

function nodeOf(instanceType: string, region = 'fsn1'): LabNode {
  const offering = hetzner.offerings.find((item) => item.instanceType === instanceType);
  if (!offering) throw new Error(`no such offering: ${instanceType}`);
  return {
    id: 1,
    offering,
    region,
    state: 'active',
    bootRemaining: 0,
    warmRemaining: 0,
    createdAt: 0,
  };
}

function runToQuiet(lab: ReturnType<typeof createLab>, maxSteps = 60): void {
  for (let i = 0; i < maxSteps; i++) {
    const pending = lab.workloads.some((w) => w.state === 'queued' || w.state === 'running');
    if (!pending) return;
    step(lab);
  }
}

describe('admission gate', () => {
  it('refuses the platform-default workload on a 4 GB host because of the host reserve', () => {
    // This is the 2026-09-09 incident in one assertion: cx23 has exactly 4096 MB, the platform
    // default reserves exactly 4096 MB, and the host keeps 512 MB for itself.
    const lab = createLab(hetzner, EU);
    const refusal = admissionRefusal(lab, nodeOf('cx23'), 'standard');
    expect(refusal).toBe(`not enough memory after the ${HOST_MEMORY_RESERVE_MB} MB host reserve`);
  });

  it('admits the same workload on the next tier up', () => {
    const lab = createLab(hetzner, EU);
    expect(admissionRefusal(lab, nodeOf('cx33'), 'standard')).toBeNull();
  });

  it('admits a small chat reservation on the 4 GB host', () => {
    const lab = createLab(hetzner, EU);
    expect(admissionRefusal(lab, nodeOf('cx23'), 'chat')).toBeNull();
  });

  it('enforces a density cap before any resource dimension is exhausted', () => {
    // Two real ceilings exist: the node-wide `MAX_WORKSPACES_PER_NODE` (3) and the per-request
    // `MAX_CO_TENANTS` (4). At the defaults the node-wide one is stricter, so it is the one that
    // binds — a model that only knew about the co-tenant cap would admit a fourth workload a
    // default deployment refuses.
    expect(MAX_WORKSPACES_PER_NODE).toBeLessThan(MAX_CO_TENANTS);

    const lab = createLab(hetzner, EU);
    const node = nodeOf('cx43');
    lab.nodes.push(node);
    const fill = (count: number): void => {
      for (let i = 0; i < count; i++) {
        const workload = submit(lab, 'chat');
        if (!workload) throw new Error('submit failed');
        workload.state = 'running';
        workload.nodeId = node.id;
      }
    };

    fill(MAX_WORKSPACES_PER_NODE - 1);
    // Owner control: below the cap the same host still accepts work, so the refusal below is the
    // cap talking and not a broken fixture.
    expect(admissionRefusal(lab, node, 'chat')).toBeNull();

    fill(1);
    const usage = usageOf(lab, node.id);
    expect(usage.coTenants).toBe(MAX_WORKSPACES_PER_NODE);
    // 3 chat workloads is 1.5 vCPU / 3 GB on an 8 vCPU / 16 GB host — no resource dimension is
    // anywhere near exhausted, so only a density cap can be refusing.
    expect(usage.memoryMb).toBeLessThan(node.offering.memoryMb - HOST_MEMORY_RESERVE_MB);
    expect(usage.cpuMillis).toBeLessThan(node.offering.vcpu * 1000);
    expect(admissionRefusal(lab, node, 'chat')).toContain('node workspace cap');
  });
});

describe('offering ranking', () => {
  it('never prefers one region over another when the machine and price are identical', () => {
    // Same SKU, same price, three regions: a genuine tie. Region must not be the discriminator.
    const lab = createLab(hetzner, EU, { strategy: 'balanced' });
    const ranked = rankOfferings(lab, 'standard');
    const cx33 = ranked.filter((c) => c.offering.instanceType === 'cx33');
    expect(cx33).toHaveLength(3);
    expect(new Set(cx33.map((c) => c.offering.monthlyCents)).size).toBe(1);
    // The three tie, so they land adjacently in the ranking rather than being interleaved with
    // any other SKU — proving nothing broke the tie on region.
    const positions = cx33.map((c) => ranked.indexOf(c));
    expect(Math.max(...positions) - Math.min(...positions)).toBe(2);
  });

  it('excludes offerings that could not pass admission even when empty', () => {
    const lab = createLab(hetzner, EU);
    const ranked = rankOfferings(lab, 'standard');
    expect(ranked.some((c) => c.offering.instanceType === 'cx23')).toBe(false);
    // Control: the same catalog does offer cx23 to a workload that fits it.
    expect(rankOfferings(lab, 'chat').some((c) => c.offering.instanceType === 'cx23')).toBe(true);
  });

  it('orders balanced/spread by FIT, not price, when the two disagree', () => {
    // The Hetzner catalog cannot discriminate these: its cheapest offering is also its tightest,
    // so "cheapest first" and "tightest fit first" name the same machine and a test over it
    // passes either way (rule 62). This synthetic catalog inverts the relationship — the roomiest
    // machine is also the cheapest — so only the real ordering key can satisfy it.
    //
    // Fit must win, because production's default selection weights are `fit: 1_000_000` against
    // `price: 1` (`DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS`).
    const inverted: ProviderCatalog = {
      id: 'hetzner',
      label: 'Inverted',
      currency: 'EUR',
      currencySymbol: '€',
      regions: ['r1'],
      offerings: [
        // tight fit, expensive
        { provider: 'hetzner', tier: 'small', instanceType: 'tight', vcpu: 2, memoryMb: 4096, diskMb: 40 * 1024, monthlyCents: 9000 },
        // roomy, cheap
        { provider: 'hetzner', tier: 'large', instanceType: 'roomy', vcpu: 8, memoryMb: 32768, diskMb: 320 * 1024, monthlyCents: 100 },
      ],
    };
    for (const strategy of ['balanced', 'spread', 'smallest-fit'] as Strategy[]) {
      const lab = createLab(inverted, ['r1'], { strategy });
      expect(rankOfferings(lab, 'chat')[0]?.offering.instanceType, strategy).toBe('tight');
    }
    // Control: `pack` explicitly wants the largest, so it takes the roomy one despite the tie-break.
    const packLab = createLab(inverted, ['r1'], { strategy: 'pack' });
    expect(rankOfferings(packLab, 'chat')[0]?.offering.instanceType).toBe('roomy');
  });

  it('orders new hardware by the strategy key', () => {
    const biggestFirst = rankOfferings(createLab(hetzner, EU, { strategy: 'pack' }), 'chat')[0];
    const cheapestFirst = rankOfferings(createLab(hetzner, EU, { strategy: 'balanced' }), 'chat')[0];
    const tightestFirst = rankOfferings(createLab(hetzner, EU, { strategy: 'smallest-fit' }), 'chat')[0];
    expect(biggestFirst?.offering.instanceType).toBe('cx43');
    expect(cheapestFirst?.offering.instanceType).toBe('cx23');
    expect(tightestFirst?.offering.instanceType).toBe('cx23');
  });
});

describe('strategies are observably different', () => {
  const shapes: WorkloadShape[] = ['chat', 'chat', 'standard', 'chat', 'chat', 'standard'];
  const seedFleet = defaultSeedFleet(EU);
  const run = (strategy: Strategy) => simulate(hetzner, EU, strategy, shapes, { seedFleet });

  it('gives every strategy a DIFFERENT placement for the same workload set', () => {
    const outcomes = STRATEGIES.map(run);
    for (const outcome of outcomes) {
      expect(outcome.rejected).toBe(0);
      expect(outcome.placed).toBe(shapes.length);
    }
    // Pairwise distinct, not merely "more than one signature exists". `placement-strategy.ts`
    // exists because `balanced` and `spread` were once byte-identical; a weaker assertion here
    // would let that recur for any three of the four.
    const placements = outcomes.map((o) => o.placement.join(' '));
    expect(new Set(placements).size).toBe(STRATEGIES.length);
  });

  it('sends the first workload to the host each ordering key names', () => {
    // The defining key, isolated: one workload, a fleet where fullest / emptiest / fewest
    // co-tenants / smallest are four DIFFERENT hosts.
    const first = (strategy: Strategy) => run(strategy).placement[0];
    // large host carries a heavy workload; medium carries one chat; small is idle.
    expect(first('pack')).toContain('cx43'); // highest projected utilization
    expect(first('smallest-fit')).toContain('cx23'); // smallest sufficient host
    expect(first('balanced')).toContain('cx33'); // lowest projected utilization
    expect(first('spread')).toContain('cx23'); // fewest co-tenants (the idle host)
  });

  it('pack and smallest-fit coincide on an IDLE fleet, and diverge once a big host is busy', () => {
    // Not a defect: for a fixed reservation the smallest host always has the highest projected
    // utilization, so the two keys agree until something large is already loaded. Pinning the
    // property keeps a future ranking change from quietly making them differ for the wrong
    // reason — or making them identical in both conditions.
    const idle = defaultSeedFleet(EU).map(({ tier, region }) => ({ tier, region }));
    const idlePack = simulate(hetzner, EU, 'pack', shapes, { seedFleet: idle });
    const idleTight = simulate(hetzner, EU, 'smallest-fit', shapes, { seedFleet: idle });
    expect(idlePack.placement).toEqual(idleTight.placement);

    expect(run('pack').placement).not.toEqual(run('smallest-fit').placement);
  });

  it('is deterministic across identical runs', () => {
    for (const strategy of STRATEGIES) {
      expect(run(strategy)).toEqual(run(strategy));
    }
  });
});

describe('provider stockout (the 412 case)', () => {
  const shapes: WorkloadShape[] = ['standard'];
  // Only fsn1, so the top-ranked candidate is guaranteed to be the stocked-out one.
  const single = ['fsn1'];

  it('fails immediately under the fail policy', () => {
    const outcome = simulate(hetzner, single, 'balanced', shapes, {
      policy: 'fail',
      stockedOut: ['fsn1'],
    });
    expect(outcome.rejected).toBe(1);
    expect(outcome.nodes).toBe(0);
  });

  it('waits, then expires, under the queue policy', () => {
    const outcome = simulate(hetzner, single, 'balanced', shapes, {
      policy: 'queue',
      stockedOut: ['fsn1'],
    });
    expect(outcome.rejected).toBe(1);
    expect(outcome.nodes).toBe(0);
  });

  it('reaches an identical machine in another region under fallback-chain', () => {
    const outcome = simulate(hetzner, EU, 'balanced', shapes, {
      policy: 'fallback-chain',
      stockedOut: ['fsn1'],
    });
    expect(outcome.rejected).toBe(0);
    expect(outcome.placed).toBe(1);
    expect(outcome.regions).not.toContain('fsn1');
  });

  it('owner control: the same request succeeds in fsn1 when it is in stock', () => {
    const outcome = simulate(hetzner, single, 'balanced', shapes, { policy: 'fail' });
    expect(outcome.rejected).toBe(0);
    expect(outcome.regions).toEqual(['fsn1']);
  });
});

describe('node lifecycle', () => {
  it('drains an idle node to warm, reuses it, then destroys it', () => {
    const lab = createLab(hetzner, EU, { strategy: 'balanced' });
    submit(lab, 'chat');
    runToQuiet(lab);

    const node = lab.nodes[0];
    expect(node).toBeDefined();
    if (!node) throw new Error('no node provisioned');
    expect(node.state).toBe('warm');

    // Warm reuse: a new workload must land on the existing node, not a new one.
    submit(lab, 'chat');
    step(lab);
    expect(lab.nodes).toHaveLength(1);
    expect(node.state).toBe('active');

    runToQuiet(lab);
    for (let i = 0; i <= LAB.warmSteps; i++) step(lab);
    expect(node.state).toBe('destroyed');
  });

  it('serializes provisioning behind one lease', () => {
    const lab = createLab(hetzner, EU, { strategy: 'balanced' });
    for (let i = 0; i < 4; i++) submit(lab, 'heavy');
    step(lab);
    expect(lab.nodes.filter((n) => n.state === 'booting')).toHaveLength(1);
    expect(lab.workloads.filter((w) => w.reason.includes('lease'))).not.toHaveLength(0);
  });
});

describe('strategy coverage', () => {
  it('every declared strategy is simulatable', () => {
    for (const strategy of STRATEGIES satisfies readonly Strategy[]) {
      expect(() => simulate(hetzner, EU, strategy, ['chat'])).not.toThrow();
    }
  });
});
