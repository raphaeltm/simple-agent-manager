import {
  Bot,
  Box,
  ChevronDown,
  ChevronUp,
  Cloud,
  Cpu,
  ExternalLink,
  Globe,
  Hash,
  MessageSquare,
  Server,
  Tag,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { type MockPort, type MockScenario, SCENARIOS } from './mock-data';

// ---------------------------------------------------------------------------
// Prototype: title-led SessionHeader
//
// Self-contained, no API calls, no auth. Explores making the collapsed header
// row minimal (title-led) and turning the expand/collapse dropdown into the
// canonical details surface (full title + initial prompt + all ports).
//
// Three variations are rendered side-by-side so we can compare under comically
// large stress-test data (50 ports, unbreakable mega-titles, etc.).
// ---------------------------------------------------------------------------

type Variation = 'A' | 'B' | 'C';

const VARIATION_LABELS: Record<Variation, string> = {
  A: 'A · Title-led, minimal row',
  B: 'B · Two-line header',
  C: 'C · Horizontal-scroll badge strip',
};

const VARIATION_BLURB: Record<Variation, string> = {
  A: 'Collapsed row = title + status + chevron only. Everything else (badges, ports, full title, initial prompt) lives in the dropdown.',
  B: 'Title gets its own line (clamped to 2 lines). Row 2 holds status + first port + “+N”. Dropdown is the canonical details surface.',
  C: 'Title truncates; secondary chips live in a horizontally scrollable strip (intentional horizontal scroll). Dropdown still holds everything.',
};

function statusColor(status: MockScenario['status']): string {
  if (status === 'active') return 'var(--sam-color-success)';
  if (status === 'idle') return 'var(--sam-color-warning)';
  return 'var(--sam-color-fg-muted)';
}

function statusLabel(status: MockScenario['status']): string {
  if (status === 'active') return 'Active';
  if (status === 'idle') return 'Idle';
  return 'Stopped';
}

function profileBadgeColors(profile: MockScenario['profile']): { bg: string; fg: string } {
  if (profile === 'lightweight') return { bg: 'var(--sam-color-info-tint)', fg: 'var(--sam-color-info)' };
  if (profile === 'recovery') return { bg: 'var(--sam-color-warning-tint)', fg: 'var(--sam-color-warning)' };
  return { bg: 'var(--sam-color-success-tint)', fg: 'var(--sam-color-success)' };
}

function profileLabel(profile: MockScenario['profile']): string {
  if (profile === 'lightweight') return 'Lightweight';
  if (profile === 'recovery') return 'Recovery container';
  return 'Full';
}

// ---- Shared sub-components --------------------------------------------------

function StatusPill({ status }: { status: MockScenario['status'] }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium shrink-0"
      style={{ color: statusColor(status) }}
    >
      <span className="w-[6px] h-[6px] rounded-full bg-current" />
      {statusLabel(status)}
    </span>
  );
}

function ProfileBadge({ profile }: { profile: MockScenario['profile'] }) {
  const c = profileBadgeColors(profile);
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 whitespace-nowrap"
      style={{ backgroundColor: c.bg, color: c.fg }}
    >
      {profileLabel(profile)}
    </span>
  );
}

function PortPill({ port }: { port: MockPort }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[10px] font-mono font-medium px-1.5 py-0.5 rounded shrink-0 whitespace-nowrap"
      style={{
        backgroundColor: 'var(--sam-color-accent-primary-tint)',
        color: 'var(--sam-color-accent-primary)',
      }}
      title={`${port.label} — ${port.url}`}
    >
      <Globe size={10} />
      {port.port}
    </span>
  );
}

