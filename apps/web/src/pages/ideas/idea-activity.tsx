/**
 * What happened to an idea: Work — every chat and pull request for it — and Updates, the
 * notes people and agents left along the way.
 *
 * Separate from `idea-sections.tsx`, which holds the idea itself (its status, its plan and
 * what linked itself to it). That is the design's own line: the idea's text is the current
 * plan, and the history of it lives beside rather than inside it.
 */
import { Button } from '@simple-agent-manager/ui';
import {
  GitMerge,
  GitPullRequest,
  Lightbulb,
  MessageSquare,
  Quote,
  SendHorizontal,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';

import { LinkedWorkRow, PullRequestStateBadge } from '../../components/linked-work';
import type { IdeaDetail, IdeaLinkedSession, IdeaUpdateNote } from '../../lib/api';
import { projectChatPath } from '../../lib/project-routes';
import { sanitizeUrl } from '../../lib/url-utils';
import { Panel, SectionTitle } from '../automation/ui';
import type { IdeaTimelineEntry } from './idea-timeline';
import { LiveDot } from './parts';
import { relativeTime } from './view-model';

/** How much of a note the composer accepts. Long enough for a paragraph, not an essay. */
export const DEFAULT_IDEA_UPDATE_MAX_LENGTH = 4_000;
export const IDEA_UPDATE_MAX_LENGTH = Number.parseInt(
  import.meta.env.VITE_IDEA_UPDATE_MAX_LENGTH || String(DEFAULT_IDEA_UPDATE_MAX_LENGTH),
  10
);

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

function workOutcome(session: IdeaLinkedSession): { text: string; tone: string } {
  switch (session.taskStatus) {
    case 'failed':
      return {
        text: session.taskErrorMessage ?? 'Stopped before it finished',
        tone: 'text-danger-fg',
      };
    case 'completed':
      return { text: 'Finished', tone: 'text-success-fg' };
    case 'cancelled':
      return { text: 'Stopped on purpose', tone: 'text-fg-muted' };
    case 'sleeping':
      return { text: 'Asleep, will wake', tone: 'text-info-fg' };
    case null:
      return {
        text: session.sessionStatus === 'active' ? 'Talking it through' : 'Ended',
        tone: 'text-fg-muted',
      };
    default:
      return { text: 'Working', tone: 'text-info-fg' };
  }
}

/**
 * Every chat and pull request for this idea, and what each one produced.
 *
 * Rows render through T4's shared `LinkedWorkRow` and `PullRequestStateBadge`, so a chat or a
 * pull request reads the same here as in the chat's Related panel and the library file's
 * Linked strip (`.claude/rules/24`). These rows were hand-built first and drifted in three
 * ways worth naming: the title did not clamp to two lines, the pull-request state was spelled
 * out in a nested ternary instead of the shared pill, and the pull-request href was passed
 * through raw — `tasks.output_pr_url` is agent-reported, and the shared row is where
 * `sanitizeUrl` runs.
 */
export function IdeaWork({ idea, projectId }: { idea: IdeaDetail; projectId: string }) {
  const total = idea.sessions.length + idea.pullRequests.length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SectionTitle title="Work" count={total} hint="Chats and pull requests for this idea" />
      <Panel label="Work" className="overflow-hidden">
        {total === 0 ? (
          <p className="m-0 px-4 py-6 text-sm text-fg-muted">
            Nothing has worked on this yet. Starting work links the chat here.
          </p>
        ) : (
          <>
            {idea.sessions.map((session) => {
              const outcome = workOutcome(session);
              const live = session.taskStatus === 'in_progress' || session.taskStatus === 'queued';
              return (
                <LinkedWorkRow
                  key={session.sessionId}
                  icon={MessageSquare}
                  accent="var(--sam-color-info-fg)"
                  title={session.topic ?? 'Untitled chat'}
                  meta={session.agentLabel ?? 'An agent'}
                  trailing={
                    <span className={`inline-flex items-center gap-1.5 font-medium ${outcome.tone}`}>
                      {live && <LiveDot />}
                      <span className="line-clamp-1 break-words">{outcome.text}</span>
                    </span>
                  }
                  timestamp={
                    session.lastActivityAt
                      ? relativeTime(new Date(session.lastActivityAt).toISOString())
                      : undefined
                  }
                  to={projectChatPath(projectId, session.sessionId)}
                />
              );
            })}
            {idea.pullRequests.map((pullRequest) => (
              <LinkedWorkRow
                key={pullRequest.url}
                icon={pullRequest.state === 'merged' ? GitMerge : GitPullRequest}
                accent={
                  pullRequest.state === 'merged'
                    ? 'var(--sam-color-success-fg)'
                    : 'var(--sam-color-purple)'
                }
                title={pullRequest.title ?? `Pull request #${pullRequest.number}`}
                meta={`PR #${pullRequest.number}`}
                /*
                 * Checks only while the pull request can still change. Once it is merged or
                 * closed they cannot alter the outcome, and on this row the green "Checks
                 * passed" sat at equal weight beside the purple "Merged" and read louder than
                 * it (ui-ux-specialist, 2026-10-24). The chat surfaces keep them on a decided
                 * PR on purpose, which is why this is a prop here rather than a change to the
                 * shared badge (`.claude/rules/67`).
                 */
                trailing={
                  <PullRequestStateBadge
                    state={pullRequest}
                    showChecks={pullRequest.state === 'open'}
                  />
                }
                href={pullRequest.url}
              />
            ))}
          </>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

function UpdateRow({ update, projectId }: { update: IdeaUpdateNote; projectId: string }) {
  const author = update.authorName ?? (update.authorKind === 'agent' ? 'An agent' : 'Someone');
  return (
    <li className="flex min-w-0 gap-3 border-0 border-b border-solid border-border-default px-4 py-3.5 last:border-b-0">
      <span
        className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border-default text-fg-muted"
        aria-hidden
      >
        {update.authorKind === 'agent' ? <Lightbulb size={15} /> : <MessageSquare size={15} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold text-fg-primary">{author}</span>
          {update.sessionId && (
            <Link
              to={projectChatPath(projectId, update.sessionId)}
              className="min-w-0 truncate text-xs text-accent no-underline hover:underline"
            >
              {update.sessionTopic ?? 'in a chat'}
            </Link>
          )}
          <span className="ml-auto shrink-0 text-xs text-fg-muted">
            {relativeTime(update.createdAt)}
          </span>
        </div>
        {update.quote && (
          <div className="flex min-w-0 items-start gap-2 rounded-lg border-0 border-l-2 border-solid border-accent bg-accent-tint px-3 py-2 text-[13px] text-fg-muted">
            <Quote size={13} aria-hidden className="mt-0.5 shrink-0 opacity-70" />
            <span className="min-w-0 break-words italic">{update.quote}</span>
          </div>
        )}
        <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-primary [overflow-wrap:anywhere]">
          {update.body}
        </p>
      </div>
    </li>
  );
}

/**
 * What people and agents have said about the idea since it was filed, newest first.
 *
 * This is where the appended sections used to go. An update is a note beside the plan rather
 * than an edit to it, so the plan can stay true while its history stays readable.
 */
/**
 * One thing the work itself did, as opposed to something a person or agent wrote.
 *
 * Visually quieter than a note and carrying an icon rather than an author, so a reader can
 * tell at a glance which entries are commentary and which are events — they are different
 * kinds of claim and the timeline should not blur them.
 */
function LifecycleRow({
  entry,
  projectId,
}: {
  entry: Extract<IdeaTimelineEntry, { kind: 'lifecycle' }>;
  projectId: string;
}) {
  const Icon = entry.event === 'pull-request-merged' ? GitMerge : MessageSquare;
  const accent =
    entry.event === 'pull-request-merged' ? 'text-success-fg' : 'text-fg-muted';
  const body = (
    <>
      <span
        aria-hidden
        className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border-default ${accent}`}
      >
        <Icon size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 break-words text-[13px] font-medium text-fg-primary [overflow-wrap:anywhere]">
          {entry.text}
        </span>
        <span className="shrink-0 text-xs text-fg-muted">
          {relativeTime(new Date(entry.at).toISOString())}
        </span>
      </span>
    </>
  );
  const className =
    'flex min-w-0 items-start gap-3 border-0 border-b border-solid border-border-default px-4 py-3 no-underline last:border-b-0';
  if (entry.url) {
    return (
      <li className="min-w-0">
        <a
          href={sanitizeUrl(entry.url)}
          target="_blank"
          rel="noreferrer noopener"
          className={`${className} hover:bg-surface-hover`}
        >
          {body}
        </a>
      </li>
    );
  }
  if (entry.sessionId) {
    return (
      <li className="min-w-0">
        <Link
          to={projectChatPath(projectId, entry.sessionId)}
          className={`${className} hover:bg-surface-hover`}
        >
          {body}
        </Link>
      </li>
    );
  }
  return <li className={className}>{body}</li>;
}

export function IdeaUpdates({
  entries,
  total,
  projectId,
  onPost,
  posting,
  error,
  onRetry,
  canWrite,
}: {
  /** Notes and lifecycle events, already merged and newest first. */
  entries: IdeaTimelineEntry[] | undefined;
  /**
   * The whole timeline's size. A string so a truncated notes page can say "N+" rather than
   * assert a total it cannot support.
   */
  total: number | string | undefined;
  projectId: string;
  onPost: (body: string) => void;
  posting: boolean;
  error: unknown;
  onRetry: () => void;
  canWrite: boolean;
}) {
  const [draft, setDraft] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || posting) return;
    onPost(body);
    setDraft('');
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SectionTitle
        title="Updates"
        count={total ?? entries?.length}
        hint="What people, agents and the work itself did — newest first"
      />
      <Panel label="Updates" className="overflow-hidden">
        {canWrite && (
          <form
            className="flex items-center gap-2 border-0 border-b border-solid border-border-default p-3"
            onSubmit={submit}
          >
            <label className="sr-only" htmlFor="idea-update-composer">
              Add an update
            </label>
            <input
              id="idea-update-composer"
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Add an update…"
              maxLength={IDEA_UPDATE_MAX_LENGTH}
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-[var(--sam-form-border)] bg-inset px-3 text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              aria-label="Post update"
              disabled={draft.trim().length === 0 || posting}
              className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-accent text-fg-on-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <SendHorizontal size={17} aria-hidden />
            </button>
          </form>
        )}
        {error ? (
          <div className="flex flex-col gap-3 px-4 py-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="m-0 text-sm text-fg-muted">Could not load the updates.</p>
            <Button variant="secondary" onClick={onRetry} className="shrink-0">
              Try again
            </Button>
          </div>
        ) : entries === undefined ? (
          <p className="m-0 px-4 py-6 text-sm text-fg-muted">Loading the updates…</p>
        ) : entries.length === 0 ? (
          <p className="m-0 px-4 py-6 text-sm text-fg-muted">
            Nothing yet. Notes, and what the work does, appear here.
          </p>
        ) : (
          <ol className="m-0 list-none p-0">
            {entries.map((entry) =>
              entry.kind === 'note' ? (
                <UpdateRow key={entry.note.id} update={entry.note} projectId={projectId} />
              ) : (
                <LifecycleRow key={entry.id} entry={entry} projectId={projectId} />
              )
            )}
          </ol>
        )}
      </Panel>
    </div>
  );
}
