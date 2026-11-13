/**
 * PROTOTYPE ONLY. Ways to show which usage window (5h, week, Opus week) a reading is about.
 * "Today" uses the real ProfileToControl and ProfilePickerRow.
 */
import { Check, ChevronDown } from 'lucide-react';

import { profileSubtitle } from '../../components/project-chat/profile-picker/model';
import { ProfileAvatar } from '../../components/project-chat/profile-picker/ProfileAvatar';
import { ProfilePickerRow } from '../../components/project-chat/profile-picker/ProfilePickerRows';
import { ProfileToControl } from '../../components/project-chat/profile-picker/ProfileToControl';
import {
  accountById,
  bindingWindow,
  formatIn,
  type MockAccount,
  type MockProfile,
  type MockWindow,
  PROFILES,
  toProfileUsage,
  windowColor,
} from './mock-data';

export type UsageVariant = 'tag' | 'twin' | 'meters';

const TRACK = 'color-mix(in srgb, var(--sam-color-fg-muted) 24%, transparent)';
const noop = () => undefined;

const left = (window: MockWindow) => Math.max(0, 100 - window.usedPercent);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Arc({
  box,
  radius,
  stroke,
  window,
  dashed,
}: Readonly<{
  box: number;
  radius: number;
  stroke: number;
  window?: MockWindow;
  dashed?: boolean;
}>) {
  const circumference = 2 * Math.PI * radius;
  const fraction = window ? left(window) / 100 : 0;
  return (
    <>
      <circle
        cx={box / 2}
        cy={box / 2}
        r={radius}
        fill="none"
        stroke={TRACK}
        strokeWidth={stroke}
        strokeDasharray={dashed ? '2 3' : undefined}
      />
      {window && fraction > 0 && (
        <circle
          cx={box / 2}
          cy={box / 2}
          r={radius}
          fill="none"
          stroke={windowColor(window.usedPercent)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${fraction * circumference} ${circumference}`}
        />
      )}
    </>
  );
}

/** A: today's ring, plus a mono tag naming the window the arc measures. */
function TaggedRing({ profile, account, size }: Readonly<RingProps>) {
  const box = size === 'md' ? 40 : 32;
  const binding = bindingWindow(account);
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: box, height: box }}
    >
      <svg width={box} height={box} className="absolute inset-0 -rotate-90">
        <Arc box={box} radius={(box - 3) / 2} stroke={3} window={binding} />
      </svg>
      <ProfileAvatar profile={profile} size="sm" />
      <span
        className="absolute -right-1.5 -bottom-1 rounded-[5px] bg-[var(--sam-chip-bg)] px-[3px] font-mono text-[8.5px] leading-[12px] font-semibold uppercase shadow-[0_0_0_1.5px_var(--sam-separator)]"
        style={{ color: windowColor(binding.usedPercent) }}
      >
        {binding.short}
      </span>
    </span>
  );
}

/** B: outer ring is the short (5h) window, inner ring the week; a missing window is dashed. */
function TwinRing({ profile, account, size }: Readonly<RingProps>) {
  const box = size === 'md' ? 42 : 34;
  const short = account.windows.find((window) => window.short === '5h');
  const long = account.windows.find((window) => window.short === 'Wk');
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: box, height: box }}
    >
      <svg width={box} height={box} className="absolute inset-0 -rotate-90">
        <Arc box={box} radius={(box - 3) / 2} stroke={3} window={short} dashed={!short} />
        <Arc box={box} radius={(box - 3) / 2 - 4} stroke={2.5} window={long} dashed={!long} />
      </svg>
      <span className="scale-[0.8]">
        <ProfileAvatar profile={profile} size="sm" />
      </span>
    </span>
  );
}

interface RingProps {
  profile: MockProfile;
  account: MockAccount;
  size: 'sm' | 'md';
}

/** C: one labelled bar per window, in "left", worst first is not reordered (5h, Wk, Opus). */
export function WindowMeters({
  account,
  compact = false,
}: Readonly<{ account: MockAccount; compact?: boolean }>) {
  return (
    <span
      className={`flex min-w-0 flex-wrap items-center ${compact ? 'gap-x-2' : 'gap-x-2.5'} gap-y-0.5 text-[11px]`}
    >
      {account.windows.map((window) => {
        const color = windowColor(window.usedPercent);
        const calm = window.usedPercent < 75;
        return (
          <span
            key={window.label}
            className="inline-flex items-center gap-1 whitespace-nowrap"
            title={`${window.label}: ${left(window)}% left, resets in ${formatIn(window.resetsAt)}`}
          >
            <span className="text-fg-muted">{window.short}</span>
            <span
              aria-hidden="true"
              className="relative inline-block h-[4px] w-6 overflow-hidden rounded-full"
              style={{ background: TRACK }}
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${left(window)}%`, background: color }}
              />
            </span>
            <span className="font-mono tabular-nums" style={calm ? undefined : { color }}>
              {left(window)}%
            </span>
          </span>
        );
      })}
    </span>
  );
}

