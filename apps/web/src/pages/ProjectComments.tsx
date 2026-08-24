import { Spinner } from '@simple-agent-manager/ui';
import { MessageSquareQuote } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { useAuth } from '../components/AuthProvider';
import {
  COMMENT_BUCKET_COLORS,
  COMMENT_BUCKET_LABELS,
  type CommentInboxFilter,
  countBuckets,
  filterInbox,
  groupInbox,
} from '../components/project-message-view/comments/comment-inbox';
import { CommentInboxFilters } from '../components/project-message-view/comments/CommentInboxFilters';
import { CommentInboxRow } from '../components/project-message-view/comments/CommentInboxRow';
import { useProjectCommentInbox } from '../components/project-message-view/comments/useProjectCommentInbox';
import { useProjectContext } from './ProjectContext';

/**
 * Project-wide comment inbox.
 *
 * Comments are the only thing in SAM that can be addressed *to* a person and
 * still have nowhere for that person to look. Chat has a list, Ideas has a
 * board, Notifications has a page — comments had only the message they were
 * attached to. This is that missing surface: every unresolved thread in the
 * project, from chat and from the library, in triage order.
 *
 * Selecting a thread navigates to where it lives rather than opening it here,
 * so a comment is always read in the context that gives it meaning.
 */
export function ProjectComments() {
  const { projectId } = useProjectContext();
  const navigate = useNavigate();
  const { user } = useAuth();
  const viewerId = user?.id ?? null;

  const inbox = useProjectCommentInbox(projectId);
  const counts = useMemo(() => countBuckets(inbox.items, viewerId), [inbox.items, viewerId]);
  const [filter, setFilter] = useState<CommentInboxFilter>('all');

  // "All" groups by bucket so the page reads as a triage queue; a specific
  // filter is already one bucket, so it renders as a flat recency list.
  const groups = useMemo(
    () =>
      filter === 'all'
        ? groupInbox(inbox.items, viewerId)
        : [{ bucket: filter, items: filterInbox(inbox.items, filter, viewerId) }],
    [inbox.items, filter, viewerId]
  );
  const showLoading = inbox.loading;
  const showEmpty = !showLoading && counts.all === 0;
  const showGroups = !showLoading && !showEmpty;

  const open = (item: (typeof inbox.items)[number]) => {
    if (item.source.kind === 'session') {
      navigate(`/projects/${projectId}/chat/${item.source.sessionId}`);
    } else {
      navigate(`/projects/${projectId}/library?file=${item.source.fileId}`);
    }
  };

  return (
    // `w-full min-w-0 max-w-3xl mx-auto` matches every sibling Project* page.
    // Without min-w-0 a flex child floors at its min-content width, which is what
    // rule 56 is about; without max-w-3xl the rows stretch edge to edge on a wide
    // screen and the count pill detaches from the heading it belongs to.
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h1 className="m-0 text-xl font-semibold text-fg-primary">Comments</h1>
        {counts.needs_you > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              backgroundColor: 'var(--sam-color-warning-tint)',
              color: 'var(--sam-color-warning-fg)',
            }}
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
            {counts.needs_you} need{counts.needs_you === 1 ? 's' : ''} you
          </span>
        )}
      </div>

      <CommentInboxFilters value={filter} counts={counts} onChange={setFilter} />

      {/*
        Disclose the page cap before the buckets, not after them. A reader who
        only checks "Needs you" should still see that the page is a capped view.
      */}
      {inbox.truncated && (
        <p className="m-0 rounded-md border border-border-default bg-surface px-3 py-2 text-xs text-fg-muted">
          Showing the {inbox.shownCount} most recently active of {inbox.totalCount} comments.
        </p>
      )}

      {showLoading && (
        <div className="flex items-center justify-center gap-2 py-12">
          <Spinner size="md" />
          <span className="text-sm text-fg-muted">Loading comments…</span>
        </div>
      )}
      {showEmpty && (
        <EmptyProjectInbox />
      )}
      {showGroups && (
        <div className="flex min-w-0 flex-col gap-5">
          {groups.map((group) => (
            <section key={group.bucket} className="min-w-0">
              <h2 className="m-0 mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: COMMENT_BUCKET_COLORS[group.bucket] }}
                />
                <span className="text-fg-muted">{COMMENT_BUCKET_LABELS[group.bucket]}</span>
                <span className="text-fg-muted opacity-70 tabular-nums">{group.items.length}</span>
              </h2>

              {group.items.length === 0 ? (
                <p className="m-0 rounded-md border border-border-default bg-surface px-4 py-6 text-center text-sm text-fg-muted">
                  Nothing in this bucket.
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-border-default overflow-hidden rounded-md border border-border-default bg-surface p-0">
                  {group.items.map((item) => (
                    <li key={item.thread.id} className="min-w-0">
                      <CommentInboxRow
                        item={item}
                        viewerId={viewerId}
                        showSource
                        showBucket={false}
                        onSelect={() => open(item)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyProjectInbox() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-border-default bg-surface py-14 text-center">
      <MessageSquareQuote size={24} className="text-fg-muted opacity-40" />
      <p className="m-0 text-sm text-fg-primary">No comments in this project yet</p>
      <p className="m-0 max-w-sm px-6 text-xs text-fg-muted">
        Select text in any chat message or library file to leave a comment. They will collect here
        so you can see what is still waiting on you.
      </p>
    </div>
  );
}
