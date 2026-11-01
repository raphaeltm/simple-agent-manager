import type { NotificationResponse } from '@simple-agent-manager/shared';
import { Button, Spinner, useModalInteraction } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ChevronDown, MessageSquare, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { useQueryScope } from '../../hooks/useQueryScope';
import { getAttentionRequestContext } from '../../lib/api/notifications';
import { RenderedMarkdown } from '../MarkdownRenderer';
import { attentionRequest } from './attention-request';
import { AttentionAnswerControls } from './AttentionAnswerControls';

/** Focused reader: body scrolls; header, answer controls and conversation link stay put. */
export function NotificationQuestionDialog({
  notification,
  onClose,
  onResolved,
}: {
  notification: NotificationResponse;
  onClose: () => void;
  onResolved: () => void;
}) {
  const { markerId } = attentionRequest(notification);
  const projectId = notification.projectId ?? '';
  const sessionId = notification.sessionId ?? '';
  const scope = useQueryScope();
  const navigate = useNavigate();
  const [context, setContext] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalInteraction({ enabled: true, modalRef, onEscape: onClose });
  const query = useQuery({
    queryKey: ['auth', scope, 'notification-question', projectId, sessionId, markerId],
    enabled: Boolean(scope && projectId && sessionId && markerId),
    queryFn: ({ signal }) =>
      getAttentionRequestContext(projectId, sessionId, markerId ?? '', false, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const data = query.data;
  const request = data?.request;
  const contextQuery = useQuery({
    queryKey: ['auth', scope, 'notification-question-context', projectId, sessionId, markerId],
    enabled: Boolean(context && request && scope && markerId),
    queryFn: ({ signal }) =>
      getAttentionRequestContext(projectId, sessionId, markerId ?? '', true, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const messages = contextQuery.data?.messages ?? [];
  const pending = request?.resolvedAt === null && request.resolvedAnswer !== null;
  const status = request?.resolvedAt
    ? 'Answered'
    : request?.expired
      ? 'Expired'
      : pending
        ? 'Answer being delivered'
        : 'Needs your answer';
  const openConversation = () => {
    const path = `/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(sessionId)}`;
    const anchor = messages.at(-1);
    const params = anchor
      ? `?commentMessage=${encodeURIComponent(anchor.id)}&commentAt=${anchor.createdAt}`
      : '';
    onClose();
    navigate(path + params);
  };
  return createPortal(
    <div
      data-sam-modal-root=""
      className="fixed inset-0 z-dialog-backdrop flex items-end justify-center bg-overlay backdrop-blur-sm sm:items-center sm:p-6"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-t-2xl border border-border-default bg-inset text-fg-primary shadow-overlay outline-none sm:max-h-[calc(100dvh-3rem)] sm:max-w-3xl sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-default px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="mb-1 truncate text-xs text-fg-muted">
              {data?.session.topic || 'Agent question'}
            </p>
            <h2 id={titleId} className="text-base font-semibold">
              Question from your agent
            </h2>
          </div>
          <Button variant="ghost" size="sm" aria-label="Close message" onClick={onClose}>
            <X size={18} />
          </Button>
        </header>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-testid="notification-question-body"
        >
          <div className="border-b border-border-default px-4 py-3 sm:px-6">
            <button
              onClick={() => setContext(!context)}
              aria-expanded={context}
              className="flex items-center gap-2 text-xs text-fg-muted hover:text-fg-primary"
            >
              <MessageSquare size={14} />
              {context ? 'Hide earlier context' : 'Show earlier context'}
              <ChevronDown size={14} />
            </button>
          </div>
          {query.isPending && (
            <div role="status" className="flex items-center gap-2 p-6 text-sm text-fg-muted">
              <Spinner size="sm" />
              Loading full question…
            </div>
          )}
          {query.isError && (
            <div role="alert" className="p-4 sm:p-6">
              <p className="text-sm">
                The full question could not be loaded. It may no longer be available, or your access
                may have changed.
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-3"
                onClick={() => void query.refetch()}
              >
                Try again
              </Button>
              {notification.body && (
                <div className="mt-4">
                  <p className="mb-2 text-xs text-fg-muted">
                    Notification preview · may be incomplete
                  </p>
                  <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                    {notification.body}
                  </p>
                </div>
              )}
            </div>
          )}
          {context && contextQuery.isFetching && (
            <p role="status" className="p-4 text-sm text-fg-muted">
              Loading earlier context…
            </p>
          )}
          {context && contextQuery.isError && (
            <div role="alert" className="p-4 text-sm text-fg-muted">
              Earlier context could not be loaded.{' '}
              <button className="text-accent" onClick={() => void contextQuery.refetch()}>
                Retry context
              </button>
            </div>
          )}
          {context && contextQuery.data && !contextQuery.isFetching && (
            <section
              aria-label="Earlier context"
              className="border-b border-border-default bg-surface/40 px-4 sm:px-6"
            >
              {messages.length ? (
                <>
                  <p className="pt-4 text-xs text-fg-muted">Recent excerpts before this question</p>
                  {messages.map((m) => (
                    <article
                      key={m.id}
                      className="border-b border-border-default py-4 last:border-0"
                    >
                      <p className="mb-2 text-xs text-fg-muted">
                        {m.role === 'user' ? 'User' : 'Agent'} ·{' '}
                        {new Date(m.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                      <RenderedMarkdown inline content={m.content} />
                      {m.truncated && (
                        <p className="mt-2 text-xs text-fg-muted">
                          Excerpt limited. Open the conversation to read more.
                        </p>
                      )}
                    </article>
                  ))}
                </>
              ) : (
                <p className="py-4 text-sm text-fg-muted">No earlier messages are available.</p>
              )}
            </section>
          )}
          {request && (
            <article className="p-4 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
                <span>Agent · {new Date(request.createdAt).toLocaleString()}</span>
                <span className="rounded-full border border-border-default px-2 py-1">
                  {status}
                </span>
              </div>
              <RenderedMarkdown
                inline
                content={request.reason || 'No question text was saved for this request.'}
              />
            </article>
          )}
        </div>
        <footer
          className="shrink-0 border-t border-border-default bg-surface px-4 py-4 sm:px-6 max-h-[45dvh] overflow-y-auto"
          aria-label="Respond to question"
        >
          {request?.canAnswer && markerId ? (
            <AttentionAnswerControls
              key={markerId}
              projectId={projectId}
              sessionId={sessionId}
              markerId={markerId}
              options={request.options}
              allowCustom
              onResolved={() => {
                onResolved();
                void query.refetch();
              }}
            />
          ) : request ? (
            <div role="status" className="text-sm text-fg-muted [overflow-wrap:anywhere]">
              {request.resolvedAt
                ? request.resolvedAnswer
                  ? `Answered: ${request.resolvedAnswer}`
                  : 'This question has already been resolved.'
                : request.expired
                  ? 'This question has expired.'
                  : pending
                    ? `Answer is being delivered: ${request.resolvedAnswer}`
                    : 'Open the conversation to respond to this request.'}
            </div>
          ) : (
            <p className="text-xs text-fg-muted">
              Answers are available after the full request loads.
            </p>
          )}
          {pending && (
            <button className="mt-2 text-xs text-accent" onClick={() => void query.refetch()}>
              Check delivery status
            </button>
          )}
        </footer>
        <div className="flex shrink-0 items-center justify-end border-t border-border-default px-4 py-3 sm:px-6">
          <button
            onClick={openConversation}
            className="flex items-center gap-1 text-xs text-accent"
          >
            Open in conversation <ArrowUpRight size={14} />
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
