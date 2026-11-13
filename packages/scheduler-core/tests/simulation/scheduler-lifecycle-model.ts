export type NodeStatus = 'provisioning' | 'running' | 'destroying' | 'deleted';
export type WorkspaceStatus = 'creating' | 'running' | 'sleeping' | 'deleted';
export type TaskStatus = 'provisioning' | 'running' | 'completed';
export type SessionActivity = 'prompting' | 'idle';
export type SnapshotStatus = 'missing' | 'pending' | 'available' | 'failed';

export interface SchedulerSimulationPolicy {
  reservePlacementBeforeAsyncCreate: boolean;
  protectProvisioningClaims: boolean;
  recheckPlacementAtCommit: boolean;
  reconcileMissingSnapshots: boolean;
  retryIncompleteSnapshots: boolean;
  synchronousTerminalSleep: boolean;
  promptingConsumesSleepAttempt: boolean;
}

export const CURRENT_SCHEDULER_POLICY: SchedulerSimulationPolicy = {
  reservePlacementBeforeAsyncCreate: true,
  protectProvisioningClaims: true,
  recheckPlacementAtCommit: true,
  reconcileMissingSnapshots: true,
  retryIncompleteSnapshots: true,
  synchronousTerminalSleep: false,
  promptingConsumesSleepAttempt: false,
};

export const STRANDED_SLEEP_POLICY: SchedulerSimulationPolicy = {
  ...CURRENT_SCHEDULER_POLICY,
  reconcileMissingSnapshots: false,
  retryIncompleteSnapshots: false,
  synchronousTerminalSleep: true,
  promptingConsumesSleepAttempt: true,
};

export const PREMATURE_CLEANUP_POLICY: SchedulerSimulationPolicy = {
  ...CURRENT_SCHEDULER_POLICY,
  protectProvisioningClaims: false,
};

export const CAPACITY_TOCTOU_POLICY: SchedulerSimulationPolicy = {
  ...CURRENT_SCHEDULER_POLICY,
  reservePlacementBeforeAsyncCreate: false,
  recheckPlacementAtCommit: false,
};

export interface SimNode {
  id: string;
  status: NodeStatus;
  capacity: number;
  createdAt: number;
  idleSince: number;
  claimedTaskIds: Set<string>;
  reservedTaskIds: Set<string>;
}

export interface SimWorkspace {
  id: string;
  nodeId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  status: WorkspaceStatus;
}

export interface SimTask {
  id: string;
  projectId: string;
  status: TaskStatus;
  nodeId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
}

export interface SimSession {
  id: string;
  projectId: string;
  taskId: string;
  workspaceId: string;
  activity: SessionActivity;
  terminal: boolean;
  sleeping: boolean;
  snapshotStatus: SnapshotStatus;
  sleepDueAt: number | null;
  attempts: number;
}

export interface SimEvent {
  id: number;
  dueAt: number;
  label: string;
  run: () => void;
}

export type SimulationCommand =
  | { type: 'submit'; task: number; project: number; node: number | 'new' }
  | { type: 'complete'; task: number }
  | { type: 'activity'; task: number; activity: SessionActivity }
  | { type: 'sleep-sweep' }
  | { type: 'cleanup-sweep' }
  | { type: 'snapshot-failure' }
  | { type: 'advance'; milliseconds: number }
  | { type: 'run-event'; choice: number };

export interface SimulationProfile {
  numRuns: number;
  maxCommands: number;
  taskSlots: number;
  projectCount: number;
  testTimeoutMs: number;
}

const PR_PROFILE: SimulationProfile = {
  numRuns: 200,
  maxCommands: 60,
  taskSlots: 12,
  projectCount: 3,
  testTimeoutMs: 5_000,
};

const NIGHTLY_PROFILE: SimulationProfile = {
  numRuns: 2_000,
  maxCommands: 160,
  taskSlots: 32,
  projectCount: 6,
  testTimeoutMs: 60_000,
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSimulationProfile(
  environment: NodeJS.ProcessEnv = process.env
): SimulationProfile {
  const base = environment.SCHEDULER_SIM_PROFILE === 'nightly' ? NIGHTLY_PROFILE : PR_PROFILE;
  return {
    numRuns: positiveInteger(environment.SCHEDULER_SIM_RUNS, base.numRuns),
    maxCommands: positiveInteger(environment.SCHEDULER_SIM_MAX_COMMANDS, base.maxCommands),
    taskSlots: positiveInteger(environment.SCHEDULER_SIM_TASK_SLOTS, base.taskSlots),
    projectCount: positiveInteger(environment.SCHEDULER_SIM_PROJECTS, base.projectCount),
    testTimeoutMs: positiveInteger(environment.SCHEDULER_SIM_TIMEOUT_MS, base.testTimeoutMs),
  };
}
