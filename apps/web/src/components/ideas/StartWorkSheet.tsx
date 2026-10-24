/**
 * Start work — the sheet that replaces Execute.
 *
 * The person chooses who works on the idea and, optionally, a skill, writes a note, and
 * reads one sentence saying exactly what will happen. Nothing is typed into a chat
 * composer: the idea travels to the agent as structured context, so this works in any
 * repository and never mentions a slash command or a SAM-repository skill (policy
 * 69acc166).
 *
 * A profile SAM runs as a conversation turns the sheet into "Talk it through". The
 * selected runtime is never swapped — the server routes Instant and VM profiles by their
 * own runtime, and the mode shown here is the mode that is sent.
 *
 * Bottom sheet on phones, centred dialog on desktop, matching `ProfilePickerSheet`.
 */
import { Button, useModalInteraction } from '@simple-agent-manager/ui';
import { Check, ChevronDown, CircleAlert, MessagesSquare, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { profileSubtitle } from '../project-chat/profile-picker/model';
import { ProfileAvatar } from '../project-chat/profile-picker/ProfileAvatar';
import { ProfilePickerSheet } from '../project-chat/profile-picker/ProfilePickerSheet';
import { SkillSelector } from '../skills/SkillSelector';
import { type StartWorkRelatedCount, useStartWork } from './useStartWork';

const NOTE_PLACEHOLDER = 'Your note is the only message you send. The idea goes along on its own.';
/**
 * Profile names are free text. Past this, a name used inside a label or a sentence wraps
 * over several lines and takes the sheet over; the picker row above still shows the full
 * name, so an ellipsis here loses nothing.
 */
const NAME_IN_COPY_MAX_CHARS = 28;

function nameForCopy(name: string): string {
  return name.length > NAME_IN_COPY_MAX_CHARS
    ? `${name.slice(0, NAME_IN_COPY_MAX_CHARS - 1).trimEnd()}\u2026`
    : name;
}

export interface StartWorkSheetProps {
  open: boolean;
  projectId: string;
  ideaId: string;
  ideaTitle: string;
  projectDefaultWorkspaceProfile?: string | null;
  onClose: () => void;
  /** Called with the new chat's session id once the start succeeds. */
  onStarted: (sessionId: string) => void;
}

function Field({
  label,
  optional,
  children,
}: Readonly<{ label: string; optional?: boolean; children: ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-fg-muted">
        {label}
        {optional && <span className="font-normal"> · optional</span>}
      </span>
      {children}
    </div>
  );
}

/** A select-style row: the current choice, and a clear way to change it. */
function ChoiceRow({
  icon,
  title,
  detail,
  badge,
  ariaLabel,
  onClick,
}: Readonly<{
  icon: ReactNode;
  title: string;
  detail: string;
  badge?: ReactNode;
  ariaLabel: string;
  onClick: (anchor: DOMRect) => void;
}>) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={(event) => onClick(event.currentTarget.getBoundingClientRect())}
      className="flex min-h-[52px] w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-[var(--sam-form-border)] bg-inset px-3 py-1.5 text-left hover:border-accent/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold text-fg-primary">{title}</span>
          {badge}
        </span>
        <span className="truncate text-[13px] text-fg-muted">{detail}</span>
      </span>
      <ChevronDown size={18} aria-hidden="true" className="shrink-0 text-fg-muted" />
    </button>
  );
}

/**
 * What SAM will do with this profile, in two words.
 *
 * Deliberately not "Can change code" / "Chat only": a conversation profile on a VM has
 * the repository checked out and can change code perfectly well. The honest distinction
 * is whether SAM runs the chat as task work or as a conversation.
 */
function ModeBadge({ taskMode }: Readonly<{ taskMode: 'task' | 'conversation' }>) {
  const isTask = taskMode === 'task';
  const color = isTask ? 'var(--sam-color-success-fg)' : 'var(--sam-color-warning-fg)';
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        color,
      }}
    >
      {isTask ? 'Does the work' : 'Talks it through'}
    </span>
  );
}

const COUNT_NOUNS: Record<StartWorkRelatedCount['kind'], [one: string, many: string]> = {
  chats: ['earlier chat', 'earlier chats'],
  files: ['file', 'files'],
  pullRequests: ['pull request', 'pull requests'],
};

