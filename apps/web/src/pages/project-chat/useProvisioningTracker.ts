/**
 * Tracks a chat session's own task through infrastructure bring-up so the
 * project chat page can render `ProvisioningIndicator`.
 *
 * Two effects share the `provisioning` state owned by `useProjectChatState`:
 *
 *  - **poll** — while `provisioning` is set and the tab is visible, refresh the
 *    task every `TASK_STATUS_POLL_MS` and clear the state once the runner is
 *    past provisioning: the agent is running, the task is terminal, or the
 *    conversation went to sleep.
 *  - **restore** — on navigation to a session with no local provisioning state,
 *    re-derive it from the session's own task so a reload mid-provisioning still
 *    shows progress.
 *
 * Restore renders the banner only for a session's FIRST boot. Since PR #2230 a
 * slept VM conversation keeps its original task row, which is `sleeping` with a
 * null execution step while idle (`services/session-sleep-teardown.ts`) and
 * `queued`/`delegated` while a wake is in flight
 * (`services/session-recovery.ts`). Neither is first-boot provisioning: nothing
 * is happening in the idle case, and the wake case is already rendered by
 * `WakeProgressBanner`. The previous "not terminal and not in_progress"
 * denylist matched both and showed "Starting... Waiting for task runner..."
 * over an idle slept chat, with a timer counting from the task's original start.
 *
 * Three gates, each keyed on the condition rather than a proxy (rule 74):
 *  1. the selected session's status is not `sleeping` (the server's chat
 *     session status, kept live by the `session.updated` sleep/wake broadcasts);
 *  2. the task status is in `PROVISIONING_TASK_STATUSES` (an allowlist, so a
 *     future status cannot fall through);
 *  3. the task has no `startedAt`. `started_at` is written exactly once, when
 *     the agent first starts (`task-runner/state-machine.ts`
 *     `transitionToInProgress`), and a wake does not reset it, so a `queued`
 *     task that has started before is a wake — this backstops gate 1 against a
 *     dropped WebSocket frame leaving the list entry stale.
 */
import type { Dispatch, SetStateAction } from 'react';
import { useEffect } from 'react';
import type { NavigateFunction } from 'react-router';

import { useDocumentVisible } from '../../hooks/useVisibilityAwarePoll';
import type { ChatSessionListItem } from '../../lib/api';
import { getProjectTask, getWorkspace } from '../../lib/api';
import type { ProvisioningState } from './types';
import {
  isProvisioningStatus,
  isTerminal,
  PROVISIONING_RESTORE_RETRIES,
  TASK_STATUS_POLL_MS,
} from './types';

export interface UseProvisioningTrackerArgs {
  projectId: string;
  sessionId: string | undefined;
  sessions: readonly ChatSessionListItem[];
  provisioning: ProvisioningState | null;
  setProvisioning: Dispatch<SetStateAction<ProvisioningState | null>>;
  navigate: NavigateFunction;
  loadSessions: () => Promise<unknown>;
}

