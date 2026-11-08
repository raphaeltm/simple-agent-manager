/**
 * The three directions, each applied to the three places a profile is picked:
 * the new-chat cards, the "Start with…" sheet rows and the composer's To chip.
 * Card, row and chip markup copies the production components' classes
 * (NewChatProfileCards, ProfilePickerRows, ProfileToControl) so only the usage differs.
 */
import type { AgentProfile, CredentialLimitWindowSummary } from '@simple-agent-manager/shared';
import {
  credentialLimitSummaryAsOf,
  credentialLimitWindowLabel,
} from '@simple-agent-manager/shared';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ProfileBudget } from '../../components/agent-profiles/useProfileBudgets';
import { LEVEL_STYLES } from '../../components/credential-limits/credential-limit-format';
import { profileSubtitle } from '../../components/project-chat/profile-picker';
import { ProfileAvatar } from '../../components/project-chat/profile-picker/ProfileAvatar';
import type { ProfileUsage } from './usage-model';
import { usageWords } from './usage-model';

export type Direction = 'words' | 'meters' | 'rings';

interface ItemProps {
  profile: AgentProfile;
  usage: ProfileUsage;
  budget: ProfileBudget | undefined;
  now: number;
  selected: boolean;
  onSelect: () => void;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function Dot({ color }: Readonly<{ color: string }>) {
  return (
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
    />
  );
}

/** Avatar inside a ring whose filled arc is what is left. */
function RingAvatar({
  profile,
  usage,
  size = 'md',
}: Readonly<{ profile: AgentProfile; usage: ProfileUsage; size?: 'sm' | 'md' }>) {
  const outer = size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
  const left = usage.left ?? 0;
  const known = usage.left !== null;
  const track = 'color-mix(in srgb, var(--sam-color-fg-muted) 22%, transparent)';
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${outer}`}
      style={{
        background: known
          ? `conic-gradient(${usage.color} ${left * 3.6}deg, ${track} 0deg)`
          : `repeating-conic-gradient(${track} 0deg 10deg, transparent 10deg 20deg)`,
      }}
    >
      <span className="absolute inset-[3px] rounded-full bg-page" />
      <span className="relative">
        <ProfileAvatar profile={profile} size="sm" />
      </span>
    </span>
  );
}

function shortLabel(window: CredentialLimitWindowSummary): string {
  const label = credentialLimitWindowLabel(window.windowType, window.windowMinutes);
  return ({ Week: 'Wk', Month: 'Mo' } as Record<string, string>)[label] ?? label;
}

/** The profile list's micro meters, without the button (cards are buttons already). */
function MicroMeters({ budget, now }: Readonly<{ budget: ProfileBudget | undefined; now: number }>) {
  if (budget?.kind !== 'account' || !budget.usage) return null;
  const current = credentialLimitSummaryAsOf(budget.usage, now);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-fg-primary">
      {current.windows.map((window) => {
        const color = LEVEL_STYLES[window.level].color;
        const pct = window.utilizationPercent;
        return (
          <span key={window.windowType} className="inline-flex items-center gap-1 whitespace-nowrap">
            <span className="text-fg-muted">{shortLabel(window)}</span>
            <span className="relative inline-block h-[3px] w-5 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--sam-color-fg-muted)_28%,transparent)]">
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${Math.min(100, pct ?? 0)}%`, background: color }}
              />
            </span>
            <span className="tabular-nums" style={window.level === 'ok' ? undefined : { color }}>
              {pct === null ? '—' : `${Math.round(pct)}%`}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function QuietState({ usage }: Readonly<{ usage: ProfileUsage }>) {
  return (
    <span
      className={`truncate text-[11px] ${usage.state === 'paused' ? 'text-warning-fg' : 'text-fg-muted'}`}
    >
      {usage.state === 'unknown' && usage.accountLabel
        ? `${usage.accountLabel} · no usage yet`
        : usageWords(usage)}
    </span>
  );
}

const hasNumbers = (usage: ProfileUsage) =>
  usage.state === 'ok' || usage.state === 'low' || usage.state === 'out';

