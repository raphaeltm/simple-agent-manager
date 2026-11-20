import { Button, Pane, Spinner } from '@simple-agent-manager/ui';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

import { buildRows } from '../../components/inbox/inbox-model';
import { InboxFilterBar } from '../../components/inbox/InboxFilterBar';
import { InboxHelpButton } from '../../components/inbox/InboxHelpButton';
import { type InboxReceipt, InboxReceiptRegion } from '../../components/inbox/InboxItemView';
import { InboxEmptyState, InboxRow } from '../../components/inbox/InboxRow';
import { InboxUpdatesList, useInboxUpdates } from '../../components/inbox/InboxUpdatesList';
import { useInboxCount } from '../../components/inbox/useInbox';
import { useInboxWalk } from '../../components/inbox/useInboxWalk';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMinuteClock } from '../../hooks/useMinuteClock';
import {
  INBOX_FROM_OVERVIEW,
  INBOX_FROM_PARAM,
  OVERVIEW_BEHIND_STATE,
  projectOverviewPath,
} from '../../lib/project-routes';
import { InboxItemPane, type InboxWalk as Walk } from './InboxItemPane';

/**
 * An item opened from the project Overview's Needs you (`?from=overview`): Back goes to the
 * Overview, in-app, so the page is not reloaded and shows the reduced count from the shared inbox
 * queries. When this history entry sits right on top of the Overview's (`OVERVIEW_BEHIND_STATE`:
 * the Overview pushed it and the walk has only replaced it since), Back pops it; otherwise (a
 * second item opened from the list, a fresh tab) it replaces this entry with the Overview.
 */
function useReturnToOverview(projectId: string | null) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const fromOverview = Boolean(projectId) && params.get(INBOX_FROM_PARAM) === INBOX_FROM_OVERVIEW;
  const overviewBehind =
    (location.state as Record<string, unknown> | null)?.[OVERVIEW_BEHIND_STATE] === true;
  const returnToOverview = useCallback(() => {
    if (!projectId) return;
    if (overviewBehind) navigate(-1);
    else navigate(projectOverviewPath(projectId), { replace: true });
  }, [navigate, overviewBehind, projectId]);
  return { fromOverview, returnToOverview };
}

function NoItemPane({ receipt, loading }: { receipt: InboxReceipt | null; loading: boolean }) {
  return (
    <>
      <InboxReceiptRegion receipt={receipt} />
      <div className="m-auto px-6 text-center text-sm text-fg-muted">
        {loading ? <Spinner size="sm" /> : 'You are all caught up.'}
      </div>
    </>
  );
}

