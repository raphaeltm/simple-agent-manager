/**
 * PROTOTYPE — not for production. /prototype/profile-usage
 *
 * How much usage is left on each profile, shown where profiles are picked: the
 * new-chat cards, the "Start with…" sheet and the composer's To chip. Three directions:
 * A Words ("83% left"), B Meters (the profile list's strip) and C Rings (a fuel ring
 * on the avatar, numbers only when low, plus a switch nudge).
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { paneClassName, SegmentedControl } from '@simple-agent-manager/ui';
import { ArrowUp, ChevronDown, ChevronRight, Mic, Paperclip, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { ProfileUsageStrip } from '../../components/agent-profiles/ProfileUsageStrip';
import { isBuildProfile } from '../../components/project-chat/profile-picker';
import { useTheme } from '../../contexts/ThemeContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { BUDGETS, NOW, PROFILES, RECENT_IDS } from './mock-data';
import { betterAlternative, profileUsage, usageWords } from './usage-model';
import { type Direction, UsageCard, UsageRow, UsageToChip } from './variants';

const DIRECTIONS: Array<{ value: Direction; label: string; blurb: string }> = [
  { value: 'words', label: 'A · Words', blurb: 'Plain “% left” on every profile, with the account name.' },
  { value: 'meters', label: 'B · Meters', blurb: 'Every limit as a tiny bar — same as Manage profiles.' },
  { value: 'rings', label: 'C · Rings', blurb: 'A fuel ring on the avatar. Numbers only when low; empty ones sink.' },
];

const usageOf = (profile: AgentProfile) => profileUsage(BUDGETS.get(profile.id), NOW);

export function ProfileUsagePrototype() {
  const [direction, setDirection] = useState<Direction>('words');
  const [selectedId, setSelectedId] = useState<string>(PROFILES[2]?.id ?? '');
  const [sheetOpen, setSheetOpen] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const selected = PROFILES.find((p) => p.id === selectedId) ?? PROFILES[0];
  const cards = PROFILES.filter((p) => RECENT_IDS.includes(p.id));
  const blurb = DIRECTIONS.find((d) => d.value === direction)?.blurb;

  return (
    <div className="sam-void" style={{ height: '100vh', overflow: 'auto' }}>
      <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col gap-2.5 p-2.5">
        <header className={`${paneClassName('pane')} flex flex-col gap-2 p-3`}>
          <div className="flex items-center justify-between gap-2">
            <h1 className="m-0 text-sm font-semibold text-fg-primary">Prototype · usage left on profiles</h1>
            <button
              type="button"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              className="min-h-9 rounded-md bg-transparent px-2 text-xs text-fg-muted hover:text-fg-primary"
            >
              {resolvedTheme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
          <SegmentedControl
            label="Design direction"
            options={DIRECTIONS.map(({ value, label }) => ({ value, label }))}
            value={direction}
            onChange={setDirection}
            size="lg"
          />
          <p className="m-0 text-xs text-fg-muted">{blurb}</p>
        </header>

        <main className={`${paneClassName('pane')} flex flex-1 flex-col items-center p-4`}>
          <section className="@container flex w-full min-w-0 max-w-[720px] flex-col gap-3">
            <div className="text-center">
              <h2 className="m-0 text-base font-semibold text-fg-primary">Who should take this?</h2>
              <p className="sam-type-secondary m-0 mt-1 text-fg-muted">
                Pick a profile, then describe the task below.
              </p>
            </div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Recent</div>
            <div className="grid grid-cols-1 gap-2 @2xs:grid-cols-2 @2xl:grid-cols-4">
              {cards.map((profile) => (
                <UsageCard
                  key={profile.id}
                  direction={direction}
                  profile={profile}
                  usage={usageOf(profile)}
                  budget={BUDGETS.get(profile.id)}
                  now={NOW}
                  selected={profile.id === selectedId}
                  onSelect={() => setSelectedId(profile.id)}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="mx-auto flex min-h-11 items-center gap-1 rounded-md bg-transparent px-3 text-sm text-fg-secondary hover:text-fg-primary"
            >
              All {PROFILES.length} profiles <ChevronRight size={15} aria-hidden="true" />
            </button>
          </section>
        </main>

        {selected && <Composer direction={direction} selected={selected} onOpen={() => setSheetOpen(true)} onSwitch={setSelectedId} />}
      </div>

      <PickerSheet
        open={sheetOpen}
        direction={direction}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setSheetOpen(false);
        }}
        onClose={() => setSheetOpen(false)}
      />
    </div>
  );
}

function Composer({
  direction,
  selected,
  onOpen,
  onSwitch,
}: Readonly<{ direction: Direction; selected: AgentProfile; onOpen: () => void; onSwitch: (id: string) => void }>) {
  const usage = usageOf(selected);
  const needsNudge = direction === 'rings' && (usage.state === 'low' || usage.state === 'out');
  const alternative = needsNudge ? betterAlternative(selected, PROFILES, usageOf) : null;

  return (
    <footer className={`${paneClassName('pane')} @container flex flex-col gap-2 p-3`}>
      {needsNudge && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-xs"
          style={{ background: `color-mix(in srgb, ${usage.color} 12%, transparent)` }}
        >
          <span className="min-w-0 flex-1 text-fg-primary">
            <strong style={{ color: usage.color }}>
              {usage.state === 'out' ? 'Out' : `${usage.left}% left`}
            </strong>{' '}
            on {usage.accountLabel}
            {usage.resetIn && ` · ${usage.state === 'out' ? 'back' : 'resets'} in ${usage.resetIn}`}
          </span>
          {alternative && (
            <button
              type="button"
              onClick={() => onSwitch(alternative.profile.id)}
              className="min-h-9 shrink-0 rounded-full border border-border-default bg-surface px-3 font-medium text-fg-primary hover:border-accent/60"
            >
              Use {alternative.profile.name} · {alternative.usage.left}% left
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <UsageToChip direction={direction} profile={selected} usage={usage} onOpen={onOpen} />
        </div>
        <IconCircle label="Attach"><Paperclip size={18} /></IconCircle>
        <IconCircle label="Options"><SlidersHorizontal size={18} /></IconCircle>
      </div>
      {direction === 'meters' && (
        <div className="flex min-w-0 items-center gap-2 pl-3">
          <span className="shrink-0 truncate text-[11px] text-fg-muted">{usage.accountLabel ?? usageWords(usage)}</span>
          <ProfileUsageStrip budget={BUDGETS.get(selected.id)} profileName={selected.name} now={NOW} />
        </div>
      )}
      <div className="flex items-end gap-2">
        <div className="min-h-[52px] flex-1 rounded-xl border border-border-default bg-surface px-3 py-3 text-sm text-fg-muted">
          Describe what you want the agent to do…
        </div>
        <IconCircle label="Voice"><Mic size={18} /></IconCircle>
        <button type="button" aria-label="Send" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-0 bg-accent text-white">
          <ArrowUp size={20} />
        </button>
      </div>
    </footer>
  );
}

function IconCircle({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <button
      type="button"
      aria-label={label}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border-default bg-transparent text-fg-muted"
    >
      {children}
    </button>
  );
}

function PickerSheet({
  open,
  direction,
  selectedId,
  onSelect,
  onClose,
}: Readonly<{
  open: boolean;
  direction: Direction;
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}>) {
  const isMobile = useIsMobile();
  const [query, setQuery] = useState('');
  const [showOut, setShowOut] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = PROFILES.filter((p) => !q || p.name.toLowerCase().includes(q));
    // Rings sinks profiles that cannot run right now into their own folded section.
    const sinkOut = direction === 'rings';
    const isOut = (p: AgentProfile) => sinkOut && usageOf(p).state === 'out';
    const recent = q ? [] : match.filter((p) => RECENT_IDS.slice(0, 3).includes(p.id) && !isOut(p));
    const rest = match.filter((p) => !recent.includes(p) && !isOut(p));
    return [
      { id: 'recent', label: 'Recent', items: recent },
      { id: 'chat', label: 'Chat & explore', items: rest.filter((p) => !isBuildProfile(p)) },
      { id: 'build', label: 'Build & open PRs', items: rest.filter((p) => isBuildProfile(p)) },
      { id: 'out', label: 'Out for now', items: match.filter(isOut) },
    ].filter((s) => s.items.length > 0);
  }, [direction, query]);

  if (!open) return null;
  return (
    <div>
      <div className="sam-scrim fixed inset-0 z-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a profile"
        className={`${
          isMobile
            ? 'fixed inset-x-0 bottom-0 max-h-[85vh] rounded-t-[var(--sam-radius-pane)]'
            : 'fixed left-1/2 top-1/2 max-h-[600px] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-[var(--sam-radius-pane)]'
        } z-drawer ${paneClassName('overlay', { rounded: false })} flex flex-col overflow-hidden`}
      >
        {isMobile && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-default" />}
        <div className="flex shrink-0 items-center gap-1 px-4 pb-1 pt-3">
          <h2 className="m-0 min-w-0 flex-1 truncate text-base font-semibold text-fg-primary">Start with…</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-md bg-transparent text-fg-muted hover:text-fg-primary">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="relative mx-4 mb-1 flex shrink-0 items-center">
          <Search size={15} className="pointer-events-none absolute left-3 text-fg-muted" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${PROFILES.length} profiles`}
            aria-label="Search profiles"
            className="min-h-11 w-full rounded-md border border-border-default bg-surface pl-9 pr-3 text-base text-fg-primary outline-none focus:border-accent/60 sm:text-sm"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-3" data-testid="sheet-scroll">
          {sections.map((section) => {
            const folded = section.id === 'out';
            const expanded = !folded || showOut;
            return (
              <div key={section.id}>
                {folded ? (
                  <button
                    type="button"
                    onClick={() => setShowOut((v) => !v)}
                    aria-expanded={showOut}
                    className="flex min-h-11 w-full items-center gap-1 bg-transparent px-4 pt-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-muted hover:text-fg-secondary"
                  >
                    {showOut ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {section.label} ({section.items.length})
                  </button>
                ) : (
                  <h3 className="m-0 px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                    {section.label}
                  </h3>
                )}
                {expanded &&
                  section.items.map((profile) => (
                    <UsageRow
                      key={profile.id}
                      direction={direction}
                      profile={profile}
                      usage={usageOf(profile)}
                      budget={BUDGETS.get(profile.id)}
                      now={NOW}
                      selected={profile.id === selectedId}
                      onSelect={() => onSelect(profile.id)}
                    />
                  ))}
              </div>
            );
          })}
          {sections.length === 0 && <p className="m-0 px-4 py-6 text-center text-sm text-fg-muted">No profiles match.</p>}
        </div>
      </div>
    </div>
  );
}
