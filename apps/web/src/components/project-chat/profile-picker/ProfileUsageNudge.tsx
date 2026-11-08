import type { AgentProfile } from '@simple-agent-manager/shared';

import { type ProfileUsage, roomierProfile } from './usage';

/**
 * One line above the composer when the chosen profile's account is nearly or fully used:
 * whose account, when it comes back, and a same-model profile on another account with
 * room. Nothing renders while there is room or no reading.
 */
export function ProfileUsageNudge({
  profile,
  usage,
  candidates,
  usageFor,
  onSwitch,
  disabled,
}: Readonly<{
  profile: AgentProfile;
  usage: ProfileUsage | undefined;
  /** Profiles the person could switch to (their visible ones). */
  candidates: readonly AgentProfile[];
  usageFor: (profileId: string) => ProfileUsage | undefined;
  onSwitch: (profileId: string) => void;
  disabled?: boolean;
}>) {
  if (usage?.state !== 'low' && usage?.state !== 'out') return null;
  const alternative = roomierProfile(profile, candidates, usageFor);
  const headline = usage.state === 'out' ? 'Out' : `${usage.left}% left`;
  const when = usage.resetIn
    ? `${usage.state === 'out' ? 'back' : 'resets'} in ${usage.resetIn}`
    : null;
  return (
    <div
      role="status"
      data-testid="profile-usage-nudge"
      className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg px-3 py-2 text-xs"
      style={{ background: `color-mix(in srgb, ${usage.color} 12%, transparent)` }}
    >
      <span className="min-w-0 flex-1 break-words text-fg-primary">
        <strong style={{ color: usage.color }}>{headline}</strong>
        {usage.accountLabel ? ` on ${usage.accountLabel}` : ''}
        {when ? ` · ${when}` : ''}
      </span>
      {alternative && (
        <button
          type="button"
          onClick={() => onSwitch(alternative.profile.id)}
          disabled={disabled}
          className="min-h-9 min-w-0 max-w-full shrink-0 truncate rounded-full border border-border-default bg-surface px-3 font-medium text-fg-primary transition-colors hover:border-accent/60 disabled:opacity-50"
        >
          {`Use ${alternative.profile.name} · ${alternative.usage.left}% left`}
        </button>
      )}
    </div>
  );
}
