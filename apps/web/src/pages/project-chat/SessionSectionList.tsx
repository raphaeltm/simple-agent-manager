import { Count } from '@simple-agent-manager/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { SESSION_SECTION_ORDER, type SessionSection } from '../../lib/chat-session-utils';
import { SessionList } from './SessionList';
import type { SessionSections as Sections } from './useSessionSections';
import type { TaskInfo } from './useTaskGroups';

/** The sections a person can fold away; attention and awake work always stays in view. */
export type CollapsibleSessionSection = Extract<SessionSection, 'sleeping' | 'history'>;
export type OpenSessionSections = Record<CollapsibleSessionSection, boolean>;

/** Sleeping chats are resumable work, so they start open; finished work starts folded. */
export const DEFAULT_OPEN_SESSION_SECTIONS: OpenSessionSections = {
  sleeping: true,
  history: false,
};

const SECTION_LABELS: Record<SessionSection, string> = {
  attention: 'Needs attention',
  awake: 'Awake',
  sleeping: 'Sleeping',
  history: 'History',
};

function isCollapsible(section: SessionSection): section is CollapsibleSessionSection {
  return section === 'sleeping' || section === 'history';
}

/**
 * The project chat list, in sections: Needs attention, Awake, Sleeping, History. Shared by
 * the desktop sidebar (and Zen peek) and the mobile drawer. Empty sections are omitted.
 * Searching opens every section so a match is never hidden behind a folded one.
 */
export function SessionSectionList({
  sections,
  isSearching,
  openSections,
  onToggleSection,
  selectedSessionId,
  onSelect,
  taskInfoMap,
  onShowHierarchy,
  showOwnership,
  size = 'md',
}: Readonly<{
  sections: Sections;
  isSearching: boolean;
  openSections: OpenSessionSections;
  onToggleSection: (section: CollapsibleSessionSection) => void;
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  taskInfoMap: Map<string, TaskInfo>;
  onShowHierarchy: (taskId: string) => void;
  showOwnership: boolean;
  /** `lg` gives section headers phone-sized (44px) targets. */
  size?: 'md' | 'lg';
}>) {
  const visible = SESSION_SECTION_ORDER.filter((section) => sections[section].length > 0);

  if (visible.length === 0) {
    return (
      <div className="flex items-center justify-center p-4">
        <span className="text-center text-[13px] text-fg-muted">
          {isSearching ? 'No matching chats' : 'No chats'}
        </span>
      </div>
    );
  }

  const headerClass = `mt-1 flex w-full items-center gap-1.5 rounded-[11px] px-3 ${
    size === 'lg' ? 'min-h-11 text-sm' : 'min-h-10 text-[13px]'
  }`;

  return (
    <>
      {visible.map((section) => {
        const list = sections[section];
        const headingId = `session-section-${section}`;
        const label = SECTION_LABELS[section];
        const tone = section === 'attention' ? 'text-warning-fg' : 'text-fg-muted';
        const count = (
          <Count
            value={list.length}
            tone={section === 'attention' ? 'attention' : 'muted'}
            asText
          />
        );
        const collapsible = isCollapsible(section);
        const open = !collapsible || isSearching || openSections[section];

        return (
          <section key={section} aria-labelledby={headingId}>
            {collapsible ? (
              <button
                type="button"
                id={headingId}
                aria-expanded={open}
                onClick={() => onToggleSection(section)}
                disabled={isSearching}
                className={`${headerClass} ${tone} cursor-pointer border-none bg-transparent transition-colors hover:bg-[var(--sam-glass-v2-raised)] hover:text-fg-primary disabled:cursor-default disabled:hover:bg-transparent`}
              >
                {open ? (
                  <ChevronDown size={14} aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} aria-hidden="true" />
                )}
                <span>{label}</span>
                {count}
              </button>
            ) : (
              <h3 id={headingId} className={`${headerClass} ${tone} m-0 font-medium`}>
                <span>{label}</span>
                {count}
              </h3>
            )}
            {open && (
              <SessionList
                sessions={list}
                selectedSessionId={selectedSessionId}
                onSelect={onSelect}
                taskInfoMap={taskInfoMap}
                onShowHierarchy={onShowHierarchy}
                showOwnership={showOwnership}
              />
            )}
          </section>
        );
      })}
    </>
  );
}
