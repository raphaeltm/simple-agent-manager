/**
 * Capacity Pools — UI prototype.
 *
 * PROTOTYPE ONLY (see .claude/rules/37-prototype-development.md):
 * unauthenticated route, mock data, no API calls. Route is dev-only and must be
 * removed before any merge to main.
 *
 * Explores the four surfaces a multi-provider placement pool needs:
 *   1. Pool      — pick a strategy, choose which providers/regions may be used
 *   2. Ladder    — the explicit, ordered "what we will try" list
 *   3. Why       — placement explanation after the fact, incl. before/after
 *   4. Providers — connection state and what capacity signal each one gives us
 */

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  ChevronRight,
  Clock,
  Layers,
  Minus,
  Plug,
  Server,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';

import {
  CANDIDATES,
  CONNECTIONS,
  DEFAULT_SLOT,
  PROVIDER_LABELS,
  SKIP_LABELS,
  STRATEGIES,
  STRESS_LONG_NOTE,
  TRACE_BEFORE,
  TRACE_BEFORE_TOTAL_MS,
  TRACE_TODAY,
  TRACE_TODAY_TOTAL_MS,
  breakEvenMinutes,
  costPerTaskEur,
  rankCandidates,
  type Candidate,
  type ProviderId,
  type OverflowPolicy,
  type RankedCandidate,
  type StrategyId,
  type TraceStep,
} from './mock-data';

// ── Shared bits ─────────────────────────────────────────────────────────────

const TABS = [
  { id: 'pool', label: 'Pool', icon: Layers },
  { id: 'ladder', label: 'Order', icon: ArrowRight },
  { id: 'why', label: 'Why', icon: Sparkles },
  { id: 'providers', label: 'Providers', icon: Plug },
] as const;

type TabId = (typeof TABS)[number]['id'];

function eur(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return '—';
  return `€${n.toFixed(digits)}`;
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="sam-type-section-heading text-fg-primary">{title}</h2>
      {hint && <p className="sam-type-secondary mt-1 mb-3 text-fg-muted">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  );
}

