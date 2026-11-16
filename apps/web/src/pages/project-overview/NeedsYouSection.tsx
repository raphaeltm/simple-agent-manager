/**
 * "Needs you" on the Project Overview (inbox slice F2, spec idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9
 * section 4.2): the first rows of this project's inbox for the viewer, in inbox order, with the
 * count and a link to the project inbox. It is the inbox itself, not a copy: the same queries
 * (`useInboxList` / `useInboxCount`, refreshed by the notification socket, no polling), the same
 * rows (`InboxRow`, `buildRows`) and the same item view, which a row opens.
 */
import type { InboxItem } from '@simple-agent-manager/shared';
import { Pane } from '@simple-agent-manager/ui';
import { ChevronRight } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';

import { buildRows, isPausedOnItem } from '../../components/inbox/inbox-model';
import { InboxRow } from '../../components/inbox/InboxRow';
import { useInboxCount, useInboxList } from '../../components/inbox/useInbox';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMinuteClock } from '../../hooks/useMinuteClock';
import { projectInboxItemFromOverviewPath } from '../../lib/project-routes';
import { Section, SectionHead } from './sections';

/** Rows shown before "All N": three keep Running now on a phone's first screen. */
export const NEEDS_YOU_ROWS_PHONE = 3;
export const NEEDS_YOU_ROWS_DESKTOP = 5;

/**
 * This project's open inbox items for the viewer, and the chats they pause. Read once by the
 * Overview and handed to Needs you and Running now, so the two sections word the same chat the
 * same way ("paused on this").
 */
export function useNeedsYou(projectId: string) {
  const list = useInboxList(projectId, 'needs_you');
  const count = useInboxCount(projectId);
  const pausedSessionIds = useMemo(() => {
    if (!list.loaded) return null;
    const ids = new Set<string>();
    for (const item of list.items) {
      if (item.sessionId && isPausedOnItem(item)) ids.add(item.sessionId);
    }
    return ids;
  }, [list.items, list.loaded]);
  return { list, count, pausedSessionIds };
}

export type NeedsYou = ReturnType<typeof useNeedsYou>;

/** The section when there is no list to show: one quiet line, not an empty panel. */
function QuietLine({
  projectId,
  text,
  className,
  alert,
}: {
  projectId: string;
  text: string;
  className: string;
  alert?: boolean;
}) {
  return (
    <Pane
      as="section"
      aria-label="Needs you"
      className={`flex min-h-12 min-w-0 shrink-0 items-center gap-2 px-3.5 ${className}`}
      data-testid="overview-needs-you-quiet"
    >
      <p
        role={alert ? 'alert' : 'status'}
        className={`m-0 min-w-0 flex-1 text-sm ${alert ? 'text-danger-fg' : 'text-fg-muted'}`}
      >
        {text}
      </p>
      <Link
        to={`/projects/${projectId}/inbox`}
        aria-label="Open the project inbox"
        className="-mr-1.5 flex min-h-11 shrink-0 items-center gap-0.5 rounded-md px-2 text-[13px] text-fg-muted no-underline hover:text-fg-primary"
      >
        Inbox
        <ChevronRight size={14} aria-hidden="true" />
      </Link>
    </Pane>
  );
}

export function NeedsYouSection({
  projectId,
  needsYou,
  className = '',
}: {
  projectId: string;
  needsYou: NeedsYou;
  className?: string;
}) {
  const isMobile = useIsMobile();
  const now = useMinuteClock();
  const navigate = useNavigate();
  const { list, count } = needsYou;
  const rows = useMemo(() => buildRows(list.items), [list.items]);
  const shown = rows.slice(0, isMobile ? NEEDS_YOU_ROWS_PHONE : NEEDS_YOU_ROWS_DESKTOP);
  const open = useCallback(
    (item: InboxItem) => navigate(projectInboxItemFromOverviewPath(projectId, item.ref)),
    [navigate, projectId]
  );

  if (rows.length === 0) {
    const text = list.loaded
      ? 'Nothing needs you.'
      : list.error
        ? 'Couldn’t load what needs you. It will retry.'
        : 'Checking what needs you…';
    return (
      <QuietLine
        projectId={projectId}
        text={text}
        className={className}
        alert={!list.loaded && Boolean(list.error)}
      />
    );
  }

  // The count route counts what the viewer can act on; until it answers, the list stands in.
  const total = count.data?.needsYou ?? list.items.length;
  const inbox = `/projects/${projectId}/inbox`;
  return (
    <Section label="Needs you" className={className}>
      <SectionHead
        title="Needs you"
        count={total}
        tone="attention"
        to={inbox}
        linkLabel={`All ${total}`}
      />
      <ul className="m-0 flex flex-col gap-1 p-0" data-testid="overview-needs-you-list">
        {shown.map((row) => (
          <InboxRow key={row.key} row={row} showProject={false} now={now} onOpen={open} />
        ))}
      </ul>
    </Section>
  );
}
