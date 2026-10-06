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
 * 4-stage progress block from the same `TaskExecutionStep` vocabulary. The two
 * must never render together, and since PR #2230 they are driven by the SAME
 * task: a slept VM conversation keeps its original task row, which is
 * `sleeping` while idle and `queued`/`delegated` while a wake is in flight.
 *
 *  - ProvisioningIndicator is fed by `pages/project-chat/useProvisioningTracker`,
 *    which restores state only for a session that is not `sleeping` and whose
 *    task is in a runner pre-agent status (`isProvisioningStatus`). It covers
 *    the first boot of a new chat and nothing else.
 *  - This banner is fed by `SessionStateSnapshot.recoveryStatus`/`wakePhase`
 *    (`routes/chat/wake-state.ts`), so it covers the wake of a sleeping session.
 *
 * `sleeping-session-audit.spec.ts` asserts the two never render together for an
 * idle slept session or a waking one; if that assertion ever fires, consolidate
 * rather than keep both.
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
