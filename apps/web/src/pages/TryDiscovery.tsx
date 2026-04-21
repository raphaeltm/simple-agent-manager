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
import type { TrialIdea } from '@simple-agent-manager/shared';
import { Alert } from '@simple-agent-manager/ui';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router';

import { ChatGate } from '../components/trial/ChatGate';
import {
  AgentActivityGroupCard,
  EventCard,
  KnowledgeGroupCard,
  StageSkeleton,
  TerminalErrorPanel,
} from '../components/trial/DiscoveryCards';
import { DiscoveryHeader } from '../components/trial/DiscoveryHeader';
import { useTrialEvents } from '../hooks/useTrialEvents';
import {
  TRIAL_EVENT_ANIMATION_MS,
  TRIAL_MAX_RECONNECT_ATTEMPTS,
} from '../lib/trial-ui-config';
import { buildFeed, deriveView } from '../lib/trial-view-model';

// Re-export for backward compatibility with existing tests.
export { buildFeed } from '../lib/trial-view-model';
export { eventDedupKey } from '../lib/trial-utils';

export function TryDiscovery() {
  const { trialId } = useParams<{ trialId: string }>();
  const navigate = useNavigate();
  const { events, connection, isSlow, sourceRef } = useTrialEvents(trialId);

  const feedRef = useRef<HTMLOListElement>(null);

  // Auto-scroll to bottom when new events arrive (especially on mobile).
  useLayoutEffect(() => {
    if (events.length === 0 || !feedRef.current) return;
    const last = feedRef.current.lastElementChild;
    if (last) {
      last.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [events.length]);

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
  // The workspace is provisioned but discovery may still be running.
  const isDiscovering = view.ready !== null && connection.status === 'open' && sourceRef.current !== null;
  // Show the stage skeleton until *substantive* progress arrives. A lone
  // `trial.started` event is just an acknowledgement — the user still sees
  // nothing happening, so keep the "Setting things up" roadmap visible.
  const showSkeleton =
    !terminalError && events.every((e) => e.type === 'trial.started');

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
          discovering={isDiscovering}
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
          ref={feedRef}
          className="flex flex-col gap-3"
          role="feed"
          aria-busy={connection.status !== 'open'}
          data-testid="trial-feed"
        >
          {feedItems.map((item) => (
            <li key={item.key} className="trial-feed-item motion-safe:animate-trial-slide-in">
              {item.kind === 'event' ? (
                <EventCard event={item.event} />
              ) : item.kind === 'knowledge-group' ? (
                <KnowledgeGroupCard items={item.items} />
              ) : (
                <AgentActivityGroupCard items={item.items} />
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