function ListPane({
  walk,
  showProject,
  projectId,
  now,
}: {
  walk: Walk;
  showProject: boolean;
  projectId: string | null;
  now: number;
}) {
  const rows = useMemo(() => buildRows(walk.order), [walk.order]);
  if (walk.view === 'updates')
    return <InboxUpdatesList projectId={projectId} showProject={showProject} now={now} />;
  const { list } = walk;
  if (!list.loaded) {
    return list.error ? (
      <div role="alert" className="flex flex-col items-start gap-2 px-4 py-6">
        <p className="m-0 text-sm text-danger-fg [overflow-wrap:anywhere]">
          Could not load the inbox: {list.error.message}
        </p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void list.refetch()}
          className="min-h-11"
        >
          Retry
        </Button>
      </div>
    ) : (
      <div className="flex justify-center py-10" role="status" aria-label="Loading inbox">
        <Spinner size="sm" />
      </div>
    );
  }
  if (rows.length === 0)
    return (
      <InboxEmptyState
        view={walk.view}
        onShowUpdates={walk.view === 'needs_you' ? () => walk.setView('updates') : undefined}
      />
    );
  return (
    <>
      <ul className="m-0 flex flex-col gap-1 p-2" aria-label="Items">
        {rows.map((row) => (
          <InboxRow
            key={row.key}
            row={row}
            selectedRef={walk.selectedRef}
            showProject={showProject}
            now={now}
            onOpen={walk.open}
          />
        ))}
      </ul>
      {list.hasNextPage && (
        <div className="flex justify-center pb-3">
          <button
            type="button"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            className="min-h-11 cursor-pointer border-0 bg-transparent px-3 text-sm text-accent disabled:opacity-60"
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * The Inbox (spec idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9 section 4.1), across every project
 * (`projectId` null) or for one project. Phone: the list, then an item full screen with previous
 * / next. Desktop: the list beside the open item. One DOM tree arranged by CSS, so crossing the
 * breakpoint never remounts the open item or its half-typed answer.
 */
export function InboxPage({
  projectId,
  projectName,
}: {
  projectId: string | null;
  projectName?: string;
}) {
  const isMobile = useIsMobile();
  const now = useMinuteClock();
  const walk = useInboxWalk({ projectId, isMobile });
  const { fromOverview, returnToOverview } = useReturnToOverview(projectId);
  const count = useInboxCount(projectId);
  const { unread } = useInboxUpdates(projectId);
  const showProject = projectId === null;
  const itemOpenOnPhone = walk.itemParam !== null;
  const updates = walk.view === 'updates';
  const counts = {
    needs_you: count.data?.needsYou,
    blocking: count.data?.blocking,
    updates: unread,
  };

  return (
    <div
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-[var(--sam-space-gutter)]"
      data-testid="inbox-page"
    >
      <Pane
        as="header"
        variant="slab"
        // relative z-20: the ⋯ menu and the ? note drop out of this pane and must paint over the
        // panes below. Desktop keeps everything on one row (title, ?, chips, ⋯) so the header
        // does not spend lines on chrome; the page's purpose sits behind the ?.
        className={`relative z-20 shrink-0 flex-col gap-3 px-3 py-3 md:flex md:flex-row md:items-center md:gap-3 md:px-5 ${itemOpenOnPhone ? 'hidden' : 'flex'}`}
      >
        {fromOverview && (
          <button
            type="button"
            onClick={returnToOverview}
            className="-my-1 -ml-1 flex min-h-11 w-fit shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1 text-sm text-fg-muted hover:text-fg-primary"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            {/* Icon-only between md and lg, so the one-row header leaves the chips room. */}
            <span className="md:max-lg:sr-only">Back to Overview</span>
          </button>
        )}
        <div className="hidden shrink-0 items-center gap-0.5 md:flex">
          <h1 className="m-0 text-2xl font-bold text-fg-primary">Inbox</h1>
          <InboxHelpButton
            text={
              projectId
                ? `What your agents need from you in ${projectName ?? 'this project'}.`
                : 'Everything your agents need from you, across projects.'
            }
          />
        </div>
        <h1 className="sr-only md:hidden">Inbox</h1>
        <div className="min-w-0 md:flex-1">
          <InboxFilterBar value={walk.view} onChange={walk.setView} counts={counts} />
        </div>
      </Pane>
      <div
        className={`grid min-h-0 flex-1 gap-[var(--sam-space-gutter)] ${
          updates
            ? 'grid-cols-1'
            : 'md:grid-cols-[minmax(0,320px)_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]'
        }`}
      >
        {/* The pane is the frame, the inner div scrolls: a pane that scrolls itself carries its
            rim and blur away with the content (sam-glass-design-system.md, "Scrolling panes"). */}
        <Pane
          className={`min-h-0 min-w-0 flex-col overflow-hidden md:flex ${itemOpenOnPhone && !updates ? 'hidden' : 'flex'}`}
          aria-label="Inbox list"
        >
          <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
            {/* On a phone with nothing open the receipt shows above the list; on desktop the
                item pane shows it. */}
            {isMobile && <InboxReceiptRegion receipt={walk.itemParam ? null : walk.receipt} />}
            <ListPane walk={walk} showProject={showProject} projectId={projectId} now={now} />
          </div>
        </Pane>
        {!updates && (
          <Pane
            className={`min-h-0 min-w-0 flex-col md:flex ${itemOpenOnPhone ? 'flex' : 'hidden'}`}
            aria-label="Inbox item"
          >
            {walk.selected ? (
              <InboxItemPane
                walk={walk}
                item={walk.selected}
                now={now}
                focusOnMount={walk.itemParam !== null}
                onBackToOverview={fromOverview ? returnToOverview : null}
              />
            ) : (
              <NoItemPane
                receipt={isMobile ? null : walk.receipt}
                loading={Boolean(walk.itemParam) && walk.detail.isLoading}
              />
            )}
          </Pane>
        )}
      </div>
    </div>
  );
}
