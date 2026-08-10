/**
 * Mock data for the capacity-pool placement prototype.
 *
 * PROTOTYPE ONLY — no API calls, no auth. Every number here is illustrative and
 * hand-entered so the UI can be evaluated before any pricing pipeline exists.
 * Prices are net list prices sampled by hand; the real product would read them
 * from each provider's own API using the user's own key.
 */

export type ProviderId = 'hetzner' | 'digitalocean' | 'vultr' | 'scaleway' | 'gcp';

export type AvailabilityState =
  | 'available' // provider reports this type is orderable here right now
  | 'sold-out' // provider reports the type exists here but has no stock
  | 'not-offered' // this type is never sold in this region
  | 'unknown'; // no availability signal from this provider — we must try to find out

export interface Candidate {
  id: string;
  provider: ProviderId;
  region: string;
  regionLabel: string;
  country: string;
  instanceType: string;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  /** Net price per hour in the provider's billing currency. */
  pricePerHour: number;
  currency: 'EUR' | 'USD';
  availability: AvailabilityState;
  /** Populated only for `sold-out` / `not-offered`, shown verbatim in the UI. */
  availabilityNote?: string;
  /** How stale the price/availability snapshot is. */
  observedMinutesAgo: number;
  /**
   * Smallest unit the provider actually charges for, in seconds.
   *
   * This is NOT a detail. Hetzner and Vultr round every VM up to a full hour,
   * DigitalOcean and GCP bill per second. For a workspace that lives ten
   * minutes, a "6× more expensive" provider can be the cheaper one.
   */
  billingIncrementSeconds: number;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  hetzner: 'Hetzner',
  digitalocean: 'DigitalOcean',
  vultr: 'Vultr',
  scaleway: 'Scaleway',
  gcp: 'Google Cloud',
};

/** Rough FX used only to compare across currencies in the prototype. */
export const EUR_PER_USD = 0.92;

export function toEur(price: number, currency: 'EUR' | 'USD'): number {
  return currency === 'EUR' ? price : price * EUR_PER_USD;
}

/**
 * One "agent slot" — the resource envelope a single agent needs.
 * Mirrors PLATFORM_RESOURCE_DEFAULTS in packages/shared/src/constants/resource-defaults.ts.
 */
export interface SlotShape {
  vcpu: number;
  ramGb: number;
  diskGb: number;
}

export const DEFAULT_SLOT: SlotShape = { vcpu: 2, ramGb: 4, diskGb: 40 };

/** How many agent slots of `slot` fit on `c`, capped by a co-tenancy limit. */
export function slotsFor(c: Candidate, slot: SlotShape, maxCoTenants = 4): number {
  const bySpec = Math.floor(
    Math.min(c.vcpu / slot.vcpu, c.ramGb / slot.ramGb, c.diskGb / slot.diskGb),
  );
  return Math.max(0, Math.min(bySpec, maxCoTenants));
}

/** Cost per agent-slot-hour, in EUR. Infinity when the machine fits no slot. */
export function pricePerSlotEur(c: Candidate, slot: SlotShape, maxCoTenants = 4): number {
  const slots = slotsFor(c, slot, maxCoTenants);
  if (slots === 0) return Number.POSITIVE_INFINITY;
  return toEur(c.pricePerHour, c.currency) / slots;
}

/**
 * What one task of `minutes` actually costs on this machine, in EUR, after the
 * provider rounds up to its billing increment.
 *
 * A 10-minute workspace on Hetzner is billed as a full hour; the same workspace
 * on DigitalOcean is billed for 10 minutes. Ranking on the sticker hourly rate
 * therefore picks the wrong provider for short tasks.
 */
export function costPerTaskEur(c: Candidate, minutes: number): number {
  const seconds = minutes * 60;
  const increments = Math.ceil(seconds / c.billingIncrementSeconds);
  const billedSeconds = increments * c.billingIncrementSeconds;
  return toEur(c.pricePerHour, c.currency) * (billedSeconds / 3600);
}

/**
 * Minutes at which a per-second machine stops being cheaper than a per-hour one.
 * Returns null when `perHour` is not actually hour-rounded.
 */