function ProviderDot({ provider }: { provider: ProviderId }) {
  const colors: Record<ProviderId, string> = {
    hetzner: 'bg-danger',
    digitalocean: 'bg-info',
    vultr: 'bg-purple',
    scaleway: 'bg-warning',
    gcp: 'bg-success',
  };
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${colors[provider]}`}
    />
  );
}

// ── Tab 1: Pool ─────────────────────────────────────────────────────────────

function StrategyCard({
  id,
  selected,
  onSelect,
}: {
  id: StrategyId;
  selected: boolean;
  onSelect: () => void;
}) {
  const s = STRATEGIES[id];
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`w-full rounded-md border p-3 text-left transition ${
        selected
          ? 'border-accent bg-accent-tint'
          : 'border-border-default bg-surface hover:border-accent/60'
      }`}
    >
      <span className="flex items-center gap-2">
        {selected ? (
          <Check size={15} className="shrink-0 text-accent" aria-hidden="true" />
        ) : (
          <span className="h-[15px] w-[15px] shrink-0 rounded-full border border-border-default" />
        )}
        <span className="sam-type-card-title text-fg-primary">{s.name}</span>
      </span>
      <span className="sam-type-secondary mt-1 block text-fg-primary">{s.tagline}</span>
      <span className="sam-type-caption mt-1 block text-fg-muted">{s.who}</span>
      <ul className="mt-2 space-y-1">
        {s.rules.map((r) => (
          <li key={r} className="sam-type-caption flex gap-1.5 text-fg-muted">
            <Minus size={11} className="mt-[3px] shrink-0" aria-hidden="true" />
            <span className="min-w-0">{r}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}

function RegionToggleRow({
  candidate,
  disabled,
  onToggle,
}: {
  candidate: Candidate;
  disabled: boolean;
  onToggle: () => void;
}) {
  const key = `${candidate.provider}:${candidate.region}`;
  return (
    <label
      htmlFor={`region-${key}`}
      className="flex cursor-pointer items-start gap-2.5 border-b border-border-default px-3 py-2.5 last:border-b-0 hover:bg-surface-hover"
    >
      <input
        id={`region-${key}`}
        type="checkbox"
        checked={!disabled}
        onChange={onToggle}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--sam-color-accent-primary)]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <ProviderDot provider={candidate.provider} />
          <span className="sam-type-secondary font-medium text-fg-primary">
            {PROVIDER_LABELS[candidate.provider]}
          </span>
          <span className="sam-type-caption text-fg-muted">
            {candidate.regionLabel}, {candidate.country}
          </span>
        </span>
        <span className="sam-type-caption mt-0.5 block break-words text-fg-muted">
          {candidate.instanceType} · {candidate.vcpu} vCPU · {candidate.ramGb} GB ·{' '}
          {eur(candidate.pricePerHour, 4)}
          {candidate.currency === 'USD' ? ' equiv/hr' : '/hr'}
        </span>
      </span>
      <AvailabilityPill candidate={candidate} />
    </label>
  );
}

function AvailabilityPill({ candidate }: { candidate: Candidate }) {
  const map = {
    available: { text: 'In stock', cls: 'bg-success-tint text-success-fg' },
    'sold-out': { text: 'No stock', cls: 'bg-danger-tint text-danger-fg' },
    'not-offered': { text: 'Not sold', cls: 'bg-inset text-fg-muted' },
    unknown: { text: 'Unknown', cls: 'bg-warning-tint text-warning-fg' },
  } as const;
  const v = map[candidate.availability];
  return (
    <span
      className={`sam-type-caption shrink-0 whitespace-nowrap rounded-sm px-1.5 py-0.5 ${v.cls}`}
    >
      {v.text}
    </span>
  );
}

function OverflowChoice({
  policy,
  setPolicy,
  ceilingMultiple,
}: {
  policy: OverflowPolicy;
  setPolicy: (p: OverflowPolicy) => void;
  ceilingMultiple: number;
}) {
  const options: Array<{ id: OverflowPolicy; title: string; body: string }> = [
    {
      id: 'wait',
      title: 'Wait for cheap capacity',
      body: `Queue the task and keep watching. Never pay more than ${ceilingMultiple}× your cheapest option.`,
    },
    {
      id: 'spill',
      title: 'Start it anywhere',
      body: 'Use the next cheapest machine in the pool even if it costs several times more.',
    },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => {
        const selected = policy === o.id;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={selected}
            onClick={() => setPolicy(o.id)}
            className={`rounded-md border p-3 text-left transition ${
              selected
                ? 'border-accent bg-accent-tint'
                : 'border-border-default bg-surface hover:border-accent/60'
            }`}
          >
            <span className="flex items-center gap-2">
              {selected ? (
                <Check size={15} className="shrink-0 text-accent" aria-hidden="true" />
              ) : (
                <span className="h-[15px] w-[15px] shrink-0 rounded-full border border-border-default" />
              )}
              <span className="sam-type-secondary font-medium text-fg-primary">{o.title}</span>
            </span>
            <span className="sam-type-caption mt-1 block break-words text-fg-muted">{o.body}</span>
          </button>
        );
      })}
    </div>
  );
}

function PoolTab({
  strategy,
  setStrategy,
  disabledRegions,
  toggleRegion,
  overflowPolicy,
  setOverflowPolicy,
  ranked,
}: {
  strategy: StrategyId;
  setStrategy: (s: StrategyId) => void;
  disabledRegions: Set<string>;
  toggleRegion: (key: string) => void;
  overflowPolicy: OverflowPolicy;
  setOverflowPolicy: (p: OverflowPolicy) => void;
  ranked: RankedCandidate[];
}) {
  const best = ranked.find((r) => !r.skipped);
  const attemptable = ranked.filter((r) => !r.skipped).length;

  // One row per distinct provider+region+type, in pool order.
  return (
    <>
      <Section
        title="How should we choose machines?"
        hint="Two presets cover almost everyone. Both respect the pool below."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <StrategyCard
            id="consolidate"
            selected={strategy === 'consolidate'}
            onSelect={() => setStrategy('consolidate')}
          />
          <StrategyCard
            id="spread"
            selected={strategy === 'spread'}
            onSelect={() => setStrategy('spread')}
          />
        </div>
      </Section>

      <Section
        title="Your pool"
        hint="Anything ticked here may be used. Prices and stock come from each provider's own API, using your key."
      >
        <div className="overflow-hidden rounded-md border border-border-default bg-surface">
          {CANDIDATES.map((c) => {
            const key = `${c.provider}:${c.region}`;
            return (
              <RegionToggleRow
                key={c.id}
                candidate={c}
                disabled={disabledRegions.has(key)}
                onToggle={() => toggleRegion(key)}
              />
            );
          })}
        </div>
      </Section>

      <Section
        title="When everything cheap is sold out"
        hint="The only decision that has no right answer — so you make it once, here, instead of us guessing per task."
      >
        <OverflowChoice
          policy={overflowPolicy}
          setPolicy={setOverflowPolicy}
          ceilingMultiple={STRATEGIES[strategy].spillCeiling}
        />
      </Section>

      <Section title="What happens next time">
        <div className="rounded-md border border-border-default bg-surface p-3">
          {best ? (
            <>
              <p className="sam-type-caption text-fg-muted">First choice</p>
              <p className="sam-type-card-title mt-0.5 flex flex-wrap items-center gap-1.5 text-fg-primary">
                <ProviderDot provider={best.candidate.provider} />
                {PROVIDER_LABELS[best.candidate.provider]} {best.candidate.instanceType}
                <span className="text-fg-muted">·</span>
                <span className="sam-type-secondary text-fg-muted">
                  {best.candidate.regionLabel}
                </span>
              </p>
              <p className="sam-type-secondary mt-1 text-fg-muted">
                Holds {best.slots} agent{best.slots === 1 ? '' : 's'} at{' '}
                <span className="text-fg-primary">{eur(best.slotPriceEur)}</span> per agent per
                hour.
              </p>
              <p className="sam-type-caption mt-2 text-fg-muted">
                {attemptable} option{attemptable === 1 ? '' : 's'} in the fallback order — see the{' '}
                <span className="text-fg-primary">Order</span> tab.
              </p>
            </>
          ) : (
            <p className="sam-type-secondary text-warning-fg">
              Nothing in your pool can run an agent right now. We would queue the task rather than
              overspend.
            </p>
          )}
        </div>
      </Section>
    </>
  );
}

// ── Tab 2: Ladder ───────────────────────────────────────────────────────────

function LadderRow({ r, position }: { r: RankedCandidate; position: number | null }) {
  const c = r.candidate;
  const skipped = !!r.skipped;

  return (
    <li
      className={`flex gap-2.5 border-b border-border-default px-3 py-2.5 last:border-b-0 ${
        skipped ? 'bg-inset/40' : ''
      }`}
    >
      <span
        className={`sam-type-caption mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-semibold ${
          skipped
            ? 'bg-inset text-fg-muted'
            : position === 1
              ? 'bg-accent text-fg-on-accent'
              : 'bg-surface-hover text-fg-primary'
        }`}
      >
        {skipped ? <X size={11} aria-hidden="true" /> : position}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-1.5">
          <ProviderDot provider={c.provider} />
          <span
            className={`sam-type-secondary font-medium ${skipped ? 'text-fg-muted' : 'text-fg-primary'}`}
          >
            {PROVIDER_LABELS[c.provider]} {c.instanceType}
          </span>
          <span className="sam-type-caption text-fg-muted">{c.regionLabel}</span>
        </span>

        {skipped ? (
          <span className="sam-type-caption mt-0.5 block break-words text-fg-muted">
            {SKIP_LABELS[r.skipped!]}
            {r.skipDetail ? ` — ${r.skipDetail}` : ''}
          </span>
        ) : (
          <span className="sam-type-caption mt-0.5 block text-fg-muted">
            {r.slots} agent slot{r.slots === 1 ? '' : 's'} · {eur(r.hourlyEur)}/hr machine
          </span>
        )}
      </span>

      {!skipped && (
        <span className="shrink-0 text-right">
          <span className="sam-type-secondary block font-medium text-fg-primary">
            {eur(r.slotPriceEur)}
          </span>
          <span className="sam-type-caption block text-fg-muted">/agent/hr</span>
        </span>
      )}
    </li>
  );
}

function LadderTab({
  ranked,
  strategy,
  overflowPolicy,
}: {
  ranked: RankedCandidate[];
  strategy: StrategyId;
  overflowPolicy: OverflowPolicy;
}) {
  const attemptable = ranked.filter((r) => !r.skipped);
  const rejected = ranked.filter((r) => r.skipped);
  const s = STRATEGIES[strategy];

  return (
    <>
      <Section
        title="The order we will try"
        hint={`Ranked by ${
          strategy === 'consolidate' ? 'price per agent' : 'hourly machine price'
        }. ${
          overflowPolicy === 'wait'
            ? `Anything above ${s.spillCeiling}× your cheapest slot is refused, so a fallback can never quietly cost several times more.`
            : 'Price ceiling is off — the task will start on the next cheapest machine, however expensive.'
        }`}
      >
        <ol className="overflow-hidden rounded-md border border-border-default bg-surface">
          {attemptable.map((r, i) => (
            <LadderRow key={r.candidate.id} r={r} position={i + 1} />
          ))}
        </ol>
        {attemptable.length === 0 && (
          <div
            data-testid="ladder-empty"
            className="rounded-md border border-warning/40 bg-surface p-3"
          >
            <p className="sam-type-secondary text-warning-fg">
              Nothing in your pool is both in stock and under your price ceiling.
            </p>
            <p className="sam-type-caption mt-1 text-fg-muted">
              The task waits in the queue and starts the moment cheap capacity returns. Switch to
              “Start it anywhere” on the Pool tab if you would rather pay more now.
            </p>
          </div>
        )}
      </Section>

      <Section
        title="Excluded"
        hint="Skipped before any provider call, so these cost nothing but a cache lookup."
      >
        <ul className="overflow-hidden rounded-md border border-border-default bg-surface">
          {rejected.map((r) => (
            <LadderRow key={r.candidate.id} r={r} position={null} />
          ))}
        </ul>
        {rejected.length === 0 && (
          <p className="sam-type-secondary text-fg-muted">Nothing excluded.</p>
        )}
      </Section>

      <Section title="If everything is gone">
        <div className="rounded-md border border-border-default bg-surface p-3">
          <p className="sam-type-secondary text-fg-primary">
            The task waits and we keep watching stock, instead of failing.
          </p>
          <p className="sam-type-caption mt-1 break-words text-fg-muted">{STRESS_LONG_NOTE}</p>
        </div>
      </Section>
    </>
  );
}

// ── Tab 3: Why ──────────────────────────────────────────────────────────────

function TraceRow({ step }: { step: TraceStep }) {
  const icon = {
    skipped: <Minus size={12} className="text-fg-muted" aria-hidden="true" />,
    failed: <X size={12} className="text-danger-fg" aria-hidden="true" />,
    succeeded: <Check size={12} className="text-success-fg" aria-hidden="true" />,
  }[step.outcome];

  return (
    <li className="flex gap-2.5 border-b border-border-default px-3 py-2.5 last:border-b-0">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-inset">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="sam-type-secondary block font-medium text-fg-primary">{step.label}</span>
        <span className="sam-type-caption mt-0.5 block break-words text-fg-muted">
          {step.detail}
        </span>
      </span>
      <span className="sam-type-caption shrink-0 whitespace-nowrap text-fg-muted">
        {step.free ? 'free' : `${step.elapsedMs} ms`}
      </span>
    </li>
  );
}

function WhyTab() {
  return (
    <>
      <Section
        title="Why this machine?"
        hint="Shown on the node and on the task, so the choice is never a mystery."
      >
        <ol className="overflow-hidden rounded-md border border-border-default bg-surface">
          {TRACE_TODAY.map((s) => (
            <TraceRow key={s.order} step={s} />
          ))}
        </ol>
        <p className="sam-type-caption mt-2 flex items-center gap-1.5 text-fg-muted">
          <Clock size={12} aria-hidden="true" />
          Running in {TRACE_TODAY_TOTAL_MS} ms, after skipping 2 sold-out regions for free.
        </p>
      </Section>

      <Section title="What happens today" hint="Same request, current shipped behaviour.">
        <ol className="overflow-hidden rounded-md border border-danger/40 bg-surface">
          {TRACE_BEFORE.map((s) => (
            <TraceRow key={s.order} step={s} />
          ))}
        </ol>
        <p className="sam-type-caption mt-2 flex items-start gap-1.5 text-danger-fg">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            Failed in {TRACE_BEFORE_TOTAL_MS} ms. Nuremberg had stock the whole time.
          </span>
        </p>
      </Section>

      <Section title="Cost of the choice">
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            { label: 'Machine', value: '€0.0246/hr', sub: 'Hetzner cx43' },
            { label: 'Per agent', value: '€0.0062/hr', sub: '4 agents packed on' },
            { label: 'If we had spilled', value: '€0.0329/hr', sub: 'DigitalOcean, 5.3×' },
          ].map((s) => (
            <div key={s.label} className="rounded-md border border-border-default bg-surface p-3">
              <p className="sam-type-caption text-fg-muted">{s.label}</p>
              <p className="sam-type-card-title mt-0.5 text-fg-primary">{s.value}</p>
              <p className="sam-type-caption mt-0.5 text-fg-muted">{s.sub}</p>
            </div>
          ))}
        </div>
      </Section>

      <BreakEvenPanel />
    </>
  );
}

/**
 * The counter-intuitive result: for short-lived workspaces the cheap provider
 * is the expensive one, because Hetzner bills a whole hour minimum.
 */
function BreakEvenPanel() {
  const hz = CANDIDATES.find((c) => c.id === 'hz-cx23-nbg1')!;
  const doSmall = CANDIDATES.find((c) => c.id === 'do-s4-fra1')!;
  // Compare like-for-like on the smallest machine each provider offers here.
  const rows = [5, 10, 15, 30, 60].map((minutes) => ({
    minutes,
    hz: costPerTaskEur(hz, minutes),
    do: costPerTaskEur(doSmall, minutes),
  }));
  const be = breakEvenMinutes(hz, doSmall);

  return (
    <Section
      title="Short tasks invert the ranking"
      hint="Hetzner and Vultr charge a full hour minimum. DigitalOcean and Google bill per second. Below the crossover, the “expensive” provider is cheaper."
    >
      <div className="overflow-hidden rounded-md border border-border-default bg-surface">
        <div className="grid grid-cols-3 gap-2 border-b border-border-default px-3 py-2">
          <span className="sam-type-caption text-fg-muted">Task length</span>
          <span className="sam-type-caption text-right text-fg-muted">Hetzner cx23</span>
          <span className="sam-type-caption text-right text-fg-muted">DO 4 vCPU</span>
        </div>
        {rows.map((r) => {
          const hetznerWins = r.hz <= r.do;
          return (
            <div
              key={r.minutes}
              className="grid grid-cols-3 gap-2 border-b border-border-default px-3 py-2 last:border-b-0"
            >
              <span className="sam-type-secondary text-fg-primary">{r.minutes} min</span>
              <span
                className={`sam-type-secondary text-right ${hetznerWins ? 'font-medium text-success-fg' : 'text-fg-muted'}`}
              >
                €{r.hz.toFixed(5)}
              </span>
              <span
                className={`sam-type-secondary text-right ${hetznerWins ? 'text-fg-muted' : 'font-medium text-success-fg'}`}
              >
                €{r.do.toFixed(5)}
              </span>
            </div>
          );
        })}
      </div>
      {be !== null && (
        <p className="sam-type-caption mt-2 text-fg-muted">
          Crossover at about {be.toFixed(0)} minutes. “Just enough” should prefer per-second
          providers for anything shorter.
        </p>
      )}
    </Section>
  );
}

// ── Tab 4: Providers ────────────────────────────────────────────────────────

function ProvidersTab() {
  return (
    <Section
      title="Connected providers"
      hint="More providers means more places to fall back to. Each key is stored encrypted and used only for your machines."
    >
      <div className="overflow-hidden rounded-md border border-border-default bg-surface">
        {CONNECTIONS.map((conn) => (
          <div
            key={conn.provider}
            className="flex items-start gap-2.5 border-b border-border-default px-3 py-3 last:border-b-0"
          >
            <span className="mt-1">
              <ProviderDot provider={conn.provider} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="sam-type-secondary font-medium text-fg-primary">
                {PROVIDER_LABELS[conn.provider]}
              </p>
              {conn.connected ? (
                <>
                  <p className="sam-type-caption mt-0.5 text-fg-muted">
                    {conn.regionsEnabled} of {conn.regionsTotal} regions in your pool · synced{' '}
                    {conn.lastCatalogSync}
                  </p>
                  {conn.note && (
                    <p className="sam-type-caption mt-1 flex items-start gap-1 break-words text-fg-muted">
                      {conn.availabilitySignal === 'live' ? (
                        <Zap size={11} className="mt-[3px] shrink-0 text-success-fg" />
                      ) : (
                        <Ban size={11} className="mt-[3px] shrink-0 text-warning-fg" />
                      )}
                      <span className="min-w-0">{conn.note}</span>
                    </p>
                  )}
                </>
              ) : (
                <p className="sam-type-caption mt-0.5 text-fg-muted">Not connected</p>
              )}
            </div>
            <button
              type="button"
              className="sam-type-caption shrink-0 rounded-sm border border-border-default px-2 py-1 text-fg-primary hover:bg-surface-hover"
            >
              {conn.connected ? 'Edit' : 'Connect'}
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export function CapacityPoolsPrototype() {
  const [tab, setTab] = useState<TabId>('pool');
  const [strategy, setStrategy] = useState<StrategyId>('consolidate');
  const [disabledRegions, setDisabledRegions] = useState<Set<string>>(new Set());
  const [overflowPolicy, setOverflowPolicy] = useState<OverflowPolicy>('wait');

  const toggleRegion = (key: string) => {
    setDisabledRegions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const ranked = useMemo(
    () =>
      rankCandidates({
        strategy: STRATEGIES[strategy],
        slot: DEFAULT_SLOT,
        disabledRegions,
        overflowPolicy,
        candidates: CANDIDATES,
      }),
    [strategy, disabledRegions, overflowPolicy],
  );

  return (
    // Prototypes sit outside AppShell, so they must own their scroll container.
    <div style={{ height: '100vh', overflow: 'auto' }} className="bg-canvas">
      <header className="border-b border-border-default bg-surface">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <p className="sam-type-caption flex items-center gap-1.5 text-fg-muted">
            <Server size={12} aria-hidden="true" />
            Project settings
            <ChevronRight size={11} aria-hidden="true" />
            Infrastructure
          </p>
          <h1 className="sam-type-page-title mt-0.5 text-fg-primary">Capacity</h1>
          <p className="sam-type-secondary mt-1 text-fg-muted">
            Where SAM is allowed to start machines, and how it picks between them.
          </p>
        </div>
      </header>

      <nav className="sticky top-0 z-10 border-b border-border-default bg-surface">
        <div className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-2 py-1.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={active ? 'page' : undefined}
                className={`sam-type-secondary flex shrink-0 items-center gap-1.5 rounded-sm px-2.5 py-1.5 transition ${
                  active
                    ? 'bg-accent-tint text-fg-primary'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
                }`}
              >
                <Icon size={13} aria-hidden="true" />
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      <main className="mx-auto max-w-3xl px-4 py-4">
        {tab === 'pool' && (
          <PoolTab
            strategy={strategy}
            setStrategy={setStrategy}
            disabledRegions={disabledRegions}
            toggleRegion={toggleRegion}
            overflowPolicy={overflowPolicy}
            setOverflowPolicy={setOverflowPolicy}
            ranked={ranked}
          />
        )}
        {tab === 'ladder' && (
          <LadderTab ranked={ranked} strategy={strategy} overflowPolicy={overflowPolicy} />
        )}
        {tab === 'why' && <WhyTab />}
        {tab === 'providers' && <ProvidersTab />}
      </main>
    </div>
  );
}

export default CapacityPoolsPrototype;
