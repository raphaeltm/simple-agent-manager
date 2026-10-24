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

import type { IdeaDetail, IdeaLinkedSession, IdeaUpdateNote } from '../../lib/api';
import { Panel, SectionTitle } from '../automation/ui';
import { chatPath, LiveDot } from './parts';
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

/** Every chat and pull request for this idea, and what each one produced. */
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
                <Link
                  key={session.sessionId}
                  to={chatPath(projectId, session.sessionId)}
                  className="group flex min-h-16 w-full min-w-0 items-center gap-3 border-0 border-b border-solid border-border-default px-4 py-3 text-left no-underline last:border-b-0 hover:bg-surface-hover"
                >
                  <MessageSquare size={17} aria-hidden className="shrink-0 text-fg-muted" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="line-clamp-2 break-words text-[14px] font-semibold leading-snug text-fg-primary">
                      {session.topic ?? 'Untitled chat'}
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-fg-muted">
                      <span className="break-words">{session.agentLabel ?? 'An agent'}</span>
                      <span aria-hidden>·</span>
                      <span
                        className={`inline-flex items-center gap-1.5 font-medium ${outcome.tone}`}
                      >
                        {live && <LiveDot />}
                        <span className="line-clamp-1 break-words">{outcome.text}</span>
                      </span>
                    </span>
                  </span>
                  {session.lastActivityAt && (
                    <span className="shrink-0 self-start pt-0.5 text-xs text-fg-muted">
                      {relativeTime(new Date(session.lastActivityAt).toISOString())}
                    </span>
                  )}
                </Link>
              );
            })}
            {idea.pullRequests.map((pullRequest) => (
              <a
                key={pullRequest.url}
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer noopener"
                className="group flex min-h-16 w-full min-w-0 items-center gap-3 border-0 border-b border-solid border-border-default px-4 py-3 text-left no-underline last:border-b-0 hover:bg-surface-hover"
              >
                {pullRequest.state === 'merged' ? (
                  <GitMerge size={17} aria-hidden className="shrink-0 text-success-fg" />
                ) : (
                  <GitPullRequest size={17} aria-hidden className="shrink-0 text-purple" />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="line-clamp-2 break-words text-[14px] font-semibold leading-snug text-fg-primary">
                    {pullRequest.title ?? `Pull request #${pullRequest.number}`}
                  </span>
                  <span className="text-[13px] text-fg-muted">
                    PR #{pullRequest.number} ·{' '}
                    {pullRequest.state === 'merged'
                      ? 'Merged'
                      : pullRequest.state === 'closed'
                        ? 'Closed'
                        : pullRequest.isDraft
                          ? 'Draft'
                          : 'Open'}
                    {pullRequest.checksState === 'success' && ', checks passed'}
                    {pullRequest.checksState === 'failure' && ', checks failed'}
                    {pullRequest.checksState === 'pending' && ', checks running'}
                  </span>
                </span>
              </a>
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
              to={chatPath(projectId, update.sessionId)}
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
export function IdeaUpdates({
  updates,
  projectId,
  onPost,
  posting,
  error,
  onRetry,
  canWrite,
}: {
  updates: IdeaUpdateNote[] | undefined;
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
        count={updates?.length}
        hint="Notes from people and agents, newest first"
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
        ) : updates === undefined ? (
          <p className="m-0 px-4 py-6 text-sm text-fg-muted">Loading the updates…</p>
        ) : updates.length === 0 ? (
          <p className="m-0 px-4 py-6 text-sm text-fg-muted">
            No updates yet. Notes from people and agents appear here.
          </p>
        ) : (
          <ol className="m-0 list-none p-0">
            {updates.map((update) => (
              <UpdateRow key={update.id} update={update} projectId={projectId} />
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
