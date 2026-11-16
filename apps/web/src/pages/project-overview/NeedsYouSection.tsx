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
import { useCallback, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';

import { buildRows, isPausedOnItem } from '../../components/inbox/inbox-model';
import { InboxRow } from '../../components/inbox/InboxRow';
import { useInboxCount, useInboxList } from '../../components/inbox/useInbox';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMinuteClock } from '../../hooks/useMinuteClock';
import { OVERVIEW_BEHIND_STATE, projectInboxItemFromOverviewPath } from '../../lib/project-routes';
import { Section, SectionHead } from './sections';

/**
 * Chats paused on one of the viewer's open inbox items, from the loaded list. `complete` is false
 * when the list has further pages the Overview did not fetch (more than one page of items): a
 * paused item may then sit past the first page, so the Overview read's own flag still counts.
 */
export interface ViewerPausedChats {
  ids: ReadonlySet<string>;
  complete: boolean;
}

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
  const complete = list.loaded && !list.hasNextPage;
  const pausedSessionIds = useMemo<ViewerPausedChats | null>(() => {
    if (!list.loaded) return null;
    const ids = new Set<string>();
    for (const item of list.items) {
      if (item.sessionId && isPausedOnItem(item)) ids.add(item.sessionId);
    }
    return { ids, complete };
  }, [list.items, list.loaded, complete]);
  return useMemo(() => ({ list, count, pausedSessionIds }), [list, count, pausedSessionIds]);
}

export type NeedsYou = ReturnType<typeof useNeedsYou>;

/** Approximate height of one row, so a loading list reserves its space instead of jumping. */
const ROW_HEIGHT_PX = 64;

/**
 * The item last opened from Needs you. Coming back to the Overview puts keyboard focus on its row
 * (or, once it is answered and gone, on the section), as the inbox's own Back does for its list.
 * Kept until the list has settled after the return: the cached list can still hold an answered
 * item while its refetch is in flight.
 */
let returnFocusRef: string | null = null;

/** `data-focus-target` of the Needs you section, in whichever form it is rendered. */
const FOCUS_TARGET = 'needs-you';

/**
 * Put focus where the person left. While the list is refetching, focus the row if it is still
 * there and keep the target; once settled, fall back to the section if the row is gone and focus
 * has not moved on to something else, then forget the target.
 */
function restoreReturnFocus(settled: boolean) {
  const ref = returnFocusRef;
  const container = document.querySelector<HTMLElement>(`[data-focus-target="${FOCUS_TARGET}"]`);
  if (!ref || !container) return;
  const row = [...container.querySelectorAll<HTMLElement>('[data-inbox-refs]')].find((candidate) =>
    (candidate.dataset.inboxRefs ?? '').split(' ').includes(ref)
  );
  if (row) {
    if (document.activeElement !== row) row.focus();
  } else if (settled) {
    const active = document.activeElement;
    if (!active || active === document.body || container.contains(active)) container.focus();
  }
  if (settled) returnFocusRef = null;
}

/** The section when there is no list to show: one quiet line, not an empty panel. */
function QuietLine({
  projectId,
  text,
  className,
  announce,
}: {
  projectId: string;
  text: string;
  className: string;
  /** Announce the text (a settled answer); a loading line stays silent. */
  announce: boolean;
}) {
  return (
    <Pane
      as="section"
      tabIndex={-1}
      data-focus-target={FOCUS_TARGET}
      aria-label="Needs you"
      className={`flex min-h-12 min-w-0 shrink-0 items-center gap-2 px-3.5 outline-none ${className}`}
      data-testid="overview-needs-you-quiet"
    >
      <h2 className="sr-only">Needs you</h2>
      <p
        role={announce ? 'status' : undefined}
        className="m-0 min-w-0 flex-1 text-sm text-fg-muted"
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
  const limit = isMobile ? NEEDS_YOU_ROWS_PHONE : NEEDS_YOU_ROWS_DESKTOP;
  const shown = rows.slice(0, limit);
  const open = useCallback(
    (item: InboxItem) => {
      returnFocusRef = item.ref;
      // The inbox item view's Back pops back here while this state is on its entry.
      navigate(projectInboxItemFromOverviewPath(projectId, item.ref), {
        state: { [OVERVIEW_BEHIND_STATE]: true },
      });
    },
    [navigate, projectId]
  );
  // Back from an item: put focus where the person left, following the list until it settles.
  const settled = list.loaded && !list.isFetching;
  useEffect(() => {
    if (list.loaded) restoreReturnFocus(settled);
  }, [list.loaded, list.items, settled]);

  const expected = count.data?.needsYou ?? 0;
  if (!list.loaded && !list.error && expected > 0) {
    // The count already says there are items: hold their space so nothing below jumps.
    return (
      <Section label="Needs you" className={className}>
        <SectionHead title="Needs you" count={expected} tone="attention" />
        <div
          aria-busy="true"
          style={{ minHeight: Math.min(expected, limit) * ROW_HEIGHT_PX }}
          data-testid="overview-needs-you-loading"
        />
      </Section>
    );
  }

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
        announce={list.loaded || Boolean(list.error)}
      />
    );
  }

  // The count route counts what the viewer can act on; until it answers, the list stands in.
  const total = count.data?.needsYou ?? list.items.length;
  const inbox = `/projects/${projectId}/inbox`;
  return (
    <Section label="Needs you" className={className} focusTarget={FOCUS_TARGET}>
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