export function breakEvenMinutes(perHour: Candidate, perSecond: Candidate): number | null {
  if (perHour.billingIncrementSeconds < 3600) return null;
  const hourlyCost = toEur(perHour.pricePerHour, perHour.currency);
  const perSecondRate = toEur(perSecond.pricePerHour, perSecond.currency);
  return (hourlyCost / perSecondRate) * 60;
}

// ── The pool ────────────────────────────────────────────────────────────────
// Deliberately stressed: sold-out entries, a region that never sells the type,
// a provider with no availability signal at all, and a 6x price spread.

export const CANDIDATES: Candidate[] = [
  // Hetzner — cheapest per slot by a wide margin, but the least reliable stock.
  {
    id: 'hz-cx43-fsn1',
    provider: 'hetzner',
    region: 'fsn1',
    regionLabel: 'Falkenstein',
    country: 'DE',
    instanceType: 'cx43',
    vcpu: 8,
    ramGb: 16,
    diskGb: 160,
    pricePerHour: 0.0246,
    currency: 'EUR',
    availability: 'sold-out',
    availabilityNote: 'No stock since 06:12 today',
    observedMinutesAgo: 2,
    billingIncrementSeconds: 3600,
  },
  {
    id: 'hz-cx43-nbg1',
    provider: 'hetzner',
    region: 'nbg1',
    regionLabel: 'Nuremberg',
    country: 'DE',
    instanceType: 'cx43',
    vcpu: 8,
    ramGb: 16,
    diskGb: 160,
    pricePerHour: 0.0246,
    currency: 'EUR',
    availability: 'available',
    observedMinutesAgo: 2,
    billingIncrementSeconds: 3600,
  },
  {
    id: 'hz-cx43-hel1',
    provider: 'hetzner',
    region: 'hel1',
    regionLabel: 'Helsinki',
    country: 'FI',
    instanceType: 'cx43',
    vcpu: 8,
    ramGb: 16,
    diskGb: 160,
    pricePerHour: 0.0246,
    currency: 'EUR',
    availability: 'sold-out',
    availabilityNote: 'No stock since 04:40 today',
    observedMinutesAgo: 2,
    billingIncrementSeconds: 3600,
  },
  {
    id: 'hz-cx43-ash',
    provider: 'hetzner',
    region: 'ash',
    regionLabel: 'Ashburn',
    country: 'US',
    instanceType: 'cx43',
    vcpu: 8,
    ramGb: 16,
    diskGb: 160,
    pricePerHour: 0.0246,
    currency: 'EUR',
    availability: 'not-offered',
    availabilityNote: 'Intel cx line is not sold in US regions',
    observedMinutesAgo: 2,
    billingIncrementSeconds: 3600,
  },
  {
    id: 'hz-cpx41-nbg1',
    provider: 'hetzner',
    region: 'nbg1',
    regionLabel: 'Nuremberg',
    country: 'DE',
    instanceType: 'cpx41',
    vcpu: 8,
    ramGb: 16,
    diskGb: 240,
    pricePerHour: 0.0416,
    currency: 'EUR',
    availability: 'available',
    observedMinutesAgo: 2,
    billingIncrementSeconds: 3600,
  },
  {
    id: 'hz-cx33-nbg1',
    provider: 'hetzner',
    region: 'nbg1',
    regionLabel: 'Nuremberg',
    country: 'DE',
    instanceType: 'cx33',
    vcpu: 4,
    ramGb: 8,
    diskGb: 80,
    pricePerHour: 0.0127,
    currency: 'EUR',
    availability: 'available',
    observedMinutesAgo: 2,
    billingIncrementSeconds: 3600,
  },
  {
    id: 'hz-cx23-nbg1',
    provider: 'hetzner',
    region: 'nbg1',
    regionLabel: 'Nuremberg',
    country: 'DE',
    instanceType: 'cx23',
    vcpu: 2,
    ramGb: 4,
    diskGb: 40,
    pricePerHour: 0.0068,
    currency: 'EUR',
    availability: 'available',
    observedMinutesAgo: 2,
    billingIncrementSeconds: 3600,
  },

  // Scaleway — mid price, big machines, availability signal is per-zone.
  {
    id: 'sw-gp1s-parr1',
    provider: 'scaleway',
    region: 'fr-par-1',
    regionLabel: 'Paris 1',
    country: 'FR',
    instanceType: 'GP1-S',
    vcpu: 8,
    ramGb: 32,
    diskGb: 600,
    pricePerHour: 0.084,
    currency: 'EUR',
    availability: 'available',
    observedMinutesAgo: 6,
    billingIncrementSeconds: 3600,
  },
  {
    id: 'sw-dev1xl-amsr1',
    provider: 'scaleway',
    region: 'nl-ams-1',
    regionLabel: 'Amsterdam 1',
    country: 'NL',
    instanceType: 'DEV1-XL',
    vcpu: 4,
    ramGb: 12,
    diskGb: 120,
    pricePerHour: 0.048,
    currency: 'EUR',
    availability: 'sold-out',
    availabilityNote: 'Zone reports no capacity for DEV1-XL',
    observedMinutesAgo: 6,
    billingIncrementSeconds: 3600,
  },

  // DigitalOcean — reliable stock, no live availability endpoint, ~6x Hetzner.
  {
    id: 'do-s8-fra1',
    provider: 'digitalocean',
    region: 'fra1',
    regionLabel: 'Frankfurt',
    country: 'DE',
    instanceType: 's-8vcpu-16gb',
    vcpu: 8,
    ramGb: 16,
    diskGb: 320,
    pricePerHour: 0.143,
    currency: 'USD',
    availability: 'unknown',
    availabilityNote: 'No availability API — verified only by attempting',
    observedMinutesAgo: 11,
    billingIncrementSeconds: 1,
  },
  {
    id: 'do-s4-fra1',
    provider: 'digitalocean',
    region: 'fra1',
    regionLabel: 'Frankfurt',
    country: 'DE',
    instanceType: 's-4vcpu-8gb',
    vcpu: 4,
    ramGb: 8,
    diskGb: 160,
    pricePerHour: 0.0714,
    currency: 'USD',
    availability: 'unknown',
    availabilityNote: 'No availability API — verified only by attempting',
    observedMinutesAgo: 11,
    billingIncrementSeconds: 1,
  },

  // Vultr — similar economics to DO, different region footprint.
  {
    id: 'vu-vc26c-fra',
    provider: 'vultr',
    region: 'fra',
    regionLabel: 'Frankfurt',
    country: 'DE',
    instanceType: 'vc2-6c-16gb',
    vcpu: 6,
    ramGb: 16,
    diskGb: 320,
    pricePerHour: 0.119,
    currency: 'USD',
    availability: 'available',
    observedMinutesAgo: 4,
    billingIncrementSeconds: 3600,
  },
];