export function useProvisioningTracker({
  projectId,
  sessionId,
  sessions,
  provisioning,
  setProvisioning,
  navigate,
  loadSessions,
}: UseProvisioningTrackerArgs): void {
  // Poll task status during provisioning
  const provisioningVisible = useDocumentVisible();
  useEffect(() => {
    if (!provisioning || isTerminal(provisioning.status)) return;
    // Provisioning polls every 2s and can run for minutes — by far the hottest
    // poll on this page. Suspend it in a hidden tab; re-running this effect on
    // the visibility transition refreshes once immediately on return, which is
    // what a 2s progress poll wants.
    if (!provisioningVisible) return;
    const poll = async () => {
      try {
        const task = await getProjectTask(projectId, provisioning.taskId);
        setProvisioning((prev) => {
          if (!prev) return null;
          const next = {
            ...prev,
            status: task.status,
            executionStep: task.executionStep ?? null,
            errorMessage: task.errorMessage ?? null,
            requestedVmSize: task.requestedVmSize ?? prev.requestedVmSize,
            provisionedVmSize: task.provisionedVmSize ?? prev.provisionedVmSize,
          };
          if (task.workspaceId && !prev.workspaceId) next.workspaceId = task.workspaceId;
          return next;
        });
        if (task.workspaceId && !provisioning.workspaceUrl) {
          try {
            const ws = await getWorkspace(task.workspaceId);
            if (ws.url)
              setProvisioning((prev) => (prev ? { ...prev, workspaceUrl: ws.url ?? null } : null));
          } catch {
            /* Workspace may not be ready yet */
          }
        }
        const agentRunning =
          task.status === 'in_progress' &&
          (Boolean(task.workspaceId) || task.executionStep === 'running');
        // A conversation that slept before the agent reported in belongs to the
        // sleep/wake UI from here on; polling it would say "Starting..." forever.
        const slept = task.status === 'sleeping';
        if (agentRunning || slept) {
          navigate(`/projects/${projectId}/chat/${provisioning.sessionId}`, { replace: true });
          setProvisioning(null);
          if (slept) void loadSessions();
        }
        if (isTerminal(task.status)) {
          navigate(`/projects/${projectId}/chat/${provisioning.sessionId}`, { replace: true });
          setProvisioning(null);
          void loadSessions();
        }
      } catch {
        /* Continue polling on transient errors */
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), TASK_STATUS_POLL_MS);
    return () => clearInterval(interval);
    // `workspaceUrl` is a dependency so that storing it restarts the interval
    // once (one immediate poll) instead of leaving a closure that refetches the
    // workspace on every tick; the other fields the poll writes are
    // deliberately NOT dependencies, or every tick would restart the interval.
  }, [
    provisioning?.taskId,
    provisioning?.status,
    provisioning?.sessionId,
    provisioning?.workspaceUrl,
    projectId,
    navigate,
    loadSessions,
    setProvisioning,
    provisioningVisible,
  ]);

  // Restore provisioning state when navigating to a session whose own task is
  // still being provisioned by the runner. Keyed on the selected session's task
  // and status rather than the whole list, so an unrelated sidebar delta does
  // not cost a task fetch (rule 60).
  const selectedSession = sessions.find((s) => s.id === sessionId);
  const selectedTaskId = selectedSession?.taskId ?? null;
  const selectedSessionSleeping = selectedSession?.status === 'sleeping';
  useEffect(() => {
    if (!sessionId || provisioning || !selectedTaskId) return;
    // Gate 1: a sleeping session's task is `sleeping` while idle and
    // `queued`/`delegated` while a wake is in flight. Neither is first-boot
    // provisioning; the sleep/wake UI owns that session until it is active again.
    if (selectedSessionSleeping) return;
    let cancelled = false;
    let retriesLeft = PROVISIONING_RESTORE_RETRIES;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      try {
        const task = await getProjectTask(projectId, selectedTaskId);
        if (cancelled) return;
        // Gate 2: allowlist. Gate 3: a task that has started before is a wake.
        if (!isProvisioningStatus(task.status) || task.startedAt) return;
        setProvisioning({
          taskId: task.id,
          sessionId,
          branchName: task.outputBranch ?? '',
          status: task.status,
          executionStep: task.executionStep ?? null,
          errorMessage: task.errorMessage ?? null,
          startedAt: Date.now(),
          workspaceId: task.workspaceId ?? null,
          workspaceUrl: null,
          requestedVmSize: task.requestedVmSize ?? null,
          provisionedVmSize: task.provisionedVmSize ?? null,
        });
      } catch {
        // Transient failure (offline blip, 5xx). Retry a bounded number of
        // times so a reload mid-provisioning does not lose the banner for good.
        if (cancelled || retriesLeft <= 0) return;
        retriesLeft -= 1;
        retryTimer = setTimeout(() => void attempt(), TASK_STATUS_POLL_MS);
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [
    sessionId,
    selectedTaskId,
    selectedSessionSleeping,
    projectId,
    provisioning,
    setProvisioning,
  ]);
}
