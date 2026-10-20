import { Alert, Button, PageLayout } from '@simple-agent-manager/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { RenderedMarkdown } from '../components/MarkdownRenderer';
import { type Action, ActionCard } from '../components/sam/ActionCard';
import { EarlierSamHistory } from '../components/sam/EarlierSamHistory';
import { type Work, WorkCard } from '../components/sam/WorkCard';
import { useQueryScope } from '../hooks/useQueryScope';
import { useSamSettings } from '../hooks/useSamSettings';
import { API_URL, ApiClientError, request } from '../lib/api/client';
import { SAM_ACTIVE_POLL_MS } from '../lib/poll-intervals';
import { useVoiceInput } from './sam-prototype/voice-input';

interface Turn {
  id: string;
  request_key: string;
  message: string;
  state: string;
  response: string | null;
  error: string | null;
  actions: Action[];
}
interface History {
  conversationId?: string;
  legacyHistoryAvailable?: boolean;
  turns: Turn[];
  nextCursor: string | null;
  work?: Work[];
}
interface PendingMessage {
  requestKey: string;
  message: string;
}
const isActive = (turn: Turn) => turn.state === 'running' || turn.state === 'accepted';

function readPending(storageKey: string): PendingMessage | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (
      value &&
      typeof value === 'object' &&
      'requestKey' in value &&
      typeof value.requestKey === 'string' &&
      'message' in value &&
      typeof value.message === 'string'
    )
      return value as PendingMessage;
  } catch {
    /* A new message reports unavailable storage before sending. */
  }
  return null;
}

export function Sam() {
  const settings = useSamSettings();
  const scope = useQueryScope();
  return (
    <PageLayout title="SAM" maxWidth="xl">
      {settings.isPending ? (
        <p role="status">Loading your SAM setting…</p>
      ) : !settings.enabled ? (
        <div className="max-w-xl space-y-3">
          <h2 className="text-xl font-semibold">Your private SAM assistant</h2>
          <p className="text-fg-muted">
            {settings.data?.available === false
              ? 'SAM is temporarily unavailable on this installation.'
              : 'SAM is off. Enable it in Settings to check your projects and manage work from one conversation.'}
          </p>
          <Link className="text-accent underline" to="/settings">
            Open Settings
          </Link>
          {settings.error && (
            <Alert variant="error">
              {settings.error.message}{' '}
              <Button variant="secondary" onClick={() => void settings.refetch()}>
                Try again
              </Button>
            </Alert>
          )}
        </div>
      ) : (
        <SamConversation key={scope} />
      )}
    </PageLayout>
  );
}

