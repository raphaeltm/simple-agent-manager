import type {
  AgentProfile,
  ProfilePickerState,
  UpdateProfilePickerRequest,
} from '@simple-agent-manager/shared';
import { useModalInteraction } from '@simple-agent-manager/ui';
import { ChevronDown, ChevronRight, Pencil, Plus, Search, Settings2, X } from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { useIsMobile } from '../../../hooks/useIsMobile';
import { idleProfiles, pickerSections } from './model';
import { IdleProfilesNudge, ProfilePickerRow, SectionLabel } from './ProfilePickerRows';

/** Search appears once the list is long enough that scanning it is slower than typing. */
const SEARCH_THRESHOLD = 8;
/** Recent profiles listed first; the rest are grouped by what they do. */
const RECENT_LIMIT = 3;
const SHEET_WIDTH_PX = 440;
const SHEET_MAX_HEIGHT_PX = 560;
const VIEWPORT_GUTTER_PX = 16;

type ProfilePickerSheetProps = Readonly<{
  open: boolean;
  /** Trigger rectangle; null opens a centered dialog on desktop. */
  anchor: DOMRect | null;
  projectId: string;
  profiles: AgentProfile[];
  selectedProfileId: string | null;
  pickerState: ProfilePickerState | undefined;
  hiddenUpdating: boolean;
  hiddenUpdateError: string | null;
  onSelect: (profileId: string) => void;
  onSetHidden: (change: UpdateProfilePickerRequest) => Promise<void>;
  onClose: () => void;
  onNewProfile: () => void;
  onEditProfile?: () => void;
}>;

function sheetLayout(isMobile: boolean, anchor: DOMRect | null) {
  if (isMobile) {
    return { className: 'fixed inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl', style: undefined };
  }
  if (!anchor) {
    return {
      className: 'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl',
      style: { width: SHEET_WIDTH_PX, maxHeight: SHEET_MAX_HEIGHT_PX } satisfies CSSProperties,
    };
  }
  const left = Math.min(
    Math.max(VIEWPORT_GUTTER_PX, anchor.left),
    window.innerWidth - SHEET_WIDTH_PX - VIEWPORT_GUTTER_PX
  );
  return {
    className: 'fixed rounded-xl',
    style: {
      left,
      bottom: window.innerHeight - anchor.top + 8,
      width: SHEET_WIDTH_PX,
      maxHeight: Math.min(SHEET_MAX_HEIGHT_PX, anchor.top - VIEWPORT_GUTTER_PX),
    } satisfies CSSProperties,
  };
}

/**
 * The full profile list for a new chat: Recent, Chat & explore, Build & open PRs and the
 * person's hidden profiles, with search, an edit mode for hiding, and New/Edit/Manage.
 */
