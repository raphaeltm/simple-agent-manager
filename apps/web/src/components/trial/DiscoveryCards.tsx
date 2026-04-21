/**
 * Presentational card components for the trial discovery feed.
 *
 * Includes event cards, knowledge groups, idea cards, agent activity,
 * stage skeleton, and terminal error panel.
 *
 * Extracted from TryDiscovery.tsx.
 */
import type {
  TrialAgentActivityEvent,
  TrialErrorEvent,
  TrialEvent,
  TrialIdeaEvent,
  TrialKnowledgeEvent,
} from '@simple-agent-manager/shared';
import { Alert } from '@simple-agent-manager/ui';
import { BookOpen, Brain, Lightbulb, Terminal, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';

import { trialErrorMessage } from '../../lib/trial-api';
import { friendlyStageLabel, STAGE_TIMELINE } from '../../lib/trial-ui-config';
import { cleanActivityText, extractRepoName } from '../../lib/trial-utils';

// ---------------------------------------------------------------------------
// EventCard — dispatches to the correct card by event type
// ---------------------------------------------------------------------------

export function EventCard({
  event,
}: {
  event: Exclude<TrialEvent, TrialKnowledgeEvent | TrialErrorEvent>;
}) {
  switch (event.type) {
    case 'trial.started':
      return (
        <Card tone="neutral" icon="◎" title={`Exploring ${extractRepoName(event.repoUrl)}`}>
          <p className="text-xs text-fg-muted">Trial id: <code className="font-mono text-[11px]">{event.trialId}</code></p>
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
        <Card tone="success" icon={<Terminal className="w-5 h-5" />} title="Environment ready">
          <p className="text-xs text-fg-muted">
            Your development environment is configured. An agent is now analyzing the
            repository to build a knowledge graph and suggest next steps&hellip;
          </p>
        </Card>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Card — reusable wrapper with tone variants
// ---------------------------------------------------------------------------

export function Card({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'neutral' | 'success' | 'info';
  icon: ReactNode;
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

// ---------------------------------------------------------------------------
// KnowledgeGroupCard
// ---------------------------------------------------------------------------

/**
 * Single grouped card for a burst of consecutive `trial.knowledge` events.
 * Shows the first observation by default; the rest collapse behind a
 * "+N more" toggle.
 */
export function KnowledgeGroupCard({ items }: { items: TrialKnowledgeEvent[] }) {
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
        <span aria-hidden className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-accent/10 text-accent">
          <BookOpen className="w-4 h-4" />
        </span>
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
                className="mt-2 inline-flex items-center text-xs font-medium text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded min-h-11 -mx-1 px-1"
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

// ---------------------------------------------------------------------------
// IdeaCard
// ---------------------------------------------------------------------------

export function IdeaCard({ event }: { event: TrialIdeaEvent }) {
  return (
    <article className="rounded-md border border-info/30 bg-info-tint/40 p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-info text-fg-on-accent"
        >
          <Lightbulb className="w-4 h-4" />
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
// AgentActivityGroupCard
// ---------------------------------------------------------------------------

/**
 * Grouped card for a burst of `trial.agent_activity` events. Shows what the
 * discovery agent is doing — tool calls, thinking snippets, assistant text.
 * Only the latest 3 items are shown to keep the feed compact.
 */
export function AgentActivityGroupCard({ items }: { items: TrialAgentActivityEvent[] }) {
  // Show only the most recent items to avoid feed spam
  const visible = items.slice(-3);
  return (
    <article
      data-testid="trial-activity-group"
      className="rounded-md border border-border-default bg-surface/60 p-3 sm:p-4"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-canvas border border-border-default text-fg-muted trial-skeleton-active"
        >
          <Brain className="w-4 h-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-medium text-fg-muted">
            Agent working&hellip;
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {visible.map((item, idx) => (
              <li key={`${idx}-${item.at}`} className="flex items-start gap-2 text-xs text-fg-muted">
                <ActivityRoleIcon role={item.role} />
                <span className="min-w-0 break-words line-clamp-2">
                  {item.toolName ? (
                    <><code className="font-mono text-[11px] text-accent">{item.toolName}</code>{' '}</>
                  ) : null}
                  {cleanActivityText(item.text)}
                </span>
              </li>
            ))}
          </ul>
          {items.length > 3 ? (
            <p className="mt-1 text-[11px] text-fg-muted">
              +{items.length - 3} more actions
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ActivityRoleIcon({ role }: { role: 'assistant' | 'tool' | 'thinking' }) {
  switch (role) {
    case 'tool':
      return <Wrench className="w-3 h-3 shrink-0 mt-0.5" />;
    case 'thinking':
      return <Brain className="w-3 h-3 shrink-0 mt-0.5" />;
    default:
      return <Terminal className="w-3 h-3 shrink-0 mt-0.5" />;
  }
}

// ---------------------------------------------------------------------------
// StageSkeleton — pre-event roadmap
// ---------------------------------------------------------------------------

/**
 * Skeleton timeline rendered before the first SSE event arrives.
 * Highlights the current stage (when known) and dims completed/upcoming.
 */
export function StageSkeleton({ activeStage }: { activeStage?: string }) {
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

// ---------------------------------------------------------------------------
// TerminalErrorPanel
// ---------------------------------------------------------------------------

export function TerminalErrorPanel({ error }: { error: TrialErrorEvent }) {
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
              className="inline-flex items-center min-h-[44px] text-sm font-medium underline underline-offset-2"
              data-testid="trial-error-retry"
            >
              Try again →
            </Link>
          ) : (
            <Link
              to="/try/cap-exceeded"
              className="inline-flex items-center min-h-[44px] text-sm font-medium underline underline-offset-2"
            >
              Join the waitlist →
            </Link>
          )}
        </div>
      </div>
    </Alert>
  );
}
