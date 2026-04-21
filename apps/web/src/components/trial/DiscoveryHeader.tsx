/**
 * Sticky header for the trial discovery page — repo name, progress bar,
 * stage label, and connection badge.
 *
 * Extracted from TryDiscovery.tsx.
 */
import type { TrialProgressEvent, TrialStartedEvent } from '@simple-agent-manager/shared';
import { Typography } from '@simple-agent-manager/ui';

import type { ConnectionState } from '../../hooks/useTrialEvents';
import { friendlyStageLabel, TRIAL_PROGRESS_TRANSITION_MS } from '../../lib/trial-ui-config';
import { extractRepoName } from '../../lib/trial-utils';

interface HeaderProps {
  started: TrialStartedEvent | null;
  progressLatest: TrialProgressEvent | null;
  connection: ConnectionState;
  ready: boolean;
  discovering?: boolean;
}

export function DiscoveryHeader({ started, progressLatest, connection, ready, discovering }: HeaderProps) {
  const repoName = started ? extractRepoName(started.repoUrl) : 'your repo';
  const progressPct =
    progressLatest?.progress !== undefined
      ? Math.round(Math.max(0, Math.min(1, progressLatest.progress)) * 100)
      : null;
  const stageLabel = progressLatest ? friendlyStageLabel(progressLatest.stage) : null;

  return (
    <header
      className="sticky top-0 -mx-4 px-4 py-3 bg-canvas/95 backdrop-blur-sm border-b border-border-default z-10"
      role="region"
      aria-label="Trial status"
    >
      <div className="flex items-start gap-3 justify-between">
        <div className="min-w-0 flex-1" title={repoName}>
          <Typography variant="title" as="h1" className="truncate">
            {ready && !discovering ? (
              <>Ready: <code className="font-mono">{repoName}</code></>
            ) : ready && discovering ? (
              <>Discovering <code className="font-mono">{repoName}</code>…</>
            ) : (
              <>Exploring <code className="font-mono">{repoName}</code>…</>
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
  // Use both color AND a Unicode shape so the meaning is conveyed without
  // relying on color alone (WCAG 1.4.1 Use of Color).
  const label =
    status === 'open'
      ? 'Live'
      : status === 'connecting'
        ? 'Connecting…'
        : status === 'retrying'
          ? 'Reconnecting'
          : 'Offline';
  const shape =
    status === 'open' ? '●' : status === 'failed' ? '✕' : status === 'retrying' ? '↺' : '○';
  const classes =
    status === 'open'
      ? 'bg-success-tint text-success-fg'
      : status === 'failed'
        ? 'bg-danger-tint text-danger-fg'
        : 'bg-surface text-fg-muted';
  return (
    <span
      data-testid="trial-connection-badge"
      className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full border border-border-default inline-flex items-center gap-1 ${classes}`}
    >
      <span aria-hidden="true">{shape}</span>
      {label}
    </span>
  );
}
