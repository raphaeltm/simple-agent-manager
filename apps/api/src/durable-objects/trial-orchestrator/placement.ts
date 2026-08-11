import type {
  PlacementExplanation,
  PlacementProvisioningAttempt,
  PlacementProvisioningFailureReason,
} from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { appendProvisioningAttempt, failPlacement } from '../../services/placement-explanation';
import type { TrialOrchestratorContext, TrialOrchestratorState } from './types';

export async function persistTrialPlacement(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext,
  explanation: PlacementExplanation
): Promise<void> {
  state.placementExplanation = explanation;
  await rc.env.DATABASE.prepare(`UPDATE trials SET placement_explanation_json = ? WHERE id = ?`)
    .bind(JSON.stringify(explanation), state.trialId)
    .run();
  await rc.ctx.storage.put('state', state);
  log.info('trial_orchestrator_do.placement_decided', {
    trialId: state.trialId,
    placement: explanation,
  });
}

export async function recordTrialProvisioningAttempt(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext,
  attempt: PlacementProvisioningAttempt,
  nodeId?: string | null
): Promise<void> {
  if (!state.placementExplanation) return;
  await persistTrialPlacement(
    state,
    rc,
    appendProvisioningAttempt(state.placementExplanation, attempt, nodeId)
  );
}

export async function recordTrialPlacementFailure(
  state: TrialOrchestratorState,
  rc: TrialOrchestratorContext,
  reason: PlacementProvisioningFailureReason
): Promise<void> {
  if (!state.placementExplanation || state.placementExplanation.outcome === 'failed') return;
  await persistTrialPlacement(state, rc, failPlacement(state.placementExplanation, reason));
}
