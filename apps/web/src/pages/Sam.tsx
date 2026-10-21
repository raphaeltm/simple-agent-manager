import { Button, PageLayout } from '@simple-agent-manager/ui';
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';

import { EarlierSamHistory } from '../components/sam/EarlierSamHistory';
import { RetryAlert } from '../components/sam/RetryAlert';
import { viewFromSnapshot } from '../components/sam/sam-live';
import { requestErrorText } from '../components/sam/sam-receipts';
import { SamComposer } from '../components/sam/SamComposer';
import { isActiveTurn, SamTurn, type Turn } from '../components/sam/SamTurn';
import { useSamLiveTurn } from '../components/sam/useSamLiveTurn';
import { useStickToBottom } from '../components/sam/useStickToBottom';
import { type Work, WorkPanel } from '../components/sam/WorkCard';
import { useProjectList } from '../hooks/useProjectData';
import { useQueryScope } from '../hooks/useQueryScope';
import { useSamSettings } from '../hooks/useSamSettings';
import { ApiClientError, request } from '../lib/api/client';
import { SAM_ACTIVE_POLL_MS, SAM_STREAMING_POLL_MS } from '../lib/poll-intervals';
import { PROJECT_LIST_LIMIT } from '../lib/project-query-config';

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

/** Starters fill the composer for review; nothing is sent until the user presses Send. */
const SUGGESTIONS = [
  'What needs my attention?',
  'What is running across my projects?',
  'Show my recent ideas',
];

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

/** The running turn in the admission receipt, or null for a replay or an unexpected shape. */
function acceptedTurn(receipt: unknown): Turn | null {
  if (!receipt || typeof receipt !== 'object' || !('turn' in receipt)) return null;
  const turn = receipt.turn;
  if (
    !turn ||
    typeof turn !== 'object' ||
    !('id' in turn) ||
    typeof turn.id !== 'string' ||
    !('request_key' in turn) ||
    typeof turn.request_key !== 'string' ||
    !('message' in turn) ||
    typeof turn.message !== 'string' ||
    !('state' in turn) ||
    typeof turn.state !== 'string'
  )
    return null;
  const accepted: Turn = {
    id: turn.id,
    request_key: turn.request_key,
    message: turn.message,
    state: turn.state,
    response: null,
    error: null,
    actions: [],
    ...('created_at' in turn && typeof turn.created_at === 'number'
      ? { created_at: turn.created_at }
      : {}),
  };
  return isActiveTurn(accepted) ? accepted : null;
}

