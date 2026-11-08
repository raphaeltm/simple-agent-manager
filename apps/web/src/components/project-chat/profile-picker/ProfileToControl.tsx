import type { AgentProfile } from '@simple-agent-manager/shared';
import { ChevronDown } from 'lucide-react';

import type { ChatAgentDefaults } from './agent-overrides';
import { profileSubtitle } from './model';
import { ProfileUsageAvatar } from './ProfileUsageAvatar';
import { type ProfileUsage, usageSpoken } from './usage';

/** The composer's single profile control: "To [avatar] Opus 5.5 Chat ⌄". Opens the picker. */
export function ProfileToControl({
  profile,
  effective,
  usage,
  loading,
  disabled,
  onOpen,
}: Readonly<{
  profile: AgentProfile | null;
  /** What this chat will launch with (skill and Chat options applied), in place of the profile's. */
  effective?: Readonly<ChatAgentDefaults>;
  /** What's left on the account this chat will run on; omitted when it doesn't apply. */
  usage?: ProfileUsage;
  loading: boolean;
  disabled: boolean;
  onOpen: (anchor: DOMRect) => void;
}>) {
  return (
    <button
      type="button"
      onClick={(event) => onOpen(event.currentTarget.getBoundingClientRect())}
      disabled={disabled}
      aria-haspopup="dialog"
      // Adjacent spans would read as "ToOpus…"; keep the visible text first (WCAG 2.5.3).
      aria-label={
        profile
          ? `To ${[profile.name, usageSpoken(usage)].filter(Boolean).join(', ')}, change profile`
          : loading
            ? 'To: loading profiles'
            : 'To: choose a profile'
      }
      className="flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-full border border-border-default bg-surface py-1 pl-3 pr-3 text-left transition-colors hover:border-accent/60 disabled:opacity-50"
    >
      {/* In a very narrow chat area the name needs the room more than the label does. */}
      <span className="hidden text-xs text-fg-muted @[10rem]:inline">To</span>
      {profile ? (
        <>
          <ProfileUsageAvatar profile={profile} usage={usage} size="sm" />
          <span className="truncate text-sm font-medium text-fg-primary">{profile.name}</span>
          {/* Needs an `@container` ancestor; shown only when the toolbar has room for it. */}
          <span className="hidden truncate text-xs text-fg-muted @md:inline">
            {profileSubtitle(
              effective?.agentType ? { ...effective, agentType: effective.agentType } : profile
            )}
          </span>
        </>
      ) : (
        <span className="truncate text-sm text-fg-muted">
          {loading ? 'Loading profiles…' : 'Choose a profile'}
        </span>
      )}
      <ChevronDown size={15} className="shrink-0 text-fg-muted" aria-hidden="true" />
    </button>
  );
}