// ── Strategies ──────────────────────────────────────────────────────────────

export type StrategyId = 'consolidate' | 'spread';

export interface Strategy {
  id: StrategyId;
  name: string;
  tagline: string;
  who: string;
  rules: string[];
  /** Reject any candidate costing more than this multiple of the cheapest slot price. */
  spillCeiling: number;
  maxCoTenants: number;
}

export const STRATEGIES: Record<StrategyId, Strategy> = {
  consolidate: {
    id: 'consolidate',
    name: 'Pack tight',
    tagline: 'Fewest, biggest machines. Best price per agent.',
    who: 'You run several agents at once and want them sharing hardware.',
    rules: [
      'Rank by price per agent slot, not by sticker price',
      'Prefer the machine that fits the most agents',
      'Reuse a warm machine before starting a new one',
      'Never pay more than 2× the cheapest option — queue instead',
    ],
    spillCeiling: 2,
    maxCoTenants: 4,
  },
  spread: {
    id: 'spread',
    name: 'Just enough',
    tagline: 'Smallest machine that fits. Lowest bill when idle.',
    who: 'You run one or two agents and want them gone quickly afterwards.',
    rules: [
      'Rank by absolute hourly price',
      'Pick the smallest machine that meets the requirement',
      'One agent per machine, shut down as soon as it goes idle',
      'Never pay more than 1.5× the cheapest option — queue instead',
    ],
    spillCeiling: 1.5,
    maxCoTenants: 1,
  },
};

// ── Ranking ─────────────────────────────────────────────────────────────────

export type SkipReason =
  | 'too-small'
  | 'not-offered'
  | 'sold-out'
  | 'over-ceiling'
  | 'region-disabled';

