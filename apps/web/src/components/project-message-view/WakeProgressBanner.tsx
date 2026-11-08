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
 * A floating capsule rather than the full provisioning slab is deliberate: a wake
 * restores an existing conversation, so the transcript stays on screen underneath.
 *
 * Extracted as its own component to keep `project-message-view/index.tsx` under the
 * file-size ceiling (rule 18).
 */

import {
  type TaskExecutionStep,
  WAKE_WAIT_REASON_LABELS,
  wakePhaseLabel,
} from '@simple-agent-manager/shared';
import type { FC, ReactNode } from 'react';

import { StatusCapsule } from '../chat-notices/StatusCapsule';
import type { WakeWait } from './useWakeProgress';

/**
 * The phase says where a wake is; a known wait reason says why it is not moving.
 * "Waiting for server capacity..." alone hid three different causes.
 */
/**
 * A reason is pulled by the poll, while phases can also arrive by push. Show a
 * reason only for the phase it describes, so a pushed phase change never keeps
 * an older cause on screen until the next poll.
 */
function wakeWaitAppliesTo(wakePhase: TaskExecutionStep | null, wakeWait: WakeWait): boolean {
  if (wakeWait.reason === 'previous_workspace_cleanup') return wakePhase === null;
  return wakePhase === 'waiting_for_node_capacity';
}

export function wakeProgressLabel(
  wakePhase: TaskExecutionStep | null,
  wakeWait: WakeWait | null | undefined,
  now = Date.now()
): string {
  if (!wakeWait || !wakeWaitAppliesTo(wakePhase, wakeWait)) return wakePhaseLabel(wakePhase);
  const label = WAKE_WAIT_REASON_LABELS[wakeWait.reason];
  const retryAt = wakeWait.retryAt ? Date.parse(wakeWait.retryAt) : Number.NaN;
  if (!Number.isFinite(retryAt) || retryAt <= now) return label;
  const time = new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${label} Next try at ${time}.`;
}

export interface WakeProgressBannerProps {
  wakePhase: TaskExecutionStep | null;
  wakeWait?: WakeWait | null;
  /** Rendered alongside the label — the elapsed-time readout, when available. */
  elapsed?: ReactNode;
}

export const WakeProgressBanner: FC<WakeProgressBannerProps> = ({
  wakePhase,
  wakeWait,
  elapsed,
}) => (
  // A capsule floating over the conversation (SAM Glass), not a strip in the column: a wake
  // restores an existing conversation, so the transcript stays put underneath it.
  <StatusCapsule
    tone={wakeWait && wakeWaitAppliesTo(wakePhase, wakeWait) ? 'warning' : 'progress'}
    data-testid="wake-progress-banner"
    trailing={elapsed}
  >
    {/*
      The live region wraps ONLY the phase label. `role="status"` implies
      aria-atomic, so a ticking elapsed-time node inside it would re-announce the
      whole banner about once a second for the entire multi-minute wake. Keeping
      the timer a sibling (the capsule's `trailing`) means assistive tech announces
      one message per phase change, which is the actual signal.
    */}
    <span
      role="status"
      aria-live="polite"
      aria-label="Session wake progress"
      data-testid="wake-progress-label"
    >
      {wakeProgressLabel(wakePhase, wakeWait)}
    </span>
  </StatusCapsule>
);
