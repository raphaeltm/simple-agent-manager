import type { CredentialLimitCredentialSummary } from '@simple-agent-manager/shared';
import { credentialLimitSummaryAsOf } from '@simple-agent-manager/shared';
import {
  AvatarStack,
  Chip,
  chipClassName,
  type ChipTone,
  paneClassName,
} from '@simple-agent-manager/ui';
import { Gauge, Globe, Lightbulb, MessageSquareQuote, User2 } from 'lucide-react';
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import {
  credentialChipText,
  credentialFamilyLabel,
  formatUtilizationPercent,
  LEVEL_STYLES,
} from '../../components/credential-limits/credential-limit-format';
import { CredentialLimitChip } from '../../components/credential-limits/CredentialLimitChip';
import { SessionCommentChip } from '../../components/project-message-view/SessionCommentChip';
import { type MockHeaderScenario, type MockProfile, type MockState, SCENARIOS } from './mock-data';

/**
 * PROTOTYPE — /prototype/session-header. Never merge to main.
 *
 * Compares today's desktop session header with three slimmer versions over the same data:
 *   A "Trim chips"      ideas 1-4: short usage chip, status+profile merged, no "Your session",
 *                       icon-and-count comments chip. Spacing and chip size unchanged.
 *   B "Trim + compact"  A plus ideas 5-6: small chips, tighter padding, 17px title.
 *   C "One line"        B plus the title sharing a row with the chips when they fit
 *                       (title clamps to one line; chips wrap below only when needed).
 */

type Variant = 'current' | 'trim' | 'compact' | 'inline';

const VARIANTS: { id: Variant; name: string; detail: string }[] = [
  { id: 'current', name: 'Current', detail: 'What ships today' },
  { id: 'trim', name: 'A · Trim chips', detail: 'Ideas 1–4' },
  { id: 'compact', name: 'B · Trim + compact', detail: 'Ideas 1–6' },
  { id: 'inline', name: 'C · One line', detail: 'B + title beside chips' },
];

const STATE_LABEL: Record<MockState, string> = {
  active: 'Active',
  idle: 'Idle',
  sleeping: 'Sleeping',
  terminated: 'Stopped',
};

function stateTone(state: MockState): ChipTone {
  return state === 'active' ? 'success' : state === 'sleeping' ? 'info' : 'muted';
}

function profileLabel(profile: MockProfile): string | null {
  if (profile === 'recovery') return 'Recovery container';
  if (profile === 'lightweight') return 'Lightweight';
  return profile === 'full' ? 'Full' : null;
}

function profileTone(profile: MockProfile): ChipTone {
  return profile === 'recovery' ? 'warning' : profile === 'lightweight' ? 'info' : 'success';
}

const interactive =
  'cursor-pointer transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/* ------------------------------------------------------------------ */
/* Current header (faithful copy of SessionHeader + SessionHeaderChips) */
/* ------------------------------------------------------------------ */