function Glyph({
  variant,
  profile,
  account,
  size,
}: Readonly<RingProps & { variant: UsageVariant }>) {
  if (variant === 'tag') return <TaggedRing profile={profile} account={account} size={size} />;
  if (variant === 'twin') return <TwinRing profile={profile} account={account} size={size} />;
  return <ProfileAvatar profile={profile} size={size === 'md' ? 'md' : 'sm'} />;
}

/**
 * The words: always name the window once a limit matters. `headline` is for the nudge
 * ("Weekly limit · 6% left"); `primary`/`secondary` fit a picker row ("6% left" over
 * "week · resets 2d 4h").
 */
export function windowWords(
  account: MockAccount
): { headline: string; primary: string; secondary: string; when: string; color: string } | null {
  const binding = bindingWindow(account);
  const remaining = left(binding);
  if (binding.usedPercent < 75) return null;
  const limit = binding.label === 'Week' ? 'Weekly limit' : `${binding.label} limit`;
  const short = binding.label === 'Week' ? 'week' : binding.label;
  const when = formatIn(binding.resetsAt);
  return remaining <= 0
    ? {
        when,
        headline: `${limit} used up`,
        primary: 'Out',
        secondary: `${short} · back in ${when}`,
        color: windowColor(100),
      }
    : {
        when,
        headline: `${limit} · ${remaining}% left`,
        primary: `${remaining}% left`,
        secondary: `${short} · resets ${when}`,
        color: windowColor(binding.usedPercent),
      };
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function ToControlVariant({
  profile,
  variant,
  accountId,
}: Readonly<{ profile: MockProfile; variant: UsageVariant | 'today'; accountId?: string }>) {
  // The ring follows the account this run will use, which an override can change.
  const account = accountById(accountId ?? profile.accountId);
  if (variant === 'today') {
    return (
      <ProfileToControl
        profile={profile}
        usage={toProfileUsage(account)}
        loading={false}
        disabled={false}
        onOpen={noop}
      />
    );
  }
  const binding = bindingWindow(account);
  return (
    <span className="flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-full border border-border-default bg-surface py-1 pr-3 pl-3">
      <span className="text-xs text-fg-muted">To</span>
      <Glyph variant={variant} profile={profile} account={account} size="sm" />
      <span className="truncate text-sm font-medium text-fg-primary">{profile.name}</span>
      {variant === 'meters' && (
        // The toolbar has room for one reading: the window that stops this account first.
        <span
          className="hidden shrink-0 font-mono text-[11px] @[22rem]:inline"
          style={{ color: windowColor(binding.usedPercent) }}
        >
          {binding.short} {left(binding)}%
        </span>
      )}
      <ChevronDown size={15} className="shrink-0 text-fg-muted" aria-hidden="true" />
    </span>
  );
}

function PickerRowVariant({
  profile,
  variant,
  selected,
}: Readonly<{ profile: MockProfile; variant: UsageVariant; selected: boolean }>) {
  const account = accountById(profile.accountId);
  const words = windowWords(account);
  return (
    <div
      className={`mx-2 flex min-h-[52px] items-center gap-3 rounded-lg px-2 py-2 ${selected ? 'bg-accent/10' : ''}`}
    >
      <Glyph variant={variant} profile={profile} account={account} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg-primary">{profile.name}</span>
        {variant === 'meters' ? (
          <span className="mt-0.5 block">
            <span className="block truncate text-xs text-fg-muted">
              {profileSubtitle(profile)} · {account.name}
            </span>
            <span className="mt-0.5 block">
              <WindowMeters account={account} />
            </span>
          </span>
        ) : (
          <span className="block truncate text-xs text-fg-muted">{profileSubtitle(profile)}</span>
        )}
      </span>
      {words && variant !== 'meters' && (
        <span className="flex max-w-[45%] shrink-0 flex-col items-end text-right text-[11px] leading-tight">
          <span className="font-medium" style={{ color: words.color }}>
            {words.primary}
          </span>
          <span className="text-fg-muted">{words.secondary}</span>
        </span>
      )}
      {selected && <Check size={16} className="shrink-0 text-accent" aria-hidden="true" />}
    </div>
  );
}

export function PickerList({ variant }: Readonly<{ variant: UsageVariant | 'today' }>) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5 py-1">
      {PROFILES.map((profile) =>
        variant === 'today' ? (
          <ProfilePickerRow
            key={profile.id}
            profile={profile}
            usage={toProfileUsage(accountById(profile.accountId))}
            selected={profile.id === 'p-opus-personal'}
            hidden={false}
            editing={false}
            busy={false}
            onSelect={noop}
            onToggleHidden={noop}
          />
        ) : (
          <PickerRowVariant
            key={profile.id}
            profile={profile}
            variant={variant}
            selected={profile.id === 'p-opus-personal'}
          />
        )
      )}
    </div>
  );
}

/** Legend only B needs: proof that it has to be learned. */
export function TwinLegend() {
  return (
    <p className="m-0 px-4 pb-2 text-[11px] text-fg-muted">
      Outer ring = 5h window, inner ring = week. Dashed = the account has no such limit.
    </p>
  );
}