function countLabel({ kind, count, lowerBound }: StartWorkRelatedCount): string {
  const [one, many] = COUNT_NOUNS[kind];
  return `${count}${lowerBound ? '+' : ''} ${count === 1 && !lowerBound ? one : many}`;
}

/**
 * What the agent starts with.
 *
 * The idea itself is handed over at session bootstrap, so it gets a check. The idea's
 * other linked work is reachable through the agent's SAM tools rather than injected, and
 * is listed as plain chips so the two are not confused.
 */
function StartsWith({
  profileName,
  related,
}: Readonly<{ profileName: string; related: StartWorkRelatedCount[] | null }>) {
  const chips = (related ?? []).map(countLabel);
  return (
    <Field label={`${profileName} starts with`}>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        <li className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-success-fg/30 bg-success-tint px-2.5 py-0.5 text-[13px] text-fg-primary">
          <Check size={13} aria-hidden="true" className="shrink-0 text-success-fg" />
          <span className="truncate">The idea</span>
        </li>
      </ul>
      {chips.length > 0 && (
        <>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {chips.map((chip) => (
              <li
                key={chip}
                className="inline-flex max-w-full items-center rounded-full border border-border-default bg-surface-hover px-2.5 py-0.5 text-[13px] text-fg-muted"
              >
                <span className="truncate">{chip}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 text-[13px] leading-snug text-fg-muted">
            Already linked to this idea. {profileName} can look them up with its SAM tools.
          </p>
        </>
      )}
    </Field>
  );
}

export function StartWorkSheet({
  open,
  projectId,
  ideaId,
  ideaTitle,
  projectDefaultWorkspaceProfile,
  onClose,
  onStarted,
}: StartWorkSheetProps) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [profileSheet, setProfileSheet] = useState<{ open: boolean; anchor: DOMRect | null }>({
    open: false,
    anchor: null,
  });

  const work = useStartWork({
    projectId,
    ideaId,
    ideaTitle,
    enabled: open,
    projectDefaultWorkspaceProfile,
  });
  const { reset } = work;

  // Escape, focus trap, scroll lock and focus restored to the Start work button.
  useModalInteraction({ enabled: open, modalRef: dialogRef, onEscape: onClose });

  // Every opening starts clean. Guarded on `open` so typing does not reset the note.
  useEffect(() => {
    if (open) return;
    reset();
    setProfileSheet({ open: false, anchor: null });
  }, [open, reset]);

  if (!open) return null;

  const profile = work.selectedProfile;
  const taskMode = work.plan?.taskMode ?? 'task';
  const isTaskWork = taskMode === 'task';
  const profileName = nameForCopy(profile?.name ?? 'The agent');

  const handleStart = () => {
    void work.start().then((result) => {
      if (result) onStarted(result.sessionId);
    });
  };

  const outcome: ReactNode = isTaskWork ? (
    <>
      <strong>{profileName}</strong> starts a new chat
      {work.selectedSkill ? (
        <>
          {' '}
          with the <strong>{work.selectedSkill.name}</strong> skill
        </>
      ) : null}{' '}
      and works on this idea. The chat, and any pull request it opens, show up on the idea.
    </>
  ) : (
    <>
      <strong>{profileName}</strong> is set up for conversation, so this starts a chat about the
      idea instead of working on it. It is recorded on the idea as a discussion.
    </>
  );

  return createPortal(
    // One root for backdrop and sheet, so isolating the page leaves the backdrop clickable.
    <div data-sam-modal-root="">
      <div
        className="fixed inset-0 z-dialog-backdrop border-0 bg-overlay glass-backdrop-dim"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`fixed z-dialog-backdrop flex justify-center ${
          isMobile ? 'inset-x-0 bottom-0' : 'inset-0 items-center p-4'
        }`}
      >
        <div
          ref={dialogRef}
          data-testid="start-work-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={`glass-panel-container glass-composited glass-modal relative flex w-full flex-col shadow-overlay ${
            isMobile
              ? 'max-h-[92dvh] rounded-t-2xl'
              : 'max-h-[calc(100dvh-2rem)] max-w-[540px] rounded-2xl'
          }`}
        >
          {isMobile && (
            <span
              className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-border-default"
              aria-hidden="true"
            />
          )}
          <header className="flex shrink-0 items-start justify-between gap-3 px-5 pb-2 pt-2.5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 id={titleId} className="m-0 text-[19px] font-bold text-fg-primary">
                {isTaskWork ? 'Start work' : 'Talk it through'}
              </h2>
              <p className="m-0 truncate text-[13px] text-fg-muted">{ideaTitle}</p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="-mr-2 -mt-1 inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-3">
            <Field label="Who works on it">
              {profile ? (
                <ChoiceRow
                  ariaLabel={`Who works on it: ${profile.name}. Change`}
                  icon={<ProfileAvatar profile={profile} />}
                  title={profile.name}
                  detail={profile.description?.trim() || profileSubtitle(profile)}
                  badge={<ModeBadge taskMode={taskMode} />}
                  onClick={(anchor) => setProfileSheet({ open: true, anchor })}
                />
              ) : (
                <p className="m-0 rounded-lg border border-[var(--sam-form-border)] bg-inset px-3 py-3 text-[13px] text-fg-muted">
                  {work.profilesLoading
                    ? 'Loading profiles…'
                    : 'No agent profiles yet. Create one in Settings → Agent profiles, then start work from here.'}
                </p>
              )}
            </Field>

            {work.skills.length > 0 && (
              <Field label="Skill" optional>
                <SkillSelector
                  skills={work.skills}
                  selectedSkillId={work.selectedSkill?.id ?? null}
                  onChange={work.setSelectedSkillId}
                  disabled={work.submitting}
                  reserveDescriptionSpace={false}
                />
              </Field>
            )}

            <Field label="Note for the agent" optional>
              <textarea
                rows={2}
                value={work.note}
                onChange={(event) => work.setNote(event.target.value)}
                placeholder={NOTE_PLACEHOLDER}
                aria-label="Note for the agent"
                className="min-h-[56px] w-full resize-none rounded-lg border border-[var(--sam-form-border)] bg-inset px-3 py-2.5 text-[15px] leading-snug text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
              />
            </Field>

            <StartsWith profileName={profileName} related={work.related} />
          </div>

          <footer className="flex shrink-0 flex-col gap-3 border-0 border-t border-solid border-border-default px-5 pb-4 pt-3">
            {work.error && (
              <p role="alert" className="m-0 flex gap-2 text-[13px] leading-relaxed text-danger-fg">
                <CircleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>{work.error}</span>
              </p>
            )}
            <p
              className={`m-0 flex gap-2 text-[13px] leading-relaxed ${
                isTaskWork ? 'text-fg-muted' : 'text-fg-primary'
              }`}
            >
              {!isTaskWork && (
                <MessagesSquare
                  size={15}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-warning-fg"
                />
              )}
              <span>{outcome}</span>
            </p>
            <div className={`flex gap-3 ${isMobile ? '' : 'justify-end'}`}>
              <Button variant="ghost" onClick={onClose} disabled={work.submitting}>
                Cancel
              </Button>
              <Button
                className={isMobile ? 'flex-1' : ''}
                onClick={handleStart}
                loading={work.submitting}
                disabled={!profile}
              >
                {isTaskWork ? 'Start work' : 'Start chat'}
              </Button>
            </div>
          </footer>
        </div>
      </div>

      <ProfilePickerSheet
        // Opened from inside this dialog, so it must sit above it.
        layer="above-dialog"
        open={profileSheet.open}
        anchor={profileSheet.anchor}
        projectId={projectId}
        profiles={work.profiles}
        selectedProfileId={profile?.id ?? null}
        pickerState={work.profilePicker.state}
        hiddenUpdating={work.profilePicker.updating}
        hiddenUpdateError={work.profilePicker.updateError}
        onSelect={(profileId) => {
          work.setSelectedProfileId(profileId);
          setProfileSheet({ open: false, anchor: null });
        }}
        onSetHidden={work.profilePicker.setHidden}
        onClose={() => setProfileSheet({ open: false, anchor: null })}
        onNewProfile={() => navigate(`/projects/${projectId}/profiles`)}
      />
    </div>,
    document.body
  );
}
