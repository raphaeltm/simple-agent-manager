/**
 * Phase-level progress indicator for a sleeping conversation being woken.
 *
 * ## Why a phase and not just a spinner
 *
 * A VM wake takes minutes: provision a server, recreate the workspace, restore the
 * snapshot, start the agent. The previous banner said "Waking and restoring
 * session..." for that entire window, which is indistinguishable from a hang — and
 * that ambiguity is not hypothetical. It is what caused a duplicate wake task to be
 * dispatched, which in turn produced two concurrent investigations of the same bug
 * (idea 01M0D1WSZ1TD6ZE2YYE268SEHV).
 *
 * Naming the current phase turns "is this broken?" into "it's on step 3 of 4".
 *
 * Extracted as its own component to keep `project-message-view/index.tsx` under the
 * file-size ceiling (rule 18).
 */

import { wakePhaseLabel, type TaskExecutionStep } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import type { FC, ReactNode } from 'react';

export interface WakeProgressBannerProps {
  wakePhase: TaskExecutionStep | null;
  /** Rendered alongside the label — the elapsed-time readout, when available. */
  elapsed?: ReactNode;
}

export const WakeProgressBanner: FC<WakeProgressBannerProps> = ({ wakePhase, elapsed }) => (
  <div
    role="status"
    aria-live="polite"
    aria-label="Session wake progress"
    data-testid="wake-progress-banner"
    className="flex items-center gap-2 px-4 py-1.5 border-b border-border-default bg-surface text-xs text-fg-muted"
  >
    <span className="shrink-0">
      <Spinner size="sm" />
    </span>
    {/*
      min-w-0 + break-words: the label is short today, but this banner sits inside
      the project Outlet wrapper where a fit-content page root can be dragged past
      the viewport by any nowrap descendant (rule 56).
    */}
    <span className="min-w-0 flex-1 break-words" data-testid="wake-progress-label">
      {wakePhaseLabel(wakePhase)}
    </span>
    {elapsed != null && <span className="shrink-0">{elapsed}</span>}
  </div>
);
