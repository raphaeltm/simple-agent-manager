/** Persist the runtime's decision evidence without exposing its credential snapshot. */
import { resolveResourceReservation } from '@simple-agent-manager/shared';

import {
  buildPlacementDecisionDiagnostics,
  type BuildPlacementDiagnosticsInput,
} from '../../services/placement-diagnostics';
import { isResolvedResourceReservation } from '../../services/workspace-resource-capacity';
import type { TaskRunnerContext, TaskRunnerState } from './types';

type DecisionUpdate = Omit<
  BuildPlacementDiagnosticsInput,
  'requestedReservation' | 'selection' | 'previous'
>;

export function updatePlacementDiagnostics(
  state: TaskRunnerState,
  update: DecisionUpdate = {}
): void {
  const reservation = isResolvedResourceReservation(state.config.resolvedReservation)
    ? state.config.resolvedReservation
    : resolveResourceReservation(
        { task: state.config.resourceRequirements ?? undefined },
        {
          taskId: state.taskId,
          projectId: state.projectId,
          userId: state.userId,
        }
      );
  state.stepResults.placementDiagnostics = buildPlacementDecisionDiagnostics({
    previous: state.stepResults.placementDiagnostics,
    requestedReservation: reservation,
    selection: state.config.capacityPoolSelection ?? null,
    selectedNodeId: state.stepResults.nodeId,
    ...update,
  });
  const snapshot = state.stepResults.capacityPlacementSnapshot;
  if (snapshot) {
    let explanation: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(snapshot.placementExplanationJson ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        explanation = parsed as Record<string, unknown>;
    } catch {
      /* Historical snapshots may predate JSON explanations. */
    }
    snapshot.placementExplanationJson = JSON.stringify({
      ...explanation,
      diagnostics: state.stepResults.placementDiagnostics,
    });
  }
}

export async function persistPlacementDiagnostics(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  update: DecisionUpdate = {}
): Promise<void> {
  updatePlacementDiagnostics(state, update);
  const diagnostics = JSON.stringify(state.stepResults.placementDiagnostics);
  // Preserve existing audit fields, including when no candidate/snapshot exists yet.
  await rc.env.DATABASE.prepare(
    `UPDATE tasks SET placement_explanation_json = json_set(
    CASE WHEN json_valid(placement_explanation_json) THEN placement_explanation_json ELSE '{}' END,
    '$.diagnostics', json(?)) WHERE id = ? AND project_id = ? AND user_id = ?`
  )
    .bind(diagnostics, state.taskId, state.projectId, state.userId)
    .run();
  await rc.ctx.storage.put('state', state);
}