/** The canonical "details" surface shared by every variation. */
function ExpandedDetails({ scenario }: { scenario: MockScenario }) {
  const sortedPorts = scenario.ports.slice().sort((a, b) => a.port - b.port);
  return (
    <div
      className="border-t px-4 py-3 space-y-3"
      style={{ borderColor: 'var(--sam-color-border-default)' }}
    >
      {/* FULL TITLE — the thing the friend went looking for. Wraps freely. */}
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--sam-color-fg-muted)' }}>
          <Tag size={10} />
          Title
        </div>
        <div
          className="text-sm font-semibold"
          style={{ color: 'var(--sam-color-fg-primary)', overflowWrap: 'anywhere' }}
        >
          {scenario.title}
        </div>
      </div>

      {/* INITIAL PROMPT — already in memory as the first user message. */}
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--sam-color-fg-muted)' }}>
          <MessageSquare size={10} />
          Initial prompt
        </div>
        <div
          className="text-xs leading-relaxed rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap"
          style={{
            color: 'var(--sam-color-fg-primary)',
            background: 'var(--sam-color-bg-inset)',
            overflowWrap: 'anywhere',
          }}
        >
          {scenario.initialPrompt}
        </div>
      </div>

      {/* Lineage + profile + agent meta */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs" style={{ color: 'var(--sam-color-fg-muted)' }}>
        <ProfileBadge profile={scenario.profile} />
        {scenario.lineageText && (
          <span className="inline-flex items-center gap-1 min-w-0" style={{ overflowWrap: 'anywhere' }}>
            {scenario.lineageText}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <Bot size={11} className="opacity-60" />
          <span style={{ color: 'var(--sam-color-fg-primary)' }}>{scenario.agentType}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          {scenario.taskMode === 'conversation' ? <MessageSquare size={11} className="opacity-60" /> : <Cpu size={11} className="opacity-60" />}
          {scenario.taskMode === 'conversation' ? 'Conversation' : 'Task'}
        </span>
        {scenario.agentProfileHint && (
          <span className="inline-flex items-center gap-1 min-w-0" style={{ overflowWrap: 'anywhere' }}>
            {scenario.agentProfileHint}
          </span>
        )}
      </div>

      {/* Infra */}
      <div className="flex flex-col gap-1.5 pt-1 border-t text-xs" style={{ borderColor: 'var(--sam-color-border-default)', color: 'var(--sam-color-fg-muted)' }}>
        <InfraRow icon={<Box size={12} />} label="Workspace" value={scenario.workspaceName} />
        <InfraRow icon={<Cpu size={12} />} label="VM Size" value={scenario.vmSize} />
        <InfraRow icon={<Server size={12} />} label="Node" value={scenario.nodeName} />
        <InfraRow icon={<Cloud size={12} />} label="Provider" value={scenario.provider} />
        {scenario.branch && <InfraRow icon={<Hash size={12} />} label="Branch" value={scenario.branch} mono />}
      </div>

      {/* ALL ports — full list, wraps. This is where "+N" / the strip lands you. */}
      {sortedPorts.length > 0 && (
        <div className="space-y-1 pt-1 border-t" style={{ borderColor: 'var(--sam-color-border-default)' }}>
          <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--sam-color-fg-muted)' }}>
            <Globe size={10} />
            Ports ({sortedPorts.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sortedPorts.map((p) => (
              <a
                key={p.port}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[11px] no-underline px-1.5 py-0.5 rounded"
                style={{ color: 'var(--sam-color-accent-primary)', background: 'var(--sam-color-accent-primary-tint)' }}
                title={p.label}
              >
                {p.port}
                {(p.address === '127.0.0.1' || p.address === '::1') ? ' (local)' : ''}
                <ExternalLink size={10} />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InfraRow({ icon, label, value, mono }: { icon: React.ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="shrink-0 opacity-60">{icon}</span>
      <span className="font-medium shrink-0">{label}:</span>
      <span
        className={`min-w-0 truncate ${mono ? 'font-mono text-[11px]' : ''}`}
        style={{ color: 'var(--sam-color-fg-primary)' }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

// ---- The three header variations ------------------------------------------

function HeaderShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-b-2xl overflow-hidden"
      style={{
        background: 'var(--sam-color-bg-surface)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(34,197,94,0.08)',
      }}
    >
      {children}
    </div>
  );
}

function VariationA({ scenario, expanded, onToggle }: { scenario: MockScenario; expanded: boolean; onToggle: () => void }) {
  return (
    <HeaderShell>
      <div className="flex items-center gap-2 px-4 py-2 min-h-[44px]">
        <span className="text-sm font-semibold truncate flex-1 min-w-0" style={{ color: 'var(--sam-color-fg-primary)' }}>
          {scenario.title}
        </span>
        <StatusPill status={scenario.status} />
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide details' : 'Show details'}
          className="shrink-0 p-2 bg-transparent border-none cursor-pointer rounded-sm"
          style={{ color: 'var(--sam-color-fg-muted)' }}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {expanded && <ExpandedDetails scenario={scenario} />}
    </HeaderShell>
  );
}

function VariationB({ scenario, expanded, onToggle }: { scenario: MockScenario; expanded: boolean; onToggle: () => void }) {
  const sortedPorts = scenario.ports.slice().sort((a, b) => a.port - b.port);
  const firstPort = sortedPorts[0];
  const extra = sortedPorts.length - 1;
  return (
    <HeaderShell>
      <div className="px-4 py-2 space-y-1.5">
        {/* Row 1: title gets its own line, clamped to 2 lines */}
        <div className="flex items-start gap-2">
          <span
            className="text-sm font-semibold flex-1 min-w-0"
            style={{
              color: 'var(--sam-color-fg-primary)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              overflowWrap: 'anywhere',
            }}
          >
            {scenario.title}
          </span>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide details' : 'Show details'}
            className="shrink-0 p-1 bg-transparent border-none cursor-pointer rounded-sm -mt-0.5"
            style={{ color: 'var(--sam-color-fg-muted)' }}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
        {/* Row 2: status + first port + +N (tap chevron / row to see all in dropdown) */}
        <div className="flex items-center gap-2 min-w-0">
          <StatusPill status={scenario.status} />
          <ProfileBadge profile={scenario.profile} />
          {firstPort && <PortPill port={firstPort} />}
          {extra > 0 && (
            <button
              type="button"
              onClick={onToggle}
              className="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 bg-transparent border cursor-pointer whitespace-nowrap"
              style={{ color: 'var(--sam-color-fg-muted)', borderColor: 'var(--sam-color-border-default)' }}
            >
              +{extra} more
            </button>
          )}
        </div>
      </div>
      {expanded && <ExpandedDetails scenario={scenario} />}
    </HeaderShell>
  );
}

function VariationC({ scenario, expanded, onToggle }: { scenario: MockScenario; expanded: boolean; onToggle: () => void }) {
  const sortedPorts = scenario.ports.slice().sort((a, b) => a.port - b.port);
  return (
    <HeaderShell>
      <div className="flex items-center gap-2 px-4 py-2 min-h-[44px]">
        <span className="text-sm font-semibold truncate flex-1 min-w-0" style={{ color: 'var(--sam-color-fg-primary)' }}>
          {scenario.title}
        </span>
        <StatusPill status={scenario.status} />
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide details' : 'Show details'}
          className="shrink-0 p-2 bg-transparent border-none cursor-pointer rounded-sm"
          style={{ color: 'var(--sam-color-fg-muted)' }}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {/* Intentionally horizontally scrollable secondary strip. */}
      {(scenario.ports.length > 0 || scenario.lineageText) && (
        <div
          data-scrollable="true"
          className="flex items-center gap-1.5 px-4 pb-2 overflow-x-auto"
          style={{ scrollbarWidth: 'thin' }}
        >
          <ProfileBadge profile={scenario.profile} />
          {scenario.lineageText && (
            <span className="text-[10px] font-medium shrink-0 whitespace-nowrap" style={{ color: 'var(--sam-color-fg-muted)' }}>
              {scenario.lineageText.startsWith('⑂') ? '⑂ fork' : scenario.lineageText}
            </span>
          )}
          {sortedPorts.map((p) => <PortPill key={p.port} port={p} />)}
        </div>
      )}
      {expanded && <ExpandedDetails scenario={scenario} />}
    </HeaderShell>
  );
}

// ---- Overflow scanner ------------------------------------------------------

/**
 * Walks the prototype root and outlines (in red) any element whose content
 * overflows horizontally and is NOT explicitly marked data-scrollable. Also
 * reports a count so we can see at a glance whether a layout is clean.
 */
function useOverflowScan(rootRef: React.RefObject<HTMLElement | null>, deps: unknown[], enabled: boolean) {
  const [count, setCount] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const all = root.querySelectorAll<HTMLElement>('*');
    let bad = 0;
    all.forEach((el) => {
      el.style.outline = '';
      el.removeAttribute('data-overflowing');
      if (!enabled) return;
      // Skip elements (and descendants of elements) that are meant to scroll.
      if (el.closest('[data-scrollable="true"]')) return;
      const overflowsX = el.scrollWidth - el.clientWidth > 1;
      if (!overflowsX) return;
      // Only a *visible* overflow is a real problem. truncate (overflow:hidden /
      // text-overflow:ellipsis) and auto/scroll containers clip or scroll their
      // content correctly — their scrollWidth > clientWidth is by design, not a bug.
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') return;
      el.style.outline = '2px solid #ef4444';
      el.style.outlineOffset = '-1px';
      el.setAttribute('data-overflowing', 'true');
      bad += 1;
    });
    setCount(bad);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return count;
}

// ---- Phone / desktop frame -------------------------------------------------

function DeviceFrame({ width, label, children }: { width: number | '100%'; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="text-[11px] font-mono" style={{ color: 'var(--sam-color-fg-muted)' }}>{label}</div>
      <div
        style={{
          width: width === '100%' ? '100%' : `${width}px`,
          maxWidth: '100%',
          border: '1px solid var(--sam-color-border-default)',
          borderRadius: 12,
          overflow: 'hidden',
          background: 'var(--sam-color-bg-canvas)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ---- Main page -------------------------------------------------------------

export function SessionHeaderPrototype() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const [variation, setVariation] = useState<Variation>('A');
  const [expanded, setExpanded] = useState(true);
  const [highlight, setHighlight] = useState(true);

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];

  const mobileRef = useRef<HTMLDivElement>(null);
  const desktopRef = useRef<HTMLDivElement>(null);

  const Header =
    variation === 'A' ? VariationA : variation === 'B' ? VariationB : VariationC;

  const mobileOverflows = useOverflowScan(mobileRef, [scenarioId, variation, expanded], highlight);
  const desktopOverflows = useOverflowScan(desktopRef, [scenarioId, variation, expanded], highlight);

  // Re-scan on window resize too.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const onResize = () => forceTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div
      style={{ height: '100vh', overflow: 'auto', background: 'var(--sam-color-bg-page)' }}
      data-testid="session-header-prototype"
    >
      <div className="mx-auto max-w-5xl px-4 py-6 space-y-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--sam-color-fg-primary)' }}>
            Title-led SessionHeader — prototype
          </h1>
          <p className="text-xs" style={{ color: 'var(--sam-color-fg-muted)' }}>
            Red outlines = unintended horizontal overflow. Strips marked “scroll” are allowed to overflow.
          </p>
        </header>

        {/* Controls */}
        <div className="flex flex-wrap gap-4 p-3 rounded-lg" style={{ background: 'var(--sam-color-bg-surface)' }}>
          <Control label="Scenario">
            <select
              value={scenarioId}
              onChange={(e) => setScenarioId(e.target.value)}
              className="text-xs rounded px-2 py-1 bg-transparent border"
              style={{ color: 'var(--sam-color-fg-primary)', borderColor: 'var(--sam-color-border-default)' }}
            >
              {SCENARIOS.map((s) => (
                <option key={s.id} value={s.id} style={{ background: 'var(--sam-color-bg-surface)' }}>
                  {s.name}
                </option>
              ))}
            </select>
          </Control>
          <Control label="Variation">
            <div className="flex gap-1">
              {(['A', 'B', 'C'] as Variation[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVariation(v)}
                  className="text-xs px-2 py-1 rounded border cursor-pointer"
                  style={{
                    color: variation === v ? 'var(--sam-color-fg-on-accent)' : 'var(--sam-color-fg-primary)',
                    background: variation === v ? 'var(--sam-color-accent-primary)' : 'transparent',
                    borderColor: 'var(--sam-color-border-default)',
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          </Control>
          <Control label="State">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs px-2 py-1 rounded border cursor-pointer"
              style={{ color: 'var(--sam-color-fg-primary)', borderColor: 'var(--sam-color-border-default)' }}
            >
              {expanded ? 'Expanded' : 'Collapsed'}
            </button>
          </Control>
          <Control label="Overflow check">
            <button
              type="button"
              onClick={() => setHighlight((v) => !v)}
              className="text-xs px-2 py-1 rounded border cursor-pointer"
              style={{
                color: highlight ? 'var(--sam-color-fg-on-accent)' : 'var(--sam-color-fg-primary)',
                background: highlight ? 'var(--sam-color-danger)' : 'transparent',
                borderColor: 'var(--sam-color-border-default)',
              }}
            >
              {highlight ? 'ON' : 'OFF'}
            </button>
          </Control>
        </div>

        <p className="text-xs" style={{ color: 'var(--sam-color-fg-muted)' }}>
          {VARIATION_LABELS[variation]} — {VARIATION_BLURB[variation]}
        </p>

        {/* Overflow report */}
        <div className="flex gap-4 text-xs font-mono">
          <span style={{ color: mobileOverflows ? 'var(--sam-color-danger)' : 'var(--sam-color-success)' }}>
            mobile overflows: {mobileOverflows}
          </span>
          <span style={{ color: desktopOverflows ? 'var(--sam-color-danger)' : 'var(--sam-color-success)' }}>
            desktop overflows: {desktopOverflows}
          </span>
        </div>

        {/* Frames */}
        <div className="grid gap-8 md:grid-cols-[375px_1fr] items-start">
          <div ref={mobileRef}>
            <DeviceFrame width={375} label="375px (mobile)">
              <Header scenario={scenario} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
            </DeviceFrame>
          </div>
          <div ref={desktopRef}>
            <DeviceFrame width="100%" label="desktop (fluid)">
              <Header scenario={scenario} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
            </DeviceFrame>
          </div>
        </div>
      </div>
    </div>
  );
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--sam-color-fg-muted)' }}>{label}</span>
      {children}
    </div>
  );
}

export default SessionHeaderPrototype;