export interface RankedCandidate {
  candidate: Candidate;
  slots: number;
  slotPriceEur: number;
  hourlyEur: number;
  /** Set when the candidate will not be attempted. */
  skipped?: SkipReason;
  skipDetail?: string;
}

export const SKIP_LABELS: Record<SkipReason, string> = {
  'too-small': 'Too small for the requirement',
  'not-offered': 'Not sold in this region',
  'sold-out': 'Provider reports no stock',
  'over-ceiling': 'Above your price ceiling',
  'region-disabled': 'Region turned off in your pool',
};

/**
 * What to do when everything under the price ceiling is out of stock.
 * This is the one genuinely unavoidable product decision: cheap capacity you
 * have to wait for, or expensive capacity you can have now.
 */
export type OverflowPolicy = 'wait' | 'spill';

export interface RankInput {
  strategy: Strategy;
  slot: SlotShape;
  /** Region ids the user has switched off. */
  disabledRegions: Set<string>;
  overflowPolicy: OverflowPolicy;
  candidates: Candidate[];
}

/**
 * Build the ordered attempt ladder.
 *
 * The key property: dropping to a smaller machine is NOT a special case. A
 * smaller machine is simply another candidate that scores worse, so the ladder
 * degrades size naturally instead of needing separate "bump down" logic.
 */
export function rankCandidates(input: RankInput): RankedCandidate[] {
  const { strategy, slot, disabledRegions, overflowPolicy, candidates } = input;

  const scored: RankedCandidate[] = candidates.map((candidate) => {
    const slots = slotsFor(candidate, slot, strategy.maxCoTenants);
    const hourlyEur = toEur(candidate.pricePerHour, candidate.currency);
    const slotPriceEur = slots === 0 ? Number.POSITIVE_INFINITY : hourlyEur / slots;
    return { candidate, slots, slotPriceEur, hourlyEur };
  });

  // The ceiling anchors to the cheapest candidate the user actually allows —
  // NOT to the cheapest that exists. Anchoring to a region the user has turned
  // off would make every remaining option look unaffordable forever.
  //
  // Stock is deliberately ignored here: the anchor is "what this pool is worth
  // when it is healthy", so a temporary sell-out does not silently re-baseline
  // the pool to a more expensive provider.
  const anchorPool = scored.filter(
    (s) =>
      s.slots > 0 &&
      s.candidate.availability !== 'not-offered' &&
      !disabledRegions.has(`${s.candidate.provider}:${s.candidate.region}`),
  );
  const cheapest = anchorPool.reduce(
    (min, s) => Math.min(min, s.slotPriceEur),
    Number.POSITIVE_INFINITY,
  );
  const ceiling = overflowPolicy === 'spill' ? Number.POSITIVE_INFINITY : cheapest * strategy.spillCeiling;

  for (const s of scored) {
    const key = `${s.candidate.provider}:${s.candidate.region}`;
    if (disabledRegions.has(key)) {
      s.skipped = 'region-disabled';
    } else if (s.candidate.availability === 'not-offered') {
      s.skipped = 'not-offered';
      s.skipDetail = s.candidate.availabilityNote;
    } else if (s.slots === 0) {
      s.skipped = 'too-small';
    } else if (s.candidate.availability === 'sold-out') {
      s.skipped = 'sold-out';
      s.skipDetail = s.candidate.availabilityNote;
    } else if (s.slotPriceEur > ceiling) {
      s.skipped = 'over-ceiling';
      s.skipDetail = `${(s.slotPriceEur / cheapest).toFixed(1)}× your cheapest slot`;
    }
  }

  const sortKey = (s: RankedCandidate) =>
    strategy.id === 'consolidate' ? s.slotPriceEur : s.hourlyEur;

  const attemptable = scored
    .filter((s) => !s.skipped)
    .sort((a, b) => {
      const diff = sortKey(a) - sortKey(b);
      if (diff !== 0) return diff;
      // Tie-break: prefer the machine that holds more agents.
      return b.slots - a.slots;
    });

  const rejected = scored
    .filter((s) => s.skipped)
    .sort((a, b) => sortKey(a) - sortKey(b));

  return [...attemptable, ...rejected];
}

