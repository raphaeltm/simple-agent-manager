/**
 * PROTOTYPE ONLY. Usage round 2 (2026-11-13): the 5h window is primary.
 * Every variant draws the same eight account states so they compare like for like.
 *
 * Prior art: Claude's Settings > Usage (5h "Current session" bar above "Weekly limit" bars),
 * CodexBar / UsageBar (thick 5h bar over a thin weekly bar), Apple Activity rings (colour
 * is identity, never state), Apple Watch battery complication (arc = charge, red when low).
 */
import { ProfileAvatar } from '../../components/project-chat/profile-picker/ProfileAvatar';
import { ProfileUsageAvatar } from '../../components/project-chat/profile-picker/ProfileUsageAvatar';
import { type ProfileUsage, usageNotice } from '../../components/project-chat/profile-picker/usage';
import { OPUS_CHAT } from './mock-data';

const TRACK = 'color-mix(in srgb, var(--sam-color-fg-muted) 24%, transparent)';
const GREEN = 'var(--sam-status-success-fg)';
const AMBER = 'var(--sam-status-warning-fg)';
const RED = 'var(--sam-status-danger-fg)';

/** Raphaël's thresholds, on what is LEFT: >50 green, 25–50 amber, <25 red. */
export function health(left: number): string {
  if (left > 50) return GREEN;
  if (left >= 25) return AMBER;
  return RED;
}

export interface Scenario {
  id: string;
  name: string;
  /** Percent left on the 5h window; null when the account has no 5h window. */
  fiveHour: number | null;
  /** Percent left on the week. */
  week: number;
  fiveHourResets?: string;
  weekResets?: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'fresh',
    name: 'Plenty of both',
    fiveHour: 90,
    week: 80,
    fiveHourResets: '4h 10m',
    weekResets: '5d',
  },
  {
    id: '5h-low',
    name: '5h nearly gone, week fine',
    fiveHour: 12,
    week: 70,
    fiveHourResets: '52m',
    weekResets: '4d',
  },
  {
    id: 'week-low',
    name: '5h fresh, week nearly gone',
    fiveHour: 85,
    week: 18,
    fiveHourResets: '4h',
    weekResets: '1d 6h',
  },
  {
    id: 'both-mid',
    name: 'Both middling',
    fiveHour: 45,
    week: 35,
    fiveHourResets: '2h 5m',
    weekResets: '3d',
  },
  {
    id: '5h-out',
    name: '5h used up, week fine',
    fiveHour: 0,
    week: 60,
    fiveHourResets: '52m',
    weekResets: '4d',
  },
  {
    id: 'week-out',
    name: 'Week used up',
    fiveHour: 70,
    week: 0,
    fiveHourResets: '3h',
    weekResets: '2d 4h',
  },
  { id: 'weekly-only', name: 'Weekly-only account', fiveHour: null, week: 40, weekResets: '3d' },
  {
    id: 'weekly-only-low',
    name: 'Weekly-only, nearly gone',
    fiveHour: null,
    week: 6,
    weekResets: '2d 4h',
  },
];

// ---------------------------------------------------------------------------
// Words: the same for every new variant, 5h first, quiet while both are fine
// ---------------------------------------------------------------------------

export function scenarioWords(s: Scenario): { text: string; color: string }[] {
  const words: { text: string; color: string }[] = [];
  if (s.week <= 0) return [{ text: `Week used up · back in ${s.weekResets}`, color: RED }];
  if (s.fiveHour !== null) {
    if (s.fiveHour <= 0)
      words.push({ text: `5h used up · back in ${s.fiveHourResets}`, color: RED });
    else if (s.fiveHour <= 50)
      words.push({
        text: `5h ${s.fiveHour}% left · resets ${s.fiveHourResets}`,
        color: health(s.fiveHour),
      });
  }
  if (s.week <= 50)
    words.push({ text: `Week ${s.week}% left · resets ${s.weekResets}`, color: health(s.week) });
  return words;
}

