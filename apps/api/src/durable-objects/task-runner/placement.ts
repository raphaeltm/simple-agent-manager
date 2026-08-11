import type {
  PlacementExplanation,
  PlacementProvisioningAttempt,
  PlacementProvisioningFailureReason,
} from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { appendProvisioningAttempt, failPlacement } from '../../services/placement-explanation';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function persistTaskPlacement(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  explanation: PlacementExplanation
): Promise<void> {
  state.placementExplanation = explanation;
  const now = new Date().toISOString();
  await rc.env.DATABASE.prepare(
    `UPDATE tasks SET placement_explanation_json = ?, updated_at = ? WHERE id = ?`
  )
    .bind(JSON.stringify(explanation), now, state.taskId)
    .run();
  await rc.ctx.storage.put('state', state);
  log.info('task_runner_do.placement_decided', {
    taskId: state.taskId,
    placement: explanation,
  });
}

export async function recordProvisioningAttempt(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  attempt: PlacementProvisioningAttempt,
  selectedNodeId?: string | null
): Promise<void> {
  if (!state.placementExplanation) return;
  await persistTaskPlacement(
    state,
    rc,
    appendProvisioningAttempt(state.placementExplanation, attempt, selectedNodeId)
  );
}

export async function recordPlacementFailure(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  reason: PlacementProvisioningFailureReason
): Promise<void> {
  if (!state.placementExplanation || state.placementExplanation.outcome === 'failed') return;
  await persistTaskPlacement(state, rc, failPlacement(state.placementExplanation, reason));
}
