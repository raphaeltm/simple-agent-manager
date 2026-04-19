/**
 * /try/:trialId — Discovery-mode feed for a running trial.
 *
 * Opens an EventSource to `/api/trial/:trialId/events` and renders each
 * TrialEvent as a card in the feed. Exponential-backoff reconnect on
 * transport errors. Mounts the Track-D `<ChatGate>` slot beneath the feed
 * once the trial is ready.
 *
 * Wave-2 polish:
 *   - Skeleton stage timeline before the first event arrives (vs. blank).
 *   - Friendly stage labels via {@link friendlyStageLabel}.
 *   - Smoothly animated progress bar (CSS transition, see TRIAL_PROGRESS_TRANSITION_MS).
 *   - Consecutive `trial.knowledge` events are grouped into a single card.
 *   - "Taking longer than usual" hint after TRIAL_SLOW_WARN_MS.
 *   - Better terminal-error recovery: clear "Try again" CTA + contextual copy.
 *   - All thresholds configurable via env (see lib/trial-ui-config.ts).
 */
import type {
  TrialErrorEvent,
  TrialEvent,
  TrialIdea,
  TrialIdeaEvent,
  TrialKnowledgeEvent,
  TrialProgressEvent,
  TrialReadyEvent,
  TrialStartedEvent,
} from '@simple-agent-manager/shared';
import { Alert, Typography } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { ChatGate } from '../components/trial/ChatGate';
import { openTrialEventStream, trialErrorMessage } from '../lib/trial-api';
import {
  friendlyStageLabel,
  STAGE_TIMELINE,
  TRIAL_BACKOFF_BASE_MS,
  TRIAL_BACKOFF_CAP_MS,
  TRIAL_EVENT_ANIMATION_MS,
  TRIAL_KNOWLEDGE_GROUP_MS,
  TRIAL_MAX_RECONNECT_ATTEMPTS,
  TRIAL_PROGRESS_TRANSITION_MS,
  TRIAL_SLOW_WARN_MS,
} from '../lib/trial-ui-config';

interface ConnectionState {
  status: 'connecting' | 'open' | 'retrying' | 'failed';
  attempt: number;
}

