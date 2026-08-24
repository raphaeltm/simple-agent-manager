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
 * ## Relationship to ProvisioningIndicator (rule 24)
 *
 * `pages/project-chat/ProvisioningIndicator.tsx` renders a similar, richer
 * 4-stage progress block from the same `TaskExecutionStep` vocabulary. The two do
 * not overlap, because they are driven by *different tasks*:
 *
 *  - ProvisioningIndicator is fed by `useProjectChatState`, which polls
 *    `getProjectTask(session.taskId)` — the session's OWN task — and only
 *    populates state for a task that is neither terminal nor `in_progress`. During
 *    a wake the session's own task is `in_progress`, so it stays hidden.
 *  - This banner is fed by the *recovery* task, a different row reached through
 *    `session_snapshots.recovery_task_id`, which ProvisioningIndicator has no
 *    reference to.
 *
 * So a wake previously showed no phase progress at all. The `wake-progress-audit`
 * spec asserts the two never render together; if that assertion ever fires, they
 * have started to overlap and should be consolidated rather than both kept.
 *
 * A thin strip rather than the full provisioning block is deliberate: a wake
 * restores an existing conversation, so the transcript stays on screen underneath.
 *
 * Extracted as its own component to keep `project-message-view/index.tsx` under the
 * file-size ceiling (rule 18).
 */

import { type TaskExecutionStep, wakePhaseLabel } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import type { FC, ReactNode } from 'react';

export interface WakeProgressBannerProps {
  wakePhase: TaskExecutionStep | null;
  /** Rendered alongside the label — the elapsed-time readout, when available. */
  elapsed?: ReactNode;
}

export const WakeProgressBanner: FC<WakeProgressBannerProps> = ({ wakePhase, elapsed }) => (
  <div
    data-testid="wake-progress-banner"
    className="flex items-center gap-2 px-4 py-1.5 border-b border-border-default bg-surface text-xs text-fg-muted"
  >
    {/*
      Spinner is decorative here — it carries its own role="status"/"Loading",
      which would otherwise nest a second status region inside this one.
    */}
    <span className="shrink-0" aria-hidden="true">
      <Spinner size="sm" />
    </span>
    {/*
      min-w-0 + break-words: the label is short today, but this banner sits inside
      the project Outlet wrapper where a fit-content page root can be dragged past
      the viewport by any nowrap descendant (rule 56).
    */}
    {/*
      The live region wraps ONLY the phase label. `role="status"` implies
      aria-atomic, so a ticking elapsed-time node inside it would re-announce the
      whole banner about once a second for the entire multi-minute wake. Keeping
      the timer a sibling means assistive tech announces one message per phase
      change, which is the actual signal.
    */}
    <span
      role="status"
      aria-live="polite"
      aria-label="Session wake progress"
      className="min-w-0 flex-1 break-words"
      data-testid="wake-progress-label"
    >
      {wakePhaseLabel(wakePhase)}
    </span>
    {elapsed != null && <span className="shrink-0">{elapsed}</span>}
  </div>
);
