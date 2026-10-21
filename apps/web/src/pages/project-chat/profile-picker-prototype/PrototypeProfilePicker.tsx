/** PROTOTYPE — new-chat profile picker directions. Do not merge to main. */
import type { AgentEffort, AgentProfile } from '@simple-agent-manager/shared';
import { getSupportedEffortsForAgent } from '@simple-agent-manager/shared';
import { ChevronDown, Paperclip, Star } from 'lucide-react';
import type { RefObject } from 'react';
import { useMemo, useRef, useState } from 'react';

import { useIsMobile } from '../../../hooks/useIsMobile';
import { useIdList, usePredictedDefault, useProfileUsage } from './hooks';
import type { PickerVariant, ProfileUsage } from './model';
import {
  agentLabel,
  effortLabel,
  modelLabel,
  profileConsequence,
  profileSubtitle,
  rankedProfiles,
} from './model';
import { OptionsButton, optionsCount, OptionsPanel, type OptionsState } from './OptionsControl';
import { ProfileAvatar } from './ProfileAvatar';
import { ProfileSheet } from './ProfileSheet';

type PickerProps = Readonly<{
  variant: PickerVariant;
  projectId: string;
  profiles: AgentProfile[];
  selectedProfileId: string | null;
  onProfileChange: (profileId: string | null) => void;
  onNewProfile: () => void;
  onEditProfile: () => void;
  onAttach: () => void;
  attachDisabled: boolean;
  options: OptionsState;
}>;

/** Phones fit three short chips plus a compact "+N" in one row; desktop fits four. */
const SHORTLIST_SIZE = { phone: 3, desktop: 4 } as const;

function useSheetAnchor() {
  const ref = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const open = () => setAnchor(ref.current?.getBoundingClientRect() ?? null);
  return { ref, anchor, open, close: () => setAnchor(null), isOpen: anchor !== null };
}

/** Direction A and C: one control that names the current profile. */
function ProfilePill({
  profile,
  prefix,
  buttonRef,
  onOpen,
  showSubtitle,
}: Readonly<{
  profile: AgentProfile | null;
  prefix?: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  showSubtitle: boolean;
}>) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className="flex min-h-10 min-w-0 max-w-full items-center gap-2 rounded-full border border-border-default bg-surface py-1 pl-1 pr-3 text-left hover:border-accent/60"
    >
      {prefix && <span className="pl-2 text-xs text-fg-muted">{prefix}</span>}
      {profile && <ProfileAvatar profile={profile} size="sm" />}
      <span className="truncate text-sm font-medium text-fg-primary">
        {profile?.name ?? 'Choose profile'}
      </span>
      {profile && showSubtitle && (
        <span className="hidden truncate text-xs text-fg-muted md:inline">
          {profileSubtitle(profile)}
        </span>
      )}
      <ChevronDown size={15} className="shrink-0 text-fg-muted" aria-hidden="true" />
    </button>
  );
}

function EffortToken({ profile }: Readonly<{ profile: AgentProfile }>) {
  const [open, setOpen] = useState(false);
  const [override, setOverride] = useState<AgentEffort | null>(null);
  const current = override ?? (profile.effort as AgentEffort | null) ?? 'auto';
  const choices = getSupportedEffortsForAgent(profile.agentType).filter(
    (level) => level !== 'auto'
  );
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-0.5 rounded border-0 bg-transparent p-0 text-xs text-fg-secondary underline decoration-dotted underline-offset-2 hover:text-fg-primary"
      >
        {effortLabel(current) ?? 'auto effort'}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <span className="absolute bottom-full left-0 z-dropdown mb-1 grid min-w-[150px] rounded-md border border-border-default bg-page p-1 shadow-xl">
          <span className="px-2 py-1 text-[11px] text-fg-muted">For this chat only</span>
          {choices.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => {
                setOverride(level);
                setOpen(false);
              }}
              className={`min-h-9 rounded px-2 text-left text-sm ${
                level === current
                  ? 'bg-accent/10 text-accent'
                  : 'bg-transparent text-fg-primary hover:bg-surface'
              }`}
            >
              {effortLabel(level) ?? 'auto'}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function SummaryLine({ profile }: Readonly<{ profile: AgentProfile }>) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-xs text-fg-muted">
      <span>{agentLabel(profile.agentType)}</span>
      {modelLabel(profile) && <span>· {modelLabel(profile)}</span>}
      <span>·</span>
      <EffortToken key={profile.id} profile={profile} />
      <span>· {profileConsequence(profile)}</span>
    </div>
  );
}

function shortlistFor(
  profiles: AgentProfile[],
  usage: ProfileUsage | undefined,
  pinned: string[],
  hidden: string[],
  selectedId: string | null,
  size: number
) {
  const ranked = rankedProfiles(profiles, usage);
  const pinnedProfiles = pinned
    .map((id) => profiles.find((profile) => profile.id === id))
    .filter((profile): profile is AgentProfile => Boolean(profile));
  const fill = ranked.filter(
    (profile) => !pinned.includes(profile.id) && !hidden.includes(profile.id)
  );
  const list = [...pinnedProfiles, ...fill].slice(0, size);
  const selected = profiles.find((profile) => profile.id === selectedId);
  if (selected && !list.some((profile) => profile.id === selected.id)) list.unshift(selected);
  return list;
}

