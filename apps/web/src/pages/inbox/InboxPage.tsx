import type { InboxItem } from '@simple-agent-manager/shared';
import { IconButton, Pane, Spinner } from '@simple-agent-manager/ui';
import { Archive, ArrowLeft, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';

import { buildRows, stackPosition } from '../../components/inbox/inbox-model';
import {
  InboxAnswerControls,
  InboxPermissionSummary,
  useInboxPermissionDetail,
} from '../../components/inbox/InboxAnswerControls';
import { InboxFilterBar } from '../../components/inbox/InboxFilterBar';
import {
  InboxItemBody,
  type InboxReceipt,
  InboxReceiptLine,
} from '../../components/inbox/InboxItemView';
import { InboxEmptyState, InboxRow } from '../../components/inbox/InboxRow';
import { InboxUpdatesList, useInboxUpdates } from '../../components/inbox/InboxUpdatesList';
import { useInboxCount } from '../../components/inbox/useInbox';
import { useInboxWalk, useMinuteClock } from '../../components/inbox/useInboxWalk';
import { useIsMobile } from '../../hooks/useIsMobile';
import { projectChatPath } from '../../lib/project-routes';

type Walk = ReturnType<typeof useInboxWalk>;

/** The open item: top bar, receipt, scrolling body and pinned answer controls. */
function ItemPane({ walk, item, now }: { walk: Walk; item: InboxItem; now: number }) {
  const navigate = useNavigate();
  const permission = useInboxPermissionDetail(item);
  const index = walk.order.findIndex((candidate) => candidate.ref === item.ref);
  const position = stackPosition(walk.order, item);
  const prev = index > 0 ? walk.order[index - 1] : undefined;
  const next = index >= 0 ? walk.order[index + 1] : undefined;
  const { onAnswered, onStale } = walk;
  const handlers = useMemo(
    () => ({
      onAnswered: (text: string) => onAnswered(item.ref, text),
      onStale: () => onStale(item.ref),
    }),
    [item.ref, onAnswered, onStale]
  );
  const context = walk.detail.data?.item.ref === item.ref ? walk.detail.data.context : null;
  const canArchive = item.status === 'open' && item.canAct;
  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--sam-hairline)] px-1 py-1">
        <IconButton
          label="Back to inbox"
          icon={<ArrowLeft size={20} />}
          onClick={walk.close}
          showTooltip={false}
          className="md:hidden"
        />
        <span className="flex flex-1 items-center justify-center md:justify-start">
          <IconButton
            label="Previous item"
            icon={<ChevronLeft size={20} />}
            disabled={!prev}
            onClick={() => prev && walk.step(prev)}
            showTooltip={false}
          />
          {!position && index >= 0 && (
            <span
              className="font-mono text-xs text-fg-muted"
              aria-label={`Item ${index + 1} of ${walk.order.length}`}
            >
              {index + 1}/{walk.order.length}
            </span>
          )}
          <IconButton
            label="Next item"
            icon={<ChevronRight size={20} />}
            disabled={!next}
            onClick={() => next && walk.step(next)}
            showTooltip={false}
          />
        </span>
        {canArchive && (
          <IconButton
            label="Archive: close it and tell the agent"
            icon={<Archive size={18} />}
            onClick={() => walk.archiveItem(item)}
            showTooltip={false}
          />
        )}
        {item.sessionId && (
          <IconButton
            label="Open chat"
            icon={<MessageSquare size={18} />}
            onClick={() =>
              item.sessionId && navigate(projectChatPath(item.projectId, item.sessionId))
            }
            showTooltip={false}
          />
        )}
      </div>
      {walk.receipt && <InboxReceiptLine receipt={walk.receipt} />}
      <div className="relative min-h-0 flex-1 overflow-y-auto" data-testid="inbox-item-scroll">
        <div className="mx-auto flex w-full max-w-[680px] min-w-0 flex-col gap-3 px-4 py-4">
          <InboxItemBody item={item} context={context} now={now} stackPosition={position} />
          {item.answerSpec.type === 'interaction' && (
            <InboxPermissionSummary detail={permission.detail} />
          )}
        </div>
      </div>
      <div
        className="shrink-0 border-t border-[var(--sam-hairline)] px-4 py-3"
        data-testid="inbox-pinned-controls"
      >
        <div className="mx-auto w-full max-w-[680px] min-w-0">
          <InboxAnswerControls item={item} permission={permission} handlers={handlers} />
        </div>
      </div>
    </>
  );
}

function NoItemPane({ receipt, loading }: { receipt: InboxReceipt | null; loading: boolean }) {
  return (
    <>
      {receipt && <InboxReceiptLine receipt={receipt} />}
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
      <p role="alert" className="m-0 px-4 py-6 text-sm text-danger-fg">
        Could not load the inbox: {list.error.message}
      </p>
    ) : (
      <div className="flex justify-center py-10" role="status" aria-label="Loading inbox">
        <Spinner size="sm" />
      </div>
    );
  }
  if (rows.length === 0)
    return (
      <InboxEmptyState
        archived={walk.view === 'archived'}
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
        className={`shrink-0 flex-col gap-3 px-3 py-3 md:flex md:px-5 md:py-4 ${itemOpenOnPhone ? 'hidden' : 'flex'}`}
      >
        <div className="hidden md:block">
          <h1 className="m-0 text-2xl font-bold text-fg-primary">Inbox</h1>
          <p className="m-0 mt-0.5 text-sm text-fg-muted">
            {projectId
              ? `What your agents need from you in ${projectName ?? 'this project'}.`
              : 'Everything your agents need from you, across projects.'}
          </p>
        </div>
        <h1 className="sr-only md:hidden">Inbox</h1>
        <InboxFilterBar value={walk.view} onChange={walk.setView} counts={counts} />
      </Pane>
      <div
        className={`grid min-h-0 flex-1 gap-[var(--sam-space-gutter)] ${
          updates
            ? 'grid-cols-1'
            : 'md:grid-cols-[minmax(0,320px)_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]'
        }`}
      >
        <Pane
          className={`relative min-h-0 min-w-0 flex-col overflow-y-auto md:flex ${itemOpenOnPhone && !updates ? 'hidden' : 'flex'}`}
          aria-label="Inbox list"
        >
          {/* On a phone with nothing open the receipt shows above the list; on desktop the item
              pane shows it. */}
          {isMobile && !walk.itemParam && walk.receipt && (
            <InboxReceiptLine receipt={walk.receipt} />
          )}
          <ListPane walk={walk} showProject={showProject} projectId={projectId} now={now} />
        </Pane>
        {!updates && (
          <Pane
            className={`min-h-0 min-w-0 flex-col md:flex ${itemOpenOnPhone ? 'flex' : 'hidden'}`}
            aria-label="Inbox item"
          >
            {walk.selected ? (
              <ItemPane walk={walk} item={walk.selected} now={now} />
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
