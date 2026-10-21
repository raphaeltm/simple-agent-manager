/** PROTOTYPE — new-chat profile picker directions. Do not merge to main. */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { useEscapeKey } from '@simple-agent-manager/ui';
import {
  Check,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { useIsMobile } from '../../../hooks/useIsMobile';
import type { ProfileUsage } from './model';
import {
  automationCount,
  idleProfiles,
  isBuildProfile,
  lookalikePairs,
  manualCount,
  profileSubtitle,
  rankedProfiles,
  recentProfiles,
} from './model';
import { ProfileAvatar } from './ProfileAvatar';

export interface ManageControls {
  pinned: string[];
  hidden: string[];
  onTogglePin: (profileId: string) => void;
  onToggleHidden: (profileId: string) => void;
  onHideMany: (profileIds: string[]) => void;
}

type ProfileSheetProps = Readonly<{
  open: boolean;
  title: string;
  anchor: DOMRect | null;
  projectId: string;
  profiles: AgentProfile[];
  selectedId: string | null;
  usage: ProfileUsage | undefined;
  onSelect: (profileId: string) => void;
  onClose: () => void;
  onNew: () => void;
  onEdit?: () => void;
  manage?: ManageControls;
}>;

const SEARCH_THRESHOLD = 8;
const RECENT_LIMIT = 3;
const SHEET_WIDTH = 440;

function usageNote(profile: AgentProfile, usage: ProfileUsage | undefined): string {
  const mine = manualCount(usage, profile.id);
  const automated = automationCount(usage, profile.id);
  if (mine === 0 && automated > 0) return `Only automations use it · ${automated} runs in 30 days`;
  if (mine === 0) return 'Not used in 30 days';
  return `${mine} of your chats in 30 days`;
}

function SectionLabel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
      {children}
    </div>
  );
}

function ProfileRow({
  profile,
  selected,
  usage,
  onSelect,
  manage,
}: Readonly<{
  profile: AgentProfile;
  selected: boolean;
  usage: ProfileUsage | undefined;
  onSelect: () => void;
  manage?: ManageControls;
}>) {
  const pinned = manage?.pinned.includes(profile.id) ?? false;
  const hidden = manage?.hidden.includes(profile.id) ?? false;
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
          <span className="block truncate text-xs text-fg-muted">
            {manage ? usageNote(profile, usage) : profileSubtitle(profile)}
          </span>
        </span>
        {selected && !manage && (
          <Check size={16} className="shrink-0 text-accent" aria-hidden="true" />
        )}
      </button>
      {manage && (
        <>
          <button
            type="button"
            onClick={() => manage.onTogglePin(profile.id)}
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${profile.name}` : `Pin ${profile.name}`}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-transparent ${
              pinned ? 'text-warning-fg' : 'text-fg-muted hover:text-fg-primary'
            }`}
          >
            <Star size={16} fill={pinned ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            onClick={() => manage.onToggleHidden(profile.id)}
            aria-pressed={!hidden}
            aria-label={
              hidden ? `Show ${profile.name} in new chat` : `Hide ${profile.name} from new chat`
            }
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-transparent text-fg-muted hover:text-fg-primary"
          >
            {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </>
      )}
    </div>
  );
}

function CleanupNudges({
  profiles,
  usage,
  manage,
}: Readonly<{
  profiles: AgentProfile[];
  usage: ProfileUsage | undefined;
  manage: ManageControls;
}>) {
  const idle = idleProfiles(profiles, usage).filter(
    (profile) => !manage.hidden.includes(profile.id)
  );
  const lookalike = lookalikePairs(profiles)[0];
  if (idle.length === 0 && !lookalike) return null;
  return (
    <div className="mx-4 mt-3 grid gap-2">
      {idle.length > 0 && (
        <div className="rounded-lg border border-accent/25 bg-accent/5 p-3">
          <div className="flex items-start gap-2">
            <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-fg-primary">
                {idle.length} profiles you haven&apos;t picked in 30 days
              </div>
              <div className="mt-0.5 text-xs text-fg-muted">
                Hiding them only tidies this list. Automations and @mentions keep working.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => manage.onHideMany(idle.map((profile) => profile.id))}
            className="mt-2 min-h-11 w-full rounded-md border-0 bg-accent px-3 text-sm font-semibold text-white"
          >
            Hide {idle.length} from new chat
          </button>
        </div>
      )}
      {lookalike && (
        <div className="rounded-lg border border-border-default bg-surface p-3 text-xs text-fg-muted">
          <span className="font-medium text-fg-primary">
            {lookalike[0].name} and {lookalike[1].name}
          </span>{' '}
          use the same agent, model and effort. Merge them?
        </div>
      )}
    </div>
  );
}