/** Direction B: the few profiles you actually use, one tap each. */
function WorkingSetPicker(props: PickerProps & Readonly<{ usage: ProfileUsage | undefined }>) {
  const { profiles, usage, selectedProfileId, onProfileChange } = props;
  const sheet = useSheetAnchor();
  const pins = useIdList(`pp-pins-${props.projectId}`, []);
  const hidden = useIdList(`pp-hidden-${props.projectId}`, []);
  const ranked = useMemo(() => rankedProfiles(profiles, usage), [profiles, usage]);
  const pinned = pins.ids.length > 0 ? pins.ids : ranked.slice(0, 1).map((profile) => profile.id);
  const isMobile = useIsMobile();
  const shortlist = shortlistFor(
    profiles,
    usage,
    pinned,
    hidden.ids,
    selectedProfileId,
    isMobile ? SHORTLIST_SIZE.phone : SHORTLIST_SIZE.desktop
  );
  const moreCount = profiles.filter(
    (profile) => !shortlist.includes(profile) && !hidden.ids.includes(profile.id)
  ).length;
  const selected = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const [optionsOpen, setOptionsOpen] = useState(false);

  return (
    <>
      {optionsOpen && <OptionsPanel options={props.options} compact={isMobile} />}
      <div className="mb-1.5 flex items-center gap-1.5">
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]"
          aria-label="Your profiles"
          data-intentional-clip="horizontal chip strip scrolls"
        >
          {shortlist.map((profile) => {
            const isSelected = profile.id === selectedProfileId;
            return (
              <button
                key={profile.id}
                type="button"
                onClick={() => onProfileChange(profile.id)}
                aria-pressed={isSelected}
                className={`flex min-h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-sm font-medium ${
                  isSelected
                    ? 'border-accent bg-accent text-white'
                    : 'border-border-default bg-transparent text-fg-secondary hover:text-fg-primary'
                }`}
              >
                {pinned.includes(profile.id) && (
                  <Star
                    size={12}
                    fill="currentColor"
                    aria-label="Pinned"
                    className={isSelected ? '' : 'text-warning-fg'}
                  />
                )}
                <span className="max-w-[9rem] truncate">{profile.name}</span>
              </button>
            );
          })}
        </div>
        <button
          ref={sheet.ref}
          type="button"
          onClick={sheet.open}
          aria-label={`More profiles (${moreCount})`}
          className="flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-dashed border-border-default bg-transparent px-3 text-sm text-fg-muted hover:text-fg-primary"
        >
          {isMobile ? `+${moreCount}` : `More · ${moreCount}`}
        </button>
      </div>
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">{selected && <SummaryLine profile={selected} />}</div>
        <OptionsButton
          open={optionsOpen}
          count={optionsCount(props.options)}
          onToggle={() => setOptionsOpen((v) => !v)}
        />
      </div>
      <ProfileSheet
        open={sheet.isOpen}
        title="Your profiles"
        anchor={sheet.anchor}
        projectId={props.projectId}
        profiles={profiles}
        selectedId={selectedProfileId}
        usage={usage}
        onSelect={(id) => onProfileChange(id)}
        onClose={sheet.close}
        onNew={props.onNewProfile}
        manage={{
          pinned,
          hidden: hidden.ids,
          onTogglePin: pins.toggle,
          onToggleHidden: hidden.toggle,
          onHideMany: hidden.addMany,
        }}
      />
    </>
  );
}

/** Direction A ("One button") and the composer half of C ("To: …"). */
function SingleControlPicker(props: PickerProps & Readonly<{ usage: ProfileUsage | undefined }>) {
  const sheet = useSheetAnchor();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const isMobile = useIsMobile();
  const selected = props.profiles.find((profile) => profile.id === props.selectedProfileId) ?? null;
  return (
    <>
      {optionsOpen && <OptionsPanel options={props.options} compact={isMobile} />}
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <ProfilePill
            profile={selected}
            prefix={props.variant === 'c' ? 'To' : undefined}
            buttonRef={sheet.ref}
            onOpen={sheet.open}
            showSubtitle={props.variant === 'a'}
          />
        </div>
        <button
          type="button"
          onClick={props.onAttach}
          disabled={props.attachDisabled}
          aria-label="Attach files to this task"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-default bg-transparent text-fg-muted hover:text-fg-primary disabled:opacity-50"
        >
          <Paperclip size={16} />
        </button>
        <OptionsButton
          open={optionsOpen}
          count={optionsCount(props.options)}
          onToggle={() => setOptionsOpen((v) => !v)}
        />
      </div>
      <ProfileSheet
        open={sheet.isOpen}
        title="Start with…"
        anchor={sheet.anchor}
        projectId={props.projectId}
        profiles={props.profiles}
        selectedId={props.selectedProfileId}
        usage={props.usage}
        onSelect={(id) => props.onProfileChange(id)}
        onClose={sheet.close}
        onNew={props.onNewProfile}
        onEdit={props.onEditProfile}
      />
    </>
  );
}

export function PrototypeProfilePicker(props: PickerProps) {
  const { data: usage } = useProfileUsage(props.projectId);
  usePredictedDefault(props.profiles, usage, props.onProfileChange);
  if (props.variant === 'b') return <WorkingSetPicker {...props} usage={usage} />;
  return <SingleControlPicker {...props} usage={usage} />;
}