function CurrentHeader({ s }: Readonly<{ s: MockHeaderScenario }>) {
  const profile = profileLabel(s.profile);
  const firstPort = s.ports[0];
  const extra = Math.max(0, s.ports.length - 1);
  return (
    <div className="shrink-0 space-y-2.5 px-4 pt-3 pb-3.5 md:px-6 md:pt-4">
      <div className="flex items-start gap-3">
        <Title text={s.title} className="text-[17px] md:text-[19px]" lines={2} />
        {s.people.length > 1 && <People s={s} size={26} />}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip tone={stateTone(s.state)} dot>
          {STATE_LABEL[s.state]}
        </Chip>
        {profile && <Chip tone={profileTone(s.profile)}>{profile}</Chip>}
        {s.credential && <CredentialLimitChip credential={s.credential} />}
        <Chip icon={<User2 size={14} strokeWidth={1.75} aria-hidden="true" />}>
          {s.isMine ? 'Your session' : s.creatorName}
        </Chip>
        {firstPort && <PortChip port={firstPort.port} size="md" />}
        {extra > 0 && (
          <button type="button" className={`${chipClassName()} ${interactive}`}>
            +{extra} more
          </button>
        )}
        <SessionCommentChip
          unresolvedCommentCount={s.unresolvedComments}
          needsAttentionCommentCount={s.needsAttentionComments}
          onOpenComments={() => undefined}
        />
        {s.workingOn && <WorkingOnChip s={s} size="md" />}
        {s.lineageText && (
          <Chip tone="muted" title={s.lineageText}>
            {s.lineageText.startsWith('⑂') ? '⑂ fork' : s.lineageText}
          </Chip>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Slim variants                                                       */
/* ------------------------------------------------------------------ */

function SlimHeader({
  s,
  variant,
}: Readonly<{ s: MockHeaderScenario; variant: Exclude<Variant, 'current'> }>) {
  const size = variant === 'trim' ? 'md' : 'sm';
  const chips = <SlimChips s={s} size={size} />;

  if (variant === 'trim') {
    return (
      <div className="shrink-0 space-y-2.5 px-4 pt-3 pb-3.5 md:px-6 md:pt-4">
        <div className="flex items-start gap-3">
          <Title text={s.title} className="text-[17px] md:text-[19px]" lines={2} />
          {s.people.length > 1 && <People s={s} size={26} />}
        </div>
        {chips}
      </div>
    );
  }

  if (variant === 'compact') {
    return (
      <div className="shrink-0 space-y-1.5 px-4 pt-3 pb-2.5 md:px-5">
        <div className="flex items-start gap-3">
          <Title text={s.title} className="text-[17px]" lines={2} />
          {s.people.length > 1 && <People s={s} size={20} />}
        </div>
        {chips}
      </div>
    );
  }

  // inline: the title takes the row and keeps at least ~18rem; the chip group sits beside it
  // when it fits and drops to its own row as one unit when it does not.
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-4 pt-3 pb-2.5 md:px-5">
      <Title text={s.title} className="min-w-[14rem] flex-[1_1_18rem] text-[17px]" lines={1} />
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
        <SlimChipItems s={s} size={size} />
        {s.people.length > 1 && <People s={s} size={20} />}
      </div>
    </div>
  );
}

function SlimChips({ s, size }: Readonly<{ s: MockHeaderScenario; size: 'sm' | 'md' }>) {
  return (
    <div className={`flex min-w-0 flex-wrap items-center ${size === 'sm' ? 'gap-1.5' : 'gap-2'}`}>
      <SlimChipItems s={s} size={size} />
    </div>
  );
}

function SlimChipItems({ s, size }: Readonly<{ s: MockHeaderScenario; size: 'sm' | 'md' }>) {
  const icon = size === 'sm' ? 13 : 14;
  const profile = profileLabel(s.profile);
  // Idea 2: status and profile share one chip. Recovery keeps its own amber chip, because it is
  // the one profile value that asks the user to do something.
  const mergedProfile = s.profile && s.profile !== 'recovery' ? profile : null;
  const firstPort = s.ports[0];
  const extra = Math.max(0, s.ports.length - 1);
  return (
    <>
      <Chip
        tone={stateTone(s.state)}
        size={size}
        dot
        title={mergedProfile ? `Workspace profile: ${mergedProfile}` : undefined}
      >
        {STATE_LABEL[s.state]}
        {mergedProfile && <span className="opacity-70">· {mergedProfile}</span>}
      </Chip>
      {s.profile === 'recovery' && (
        <Chip tone="warning" size={size}>
          Recovery
        </Chip>
      )}
      {s.credential && <CompactUsageChip credential={s.credential} size={size} />}
      {/* Idea 3: only say who started it when it was not you. */}
      {!s.isMine && (
        <Chip
          size={size}
          icon={<User2 size={icon} strokeWidth={1.75} aria-hidden="true" />}
          title={`Created by ${s.creatorName}`}
        >
          {s.creatorName.split(' ')[0]}
        </Chip>
      )}
      {firstPort && <PortChip port={firstPort.port} size={size} />}
      {extra > 0 && (
        <button type="button" className={`${chipClassName({ size })} ${interactive}`}>
          +{extra}
        </button>
      )}
      <CompactCommentChip s={s} size={size} />
      {s.workingOn && <WorkingOnChip s={s} size={size} />}
      {s.lineageText && (
        <Chip tone="muted" size={size} title={s.lineageText}>
          {s.lineageText.startsWith('⑂') ? '⑂ fork' : s.lineageText}
        </Chip>
      )}
    </>
  );
}

/**
 * Idea 1: "Claude 15% · 17%" instead of "Claude · 5h 15% · Week 17% · prompt rejection 0%".
 * Shows the first two usage windows; a rejection window only appears when it is above zero.
 * The full text stays in the tooltip and the accessible name, and the click opens the same
 * breakdown dialog as today.
 */
function compactUsageText(credential: CredentialLimitCredentialSummary): string {
  const usage = credential.windows.filter((w) => !w.windowType.includes('rejection'));
  const rejection = credential.windows.find((w) => w.windowType.includes('rejection'));
  const shown = usage.slice(0, 2).map((w) => formatUtilizationPercent(w.utilizationPercent));
  const parts = [`${credentialFamilyLabel(credential)} ${shown.join(' · ')}`];
  if (rejection && (rejection.utilizationPercent ?? 0) > 0) {
    parts.push(`${formatUtilizationPercent(rejection.utilizationPercent)} rejected`);
  }
  return parts.join(' · ');
}

function CompactUsageChip({
  credential,
  size,
}: Readonly<{ credential: CredentialLimitCredentialSummary; size: 'sm' | 'md' }>) {
  const current = credentialLimitSummaryAsOf(credential, Date.now());
  const full = credentialChipText(current);
  return (
    <button
      type="button"
      title={full}
      aria-label={`Usage limits: ${full}. Open details`}
      className={`${chipClassName({ size })} ${interactive}`}
    >
      <Gauge
        size={size === 'sm' ? 13 : 14}
        strokeWidth={1.75}
        aria-hidden="true"
        style={{ color: LEVEL_STYLES[current.level].color }}
      />
      <span className="truncate">{compactUsageText(current)}</span>
    </button>
  );
}

/** Idea 4: icon-only at zero, icon + count otherwise; amber text only when someone waits on you. */
function CompactCommentChip({ s, size }: Readonly<{ s: MockHeaderScenario; size: 'sm' | 'md' }>) {
  const attention = s.needsAttentionComments > 0;
  const text = attention
    ? `${s.needsAttentionComments} need${s.needsAttentionComments === 1 ? 's' : ''} you`
    : s.unresolvedComments > 0
      ? String(s.unresolvedComments)
      : null;
  return (
    <button
      type="button"
      title="Open comments"
      aria-label={
        s.unresolvedComments > 0 ? `${s.unresolvedComments} unresolved comments` : 'Comments'
      }
      className={`${chipClassName({ tone: attention ? 'warning' : 'neutral', size })} ${interactive} ${text ? '' : size === 'sm' ? '!px-[6px]' : '!px-[7px]'}`}
    >
      <MessageSquareQuote size={size === 'sm' ? 13 : 14} strokeWidth={1.75} aria-hidden="true" />
      {text}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function Title({
  text,
  className,
  lines,
}: Readonly<{ text: string; className: string; lines: 1 | 2 }>) {
  return (
    <div
      title={text}
      className={`min-w-0 flex-1 leading-snug font-semibold text-fg-primary ${className}`}
      style={
        lines === 1
          ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
          : {
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              overflowWrap: 'anywhere',
            }
      }
    >
      {text}
    </div>
  );
}

function People({ s, size }: Readonly<{ s: MockHeaderScenario; size: 20 | 26 }>) {
  return (
    <AvatarStack
      people={s.people}
      size={size}
      label={`People with access: ${s.people.map((p) => p.name).join(', ')}`}
      className="shrink-0"
    />
  );
}

function PortChip({ port, size }: Readonly<{ port: number; size: 'sm' | 'md' }>) {
  return (
    <span
      className={`${chipClassName({ tone: 'success', size })} transition-[filter] hover:brightness-110`}
    >
      <Globe size={size === 'sm' ? 13 : 14} strokeWidth={1.75} aria-hidden="true" />
      {port}
    </span>
  );
}

function WorkingOnChip({ s, size }: Readonly<{ s: MockHeaderScenario; size: 'sm' | 'md' }>) {
  if (!s.workingOn) return null;
  return (
    <span
      title={`${s.workingOn.verb}: ${s.workingOn.title}`}
      className={`${chipClassName({ tone: 'success', size })} !shrink transition-[filter] hover:brightness-110 sm:max-w-[22rem]`}
    >
      <Lightbulb
        size={size === 'sm' ? 13 : 14}
        strokeWidth={1.75}
        aria-hidden="true"
        className="shrink-0"
      />
      <span className="shrink-0">{s.workingOn.verb}</span>
      <span className="min-w-0 truncate">{s.workingOn.title}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function MeasuredSlab({
  children,
  onHeight,
}: Readonly<{ children: ReactNode; onHeight: (h: number) => void }>) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onHeight(Math.round(el.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onHeight]);
  return (
    <div
      ref={ref}
      data-testid="proto-header"
      className={`${paneClassName('slab')} flex flex-col overflow-hidden`}
    >
      {children}
    </div>
  );
}

export function SessionHeaderPrototype() {
  const [params, setParams] = useSearchParams();
  const width = Number(params.get('w')) || 960;
  const only = params.get('s');
  const [heights, setHeights] = useState<Record<string, number>>({});
  const record = useCallback((key: string, h: number) => {
    setHeights((prev) => (prev[key] === h ? prev : { ...prev, [key]: h }));
  }, []);
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;

  return (
    <div className="sam-void" style={{ height: '100vh', overflow: 'auto' }}>
      <div className="mx-auto flex flex-col gap-6 p-4 md:p-6" style={{ maxWidth: width + 220 }}>
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="m-0 text-lg font-semibold text-fg-primary">
              Session header — slimmer variants
            </h1>
            <p className="m-0 mt-1 text-sm text-fg-muted">
              Prototype. Same data in every row; the number is the header&apos;s measured height.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-fg-muted">
            Chat column
            {[960, 720].map((w) => (
              <button
                key={w}
                type="button"
                onClick={() =>
                  setParams((p) => {
                    p.set('w', String(w));
                    return p;
                  })
                }
                className={`${chipClassName({ size: 'sm', tone: w === width ? 'success' : 'neutral' })} ${interactive}`}
              >
                {w}px
              </button>
            ))}
          </div>
        </header>

        {scenarios.map((s) => {
          const base = heights[`${s.id}:current`];
          return (
            <section
              key={s.id}
              className={`${paneClassName('quiet')} flex flex-col gap-3 p-3 md:p-4`}
            >
              <div>
                <h2 className="m-0 text-sm font-semibold text-fg-primary">{s.name}</h2>
                <p className="m-0 text-xs text-fg-muted">{s.note}</p>
              </div>
              {VARIANTS.map((v) => {
                const key = `${s.id}:${v.id}`;
                const h = heights[key];
                const delta =
                  h !== undefined && base !== undefined && v.id !== 'current' ? h - base : null;
                return (
                  <div
                    key={v.id}
                    className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-4"
                  >
                    <div className="w-44 shrink-0 pt-1">
                      <div className="text-xs font-semibold text-fg-primary">{v.name}</div>
                      <div className="font-mono text-[11px] text-fg-muted">
                        {v.detail} · {h ?? '…'}px
                        {delta !== null && (
                          <span className={delta < 0 ? 'text-[var(--sam-status-success-fg)]' : ''}>
                            {' '}
                            ({delta > 0 ? '+' : ''}
                            {delta})
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1" style={{ maxWidth: width }}>
                      <MeasuredSlab onHeight={(hh) => record(key, hh)}>
                        {v.id === 'current' ? (
                          <CurrentHeader s={s} />
                        ) : (
                          <SlimHeader s={s} variant={v.id} />
                        )}
                      </MeasuredSlab>
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
