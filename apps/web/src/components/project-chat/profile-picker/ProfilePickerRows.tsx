import type { AgentProfile } from '@simple-agent-manager/shared';
import { Check, Eye, EyeOff, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';

import { profileSubtitle } from './model';
import { ProfileAvatar } from './ProfileAvatar';

/** A heading, so screen readers can jump between the sheet's sections. */
export function SectionLabel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <h3 className="m-0 px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
      {children}
    </h3>
  );
}

/** One profile: tap to start the chat with it; in edit mode an eye toggles "hide from new chat". */
export function ProfilePickerRow({
  profile,
  selected,
  hidden,
  editing,
  busy,
  onSelect,
  onToggleHidden,
}: Readonly<{
  profile: AgentProfile;
  selected: boolean;
  hidden: boolean;
  editing: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggleHidden: () => void;
}>) {
  return (
    <div
      className={`mx-2 flex items-center gap-1 rounded-lg ${selected ? 'bg-accent/10' : 'hover:bg-surface'}`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 bg-transparent px-2 py-2 text-left"
      >
        <ProfileAvatar profile={profile} />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm font-medium ${hidden ? 'text-fg-muted' : 'text-fg-primary'}`}
          >
            {profile.name}
          </span>
          <span className="block truncate text-xs text-fg-muted">{profileSubtitle(profile)}</span>
        </span>
        {selected && <Check size={16} className="shrink-0 text-accent" aria-hidden="true" />}
      </button>
      {editing && (
        <button
          type="button"
          onClick={onToggleHidden}
          disabled={busy}
          aria-pressed={hidden}
          aria-label={
            hidden ? `Show ${profile.name} in new chat` : `Hide ${profile.name} from new chat`
          }
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-transparent text-fg-muted hover:text-fg-primary disabled:opacity-50"
        >
          {hidden ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

/** Offer to hide profiles the person hasn't picked lately; only tidies their own list. */
export function IdleProfilesNudge({
  count,
  windowDays,
  busy,
  onHide,
}: Readonly<{ count: number; windowDays: number; busy: boolean; onHide: () => void }>) {
  return (
    <div className="mx-4 mt-3 rounded-lg border border-accent/25 bg-accent/5 p-3">
      <div className="flex items-start gap-2">
        <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg-primary">
            {count === 1
              ? `1 profile you haven’t picked in ${windowDays} days`
              : `${count} profiles you haven’t picked in ${windowDays} days`}
          </div>
          <div className="mt-0.5 text-xs text-fg-muted">
            Hiding only tidies your list. Automations, other people and @mentions are unaffected.
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onHide}
        disabled={busy}
        className="mt-2 min-h-11 w-full rounded-md border-0 bg-accent px-3 text-sm font-semibold text-white disabled:opacity-60"
      >
        Hide {count} from new chat
      </button>
    </div>
  );
}
