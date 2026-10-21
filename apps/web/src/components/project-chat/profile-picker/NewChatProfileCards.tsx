import type { AgentProfile, ProfilePickerState } from '@simple-agent-manager/shared';
import { Check, ChevronRight } from 'lucide-react';
import { useId } from 'react';

import { profileCardSet, profileSubtitle } from './model';
import { ProfileAvatar } from './ProfileAvatar';

/** Cards fit two rows on a phone and one row on desktop; the rest is one tap away. */
const CARD_LIMIT = 4;
/**
 * Columns follow the chat area's width, not the screen's: on a tablet the two sidebars
 * leave the chat about 250px, where four columns would hide every name.
 */
const GRID_CLASSES = 'grid grid-cols-1 gap-2 @2xs:grid-cols-2 @2xl:grid-cols-4';

function ProfileCard({
  profile,
  selected,
  onSelect,
}: Readonly<{ profile: AgentProfile; selected: boolean; onSelect: () => void }>) {
  const descriptionId = useId();
  const subtitle = profileSubtitle(profile);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      // Name and what runs it; a long description is read after, as the description.
      aria-label={`${profile.name}, ${subtitle}`}
      aria-describedby={profile.description ? descriptionId : undefined}
      className={`relative flex min-h-[76px] min-w-0 flex-col gap-1 rounded-xl border p-3 text-left transition-colors ${
        selected
          ? 'border-accent bg-accent/15 ring-1 ring-accent'
          : 'border-border-default bg-surface hover:border-accent/50'
      }`}
    >
      <span className="flex min-w-0 items-center gap-2 pr-4">
        <ProfileAvatar profile={profile} size="sm" />
        <span className="line-clamp-2 break-words text-sm font-semibold leading-tight text-fg-primary">
          {profile.name}
        </span>
      </span>
      {selected && (
        <Check size={15} className="absolute right-2.5 top-2.5 text-accent" aria-hidden="true" />
      )}
      {profile.description && (
        <span
          id={descriptionId}
          className="line-clamp-2 break-words text-xs leading-snug text-fg-secondary"
        >
          {profile.description}
        </span>
      )}
      <span className="truncate text-[11px] text-fg-muted">{subtitle}</span>
    </button>
  );
}

function CardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="h-[76px] animate-pulse rounded-xl border border-border-default bg-surface"
    />
  );
}

/**
 * The empty new-chat screen's "Who should take this?": the person's recent profiles as
 * cards (or their first profiles when they have no recent chats), plus PR builders where
 * a full row fits. Hidden profiles are left out; "All N profiles" opens the full picker.
 */
export function NewChatProfileCards({
  profiles,
  pickerState,
  loading,
  selectedProfileId,
  onSelect,
  onShowAll,
}: Readonly<{
  profiles: AgentProfile[];
  pickerState: ProfilePickerState | undefined;
  loading: boolean;
  selectedProfileId: string | null;
  onSelect: (profileId: string) => void;
  onShowAll: () => void;
}>) {
  const cards = profileCardSet(profiles, pickerState, CARD_LIMIT);

  return (
    <section
      aria-label="Choose a profile"
      className="@container flex w-full min-w-0 max-w-[720px] flex-col gap-3"
    >
      <div className="text-center">
        <h2 className="m-0 text-base font-semibold text-fg-primary">Who should take this?</h2>
        <p className="sam-type-secondary m-0 mt-1 text-fg-muted">
          Pick a profile, then describe the task below.
        </p>
      </div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
        {cards.kind === 'recent' ? 'Recent' : 'Your profiles'}
      </div>
      <div className={GRID_CLASSES}>
        {loading
          ? Array.from({ length: CARD_LIMIT }, (_, index) => <CardSkeleton key={index} />)
          : cards.items.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                selected={profile.id === selectedProfileId}
                onSelect={() => onSelect(profile.id)}
              />
            ))}
      </div>
      {/* PR builders only where a full row of cards fits; the picker lists them everywhere. */}
      {!loading && cards.builders.length > 0 && (
        <div className="hidden flex-col gap-3 @2xl:flex">
          <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Builds and opens PRs
          </div>
          <div className={GRID_CLASSES}>
            {cards.builders.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                selected={profile.id === selectedProfileId}
                onSelect={() => onSelect(profile.id)}
              />
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={onShowAll}
        className="mx-auto flex min-h-11 items-center gap-1 rounded-md bg-transparent px-3 text-sm text-fg-secondary hover:text-fg-primary"
      >
        All {profiles.length} profiles <ChevronRight size={15} aria-hidden="true" />
      </button>
    </section>
  );
}
