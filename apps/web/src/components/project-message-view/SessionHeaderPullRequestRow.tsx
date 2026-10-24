/**
 * The header's "View PR" link and the idle-cleanup countdown.
 *
 * Extracted from `SessionHeader` so adding the PR's state did not push that file further past
 * the 500-line ceiling (`.claude/rules/18-file-size-limits.md`); the behaviour of the two
 * pieces is unchanged apart from the state badge and the PR number.
 *
 * "View PR" used to be a bare link: it told you a pull request existed and nothing about
 * whether it was open, merged or closed — the one thing you want to know before clicking
 * through to GitHub. The state comes from SAM's own stored PR tracking via the chat's linked
 * work, so no GitHub request is made to render it, and the badge is simply absent while the
 * state is unknown rather than guessing.
 */
import type { LinkedPullRequest } from '@simple-agent-manager/shared';
import { GitPullRequest } from 'lucide-react';

import { PullRequestStateBadge } from '../chat/linked-work/PullRequestStateBadge';
import type { SessionState } from './types';
import { formatCountdown } from './types';

export function SessionHeaderPullRequestRow({
  sessionState,
  idleCountdownMs,
  pullRequest,
}: Readonly<{
  sessionState: SessionState;
  idleCountdownMs: number | null;
  /** The chat's primary pull request, with state when SAM has recorded it. */
  pullRequest: LinkedPullRequest | null;
}>) {
  const showCountdown = sessionState === 'idle' && idleCountdownMs !== null;
  if (!pullRequest && !showCountdown) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {showCountdown && (
        <span
          className="sam-type-caption font-mono"
          style={{
            color:
              (idleCountdownMs ?? 0) < 5 * 60 * 1000
                ? 'var(--sam-color-danger)'
                : 'var(--sam-color-warning, #f59e0b)',
          }}
        >
          Cleanup in {formatCountdown(idleCountdownMs ?? 0)}
        </span>
      )}

      {pullRequest && (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href={pullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
            className="sam-type-caption inline-flex shrink-0 items-center gap-1 font-medium no-underline"
            style={{ color: 'var(--sam-color-accent-primary)' }}
            data-testid="session-view-pr"
          >
            <GitPullRequest size={12} aria-hidden="true" />
            View PR #{pullRequest.number}
          </a>
          <PullRequestStateBadge state={pullRequest.state} />
        </span>
      )}
    </div>
  );
}
