import type { AgentProfile } from '@simple-agent-manager/shared';

import { ProfileAvatar } from './ProfileAvatar';
import { hasUsageReading, type ProfileUsage, ringLeft } from './usage';

/** Outer box (px) per size; the ring's stroke sits inside it, around the small glyph. */
const RING_BOX = { sm: 32, md: 40 } as const;
const STROKE = 3;
const TRACK = 'color-mix(in srgb, var(--sam-color-fg-muted) 24%, transparent)';

/**
 * The profile glyph inside a usage ring (approved 2026-11-13). The arc is what is left of
 * the session window (5h), drawn from twelve o'clock with round ends; the colour is the
 * week's health (green above half, amber to a quarter, red below). An empty arc still shows a
 * dot, so "nothing left this session" never looks like "no reading". A weekly-only account
 * draws the week. With no reading, or while usage loads (`null`), the glyph keeps the
 * ring's footprint without an arc, so rows stay aligned; where a surface doesn't load usage
 * at all (`undefined`) it is the plain glyph. Decorative: the control around it carries the
 * usage in its accessible name.
 */
export function ProfileUsageAvatar({
  profile,
  usage,
  size = 'md',
}: Readonly<{
  profile: Pick<AgentProfile, 'agentType' | 'model'>;
  usage: ProfileUsage | null | undefined;
  size?: keyof typeof RING_BOX;
}>) {
  if (usage === undefined) return <ProfileAvatar profile={profile} size={size} />;
  const box = RING_BOX[size];
  const reading = hasUsageReading(usage) ? usage : null;
  const radius = (box - STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const left = reading ? ringLeft(reading) : 0;
  const fraction = Math.min(100, Math.max(0, left)) / 100;
  return (
    <span
      aria-hidden="true"
      data-testid={reading ? 'profile-usage-ring' : undefined}
      data-usage-left={reading ? left : undefined}
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: box, height: box }}
    >
      {reading && (
        <svg
          width={box}
          height={box}
          viewBox={`0 0 ${box} ${box}`}
          className="absolute inset-0 -rotate-90"
        >
          <circle
            cx={box / 2}
            cy={box / 2}
            r={radius}
            fill="none"
            stroke={TRACK}
            strokeWidth={STROKE}
          />
          {fraction > 0 ? (
            <circle
              cx={box / 2}
              cy={box / 2}
              r={radius}
              fill="none"
              stroke={reading.color}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${fraction * circumference} ${circumference}`}
            />
          ) : (
            // Twelve o'clock: the svg is rotated -90deg, so the arc's start is (cx + r, cy).
            <circle
              data-testid="profile-usage-ring-empty"
              cx={box / 2 + radius}
              cy={box / 2}
              r={STROKE / 2 + 0.75}
              fill={reading.color}
            />
          )}
        </svg>
      )}
      <span className="relative inline-flex">
        <ProfileAvatar profile={profile} size="sm" />
      </span>
    </span>
  );
}
