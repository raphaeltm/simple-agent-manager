import type { TriggerResponse, TriggerStatus, UpdateTriggerRequest } from '@simple-agent-manager/shared';
import { useCallback, useRef, useState } from 'react';

import { deleteTrigger, runTrigger, updateTrigger } from '../lib/api';
import { useToast } from './useToast';

/**
 * The mutating actions a user can start from a trigger card or the trigger
 * detail header. Tracked per trigger so one row going busy never disables the
 * controls on a sibling row.
 */
export type TriggerActionKind = 'run' | 'toggle' | 'delete';

interface UseTriggerActionsOptions {
  projectId: string;
  /**
   * Applies a status to locally-held trigger state. Called twice per toggle:
   * once optimistically before the request, and once more to roll back if the
   * request fails. Must be a no-op when the trigger is not present locally.
   */
  applyStatus: (triggerId: string, status: TriggerStatus) => void;
  /** Reconciles authoritative server state after a mutation settles. */
  onSettled?: (trigger: TriggerResponse) => void;
  /** Called after a successful manual run, once the execution row exists. */
  onRan?: (triggerId: string) => void;
  /** Called after a successful delete, e.g. to drop the row or navigate away. */
  onDeleted?: (triggerId: string) => void;
}

/**
 * Extracts a user-presentable message, falling back when the error carries no
 * usable text. An error toast with an empty body is barely better than no toast
 * at all, and a server can legitimately return a body without a `message`.
 */
function errorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message.trim() : '';
  return message.length > 0 ? message : fallback;
}

export interface TriggerActions {
  runNow: (trigger: TriggerResponse) => void;
  togglePause: (trigger: TriggerResponse) => void;
  remove: (trigger: TriggerResponse) => void;
  /** The action currently in flight for this trigger, if any. */
  pendingAction: (triggerId: string) => TriggerActionKind | null;
}

/**
 * Shared mutation orchestration for the trigger list and trigger detail pages.
 *
 * Three behaviours this centralises, all of which were previously missing:
 *
 * 1. **Optimistic status.** Pause/resume flips local status immediately and
 *    rolls back on failure, so the status dot, button label, and paused banner
 *    all respond on the same frame as the tap instead of ~1-2s later.
 * 2. **Pending state.** The in-flight action is exposed per trigger so the
 *    button that was pressed can show a spinner and disable itself.
 * 3. **Re-entrancy guard.** A trigger with an action in flight ignores further
 *    presses. Without this, repeated taps (which are exactly what a user does
 *    when nothing appears to happen) fired one request per tap — and for
 *    "Run Now" that meant one real agent task spawned per tap.
 *
 * Toast policy: pause/resume is silent on success because the optimistic state
 * change is itself the feedback, and only surfaces a toast when it fails. Run
 * and delete do toast on success because neither produces a visible state
 * change on this screen.
 */
export function useTriggerActions({
  projectId,
  applyStatus,
  onSettled,
  onRan,
  onDeleted,
}: UseTriggerActionsOptions): TriggerActions {
  const toast = useToast();
  const [pending, setPending] = useState<Record<string, TriggerActionKind>>({});

  // Mirrors `pending` for synchronous reads. Two taps inside the same tick both
  // observe the pre-update state variable, so the guard has to read a ref.
  const pendingRef = useRef<Record<string, TriggerActionKind>>({});

  const begin = useCallback((triggerId: string, kind: TriggerActionKind): boolean => {
    if (pendingRef.current[triggerId]) return false;
    pendingRef.current = { ...pendingRef.current, [triggerId]: kind };
    setPending(pendingRef.current);
    return true;
  }, []);

  const end = useCallback((triggerId: string) => {
    const next = { ...pendingRef.current };
    delete next[triggerId];
    pendingRef.current = next;
    setPending(next);
  }, []);

  const runNow = useCallback(
    (trigger: TriggerResponse) => {
      if (!begin(trigger.id, 'run')) return;
      void (async () => {
        try {
          await runTrigger(projectId, trigger.id);
          toast.success(`"${trigger.name}" triggered`);
          // The run has been accepted and the execution row now exists, so a
          // refresh here reads back the new execution rather than the stale list.
          onRan?.(trigger.id);
        } catch (err) {
          toast.error(errorMessage(err, `Failed to run "${trigger.name}"`));
        } finally {
          end(trigger.id);
        }
      })();
    },
    [projectId, toast, onRan, begin, end]
  );

  const togglePause = useCallback(
    (trigger: TriggerResponse) => {
      if (!begin(trigger.id, 'toggle')) return;
      const previousStatus = trigger.status;
      const nextStatus: TriggerStatus = previousStatus === 'paused' ? 'active' : 'paused';

      // Optimistic: flip before the request so the tap has an immediate effect.
      applyStatus(trigger.id, nextStatus);

      void (async () => {
        try {
          const data: UpdateTriggerRequest = { status: nextStatus };
          const updated = await updateTrigger(projectId, trigger.id, data);
          onSettled?.(updated);
        } catch (err) {
          applyStatus(trigger.id, previousStatus); // roll back
          toast.error(
            errorMessage(
              err,
              `Failed to ${nextStatus === 'active' ? 'resume' : 'pause'} "${trigger.name}"`
            )
          );
        } finally {
          end(trigger.id);
        }
      })();
    },
    [projectId, toast, applyStatus, onSettled, begin, end]
  );

  const remove = useCallback(
    (trigger: TriggerResponse) => {
      if (!begin(trigger.id, 'delete')) return;
      void (async () => {
        try {
          await deleteTrigger(projectId, trigger.id);
          toast.success(`"${trigger.name}" deleted`);
          onDeleted?.(trigger.id);
        } catch (err) {
          toast.error(errorMessage(err, `Failed to delete "${trigger.name}"`));
        } finally {
          end(trigger.id);
        }
      })();
    },
    [projectId, toast, onDeleted, begin, end]
  );

  const pendingAction = useCallback(
    (triggerId: string): TriggerActionKind | null => pending[triggerId] ?? null,
    [pending]
  );

  return { runNow, togglePause, remove, pendingAction };
}