export function ProfilePickerSheet(props: ProfilePickerSheetProps) {
  const { open, profiles, pickerState, selectedProfileId } = props;
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { onClose } = props;
  // Focus trap, Escape, scroll lock, an inert page behind, and focus back on whatever
  // opened the sheet (the To control or the cards link).
  useModalInteraction({ enabled: open, modalRef: dialogRef, onEscape: onClose });

  // Every opening starts from the plain list.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setEditing(false);
    setShowHidden(false);
  }, [open]);

  const sections = useMemo(
    () => pickerSections(profiles, pickerState, query, RECENT_LIMIT),
    [pickerState, profiles, query]
  );
  const hiddenIds = useMemo(
    () => new Set(pickerState?.hiddenProfileIds ?? []),
    [pickerState?.hiddenProfileIds]
  );
  const idle = editing && !query ? idleProfiles(profiles, pickerState) : [];
  const selected = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  if (!open) return null;

  const layout = sheetLayout(isMobile, props.anchor);
  const setHidden = (change: UpdateProfilePickerRequest) => {
    props.onSetHidden(change).catch(() => undefined);
  };

  return createPortal(
    // One root for backdrop and sheet, so isolating the page leaves the backdrop clickable.
    <div data-sam-modal-root="">
      <div
        className="fixed inset-0 z-drawer-backdrop border-0 glass-backdrop-dim"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Choose a profile"
        tabIndex={-1}
        style={layout.style}
        className={`${layout.className} z-drawer flex flex-col overflow-hidden outline-none glass-modal glass-panel-container glass-composited`}
      >
        {isMobile && (
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-default" />
        )}
        <div className="flex shrink-0 items-center gap-1 px-4 pb-1 pt-3">
          <h2 className="m-0 min-w-0 flex-1 truncate text-base font-semibold text-fg-primary">
            {editing ? 'Show or hide profiles' : 'Start with…'}
          </h2>
          <button
            type="button"
            onClick={() => setEditing((value) => !value)}
            aria-pressed={editing}
            className="min-h-11 rounded-md bg-transparent px-3 text-sm text-fg-secondary hover:text-fg-primary"
          >
            {editing ? 'Done' : 'Edit list'}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-md bg-transparent text-fg-muted hover:text-fg-primary"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {profiles.length > SEARCH_THRESHOLD && (
          <div className="relative mx-4 mb-1 flex shrink-0 items-center">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 text-fg-muted"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${profiles.length} profiles`}
              aria-label="Search profiles"
              className="min-h-11 w-full rounded-md border border-border-default bg-surface pl-9 pr-3 text-base text-fg-primary outline-none focus:border-accent/60 sm:text-sm"
            />
          </div>
        )}
        {props.hiddenUpdateError && (
          <div
            role="alert"
            className="mx-4 mt-2 rounded-md bg-danger-tint px-3 py-2 text-xs text-danger"
          >
            {props.hiddenUpdateError}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {idle.length > 0 && pickerState && (
            <IdleProfilesNudge
              count={idle.length}
              windowDays={pickerState.usageWindowDays}
              busy={props.hiddenUpdating}
              onHide={() => setHidden({ hide: idle.map((profile) => profile.id) })}
            />
          )}
          {sections.map((section) => {
            const collapsible = section.id === 'hidden' && !editing;
            const expanded = !collapsible || showHidden;
            return (
              <div key={section.id}>
                {collapsible ? (
                  <h3 className="m-0">
                    <button
                      type="button"
                      onClick={() => setShowHidden((value) => !value)}
                      aria-expanded={showHidden}
                      className="flex min-h-11 w-full items-center gap-1 bg-transparent px-4 pt-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-muted hover:text-fg-secondary"
                    >
                      {showHidden ? (
                        <ChevronDown size={13} aria-hidden="true" />
                      ) : (
                        <ChevronRight size={13} aria-hidden="true" />
                      )}
                      {section.label} ({section.items.length})
                    </button>
                  </h3>
                ) : (
                  <SectionLabel>{section.label}</SectionLabel>
                )}
                {expanded &&
                  section.items.map((profile) => (
                    <ProfilePickerRow
                      key={profile.id}
                      profile={profile}
                      selected={profile.id === selectedProfileId}
                      hidden={hiddenIds.has(profile.id)}
                      editing={editing}
                      busy={props.hiddenUpdating}
                      onSelect={() => {
                        props.onSelect(profile.id);
                        onClose();
                      }}
                      onToggleHidden={() =>
                        setHidden(
                          hiddenIds.has(profile.id)
                            ? { unhide: [profile.id] }
                            : { hide: [profile.id] }
                        )
                      }
                    />
                  ))}
              </div>
            );
          })}
          {sections.length === 0 && (
            <p className="m-0 px-4 py-6 text-center text-sm text-fg-muted">No profiles match.</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-border-default px-4 py-2.5">
          <button
            type="button"
            onClick={() => {
              onClose();
              props.onNewProfile();
            }}
            className="flex min-h-11 items-center gap-1.5 rounded-md border border-dashed border-border-default bg-transparent px-3 text-sm text-fg-secondary hover:text-fg-primary"
          >
            <Plus size={15} aria-hidden="true" /> New
          </button>
          {props.onEditProfile && selected && (
            <button
              type="button"
              onClick={() => {
                onClose();
                props.onEditProfile?.();
              }}
              aria-label={`Edit ${selected.name}`}
              className="flex min-h-11 items-center gap-1.5 rounded-md border border-border-default bg-transparent px-3 text-sm text-fg-secondary hover:text-fg-primary"
            >
              <Pencil size={14} aria-hidden="true" /> Edit
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate(`/projects/${props.projectId}/profiles`)}
            className="ml-auto flex min-h-11 items-center gap-1.5 rounded-md bg-transparent px-2 text-sm text-fg-muted hover:text-fg-primary"
          >
            <Settings2 size={15} aria-hidden="true" /> Manage
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