function useSheetSections(
  profiles: AgentProfile[],
  usage: ProfileUsage | undefined,
  query: string,
  manage: ManageControls | undefined
) {
  return useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed) {
      return [
        {
          label: 'Results',
          items: profiles.filter((profile) =>
            `${profile.name} ${profileSubtitle(profile)}`.toLowerCase().includes(trimmed)
          ),
        },
      ];
    }
    if (manage) {
      const ranked = rankedProfiles(profiles, usage);
      return [
        { label: 'Shown in new chat', items: ranked.filter((p) => !manage.hidden.includes(p.id)) },
        {
          label: 'Hidden from new chat',
          items: ranked.filter((p) => manage.hidden.includes(p.id)),
        },
      ];
    }
    const recent = recentProfiles(profiles, usage, RECENT_LIMIT);
    const rest = profiles.filter((profile) => !recent.some((r) => r.id === profile.id));
    return [
      { label: 'Recent', items: recent },
      { label: 'Chat & explore', items: rest.filter((p) => !isBuildProfile(p)) },
      { label: 'Build & open PRs', items: rest.filter((p) => isBuildProfile(p)) },
    ];
  }, [manage, profiles, query, usage]);
}

function sheetPosition(isMobile: boolean, anchor: DOMRect | null) {
  if (isMobile || !anchor) {
    return 'fixed inset-x-0 bottom-0 max-h-[82vh] rounded-t-2xl';
  }
  return 'fixed w-[440px] max-h-[560px] rounded-xl';
}

export function ProfileSheet({
  open,
  title,
  anchor,
  projectId,
  profiles,
  selectedId,
  usage,
  onSelect,
  onClose,
  onNew,
  onEdit,
  manage,
}: ProfileSheetProps) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const sections = useSheetSections(profiles, usage, query, manage);
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;
  useEscapeKey(onClose, open);
  if (!open) return null;

  const anchoredStyle =
    !isMobile && anchor
      ? {
          left: Math.min(Math.max(16, anchor.left), window.innerWidth - SHEET_WIDTH - 16),
          bottom: window.innerHeight - anchor.top + 8,
        }
      : undefined;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-drawer-backdrop bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={anchoredStyle}
        className={`${sheetPosition(isMobile, anchor)} z-drawer flex flex-col overflow-hidden border border-border-default bg-page shadow-2xl`}
      >
        {isMobile && (
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-default" />
        )}
        <div className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-3">
          <h2 className="m-0 flex-1 text-base font-semibold text-fg-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-md bg-transparent text-fg-muted hover:text-fg-primary"
          >
            <X size={18} />
          </button>
        </div>
        {profiles.length > SEARCH_THRESHOLD && (
          <div className="relative mx-4 mb-1 flex shrink-0 items-center">
            <Search size={15} className="pointer-events-none absolute left-3 text-fg-muted" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${profiles.length} profiles`}
              className="min-h-11 w-full rounded-md border border-border-default bg-surface pl-9 pr-3 text-base text-fg-primary outline-none focus:border-accent/60 sm:text-sm"
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {manage && !query && <CleanupNudges profiles={profiles} usage={usage} manage={manage} />}
          {sections
            .filter((section) => section.items.length > 0)
            .map((section) => (
              <div key={section.label}>
                <SectionLabel>{section.label}</SectionLabel>
                {section.items.map((profile) => (
                  <ProfileRow
                    key={profile.id}
                    profile={profile}
                    selected={profile.id === selectedId}
                    usage={usage}
                    manage={manage}
                    onSelect={() => {
                      onSelect(profile.id);
                      onClose();
                    }}
                  />
                ))}
              </div>
            ))}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-border-default px-4 py-2.5">
          <button
            type="button"
            onClick={() => {
              onClose();
              onNew();
            }}
            className="flex min-h-11 items-center gap-1.5 rounded-md border border-dashed border-border-default bg-transparent px-3 text-sm text-fg-secondary hover:text-fg-primary"
          >
            <Plus size={15} /> New
          </button>
          {onEdit && selected && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onEdit();
              }}
              className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-md border border-border-default bg-transparent px-3 text-sm text-fg-secondary hover:text-fg-primary"
            >
              <Pencil size={14} className="shrink-0" /> Edit
              <span className="sr-only"> {selected.name}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate(`/projects/${projectId}/profiles`)}
            className="ml-auto flex min-h-11 items-center gap-1.5 rounded-md bg-transparent px-2 text-sm text-fg-muted hover:text-fg-primary"
          >
            <Settings2 size={15} /> Manage
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