// ---------------------------------------------------------------------------
// Ring primitive: an arc from twelve o'clock, with a dot that never disappears
// ---------------------------------------------------------------------------

function Ring({
  box,
  stroke,
  inset = 0,
  left,
  color,
  dot = true,
}: Readonly<{
  box: number;
  stroke: number;
  inset?: number;
  left: number;
  color: string;
  dot?: boolean;
}>) {
  const r = (box - stroke) / 2 - inset;
  const c = 2 * Math.PI * r;
  const fraction = Math.min(100, Math.max(0, left)) / 100;
  return (
    <>
      <circle cx={box / 2} cy={box / 2} r={r} fill="none" stroke={TRACK} strokeWidth={stroke} />
      {fraction > 0 ? (
        <circle
          cx={box / 2}
          cy={box / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${fraction * c} ${c}`}
        />
      ) : (
        // Empty is still a reading: a dot at twelve o'clock (the svg is rotated -90deg).
        dot && <circle cx={box / 2 + r} cy={box / 2} r={stroke / 2 + 0.75} fill={color} />
      )}
    </>
  );
}

const BOX = { sm: 32, md: 40 } as const;
type Size = keyof typeof BOX;

function Frame({
  size,
  children,
  extra,
}: Readonly<{ size: Size; children: React.ReactNode; extra?: React.ReactNode }>) {
  const box = BOX[size];
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: box, height: box }}
    >
      <svg width={box} height={box} className="absolute inset-0 -rotate-90" aria-hidden="true">
        {children}
      </svg>
      <ProfileAvatar profile={OPUS_CHAT} size="sm" />
      {extra}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export type Round2Variant = 'today' | 'raph' | 'pip' | 'hairline' | 'bar';

/** Today's production ring, fed the same scenario (one number: the tightest window). */
function TodayGlyph({ s, size }: Readonly<{ s: Scenario; size: Size }>) {
  const left = Math.min(s.fiveHour ?? 100, s.week);
  const binding = (s.fiveHour ?? 100) <= s.week ? s.fiveHourResets : s.weekResets;
  const usage: ProfileUsage = {
    state: left <= 0 ? 'out' : left <= 25 ? 'low' : 'ok',
    left,
    color:
      left <= 0 ? RED : left <= 10 ? 'var(--sam-status-critical-fg)' : left <= 25 ? AMBER : GREEN,
    resetIn: binding ?? null,
    accountLabel: 'Personal Pro',
    accountKey: 'k',
  };
  return <ProfileUsageAvatar profile={OPUS_CHAT} usage={usage} size={size} />;
}

/** Yours: arc = 5h left, colour = the week's health. No 5h window: arc = week. */
function RaphGlyph({ s, size }: Readonly<{ s: Scenario; size: Size }>) {
  const arc = s.week <= 0 ? 0 : (s.fiveHour ?? s.week);
  return (
    <Frame size={size}>
      <Ring box={BOX[size]} stroke={3} left={arc} color={health(s.week)} />
    </Frame>
  );
}

/** Ring = 5h in its own health colour; a pip at the corner is the week's health. */
function PipGlyph({ s, size }: Readonly<{ s: Scenario; size: Size }>) {
  const arc = s.week <= 0 ? 0 : (s.fiveHour ?? s.week);
  const ringColor = s.week <= 0 ? RED : health(s.fiveHour ?? s.week);
  const pip = size === 'md' ? 10 : 9;
  return (
    <Frame
      size={size}
      extra={
        <span
          className="absolute rounded-full shadow-[0_0_0_2px_var(--sam-separator)]"
          style={{ width: pip, height: pip, right: -1, bottom: -1, background: health(s.week) }}
        />
      }
    >
      <Ring box={BOX[size]} stroke={3} left={arc} color={ringColor} />
    </Frame>
  );
}

/** Thick ring = 5h, hairline inside it = week; each in its own health colour. */
function HairlineGlyph({ s, size }: Readonly<{ s: Scenario; size: Size }>) {
  const box = BOX[size];
  const arc = s.week <= 0 ? 0 : (s.fiveHour ?? s.week);
  return (
    <Frame size={size}>
      <Ring
        box={box}
        stroke={3}
        left={arc}
        color={s.week <= 0 ? RED : health(s.fiveHour ?? s.week)}
      />
      {s.fiveHour !== null && (
        <Ring
          box={box}
          stroke={1.5}
          inset={3.25}
          left={s.week}
          color={health(s.week)}
          dot={s.week > 0}
        />
      )}
    </Frame>
  );
}

/** CodexBar-style: ring = 5h, a thin bar under the glyph = week. */
function BarGlyph({ s, size }: Readonly<{ s: Scenario; size: Size }>) {
  const box = BOX[size];
  const arc = s.week <= 0 ? 0 : (s.fiveHour ?? s.week);
  return (
    <span className="inline-flex shrink-0 flex-col items-center gap-[3px]">
      <Frame size={size}>
        <Ring
          box={box}
          stroke={3}
          left={arc}
          color={s.week <= 0 ? RED : health(s.fiveHour ?? s.week)}
        />
      </Frame>
      {s.fiveHour !== null && (
        <span
          className="relative h-[3px] overflow-hidden rounded-full"
          style={{ width: box - 10, background: TRACK }}
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${Math.max(s.week, 8)}%`, background: health(s.week) }}
          />
        </span>
      )}
    </span>
  );
}

