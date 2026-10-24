/**
 * The chat tool rail's "Related" panel: the ideas, library files and pull requests this chat is
 * related to, with the relation in plain words.
 *
 * Same shape as the Resources and Automation drawers — a right-side rail on desktop, full
 * screen on a phone — so the rail's tools behave alike and desktop/mobile stay at parity
 * (`.claude/rules/15-nav-parity.md`). It reads the query `useSessionLinkedWork` already owns,
 * so opening it issues no request of its own.
 */
import { Spinner } from '@simple-agent-manager/ui';
import { FileText, GitPullRequest, Lightbulb, Link2, X } from 'lucide-react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';

import {
  describeRelations,
  formatCappedTotal,
  LinkedWorkRow,
  PullRequestStateBadge,
} from '../linked-work';
import type { SessionLinkedWork } from '../project-message-view/useSessionLinkedWork';
import { useDialogFocusTrap } from './useDialogFocusTrap';

const IDEA_ACCENT = 'var(--sam-color-accent-primary)';
const FILE_ACCENT = 'var(--sam-color-info-fg)';
const PR_ACCENT = 'var(--sam-color-purple)';

/**
 * A group heading with its count.
 *
 * The count is `formatCappedTotal`, so a list the server could only bound renders "4+" rather
 * than claiming an exact 4 (linked-work program decision 9).
 */
function GroupHeading({
  label,
  count,
  truncated,
}: Readonly<{ label: string; count: string; truncated: boolean }>) {
  return (
    <div className="flex items-baseline gap-2 px-3 pb-1 pt-3">
      {/* The count sits beside the label, not at the far right: across a 460px panel the two
          stopped reading as one fact. */}
      <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-muted">
        {label}
      </h3>
      <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-fg-muted">
        {count}
      </span>
      {truncated && <span className="sr-only">Showing the most recent only</span>}
    </div>
  );
}

/** Joins the non-empty parts of a meta line, so a missing part leaves no stray separator. */
function metaLine(...parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.length > 0)).join(' · ');
}

function LinkedWorkSections({
  projectId,
  linkedWork,
}: Readonly<{ projectId: string; linkedWork: SessionLinkedWork }>) {
  const { ideas, files, pullRequests } = linkedWork;
  return (
    <>
      {ideas.items.length > 0 && (
        <section aria-label="Related ideas">
          <GroupHeading
            label="Ideas"
            count={formatCappedTotal(ideas)}
            truncated={ideas.truncated}
          />
          {ideas.items.map((idea) => (
            <LinkedWorkRow
              key={idea.ideaId}
              icon={Lightbulb}
              accent={IDEA_ACCENT}
              title={idea.title}
              meta={describeRelations(idea.relations)}
              to={`/projects/${projectId}/ideas/${idea.ideaId}`}
              testId="linked-work-idea"
            />
          ))}
        </section>
      )}

      {files.items.length > 0 && (
        <section aria-label="Related files">
          <GroupHeading
            label="Files"
            count={formatCappedTotal(files)}
            truncated={files.truncated}
          />
          {files.items.map((file) => (
            <LinkedWorkRow
              key={file.fileId}
              icon={FileText}
              accent={FILE_ACCENT}
              title={file.filename}
              meta={metaLine(describeRelations(file.relations), file.directory)}
              // The library page opens a preview straight from the URL.
              to={`/projects/${projectId}/library?preview=${encodeURIComponent(file.fileId)}`}
              testId="linked-work-file"
            />
          ))}
        </section>
      )}

      {pullRequests.items.length > 0 && (
        <section aria-label="Related pull requests">
          <GroupHeading
            label="Pull requests"
            count={formatCappedTotal(pullRequests)}
            truncated={pullRequests.truncated}
          />
          {pullRequests.items.map((pr) => (
            <LinkedWorkRow
              key={pr.url}
              icon={GitPullRequest}
              accent={PR_ACCENT}
              // The title arrives with the PR's state. Without it the number is all SAM knows,
              // so the row says that instead of inventing a name.
              title={pr.state?.title ?? `Pull request #${pr.number}`}
              meta={`#${pr.number}`}
              trailing={<PullRequestStateBadge state={pr.state} />}
              href={pr.url}
              testId="linked-work-pr"
            />
          ))}
        </section>
      )}
    </>
  );
}

/** What links are, for someone who has never seen one. */
function EmptyState() {
  return (
    <div className="px-4 py-8 text-center" data-testid="linked-work-empty">
      <Link2 size={22} aria-hidden="true" className="mx-auto mb-2 text-fg-muted opacity-60" />
      <p className="m-0 text-sm font-semibold text-fg-primary">Nothing related yet</p>
      <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-fg-muted">
        SAM keeps track of what a chat touches: the ideas it works on, the library files it adds or
        reads, and the pull requests it opens. They show up here as the work happens.
      </p>
    </div>
  );
}

function ErrorState({ onRetry }: Readonly<{ onRetry: () => void }>) {
  return (
    <div className="px-4 py-8 text-center" data-testid="linked-work-error">
      <p className="m-0 text-sm font-semibold text-fg-primary">Couldn&apos;t load related work</p>
      <p className="m-0 mt-1.5 text-[13px] text-fg-muted">
        The rest of the chat is unaffected. Try again in a moment.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex min-h-11 cursor-pointer items-center rounded-md border border-border-default bg-transparent px-3 text-xs font-medium text-fg-primary transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
      >
        Try again
      </button>
    </div>
  );
}

export function SessionLinkedWorkDrawer({
  projectId,
  linkedWork,
  onClose,
}: Readonly<{ projectId: string; linkedWork: SessionLinkedWork; onClose: () => void }>) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(panelRef, onClose);

  const hasItems =
    linkedWork.ideas.items.length > 0 ||
    linkedWork.files.items.length > 0 ||
    linkedWork.pullRequests.items.length > 0;

  return createPortal(
    <>
      <div
        className="hidden md:block fixed inset-0 glass-backdrop-dim z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Related work"
        data-testid="session-linked-work-drawer"
        className="glass-panel-container glass-composited fixed z-50 glass-modal flex flex-col overflow-hidden rounded-l-[20px] rounded-r-none border-y-0 border-r-0 shadow-xl
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:w-[400px] lg:w-[460px]"
      >
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border-default px-3 py-1">
          <Link2 size={18} className="shrink-0 text-fg-muted" aria-hidden="true" />
          <h2 className="m-0 min-w-0 flex-1 text-[15px] font-semibold text-fg-primary">
            Related work
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-md bg-transparent text-fg-muted transition-colors hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary"
            aria-label="Close related work"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          {/* Spinner only before the first result. A refetch keeps the list on screen
              (`apps/web/.claude/rules/48-stale-while-revalidate-ui.md`). */}
          {linkedWork.isLoading ? (
            <div role="status" className="flex items-center justify-center py-10">
              <Spinner size="sm" />
              <span className="sr-only">Loading related work</span>
            </div>
          ) : linkedWork.isError ? (
            <ErrorState onRetry={linkedWork.refetch} />
          ) : hasItems ? (
            <LinkedWorkSections projectId={projectId} linkedWork={linkedWork} />
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    </>,
    document.body
  );
}