export function TryDiscovery() {
  const { trialId } = useParams<{ trialId: string }>();
  const navigate = useNavigate();
  const [events, setEvents] = useState<TrialEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'connecting',
    attempt: 0,
  });
  const [isSlow, setIsSlow] = useState(false);

  // Keep refs so the SSE callback doesn't need to re-run on every event.
  const sourceRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

    const clearSlowTimer = () => {
      if (slowTimerRef.current !== null) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
    };

    // Show "this is taking longer than usual" hint if no event arrives.
    slowTimerRef.current = setTimeout(() => {
      if (!closedRef.current) setIsSlow(true);
    }, TRIAL_SLOW_WARN_MS);

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
          // Any event clears the slow-warn — momentum has resumed.
          clearSlowTimer();
          setIsSlow(false);
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

          if (attemptRef.current >= TRIAL_MAX_RECONNECT_ATTEMPTS) {
            setConnection({ status: 'failed', attempt: attemptRef.current });
            return;
          }

          const delay = Math.min(
            TRIAL_BACKOFF_CAP_MS,
            TRIAL_BACKOFF_BASE_MS * 2 ** (attemptRef.current - 1),
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
      clearSlowTimer();
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [trialId]);

  // Derive structured buckets from the flat event list. Memoized so re-renders
  // on new events don't re-scan.
  const view = useMemo(() => deriveView(events), [events]);
  const feedItems = useMemo(() => buildFeed(events), [events]);

  if (!trialId) {
    return (
      <div className="min-h-[100dvh] bg-canvas flex items-center justify-center px-4 py-8">
        <Alert variant="error">Missing trial id.</Alert>
      </div>
    );
  }

  const terminalError = view.error;
  const showSkeleton = events.length === 0 && !terminalError;

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

        {showSkeleton ? <StageSkeleton activeStage={view.progressLatest?.stage} /> : null}

        {isSlow && !terminalError && view.ready === null ? (
          <p
            role="status"
            data-testid="trial-slow-hint"
            className="text-xs text-fg-muted text-center -mt-1"
          >
            This is taking a little longer than usual — hang tight, we&rsquo;re still working on it.
          </p>
        ) : null}

        <ol
          className="flex flex-col gap-3"
          role="feed"
          aria-busy={connection.status !== 'open'}
          data-testid="trial-feed"
        >
          {feedItems.map((item) => (
            <li key={item.key} className="trial-feed-item motion-safe:animate-trial-slide-in">
              {item.kind === 'event' ? (
                <EventCard event={item.event} />
              ) : (
                <KnowledgeGroupCard items={item.items} />
              )}
            </li>
          ))}
        </ol>

        {connection.status === 'retrying' ? (
          <p role="status" className="text-xs text-fg-muted text-center">
            Reconnecting… (attempt {connection.attempt}/{TRIAL_MAX_RECONNECT_ATTEMPTS})
          </p>
        ) : null}

        {/* Track-D slot */}
        <div data-testid="trial-chat-gate">
          <ChatGate
            trialId={trialId}
            ideas={view.ideas.map<TrialIdea>((i) => ({
              id: i.ideaId,
              title: i.title,
              summary: i.summary,
              prompt: i.summary,
            }))}
            onAuthenticatedSubmit={async (message: string) => {
              const projectId = view.ready?.projectId ?? view.started?.projectId ?? null;
              if (!projectId) {
                throw new Error('Trial not ready — please wait for discovery to complete');
              }
              try {
                sessionStorage.setItem(`project-chat-draft:${projectId}`, message);
              } catch {
                // sessionStorage may be unavailable (Safari private mode); continue anyway.
              }
              navigate(`/projects/${projectId}`);
            }}
          />
        </div>
      </div>

      <style>{`
        @keyframes trial-slide-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .motion-safe\\:animate-trial-slide-in {
          animation: trial-slide-in ${TRIAL_EVENT_ANIMATION_MS}ms ease-out;
        }
        @media (prefers-reduced-motion: reduce) {
          .trial-feed-item { animation: none !important; }
        }
        @keyframes trial-skeleton-pulse {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
        .trial-skeleton-active {
          animation: trial-skeleton-pulse 1.6s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .trial-skeleton-active { animation: none !important; }
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

/**
 * Group consecutive `trial.knowledge` events arriving within
 * {@link TRIAL_KNOWLEDGE_GROUP_MS} into a single feed item. Other event
 * types break the group. Order is preserved.
 */
type FeedItem =
  | { kind: 'event'; key: string; event: Exclude<TrialEvent, TrialKnowledgeEvent | TrialErrorEvent> }
  | { kind: 'knowledge-group'; key: string; items: TrialKnowledgeEvent[] };

function buildFeed(events: TrialEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  let group: TrialKnowledgeEvent[] = [];
  let groupStartIdx = -1;

  const flushGroup = () => {
    if (group.length === 0) return;
    out.push({
      kind: 'knowledge-group',
      key: `knowledge-${groupStartIdx}-${group.length}`,
      items: group,
    });
    group = [];
    groupStartIdx = -1;
  };

  events.forEach((event, idx) => {
    if (event.type === 'trial.knowledge') {
      const last = group[group.length - 1];
      if (group.length === 0 || (last && event.at - last.at <= TRIAL_KNOWLEDGE_GROUP_MS)) {
        if (group.length === 0) groupStartIdx = idx;
        group.push(event);
      } else {
        flushGroup();
        group = [event];
        groupStartIdx = idx;
      }
      return;
    }

    flushGroup();

    if (event.type === 'trial.error') {
      // Rendered as the terminal panel above, not in the feed.
      return;
    }

    out.push({ kind: 'event', key: `event-${idx}-${event.type}`, event });
  });

  flushGroup();
  return out;
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
  const stageLabel = progressLatest ? friendlyStageLabel(progressLatest.stage) : null;

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
          {stageLabel ? (
            <p
              className="text-xs text-fg-muted mt-1 truncate"
              data-testid="trial-stage-label"
              title={stageLabel}
            >
              {stageLabel}
            </p>
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
          aria-label={stageLabel ?? 'Trial progress'}
        >
          <div
            className="h-full bg-accent"
            style={{
              width: `${progressPct}%`,
              transition: `width ${TRIAL_PROGRESS_TRANSITION_MS}ms ease-out`,
            }}
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
      data-testid="trial-connection-badge"
      className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full border border-border-default ${classes}`}
    >
      {label}
    </span>
  );
}

/**
 * Skeleton timeline rendered before the first SSE event arrives.
 * Highlights the current stage (when known) and dims completed/upcoming.
 * Replaces the previous opaque "Warming up…" copy with a visible roadmap.
 */
