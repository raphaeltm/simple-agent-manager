import type { AgentProfile } from '@simple-agent-manager/shared';

import { ProfileAvatar } from './ProfileAvatar';
import { hasUsageReading, type ProfileUsage } from './usage';

const RING_SIZES = { sm: 'h-8 w-8', md: 'h-10 w-10' } as const;
const TRACK = 'color-mix(in srgb, var(--sam-color-fg-muted) 24%, transparent)';

/**
 * The profile glyph inside a fuel ring: the filled arc is what is left on the account
 * the profile runs on. With no reading (no usage yet, platform, paused, no account) the
 * glyph keeps the ring's footprint without a ring, so rows stay aligned and an unknown
 * is never drawn as full or empty. With no usage at all (the surface doesn't load it,
 * or it is still loading) it is the plain glyph. Decorative: the control around it
 * carries the usage in its accessible name.
 */
export function ProfileUsageAvatar({
  profile,
  usage,
  size = 'md',
}: Readonly<{
  profile: Pick<AgentProfile, 'agentType' | 'model'>;
  usage: ProfileUsage | undefined;
  size?: keyof typeof RING_SIZES;
}>) {
  if (!usage) return <ProfileAvatar profile={profile} size={size} />;
  const reading = hasUsageReading(usage);
  const degrees = Math.min(100, Math.max(0, usage.left ?? 0)) * 3.6;
  return (
    <span
      aria-hidden="true"
      data-testid={reading ? 'profile-usage-ring' : undefined}
      data-usage-left={reading ? (usage.left ?? undefined) : undefined}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${RING_SIZES[size]}`}
      style={
        reading
          ? { background: `conic-gradient(${usage.color} ${degrees}deg, ${TRACK} 0deg)` }
          : undefined
      }
    >
      {reading && <span className="absolute inset-[3px] rounded-full bg-page" />}
      <span className="relative inline-flex">
        <ProfileAvatar profile={profile} size="sm" />
      </span>
    </span>
  );
}
