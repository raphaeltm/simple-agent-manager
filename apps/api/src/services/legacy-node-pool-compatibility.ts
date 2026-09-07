import type { VMSize } from '@simple-agent-manager/shared';
import { canSatisfyVmSize } from '@simple-agent-manager/shared';

export function normalizeLegacyPoolSize(value: string | null): VMSize | null {
  switch (value) {
    case 'small':
    case 'medium':
    case 'large':
      return value;
    default:
      return null;
  }
}

export function legacyReusableNodeMatches(input: {
  nodeVmSize: string | null;
  requestedVmSize: string;
  candidateMachineSize: VMSize | null;
}): boolean {
  if (!input.nodeVmSize) return false;
  if (input.candidateMachineSize) {
    return canSatisfyVmSize(input.nodeVmSize, input.candidateMachineSize);
  }
  return canSatisfyVmSize(input.nodeVmSize, input.requestedVmSize);
}
