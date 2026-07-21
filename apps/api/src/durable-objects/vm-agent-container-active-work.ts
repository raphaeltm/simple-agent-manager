import { log } from '../lib/logger';

export type ActiveWorkStatus = 'active' | 'ended' | 'expired';

export interface ActiveWorkState {
  status: ActiveWorkStatus;
  nodeId: string;
  workspaceId: string;
  agentSessionId: string;
  reason: string;
  activeSince: number;
  lastRenewedAt: number;
  deadlineAt: number;
  endedAt?: number;
  endReason?: string;
}

export interface ActiveWorkRuntime {
  storage: DurableObjectStorage;
  activeWorkMaxMs: number;
  renewIntervalMs: number;
  renewActivityTimeout: () => void;
  replaceSchedule: (delayMs: number) => Promise<void>;
  clearSchedule: () => Promise<void>;
}

export const ACTIVE_WORK_KEY = 'activeWork';

export async function startActiveWork(
  runtime: ActiveWorkRuntime,
  nodeId: string,
  input: { workspaceId: string; agentSessionId: string; reason: string }
): Promise<void> {
  const now = Date.now();
  const activeWork: ActiveWorkState = {
    status: 'active',
    nodeId,
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    reason: input.reason,
    activeSince: now,
    lastRenewedAt: now,
    deadlineAt: now + runtime.activeWorkMaxMs,
  };
  runtime.renewActivityTimeout();
  await runtime.storage.put(ACTIVE_WORK_KEY, activeWork);
  await runtime.replaceSchedule(runtime.renewIntervalMs);
  log.info('vm_agent_container_active_work_started', {
    nodeId,
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    reason: input.reason,
    activeSince: new Date(now).toISOString(),
    deadlineAt: new Date(activeWork.deadlineAt).toISOString(),
  });
}

export async function endActiveWork(runtime: ActiveWorkRuntime, reason: string): Promise<void> {
  const activeWork = await runtime.storage.get<ActiveWorkState>(ACTIVE_WORK_KEY);
  if (!activeWork || activeWork.status !== 'active') {
    await runtime.clearSchedule();
    return;
  }
  const now = Date.now();
  await runtime.storage.put(ACTIVE_WORK_KEY, {
    ...activeWork,
    status: 'ended',
    endedAt: now,
    endReason: reason,
  } satisfies ActiveWorkState);
  await runtime.clearSchedule();
  log.info('vm_agent_container_active_work_ended', {
    nodeId: activeWork.nodeId,
    workspaceId: activeWork.workspaceId,
    agentSessionId: activeWork.agentSessionId,
    reason,
    activeSince: new Date(activeWork.activeSince).toISOString(),
    lastRenewedAt: new Date(activeWork.lastRenewedAt).toISOString(),
    endedAt: new Date(now).toISOString(),
  });
}

export async function renewActiveWork(runtime: ActiveWorkRuntime): Promise<void> {
  const activeWork = await runtime.storage.get<ActiveWorkState>(ACTIVE_WORK_KEY);
  if (!activeWork || activeWork.status !== 'active') {
    await runtime.clearSchedule();
    return;
  }
  const now = Date.now();
  if (now >= activeWork.deadlineAt) {
    await runtime.storage.put(ACTIVE_WORK_KEY, {
      ...activeWork,
      status: 'expired',
      endedAt: now,
      endReason: 'keepalive_deadline_exceeded',
    } satisfies ActiveWorkState);
    await runtime.clearSchedule();
    log.warn('vm_agent_container_active_work_keepalive_expired', {
      nodeId: activeWork.nodeId,
      workspaceId: activeWork.workspaceId,
      agentSessionId: activeWork.agentSessionId,
      deadlineAt: new Date(activeWork.deadlineAt).toISOString(),
    });
    return;
  }

  runtime.renewActivityTimeout();
  await runtime.storage.put(ACTIVE_WORK_KEY, { ...activeWork, lastRenewedAt: now });
  await runtime.replaceSchedule(runtime.renewIntervalMs);
}