// ── Placement trace (what actually happened, for the explanation screen) ─────

export interface TraceStep {
  order: number;
  label: string;
  detail: string;
  outcome: 'skipped' | 'failed' | 'succeeded';
  elapsedMs: number;
  /** True when the step cost no provider round-trip (pruned from cache). */
  free?: boolean;
}

export const TRACE_TODAY: TraceStep[] = [
  {
    order: 1,
    label: 'Reuse a warm machine',
    detail: 'No warm machine in the pool — 0 idle nodes',
    outcome: 'skipped',
    elapsedMs: 4,
    free: true,
  },
  {
    order: 2,
    label: 'Hetzner cx43 · Falkenstein',
    detail: 'Snapshot 2 min old said no stock — not attempted',
    outcome: 'skipped',
    elapsedMs: 1,
    free: true,
  },
  {
    order: 3,
    label: 'Hetzner cx43 · Helsinki',
    detail: 'Snapshot 2 min old said no stock — not attempted',
    outcome: 'skipped',
    elapsedMs: 1,
    free: true,
  },
  {
    order: 4,
    label: 'Hetzner cx43 · Nuremberg',
    detail: 'Created server 68241193, 4 agent slots at €0.0062/slot/hr',
    outcome: 'succeeded',
    elapsedMs: 2140,
  },
];

export const TRACE_TODAY_TOTAL_MS = 2146;

/** The same request under today's shipped behaviour, for the before/after panel. */
export const TRACE_BEFORE: TraceStep[] = [
  {
    order: 1,
    label: 'Hetzner cx43 · Falkenstein',
    detail: 'HTTP 422 unsupported location for server type',
    outcome: 'failed',
    elapsedMs: 890,
  },
  {
    order: 2,
    label: 'Task marked failed',
    detail: 'No retry, no other region tried, no other provider tried',
    outcome: 'failed',
    elapsedMs: 12,
  },
];

export const TRACE_BEFORE_TOTAL_MS = 902;

// ── Connected providers (for the Connections screen) ────────────────────────

export interface Connection {
  provider: ProviderId;
  connected: boolean;
  scope: 'project' | 'personal' | 'platform';
  regionsEnabled: number;
  regionsTotal: number;
  /** null when the provider exposes no availability endpoint. */
  availabilitySignal: 'live' | 'none' | null;
  lastCatalogSync: string;
  note?: string;
}

export const CONNECTIONS: Connection[] = [
  {
    provider: 'hetzner',
    connected: true,
    scope: 'personal',
    regionsEnabled: 3,
    regionsTotal: 5,
    availabilitySignal: 'live',
    lastCatalogSync: '2 minutes ago',
    note: 'Reports per-region stock for every server type',
  },
  {
    provider: 'scaleway',
    connected: true,
    scope: 'project',
    regionsEnabled: 2,
    regionsTotal: 8,
    availabilitySignal: 'live',
    lastCatalogSync: '6 minutes ago',
    note: 'Reports per-zone availability',
  },
  {
    provider: 'digitalocean',
    connected: true,
    scope: 'personal',
    regionsEnabled: 1,
    regionsTotal: 10,
    availabilitySignal: 'none',
    lastCatalogSync: '11 minutes ago',
    note: 'Prices are live; stock is only discoverable by attempting',
  },
  {
    provider: 'vultr',
    connected: true,
    scope: 'personal',
    regionsEnabled: 1,
    regionsTotal: 9,
    availabilitySignal: 'none',
    lastCatalogSync: '4 minutes ago',
    note: 'Prices are live; stock is only discoverable by attempting',
  },
  {
    provider: 'gcp',
    connected: false,
    scope: 'personal',
    regionsEnabled: 0,
    regionsTotal: 8,
    availabilitySignal: null,
    lastCatalogSync: 'never',
  },
];

// ── Long-text / stress fixtures ─────────────────────────────────────────────

export const STRESS_LONG_NOTE =
  'Provider returned a very long diagnostic string that must wrap cleanly instead of ' +
  'pushing the card off the side of a 375px viewport: unsupported location for server ' +
  'type cx43 in datacenter fsn1-dc14, and no alternative datacenter in this location ' +
  'currently reports available capacity for the requested server type family.';