export function Sam() {
  const settings = useSamSettings();
  const scope = useQueryScope();
  // The conversation fills the shell like project chat: its own scroller and a pinned composer.
  if (!settings.isPending && settings.enabled) return <SamConversation key={scope} />;
  return (
    <PageLayout title="SAM" maxWidth="xl">
      {settings.isPending ? (
        <p role="status" className="inline-flex items-center gap-2 text-fg-muted">
          <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin" />
          Loading your SAM setting…
        </p>
      ) : (
        <div className="max-w-xl space-y-3">
          <h2 className="sam-type-section-heading text-fg-primary">Your private SAM assistant</h2>
          <p className="text-fg-muted">
            {settings.data?.available === false
              ? 'SAM is temporarily unavailable on this installation.'
              : 'SAM is off. Turn it on in Settings to check your projects and manage work from one conversation.'}
          </p>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 font-semibold text-fg-on-accent"
            to="/settings"
          >
            Open Settings
          </Link>
          {settings.error && (
            <RetryAlert
              error={settings.error}
              fallback="Couldn’t load your SAM setting."
              onRetry={() => void settings.refetch()}
            />
          )}
        </div>
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Read by the poll cadence below; the live stream pushes the running turn's progress.
  const streamingRef = useRef(false);
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
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const runningTurn = pages.some((page) => page.turns.some(isActiveTurn));
      const otherActivity = pages.some(
        (page) =>
          page.turns.some((turn) =>
            turn.actions.some((action) => action.state === 'pending' || action.state === 'running')
          ) ||
          page.work?.some(
            (work) => !['completed', 'failed', 'cancelled', 'archived'].includes(work.status)
          )
      );
      if (otherActivity || (runningTurn && !streamingRef.current)) return SAM_ACTIVE_POLL_MS;
      return runningTurn ? SAM_STREAMING_POLL_MS : false;
    },
  });
  // Shares the sidebar's cached project list, so naming an action's project costs no request.
  const { projects } = useProjectList({
    queryScope: scope,
    limit: PROJECT_LIST_LIMIT,
    pollInterval: 0,
  });
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  );
  const turns =
    history.data?.pages
      .slice()
      .reverse()
      .flatMap((page) => page.turns) ?? [];
  const work = history.data?.pages[0]?.work ?? [];
  const scroll = useStickToBottom(turns[0]?.id);
  // Stable, so memoized turns that did not change skip re-rendering during live updates.
  const refresh = useCallback(
    () => client.invalidateQueries({ queryKey: ['auth', scope, 'sam'] }),
    [client, scope]
  );
  const active = turns.find(isActiveTurn);
  const live = useSamLiveTurn(active?.id, () => void refresh());
  useEffect(() => {
    streamingRef.current = live.streaming;
  }, [live.streaming]);
  // Without a stream (or before it connects), polled history carries the same snapshot.
  const polledLive = active?.live ? viewFromSnapshot(active.live, history.dataUpdatedAt) : null;
  const activeLive = live.view ?? polledLive;
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
    scroll.scrollToBottom();
    const submission = pending ?? { requestKey: crypto.randomUUID(), message };
    let shown = false;
    try {
      // Persist before the network request: a lost response followed by a reload
      // must replay the same request, never dispatch the work a second time.
      sessionStorage.setItem(storageKey, JSON.stringify(submission));
      setPending(submission);
      const receipt = acceptedTurn(
        await request<unknown>('/api/sam/turns', {
          method: 'POST',
          body: JSON.stringify(submission),
        })
      );
      sessionStorage.removeItem(storageKey);
      setPending(null);
      setMessage('');
      if (receipt) {
        // A history read can take seconds. Show the accepted turn now so its live
        // progress streams in while history refreshes behind it.
        await client.cancelQueries({ queryKey: key });
        client.setQueryData<InfiniteData<History, string | null>>(key, (data) => {
          const [newest, ...older] = data?.pages ?? [];
          const known = data?.pages.some((page) => page.turns.some(({ id }) => id === receipt.id));
          if (!data || !newest || known) return data;
          return { ...data, pages: [{ ...newest, turns: [...newest.turns, receipt] }, ...older] };
        });
        shown = true;
      }
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.rejectedBeforeEffects) {
        sessionStorage.removeItem(storageKey);
        setPending(null);
      }
      setError(requestErrorText(cause, 'Could not send. Retry uses the same request.'));
    } finally {
      // Without the turn on screen, Send stays locked until history shows what was recorded.
      if (shown) void refresh();
      else await refresh();
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
      setError(requestErrorText(cause, 'Could not stop SAM'));
    } finally {
      await refresh();
      setCancelling(false);
    }
  };
  const suggest = (text: string) => {
    setMessage(text);
    textareaRef.current?.focus();
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border-default">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="sam-type-card-title text-fg-primary">SAM</h1>
              <span className="rounded-full bg-accent-tint px-2 py-0.5 text-xs font-medium text-accent">
                Preview
              </span>
            </div>
            <p className="text-xs text-fg-muted">
              Private to you · Project work runs in visible project chats
            </p>
          </div>
          <Link
            to="/settings"
            aria-label="SAM settings"
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-fg-muted hover:text-fg-primary"
          >
            <Settings size={16} aria-hidden="true" />
            <span className="hidden sm:inline">Settings</span>
          </Link>
        </div>
        {work.length > 0 && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <WorkPanel work={work} projectNames={projectNames} refresh={refresh} />
          </div>
        )}
      </header>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroll.scrollerRef}
          onScroll={scroll.onScroll}
          data-testid="sam-conversation-scroller"
          // useStickToBottom anchors prepends itself (Safari has no scroll anchoring);
          // Chromium's native anchoring is off so every browser behaves the same.
          // `relative` makes this scroller the containing block of absolute descendants
          // (the turns' sr-only labels). Without it they escape the clip and stretch the
          // shell's <main> scroll area, so scrolling past the newest turn dragged the
          // pinned composer up the screen.
          className="relative h-full overflow-y-auto overflow-x-hidden [overflow-anchor:none]"
        >
          <div
            ref={scroll.contentRef}
            className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 px-4 py-4"
          >
            {history.hasNextPage && (
              <Button
                variant="ghost"
                className="self-center"
                disabled={history.isFetchingNextPage}
                onClick={() => {
                  scroll.holdPosition();
                  void history.fetchNextPage();
                }}
              >
                {history.isFetchingNextPage ? 'Loading…' : 'Load older messages'}
              </Button>
            )}
            {history.isPending && (
              <p role="status" className="inline-flex items-center gap-2 text-fg-muted">
                <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin" />
                Loading conversation…
              </p>
            )}
            {history.error && (
              <RetryAlert
                error={history.error}
                fallback="Couldn’t load your conversation."
                onRetry={() => void history.refetch()}
              />
            )}
            {history.data?.pages[0]?.legacyHistoryAvailable &&
              history.data.pages[0].conversationId && (
                <EarlierSamHistory conversationId={history.data.pages[0].conversationId} />
              )}
            {history.data && turns.length === 0 && (
              <div className="my-auto py-6 text-center">
                <h2 className="sam-type-section-heading text-fg-primary">
                  What would you like to work on?
                </h2>
                <p className="mx-auto mt-2 max-w-md text-fg-muted">
                  Ask what needs your attention, explore an idea, or start work in one of your
                  projects.
                </p>
                {!pending && (
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => suggest(suggestion)}
                        className="min-h-11 rounded-full border border-border-default bg-surface px-4 text-sm text-fg-primary transition-colors hover:bg-surface-hover"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-4 text-xs text-fg-muted">
                  Settings, connections and infrastructure stay on their own pages.
                </p>
              </div>
            )}
            <section aria-label="Conversation" className="space-y-6">
              {turns.map((turn) => (
                <SamTurn
                  key={turn.id}
                  turn={turn}
                  projectNames={projectNames}
                  refresh={refresh}
                  live={turn.id === active?.id ? activeLive : null}
                />
              ))}
            </section>
          </div>
        </div>
        {scroll.showJump && (
          <button
            type="button"
            onClick={scroll.scrollToBottom}
            aria-label="Scroll to bottom"
            className="absolute bottom-3 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-[var(--sam-form-border)] bg-[var(--sam-form-bg)] shadow-md hover:bg-page"
          >
            <ChevronDown size={16} aria-hidden="true" className="text-fg-muted" />
          </button>
        )}
      </div>
      <SamComposer
        message={message}
        setMessage={setMessage}
        onSend={() => void send()}
        onStop={() => void cancel()}
        active={Boolean(active)}
        sending={sending}
        cancelling={cancelling}
        pending={Boolean(pending)}
        blocked={history.isPending || history.isError}
        error={error}
        textareaRef={textareaRef}
      />
    </div>
  );
}