function StageSkeleton({ activeStage }: { activeStage?: string }) {
  const activeIdx = activeStage
    ? STAGE_TIMELINE.findIndex((s) => s.key === activeStage)
    : -1;

  return (
    <div
      data-testid="trial-stage-skeleton"
      className="rounded-md border border-border-default bg-surface p-4"
    >
      <p className="text-xs text-fg-muted uppercase tracking-wide mb-3">
        Setting things up
      </p>
      <ol className="flex flex-col gap-2">
        {STAGE_TIMELINE.map((stage, idx) => {
          const isActive = idx === activeIdx;
          const isComplete = activeIdx >= 0 && idx < activeIdx;
          return (
            <li key={stage.key} className="flex items-center gap-3 text-sm">
              <span
                aria-hidden
                className={[
                  'inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-semibold shrink-0',
                  isComplete
                    ? 'bg-success-tint text-success-fg'
                    : isActive
                      ? 'bg-accent text-fg-on-accent trial-skeleton-active'
                      : 'bg-canvas border border-border-default text-fg-muted',
                ].join(' ')}
              >
                {isComplete ? '✓' : idx + 1}
              </span>
              <span
                className={[
                  'truncate',
                  isActive
                    ? 'text-fg-primary font-medium'
                    : isComplete
                      ? 'text-fg-muted line-through decoration-1'
                      : 'text-fg-muted',
                ].join(' ')}
              >
                {stage.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TerminalErrorPanel({ error }: { error: TrialErrorEvent }) {
  const friendly = error.message || trialErrorMessage(error.error);
  const isRetryable = error.error !== 'cap_exceeded' && error.error !== 'trials_disabled';
  return (
    <Alert variant="error" data-testid="trial-error-panel">
      <div className="flex flex-col gap-2">
        <p>
          <strong>SAM hit a snag:</strong> {friendly}
        </p>
        <div className="flex flex-wrap gap-3">
          {isRetryable ? (
            <Link
              to="/try"
              className="text-sm font-medium underline underline-offset-2"
              data-testid="trial-error-retry"
            >
              Try again →
            </Link>
          ) : (
            <Link
              to="/try/cap-exceeded"
              className="text-sm font-medium underline underline-offset-2"
            >
              Join the waitlist →
            </Link>
          )}
        </div>
      </div>
    </Alert>
  );
}

function EventCard({
  event,
}: {
  event: Exclude<TrialEvent, TrialKnowledgeEvent | TrialErrorEvent>;
}) {
  switch (event.type) {
    case 'trial.started':
      return (
        <Card tone="neutral" icon="◎" title={`Started exploring ${extractRepoName(event.repoUrl)}`}>
          <p className="text-xs text-fg-muted">Trial id: <code>{event.trialId}</code></p>
        </Card>
      );
    case 'trial.progress':
      return (
        <Card tone="neutral" icon="▸" title={friendlyStageLabel(event.stage)}>
          {event.progress !== undefined ? (
            <p className="text-xs text-fg-muted">{Math.round(event.progress * 100)}% complete</p>
          ) : null}
        </Card>
      );
    case 'trial.idea':
      return <IdeaCard event={event} />;
    case 'trial.ready':
      return (
        <Card tone="success" icon="✓" title="Workspace ready">
          <p className="text-sm">Your workspace is warm and waiting. Chat below to continue.</p>
        </Card>
      );
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

/**
 * Single grouped card for a burst of consecutive `trial.knowledge` events.
 * Shows the first observation by default; the rest collapse behind a
 * "+N more" toggle. Reduces flicker when GitHub-knowledge fast-path emits
 * description / language / readme back-to-back.
 */
function KnowledgeGroupCard({ items }: { items: TrialKnowledgeEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const head = items[0];
  const rest = items.slice(1);
  if (!head) return null;

  return (
    <article
      data-testid="trial-knowledge-group"
      className="rounded-md border border-border-default bg-surface p-3 sm:p-4"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-lg leading-none shrink-0">📎</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold truncate">{head.entity}</h3>
          <p className="mt-1 text-xs text-fg-muted">{head.observation}</p>
          {rest.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                data-testid="trial-knowledge-toggle"
                className="mt-2 text-xs font-medium text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded min-h-6"
              >
                {expanded ? 'Show less' : `+${rest.length} more`}
              </button>
              {expanded ? (
                <ul className="mt-2 flex flex-col gap-2 border-t border-border-default pt-2">
                  {rest.map((item, idx) => (
                    <li key={`${idx}-${item.entity}`} className="text-xs">
                      <span className="font-semibold text-fg-primary">{item.entity}: </span>
                      <span className="text-fg-muted">{item.observation}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
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
