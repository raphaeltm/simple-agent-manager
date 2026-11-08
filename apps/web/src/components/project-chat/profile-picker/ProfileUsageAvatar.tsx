import type { AgentProfile } from '@simple-agent-manager/shared';

import { ProfileAvatar } from './ProfileAvatar';
import { hasUsageReading, type ProfileUsage } from './usage';

/** Outer box (px) per size; the ring's stroke sits inside it, around the small glyph. */
const RING_BOX = { sm: 32, md: 40 } as const;
const STROKE = 3;
const TRACK = 'color-mix(in srgb, var(--sam-color-fg-muted) 24%, transparent)';

/**
 * The profile glyph inside a fuel ring: the arc is what is left on the account the
 * profile runs on, drawn from twelve o'clock with round ends so a small remainder reads
 * as a short arc. With no reading (no usage yet, platform, paused, no account), or while
 * usage is loading (`null`), the glyph keeps the ring's footprint without an arc, so rows
 * stay aligned and nothing jumps when usage arrives. Where a surface doesn't load usage
 * at all (`undefined`) it is the plain glyph. Decorative: the control around it carries
 * the usage in its accessible name.
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
  const fraction = reading ? Math.min(100, Math.max(0, reading.left ?? 0)) / 100 : 0;
  return (
    <span
      aria-hidden="true"
      data-testid={reading ? 'profile-usage-ring' : undefined}
      data-usage-left={reading?.left ?? undefined}
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
          {fraction > 0 && (
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
          )}
        </svg>
      )}
      <span className="relative inline-flex">
        <ProfileAvatar profile={profile} size="sm" />
      </span>
    </span>
  );
}
