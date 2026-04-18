/**
 * /try/:trialId — Discovery-mode feed for a running trial.
 *
 * Opens an EventSource to `/api/trial/:trialId/events` and renders each
 * TrialEvent as a card in the feed. Exponential-backoff reconnect on
 * transport errors (max 5 retries). Mounts the Track-D `<ChatGate>` slot
 * beneath the feed once the trial is ready.
 */
import type {
  TrialErrorEvent,
  TrialEvent,
  TrialIdeaEvent,
  TrialKnowledgeEvent,
  TrialProgressEvent,
  TrialReadyEvent,
  TrialStartedEvent,
} from '@simple-agent-manager/shared';
import { Alert, Typography } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';

import { ChatGate } from '../components/trial/ChatGate';
import { openTrialEventStream, trialErrorMessage } from '../lib/trial-api';

const MAX_RECONNECT_ATTEMPTS = 5;
// Exponential: 1s, 2s, 4s, 8s, 16s — capped at 16s
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 16_000;

interface ConnectionState {
  status: 'connecting' | 'open' | 'retrying' | 'failed';
  attempt: number;
}

export function TryDiscovery() {
  const { trialId } = useParams<{ trialId: string }>();
  const [events, setEvents] = useState<TrialEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'connecting',
    attempt: 0,
  });

  // Keep a ref so the SSE callback doesn't need to re-run on every event.
  const sourceRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const closedRef = useRef(false);

  useEffect(() => {
    if (!trialId) return undefined;

    closedRef.current = false;

    const clearRetryTimer = () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const open = () => {
      if (closedRef.current) return;

      attemptRef.current += 1;
      setConnection({ status: 'connecting', attempt: attemptRef.current });

      const source = openTrialEventStream(trialId, {
        onOpen: () => {
          if (closedRef.current) return;
          attemptRef.current = 0;
          setConnection({ status: 'open', attempt: 0 });
        },
        onEvent: (event) => {
          if (closedRef.current) return;
          setEvents((prev) => [...prev, event]);
          // Close early on terminal events to avoid unnecessary reconnects.
          if (event.type === 'trial.ready' || event.type === 'trial.error') {
            sourceRef.current?.close();
            sourceRef.current = null;
            setConnection({ status: 'open', attempt: 0 });
          }
        },
        onError: () => {
          if (closedRef.current) return;
          sourceRef.current?.close();
          sourceRef.current = null;

          if (attemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
            setConnection({ status: 'failed', attempt: attemptRef.current });
            return;
          }

          const delay = Math.min(
            BACKOFF_CAP_MS,
            BACKOFF_BASE_MS * 2 ** (attemptRef.current - 1),
          );
          setConnection({ status: 'retrying', attempt: attemptRef.current });
          retryTimerRef.current = setTimeout(open, delay);
        },
      });
      sourceRef.current = source;
    };

    open();

    return () => {
      closedRef.current = true;
      clearRetryTimer();
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [trialId]);

  // Derive structured buckets from the flat event list. Memoized so re-renders
  // on new events don't re-scan.
  const view = useMemo(() => deriveView(events), [events]);

  if (!trialId) {
    return (
      <div className="min-h-[100dvh] bg-canvas flex items-center justify-center px-4 py-8">
        <Alert variant="error">Missing trial id.</Alert>
      </div>
    );
  }

  const terminalError = view.error;

  return (
    <div
      className="min-h-[100dvh] bg-canvas px-4 py-6 sm:py-10"
      style={{
        paddingTop: 'max(1.5rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
      }}
    >
      <div className="mx-auto w-full max-w-[1024px] flex flex-col gap-4">
        <DiscoveryHeader
          started={view.started}
          progressLatest={view.progressLatest}
          connection={connection}
          ready={view.ready !== null}
        />

        {terminalError ? <TerminalErrorPanel error={terminalError} /> : null}

        {events.length === 0 && !terminalError ? <EmptyState /> : null}

        <ol className="flex flex-col gap-3" role="feed" aria-busy={connection.status !== 'open'}>
          {events.map((event, idx) => (
            <li
              key={`${idx}-${event.type}`}
              className="trial-feed-item motion-safe:animate-[trial-slide-in_.28s_ease-out]"
            >
              <EventCard event={event} />
            </li>
          ))}
        </ol>

        {connection.status === 'retrying' ? (
          <p role="status" className="text-xs text-fg-muted text-center">
            Reconnecting… (attempt {connection.attempt}/{MAX_RECONNECT_ATTEMPTS})
          </p>
        ) : null}

        {/* Track-D slot */}
        <div data-testid="trial-chat-gate">
          <ChatGate
            trialId={trialId}
            projectId={view.ready?.projectId ?? view.started?.projectId ?? null}
            ready={view.ready !== null}
            ideas={view.ideas.map((i) => ({
              ideaId: i.ideaId,
              title: i.title,
              summary: i.summary,
            }))}
          />
        </div>
      </div>

      <style>{`
        @keyframes trial-slide-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .trial-feed-item { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Derived view model
// ---------------------------------------------------------------------------

interface DiscoveryView {
  started: TrialStartedEvent | null;
  progressLatest: TrialProgressEvent | null;
  ready: TrialReadyEvent | null;
  error: TrialErrorEvent | null;
  ideas: TrialIdeaEvent[];
  knowledge: TrialKnowledgeEvent[];
}

function deriveView(events: TrialEvent[]): DiscoveryView {
  const view: DiscoveryView = {
    started: null,
    progressLatest: null,
    ready: null,
    error: null,
    ideas: [],
    knowledge: [],
  };
  for (const event of events) {
    switch (event.type) {
      case 'trial.started':
        view.started = event;
        break;
      case 'trial.progress':
        view.progressLatest = event;
        break;
      case 'trial.knowledge':
        view.knowledge.push(event);
        break;
      case 'trial.idea':
        view.ideas.push(event);
        break;
      case 'trial.ready':
        view.ready = event;
        break;
      case 'trial.error':
        view.error = event;
        break;
    }
  }
  return view;
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

interface HeaderProps {
  started: TrialStartedEvent | null;
  progressLatest: TrialProgressEvent | null;
  connection: ConnectionState;
  ready: boolean;
}

function DiscoveryHeader({ started, progressLatest, connection, ready }: HeaderProps) {
  const repoName = started ? extractRepoName(started.repoUrl) : 'your repo';
  const progressPct =
    progressLatest?.progress !== undefined
      ? Math.round(Math.max(0, Math.min(1, progressLatest.progress)) * 100)
      : null;

  return (
    <header
      className="sticky top-0 -mx-4 px-4 py-3 bg-canvas/95 backdrop-blur-sm border-b border-border-default z-10"
      role="banner"
    >
      <div className="flex items-start gap-3 justify-between">
        <div className="min-w-0 flex-1">
          <Typography variant="title" as="h1" className="truncate">
            {ready ? (
              <>Ready: <code className="font-mono text-base">{repoName}</code></>
            ) : (
              <>Exploring <code className="font-mono text-base">{repoName}</code>…</>
            )}
          </Typography>
          {progressLatest ? (
            <p className="text-xs text-fg-muted mt-1 truncate">{progressLatest.stage}</p>
          ) : null}
        </div>
        <ConnectionBadge connection={connection} />
      </div>

      {progressPct !== null && !ready ? (
        <div
          className="mt-2 h-1 rounded-full bg-surface overflow-hidden"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-accent transition-[width] duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      ) : null}
    </header>
  );
}

function ConnectionBadge({ connection }: { connection: ConnectionState }) {
  const { status } = connection;
  const label =
    status === 'open'
      ? 'Live'
      : status === 'connecting'
        ? 'Connecting…'
        : status === 'retrying'
          ? 'Reconnecting'
          : 'Offline';
  const classes =
    status === 'open'
      ? 'bg-success-tint text-success-fg'
      : status === 'failed'
        ? 'bg-danger-tint text-danger-fg'
        : 'bg-surface text-fg-muted';
  return (
    <span
      className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full border border-border-default ${classes}`}
    >
      {label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-md border border-border-default bg-surface p-6 text-center text-fg-muted text-sm">
      <p>Warming up the workspace and reading your repo…</p>
      <p className="mt-1 text-xs">Events stream in here as SAM learns about the code.</p>
    </div>
  );
}

function TerminalErrorPanel({ error }: { error: TrialErrorEvent }) {
  return (
    <Alert variant="error">
      <div className="flex flex-col gap-2">
        <p>
          <strong>SAM hit a snag:</strong> {error.message || trialErrorMessage(error.error)}
        </p>
        <Link
          to="/try"
          className="text-sm underline underline-offset-2 inline-block"
        >
          Start a new trial →
        </Link>
      </div>
    </Alert>
  );
}

function EventCard({ event }: { event: TrialEvent }) {
  switch (event.type) {
    case 'trial.started':
      return (
        <Card tone="neutral" icon="◎" title={`Started exploring ${extractRepoName(event.repoUrl)}`}>
          <p className="text-xs text-fg-muted">Trial id: <code>{event.trialId}</code></p>
        </Card>
      );
    case 'trial.progress':
      return (
        <Card tone="neutral" icon="▸" title={event.stage}>
          {event.progress !== undefined ? (
            <p className="text-xs text-fg-muted">{Math.round(event.progress * 100)}% complete</p>
          ) : null}
        </Card>
      );
    case 'trial.knowledge':
      return <KnowledgeCard event={event} />;
    case 'trial.idea':
      return <IdeaCard event={event} />;
    case 'trial.ready':
      return (
        <Card tone="success" icon="✓" title="Workspace ready">
          <p className="text-sm">Your workspace is warm and waiting. Chat below to continue.</p>
        </Card>
      );
    case 'trial.error':
      return null; // Rendered as terminal panel above.
    default:
      return null;
  }
}

function Card({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'neutral' | 'success' | 'info';
  icon: string;
  title: string;
  children?: ReactNode;
}) {
  const toneClasses =
    tone === 'success'
      ? 'border-success/30 bg-success-tint/50'
      : tone === 'info'
        ? 'border-info/30 bg-info-tint/50'
        : 'border-border-default bg-surface';
  return (
    <article className={`rounded-md border p-3 sm:p-4 ${toneClasses}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-lg leading-none shrink-0">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold truncate">{title}</h3>
          {children ? <div className="mt-1">{children}</div> : null}
        </div>
      </div>
    </article>
  );
}

function KnowledgeCard({ event }: { event: TrialKnowledgeEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="rounded-md border border-border-default bg-surface p-3 sm:p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-start gap-3 w-full text-left min-h-11 cursor-pointer"
      >
        <span aria-hidden className="text-lg leading-none shrink-0">
          📎
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold truncate">{event.entity}</h3>
          <p
            className={`mt-1 text-xs text-fg-muted ${open ? '' : 'line-clamp-2'}`}
          >
            {event.observation}
          </p>
        </div>
        <span aria-hidden className="text-fg-muted text-xs mt-1 shrink-0">
          {open ? '▲' : '▼'}
        </span>
      </button>
    </article>
  );
}

function IdeaCard({ event }: { event: TrialIdeaEvent }) {
  return (
    <article className="rounded-md border border-info/30 bg-info-tint/40 p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-info text-fg-on-accent text-xs font-semibold"
        >
          ★
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{event.title}</h3>
          <p className="mt-1 text-xs text-fg-muted">{event.summary}</p>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractRepoName(repoUrl: string): string {
  const match = /github\.com\/([^/]+\/[^/?#.]+)/i.exec(repoUrl);
  return match?.[1] ?? repoUrl;
}