export function Round2Glyph({
  variant,
  s,
  size,
}: Readonly<{ variant: Round2Variant; s: Scenario; size: Size }>) {
  switch (variant) {
    case 'today':
      return <TodayGlyph s={s} size={size} />;
    case 'raph':
      return <RaphGlyph s={s} size={size} />;
    case 'pip':
      return <PipGlyph s={s} size={size} />;
    case 'hairline':
      return <HairlineGlyph s={s} size={size} />;
    case 'bar':
      return <BarGlyph s={s} size={size} />;
  }
}

function TodayWords({ s }: Readonly<{ s: Scenario }>) {
  const left = Math.min(s.fiveHour ?? 100, s.week);
  const binding = (s.fiveHour ?? 100) <= s.week ? s.fiveHourResets : s.weekResets;
  const notice = usageNotice({
    state: left <= 0 ? 'out' : left <= 25 ? 'low' : 'ok',
    left,
    color: '',
    resetIn: binding ?? null,
    accountLabel: null,
    accountKey: null,
  });
  return notice ? <span className="text-[11px] text-fg-secondary">{notice}</span> : null;
}

/** One card's column: the composer chip, then every scenario as a picker-sized row. */
export function Round2Column({ variant }: Readonly<{ variant: Round2Variant }>) {
  const composer = SCENARIOS[1]; // 5h nearly gone
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5 p-1.5">
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-2">
        <span className="flex min-h-11 min-w-0 items-center gap-2 rounded-full border border-border-default bg-surface py-1 pr-3 pl-3">
          <span className="text-xs text-fg-muted">To</span>
          {composer && <Round2Glyph variant={variant} s={composer} size="sm" />}
          <span className="truncate text-sm font-medium text-fg-primary">Opus Chat</span>
        </span>
      </div>
      {SCENARIOS.map((s) => {
        const words = scenarioWords(s);
        return (
          <div
            key={s.id}
            data-scenario={s.id}
            className="flex min-h-[56px] min-w-0 items-center gap-3 rounded-lg px-2 py-1.5"
          >
            <Round2Glyph variant={variant} s={s} size="md" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-fg-primary">{s.name}</span>
              <span className="block font-mono text-[10.5px] text-fg-muted">
                {s.fiveHour === null ? 'no 5h' : `5h ${s.fiveHour}%`} · wk {s.week}%
              </span>
              {variant === 'today' ? (
                <TodayWords s={s} />
              ) : (
                words.map((w) => (
                  <span
                    key={w.text}
                    className="block text-[11px] font-medium"
                    style={{ color: w.color }}
                  >
                    {w.text}
                  </span>
                ))
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
