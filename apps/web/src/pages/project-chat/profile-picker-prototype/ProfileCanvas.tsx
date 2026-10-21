/** PROTOTYPE — new-chat profile picker directions. Do not merge to main. */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { useIsMobile } from '../../../hooks/useIsMobile';
import { useProfileUsage } from './hooks';
import { isBuildProfile, profileSubtitle, recentProfiles } from './model';
import { ProfileAvatar } from './ProfileAvatar';
import { ProfileSheet } from './ProfileSheet';

const GENERIC_DESCRIPTION = 'Chat and explore with a lightweight workspace';

/**
 * Direction C shows each profile's "Good for" line. A real version stores it on the
 * profile (SAM drafts it from the config and the user edits it); the prototype reads
 * an optional `goodFor` field from the mocked API.
 */
function goodFor(profile: AgentProfile): string {
  const drafted = (profile as AgentProfile & { goodFor?: string }).goodFor;
  if (drafted) return drafted;
  if (profile.description && profile.description !== GENERIC_DESCRIPTION)
    return profile.description;
  return profileSubtitle(profile);
}

function ProfileCard({
  profile,
  selected,
  onSelect,
}: Readonly<{ profile: AgentProfile; selected: boolean; onSelect: () => void }>) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative flex min-h-[76px] min-w-0 flex-col gap-1 rounded-xl border p-3 text-left transition-colors ${
        selected
          ? 'border-accent bg-accent/15 ring-1 ring-accent'
          : 'border-border-default bg-surface hover:border-accent/50'
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ProfileAvatar profile={profile} size="sm" />
        <span className="line-clamp-2 break-words text-sm font-semibold leading-tight text-fg-primary">
          {profile.name}
        </span>
      </span>
      <span className="line-clamp-2 break-words text-xs leading-snug text-fg-secondary">
        {goodFor(profile)}
      </span>
      <span className="hidden truncate text-[11px] text-fg-muted sm:block">
        {profileSubtitle(profile)}
      </span>
    </button>
  );
}

export function ProfileCanvas({
  projectId,
  profiles,
  selectedProfileId,
  onSelect,
  onNewProfile,
}: Readonly<{
  projectId: string;
  profiles: AgentProfile[];
  selectedProfileId: string | null;
  onSelect: (profileId: string) => void;
  onNewProfile: () => void;
}>) {
  const isMobile = useIsMobile();
  const { data: usage } = useProfileUsage(projectId);
  const [allOpen, setAllOpen] = useState(false);
  const recent = recentProfiles(profiles, usage, 4);
  const builders = profiles.filter(
    (profile) => isBuildProfile(profile) && !recent.includes(profile)
  );

  return (
    <div className="flex w-full max-w-[720px] flex-col gap-3">
      <div className="text-center">
        <div className="text-base font-semibold text-fg-primary">Who should take this?</div>
        <div className="sam-type-secondary mt-1 text-fg-muted">
          Pick a profile, then describe the task below.
        </div>
      </div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
        Your recent
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {recent.map((profile) => (
          <ProfileCard
            key={profile.id}
            profile={profile}
            selected={profile.id === selectedProfileId}
            onSelect={() => onSelect(profile.id)}
          />
        ))}
      </div>
      {!isMobile && builders.length > 0 && (
        <>
          <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Builds and opens PRs
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {builders.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                selected={profile.id === selectedProfileId}
                onSelect={() => onSelect(profile.id)}
              />
            ))}
          </div>
        </>
      )}
      <button
        type="button"
        onClick={() => setAllOpen(true)}
        className="mx-auto flex min-h-11 items-center gap-1 rounded-md bg-transparent px-3 text-sm text-fg-secondary hover:text-fg-primary"
      >
        All {profiles.length} profiles <ChevronRight size={15} aria-hidden="true" />
      </button>
      <ProfileSheet
        open={allOpen}
        title="All profiles"
        anchor={null}
        projectId={projectId}
        profiles={profiles}
        selectedId={selectedProfileId}
        usage={usage}
        onSelect={onSelect}
        onClose={() => setAllOpen(false)}
        onNew={onNewProfile}
      />
    </div>
  );
}
