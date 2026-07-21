import {
  type ActiveWorkState,
  type ActiveWorkStatus,
} from './vm-agent-container-active-work';
import type {
  RuntimeRecoveryPhase,
  RuntimeRecoveryState,
  RuntimeRecoveryTrigger,
} from './vm-agent-container-recovery';

export type VmAgentContainerLifecycleStatus =
  | 'launching'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'sleeping'
  | 'recovering'
  | 'waking'
  | 'restoring'
  | 'degraded'
  | 'expired'
  | 'error';

export interface VmAgentContainerLifecycleInspection {
  status: VmAgentContainerLifecycleStatus | null;
  recoveryPhase: RuntimeRecoveryPhase | null;
  recoveryTrigger: RuntimeRecoveryTrigger | null;
  activeWorkStatus: ActiveWorkStatus | null;
}

export interface VmAgentContainerLivenessClassification {
  live: boolean;
  conclusive: boolean;
  reason: string;
}

export async function inspectStoredVmAgentContainerLifecycle(
  storage: DurableObjectStorage,
  recoveryStateKey: string,
  activeWorkKey: string
): Promise<VmAgentContainerLifecycleInspection> {
  const [status, recovery, activeWork] = await Promise.all([
    storage.get<VmAgentContainerLifecycleStatus>('lifecycleStatus'),
    storage.get<RuntimeRecoveryState>(recoveryStateKey),
    storage.get<ActiveWorkState>(activeWorkKey),
  ]);
  return {
    status: status ?? null,
    recoveryPhase: recovery?.phase ?? null,
    recoveryTrigger: recovery?.trigger ?? null,
    activeWorkStatus: activeWork?.status ?? null,
  };
}

const TERMINAL_LIFECYCLE_STATUSES = new Set<VmAgentContainerLifecycleStatus>([
  'stopping',
  'stopped',
  'expired',
  'error',
]);

export function isVmAgentContainerLifecycleTerminal(
  status: VmAgentContainerLifecycleStatus | null
): boolean {
  return status !== null && TERMINAL_LIFECYCLE_STATUSES.has(status);
}

export function classifyVmAgentContainerLiveness(
  inspection: VmAgentContainerLifecycleInspection
): VmAgentContainerLivenessClassification {
  if (isVmAgentContainerLifecycleTerminal(inspection.status)) {
    return {
      live: false,
      conclusive: true,
      reason: `cf_container_${inspection.status}`,
    };
  }
  if (inspection.status === 'running' && inspection.activeWorkStatus === 'active') {
    return { live: true, conclusive: true, reason: 'cf_container_active_work' };
  }
  return {
    live: false,
    conclusive: false,
    reason: `cf_container_${inspection.status ?? 'unknown'}_resumable`,
  };
}