function SamConversation() {
  const scope = useQueryScope();
  const client = useQueryClient();
  const storageKey = `sam-pending-turn:${scope}`;
  const [pending, setPending] = useState(() => readPending(storageKey));
  const [message, setMessage] = useState(() => readPending(storageKey)?.message ?? '');
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amplitude = useRef(0);
  const transcribed = useCallback(
    (text: string) => setMessage((previous) => (previous ? `${previous}\n${text}` : text)),
    []
  );
  const voice = useVoiceInput({
    transcribeUrl: `${API_URL}/api/transcribe`,
    amplitudeRef: amplitude,
    onTranscription: transcribed,
  });
  const key = ['auth', scope, 'sam', 'turns'] as const;
  const history = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      request<History>(
        `/api/sam/turns${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`,
        { signal }
      ),
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      query.state.data?.pages.some(
        (page) =>
          page.turns.some(
            (turn) =>
              isActive(turn) ||
              turn.actions.some(
                (action) => action.state === 'pending' || action.state === 'running'
              )
          ) ||
          page.work?.some(
            (work) => !['completed', 'failed', 'cancelled', 'archived'].includes(work.status)
          )
      )
        ? SAM_ACTIVE_POLL_MS
        : false,
  });
  const turns =
    history.data?.pages
      .slice()
      .reverse()
      .flatMap((page) => page.turns) ?? [];
  const work = history.data?.pages[0]?.work ?? [];
  const refresh = () => client.invalidateQueries({ queryKey: ['auth', scope, 'sam'] });
  const active = turns.find(isActive);
  const pendingRecorded = pending && turns.some((turn) => turn.request_key === pending.requestKey);
  // Only a matching server receipt clears an uncertain submission. Polling must
  // never overwrite an ordinary draft or clear an unrelated request.
  useEffect(() => {
    if (!pendingRecorded) return;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Receipt still confirms delivery. */
    }
    setPending(null);
    setMessage('');
    setError(null);
  }, [pendingRecorded, storageKey]);
  const send = async () => {
    if (!message.trim() || sending || active || history.isPending || history.isError) return;
    setSending(true);
    setError(null);
    const submission = pending ?? { requestKey: crypto.randomUUID(), message };
    try {
      // Persist before the network request: a lost response followed by a reload
      // must replay the same request, never dispatch the work a second time.
      sessionStorage.setItem(storageKey, JSON.stringify(submission));
      setPending(submission);
      await request('/api/sam/turns', { method: 'POST', body: JSON.stringify(submission) });
      sessionStorage.removeItem(storageKey);
      setPending(null);
      setMessage('');
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.rejectedBeforeEffects) {
        sessionStorage.removeItem(storageKey);
        setPending(null);
      }
      setError(
        cause instanceof Error ? cause.message : 'Could not send. Retry uses the same request.'
      );
    } finally {
      await refresh();
      setSending(false);
    }
  };
  const cancel = async () => {
    if (!active || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await request(`/api/sam/turns/${encodeURIComponent(active.id)}/cancel`, {
        method: 'POST',
        body: '{}',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not cancel turn');
    } finally {
      await refresh();
      setCancelling(false);
    }
  };
  return (
    <div className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-4 pb-6">
      <p className="text-sm text-fg-muted">
        Private to you · Project work opens a visible project session.{' '}
        <Link className="text-accent underline" to="/settings">
          Settings
        </Link>
      </p>
      {history.isPending && <p role="status">Loading conversation…</p>}
      {history.error && (
        <Alert variant="error">
          {history.error.message}{' '}
          <Button variant="secondary" onClick={() => void history.refetch()}>
            Retry history
          </Button>
        </Alert>
      )}
      {history.hasNextPage && (
        <Button
          variant="secondary"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Load older messages'}
        </Button>
      )}
      {history.data && turns.length === 0 && (
        <div className="rounded-xl border border-border-default p-6">
          <h2 className="text-xl font-semibold">What would you like to work on?</h2>
          <p className="mt-2 text-fg-muted">
            Ask what needs your attention, explore an idea, or start work in a project. Settings,
            connections and infrastructure controls remain in their existing pages.
          </p>
        </div>
      )}
      {history.data?.pages[0]?.legacyHistoryAvailable && history.data.pages[0].conversationId && (
        <EarlierSamHistory conversationId={history.data.pages[0].conversationId} />
      )}
      {work.length > 0 && (
        <details className="min-w-0 rounded-lg border border-border-default p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Project work · {work.length}{' '}
            {work.some((item) => item.attention) ? '· Needs attention' : ''}
            {work.some((item) => item.updates?.unread) ? ' · New updates' : ''}
          </summary>
          <ul className="mt-3 space-y-3">
            {work.map((item) => (
              <WorkCard key={item.actionId} item={item} refresh={refresh} />
            ))}
          </ul>
        </details>
      )}
      <div aria-label="Conversation" className="space-y-5">
        {turns.map((turn) => (
          <article key={turn.id} className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
            <div className="rounded-xl bg-surface-secondary p-4">
              <p className="text-xs font-medium text-fg-muted">You</p>
              <p className="mt-1 whitespace-pre-wrap">{turn.message}</p>
            </div>
            <div className="min-w-0 px-1">
              <p className="text-xs font-medium text-fg-muted">
                SAM · {turn.state.replaceAll('_', ' ')}
              </p>
              {turn.response && <RenderedMarkdown content={turn.response} inline />}
              {turn.error && <Alert variant="warning">{turn.error}</Alert>}
              {isActive(turn) && (
                <p className="mt-2 text-sm" role="status">
                  Working… You can leave this page and return.
                </p>
              )}
              {turn.actions.map((action) => (
                <ActionCard key={action.id} action={action} refresh={refresh} />
              ))}
            </div>
          </article>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="space-y-3 rounded-xl border border-border-default bg-surface-secondary p-3"
      >
        <label htmlFor="sam-message" className="block text-sm font-medium">
          Message SAM
        </label>
        <textarea
          id="sam-message"
          className="min-h-28 w-full resize-y rounded-lg border border-border-default bg-surface-primary p-3 text-fg-primary focus-visible:outline-2 focus-visible:outline-accent"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="What needs my attention across my projects?"
          readOnly={sending || Boolean(pending)}
        />
        {pending && (
          <p className="text-sm text-fg-muted">
            This message is saved in this tab until delivery is confirmed. Retry safely sends the
            same request.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={voice.toggle}
            disabled={voice.state === 'processing' || sending || Boolean(pending)}
          >
            {voice.state === 'recording'
              ? 'Stop recording'
              : voice.state === 'processing'
                ? 'Transcribing…'
                : 'Voice input'}
          </Button>
          {active ? (
            <Button
              type="button"
              variant="secondary"
              disabled={cancelling}
              onClick={() => void cancel()}
            >
              {cancelling ? 'Stopping…' : 'Stop SAM turn'}
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={
                sending ||
                !message.trim() ||
                history.isPending ||
                history.isError ||
                voice.state === 'recording' ||
                voice.state === 'processing'
              }
            >
              {sending ? 'Sending…' : pending ? 'Retry message' : 'Send'}
            </Button>
          )}
        </div>
        {(error || voice.errorMsg) && <Alert variant="error">{error ?? voice.errorMsg}</Alert>}
        <p className="text-xs text-fg-muted">
          Stopping this turn does not cancel project work already dispatched.
        </p>
      </form>
    </div>
  );
}