// ---------------------------------------------------------------------------
// A — Words: one plain line, "83% left · Sam Sam"
// ---------------------------------------------------------------------------

function WordsLine({ usage }: Readonly<{ usage: ProfileUsage }>) {
  if (!hasNumbers(usage)) return <QuietState usage={usage} />;
  const calm = usage.state === 'ok';
  const tail =
    usage.state === 'out'
      ? usage.accountLabel
      : calm
        ? usage.accountLabel
        : usage.resetIn
          ? `resets ${usage.resetIn}`
          : usage.accountLabel;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
      <Dot color={usage.color} />
      <span
        className="shrink-0 font-semibold tabular-nums"
        style={calm ? { color: 'var(--sam-color-fg-primary)' } : { color: usage.color }}
      >
        {usageWords(usage)}
      </span>
      {tail && <span className="truncate text-fg-muted">· {tail}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function CardShell({
  profile,
  selected,
  onSelect,
  avatar,
  dim,
  children,
}: Readonly<{
  profile: AgentProfile;
  selected: boolean;
  onSelect: () => void;
  avatar: ReactNode;
  dim?: boolean;
  children?: ReactNode;
}>) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative flex min-h-[76px] min-w-0 flex-col gap-1 rounded-xl border p-3 text-left transition-colors ${
        selected
          ? 'border-accent bg-accent/15 ring-1 ring-accent'
          : 'border-border-default bg-surface hover:border-accent/50'
      } ${dim ? 'opacity-70' : ''}`}
    >
      <span className={`flex min-w-0 items-center gap-2 ${selected ? 'pr-4' : ''}`}>
        {avatar}
        <span className="line-clamp-2 break-words text-sm font-semibold leading-tight text-fg-primary">
          {profile.name}
        </span>
      </span>
      {selected && (
        <Check size={15} className="absolute right-2.5 top-2.5 text-accent" aria-hidden="true" />
      )}
      {profile.description && (
        <span className="line-clamp-2 break-words text-xs leading-snug text-fg-secondary">
          {profile.description}
        </span>
      )}
      <span className="truncate text-[11px] text-fg-muted">{profileSubtitle(profile)}</span>
      {children}
    </button>
  );
}

export function UsageCard({ direction, ...props }: Readonly<ItemProps & { direction: Direction }>) {
  const { profile, usage, budget, now } = props;
  if (direction === 'words') {
    return (
      <CardShell {...props} avatar={<ProfileAvatar profile={profile} size="sm" />}>
        <span className="mt-auto border-t border-[var(--sam-hairline)] pt-1.5">
          <WordsLine usage={usage} />
        </span>
      </CardShell>
    );
  }
  if (direction === 'meters') {
    return (
      <CardShell {...props} avatar={<ProfileAvatar profile={profile} size="sm" />}>
        <span className="mt-auto flex min-w-0 items-center gap-2 pt-0.5">
          {hasNumbers(usage) ? (
            <>
              <Dot color={usage.color} />
              <MicroMeters budget={budget} now={now} />
            </>
          ) : (
            <QuietState usage={usage} />
          )}
        </span>
      </CardShell>
    );
  }
  // Rings: the number only appears when it matters.
  const loud = usage.state === 'low' || usage.state === 'out';
  return (
    <CardShell
      {...props}
      dim={usage.state === 'out'}
      avatar={<RingAvatar profile={profile} usage={usage} />}
    >
      {loud && (
        <span className="truncate text-[11px] font-medium" style={{ color: usage.color }}>
          {usage.state === 'out'
            ? `Out · back in ${usage.resetIn ?? 'a while'}`
            : `${usage.left}% left · resets ${usage.resetIn ?? 'soon'}`}
        </span>
      )}
      {(usage.state === 'none' || usage.state === 'paused') && <QuietState usage={usage} />}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Sheet rows
// ---------------------------------------------------------------------------

export function UsageRow({ direction, ...props }: Readonly<ItemProps & { direction: Direction }>) {
  const { profile, usage, budget, now, selected, onSelect } = props;
  const avatar =
    direction === 'rings' ? (
      <RingAvatar profile={profile} usage={usage} />
    ) : (
      <ProfileAvatar profile={profile} />
    );

  let trailing: ReactNode = null;
  let below: ReactNode = null;
  if (direction === 'words') {
    trailing = hasNumbers(usage) ? (
      <span className="flex shrink-0 flex-col items-end leading-tight">
        <span
          className="text-sm font-semibold tabular-nums"
          style={{ color: usage.state === 'ok' ? 'var(--sam-color-fg-primary)' : usage.color }}
        >
          {usage.state === 'out' ? 'Out' : `${usage.left}%`}
        </span>
        <span className="text-[10px] text-fg-muted">
          {usage.state === 'out' ? (usage.resetIn ?? '') : 'left'}
        </span>
      </span>
    ) : (
      <span className="shrink-0 text-[10px] text-fg-muted">
        {usage.state === 'unknown' ? 'no data' : usage.state === 'none' ? 'no account' : usage.state === 'paused' ? 'paused' : 'SAM'}
      </span>
    );
  } else if (direction === 'meters') {
    below = (
      <span className="mt-1 flex min-w-0 items-center gap-2">
        {hasNumbers(usage) ? (
          <>
            <Dot color={usage.color} />
            <MicroMeters budget={budget} now={now} />
          </>
        ) : (
          <QuietState usage={usage} />
        )}
      </span>
    );
  } else if (usage.state === 'paused' || usage.state === 'none') {
    trailing = (
      <span className={`shrink-0 text-[11px] ${usage.state === 'paused' ? 'text-warning-fg' : 'text-fg-muted'}`}>
        {usage.state === 'paused' ? 'paused' : 'no account'}
      </span>
    );
  } else if (usage.state === 'out' || usage.state === 'low') {
    trailing = (
      <span className="shrink-0 text-right text-[11px] font-medium leading-tight" style={{ color: usage.color }}>
        {usage.state === 'out' ? (
          <>
            Out
            <br />
            <span className="font-normal text-fg-muted">back {usage.resetIn}</span>
          </>
        ) : (
          `${usage.left}% left`
        )}
      </span>
    );
  }

  return (
    <div className={`mx-2 flex items-center gap-1 rounded-lg ${selected ? 'bg-accent/10' : 'hover:bg-surface'}`}>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex min-h-[52px] min-w-0 flex-1 items-center gap-3 bg-transparent px-2 py-2 text-left ${
          direction === 'rings' && usage.state === 'out' ? 'opacity-70' : ''
        }`}
      >
        {avatar}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg-primary">{profile.name}</span>
          <span className="block truncate text-xs text-fg-muted">{profileSubtitle(profile)}</span>
          {below}
        </span>
        {trailing}
        {selected && <Check size={16} className="shrink-0 text-accent" aria-hidden="true" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer To chip
// ---------------------------------------------------------------------------

export function UsageToChip({
  direction,
  profile,
  usage,
  onOpen,
}: Readonly<{ direction: Direction; profile: AgentProfile; usage: ProfileUsage; onOpen: () => void }>) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`To ${profile.name}, ${usageWords(usage)}, change profile`}
      className="flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-full border border-border-default bg-surface py-1 pl-3 pr-3 text-left transition-colors hover:border-accent/60"
    >
      <span className="text-xs text-fg-muted">To</span>
      {direction === 'rings' ? (
        <RingAvatar profile={profile} usage={usage} size="sm" />
      ) : (
        <ProfileAvatar profile={profile} size="sm" />
      )}
      <span className="truncate text-sm font-medium text-fg-primary">{profile.name}</span>
      {direction === 'words' && hasNumbers(usage) && (
        <span
          className="shrink-0 text-xs font-semibold tabular-nums"
          style={{ color: usage.state === 'ok' ? 'var(--sam-color-fg-muted)' : usage.color }}
        >
          {usage.state === 'out' ? 'Out' : `${usage.left}%`}
        </span>
      )}
      <ChevronDown size={15} className="shrink-0 text-fg-muted" aria-hidden="true" />
    </button>
  );
}
