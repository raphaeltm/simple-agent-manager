import type { AgentProfile } from '@simple-agent-manager/shared';
import { ChevronDown } from 'lucide-react';

import { profileSubtitle } from './model';
import { ProfileAvatar } from './ProfileAvatar';

/** The composer's single profile control: "To [avatar] Opus 5.5 Chat ⌄". Opens the picker. */
export function ProfileToControl({
  profile,
  loading,
  disabled,
  onOpen,
}: Readonly<{
  profile: AgentProfile | null;
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
          ? `To ${profile.name}, change profile`
          : loading
            ? 'To: loading profiles'
            : 'To: choose a profile'
      }
      className="flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-full border border-border-default bg-surface py-1 pl-3 pr-3 text-left transition-colors hover:border-accent/60 disabled:opacity-50"
    >
      <span className="text-xs text-fg-muted">To</span>
      {profile ? (
        <>
          <ProfileAvatar profile={profile} size="sm" />
          <span className="truncate text-sm font-medium text-fg-primary">{profile.name}</span>
          <span className="hidden truncate text-xs text-fg-muted md:inline">
            {profileSubtitle(profile)}
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
