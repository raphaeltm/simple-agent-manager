import { type ResolvedResourceReservation } from '@simple-agent-manager/shared';

import type { PlacementHostDiagnosticInput } from '../../services/placement-diagnostics';
import {
  normalizePlacementHostSignals,
  type PlacementHostSignals,
} from '../../services/placement-strategy';
import {
  type ActiveWorkspaceReservationUsage,
  evaluateWorkspaceReservationCapacity,
  parseWorkspaceAdmissionMetrics,
  type WorkspaceAdmissionPolicy,
} from '../../services/workspace-resource-capacity';
import type { DeferrableReusableNodeCandidate, ReusableNodeSelection } from './node-placement-deferral';
import type { NodePlacementFields } from './node-selection';

export type RankedReusableNode = {
  id: string;
  vmLocation: string;
  capacityPlacementSnapshot: import('@simple-agent-manager/shared').CapacityPlacementSnapshot | null;
  signals: PlacementHostSignals;
};

type ReusableNodeCandidateEvaluation = {
  diagnosticHost: PlacementHostDiagnosticInput;
  candidate?: RankedReusableNode;
  deferrableCandidate?: DeferrableReusableNodeCandidate;
  rejection?: { nodeId: string; reasons: string[] };
};

type ReusableNodeCandidateInput = {
  node: NodePlacementFields & { agentVersion: string | null };
  selection: ReusableNodeSelection | null;
  policy: WorkspaceAdmissionPolicy;
  usage: ActiveWorkspaceReservationUsage | undefined;
  requestedReservation: ResolvedResourceReservation;
  agentCompatible: boolean;
  satisfiesTaskResources: boolean;
  authoritative: boolean;
};

function candidateSignals(input: ReusableNodeCandidateInput): PlacementHostSignals {
  return normalizePlacementHostSignals({
    node: input.node,
    usage: input.usage,
    request: input.requestedReservation,
    policy: input.policy,
    metrics: parseWorkspaceAdmissionMetrics(input.node, input.policy),
  });
}

function reusableNodeExclusion(input: ReusableNodeCandidateInput): string | null {
  if (!input.agentCompatible) return 'Host agent version is incompatible';
  if (!input.satisfiesTaskResources) {
    return 'Trusted host hardware does not satisfy the requested resources';
  }
  if (!input.authoritative) return 'Host is outside the current pool allocation authority';
  return null;
}

function rejectedCandidateEvaluation(
  input: ReusableNodeCandidateInput,
  signals: PlacementHostSignals,
  reason: string
): ReusableNodeCandidateEvaluation {
  return {
    diagnosticHost: {
      signals,
      outcome: 'rejected',
      reasons: [reason],
      provider: input.node.cloudProvider,
      location: input.node.vmLocation,
      providerInstanceType: input.node.providerInstanceType,
    },
  };
}

function rankedNode(
  input: ReusableNodeCandidateInput,
  signals: PlacementHostSignals,
  selection: ReusableNodeSelection
): RankedReusableNode {
  return {
    id: input.node.id,
    vmLocation: input.node.vmLocation ?? '',
    capacityPlacementSnapshot: selection.capacityPlacementSnapshot,
    signals,
  };
}

function capacityCandidateEvaluation(
  input: ReusableNodeCandidateInput,
  signals: PlacementHostSignals,
  selection: ReusableNodeSelection
): ReusableNodeCandidateEvaluation {
  const metrics = parseWorkspaceAdmissionMetrics(input.node, input.policy);
  const capacity = evaluateWorkspaceReservationCapacity(
    input.node,
    input.usage,
    input.requestedReservation,
    input.policy,
    metrics
  );
  const diagnosticHost: PlacementHostDiagnosticInput = {
    signals,
    outcome: capacity.deferrable ? 'deferred' : 'rejected',
    reasons: capacity.admitted ? ['Another eligible host ranked higher'] : capacity.reasons,
    provider: input.node.cloudProvider,
    location: input.node.vmLocation,
    providerInstanceType: input.node.providerInstanceType,
  };
  if (capacity.admitted) return { diagnosticHost, candidate: rankedNode(input, signals, selection) };
  if (capacity.deferrable) {
    return {
      diagnosticHost,
      deferrableCandidate: rankedNode(input, signals, selection),
    };
  }
  return {
    diagnosticHost,
    rejection: { nodeId: input.node.id, reasons: capacity.reasons },
  };
}

export function evaluateReusableNodeCandidate(
  input: ReusableNodeCandidateInput
): ReusableNodeCandidateEvaluation {
  const signals = candidateSignals(input);
  const exclusion = reusableNodeExclusion(input);
  if (exclusion) return rejectedCandidateEvaluation(input, signals, exclusion);
  if (!input.selection) return rejectedCandidateEvaluation(input, signals, 'Host is not eligible');
  return capacityCandidateEvaluation(input, signals, input.selection);
}
