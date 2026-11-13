/**
 * Ports: what ProjectData needs from other areas of the worker.
 *
 * ProjectData owns its Durable Object storage and its client. Task lifecycle, task
 * runtime liveness, session recovery, node agent calls, prompt transport, notices
 * and telemetry belong to other areas, so this module declares the small typed
 * interface ProjectData calls and the worker supplies the implementation
 * (one module per port in `apps/api/src/project-data-ports/`), installed once at
 * module load by `apps/api/src/project-data-wiring.ts` through
 * `configureProjectDataPorts()`.
 *
 * Every method takes the caller's narrow ProjectData env. At runtime a Durable
 * Object receives the whole Worker env, so the worker implementation may widen
 * it in that one adapter file (`.claude/rules/51` sanctioned boundary cast).
 *
 * Types here are deliberately minimal structural views. The worker implementation
 * object is typed `ProjectDataPorts`, so `tsc` proves each view stays compatible
 * with the worker function it delegates to.
 */
import type {
  ProjectEventRecord,
  SamNotice,
  TaskActorType,
  TaskMode,
  TriggeredBy,
  VmPromptDeliveryCapabilities,
} from '@simple-agent-manager/shared';

import type { ProjectDataArchiveBreakerOpening } from '../archive/breaker-opening';
import type { PromptDeliveryClaim, PromptDeliveryResult } from './prompt-delivery';
import type { Env } from './types';

// ─── Task lifecycle ───────────────────────────────────────────────────────────

export interface TaskTerminalTransitionRequest {
  taskId: string;
  projectId: string | null;
  status: 'failed';
  reason: string;
  source: string;
  expectedWorkspaceId?: string | null;
  expectedChatSessionId?: string | null;
  expectedNodeId?: string | null;
  stopWorkspace?: boolean;
}

/** Outcome of the worker's guarded terminal transition; `'transitioned'` means this call won. */
export type TaskTerminalTransitionOutcome =
  | 'transitioned'
  | 'already_terminal'
  | 'not_terminalizable'
  | 'not_found'
  | 'scope_mismatch'
  | 'superseded';

export interface FailedTaskWorkInput {
  taskId: string;
  projectId: string;
  workspaceId: string | null;
  chatSessionId: string | null;
  source: string;
  /** The check-in watchdog judged the agent stalled mid-turn: never preservable. */
  agentUnresponsive: boolean;
}

/**
 * `preserved: true` — the sleep lifecycle holds the runtime and teardown is withheld.
 * `preserved: false` — the work loss was already surfaced; the caller fails the
 * session and tears down.
 */
export type FailedTaskWorkOutcome = { preserved: true; outcome: string } | { preserved: false };

export interface ReservedTaskSubmissionInput {
  identities: {
    taskId: string;
    chatSessionId: string;
    initialMessageId: string;
    initialStatusEventId: string;
  };
  projectId: string;
  userId: string;
  prompt: string;
  branchNameSeed: string;
  agentProfileId: string | null;
  skillId: string | null;
  taskMode: TaskMode;
  vmSizeOverride: string | null;
  source: {
    kind: 'schedule' | 'standing_watch';
    expiresAt?: number;
    sourceId: string;
    sourceExecutionId: string;
    triggeredBy: TriggeredBy;
    displayName: string;
    repositoryAccessFlow: string;
    initialStatusReason: string;
    initialStatusActorType: TaskActorType;
    initialStatusActorId: string | null;
  };
}

export type ReservedTaskSubmissionOutcome =
  | { outcome: 'admitted' }
  | { outcome: 'pending'; reason: string }
  | { outcome: 'conflict'; reason: string; message: string }
  | { outcome: 'terminal'; reason?: string | null };

export interface TaskLifecyclePort {
  transitionToTerminal(
    env: Env,
    request: TaskTerminalTransitionRequest
  ): Promise<TaskTerminalTransitionOutcome>;
  /** Preserve a failed task's work through the sleep lifecycle, or surface its loss. */
  preserveFailedWorkOrSurfaceLoss(
    env: Env,
    input: FailedTaskWorkInput
  ): Promise<FailedTaskWorkOutcome>;
  /** Tear down a task's runtime through the TaskRunner's shared lifecycle cleanup. */
  releaseTaskRun(env: Env, taskId: string): Promise<void>;
  /** Mirror a task's terminal status onto its trigger execution, if any. */
  syncTriggerExecutionStatus(
    env: Env,
    taskId: string,
    status: 'completed' | 'failed' | 'cancelled',
    errorMessage?: string
  ): Promise<void>;
  /** Submit a task whose identities ProjectData reserved (scheduled actions, standing watches). */
  submitReservedTask(
    env: Env,
    input: ReservedTaskSubmissionInput
  ): Promise<ReservedTaskSubmissionOutcome>;
  /** Task statuses a scheduled wake may target (live plus sleeping). */
  readonly wakeableStatuses: readonly string[];
}

// ─── Task runtime liveness ────────────────────────────────────────────────────

export interface LocalTaskRuntimeTask {
  taskId: string;
  projectId: string;
  workspaceId: string | null;
  chatSessionId?: string | null;
  acpSessionId?: string | null;
}

export type TaskRuntimeDeliveryDisposition =
  | { kind: 'deliverable'; target: { nodeId: string; userId: string } }
  | { kind: 'terminal'; reason: string; nodeId: string | null }
  | { kind: 'inconclusive'; reason: string };

/** The shared task-runtime verdict, as ProjectData consumes it. */
export interface LocalTaskRuntimeVerdict {
  live: boolean;
  conclusive: boolean;
  reason: string;
  /** The verdict ends the task because a successor superseded it, not because it died. */
  supersededTermination: boolean;
  /** Bounded diagnostic fields for logs; never a decision input. */
  evidenceLogFields: Record<string, unknown>;
  /** Reconciliation delivery gate derived from the same verdict. */
  delivery: TaskRuntimeDeliveryDisposition;
}

export interface TaskRuntimeLivenessPort {
  /**
   * Classify a task's runtime with the shared classifier the cron sweep uses
   * (`.claude/rules/61`), reading this object's ACP state through `sql`.
   */
  getLocalTaskRuntimeVerdict(
    sql: SqlStorage,
    env: Env,
    task: LocalTaskRuntimeTask
  ): Promise<LocalTaskRuntimeVerdict>;
}

// ─── Session lifecycle (sleep, idleness, recovery) ───────────────────────────

export interface SessionIdlenessState {
  activity?: string | null;
  activityAt?: number | null;
  promptStartedAt?: number | null;
  workAt?: number | null;
  reportedPromptStartedAt?: number | null;
  runtimeWorkState?: string | null;
  runtimeWorkCount?: number | null;
  runtimeWorkSource?: string | null;
  runtimeWorkUpdatedAt?: number | null;
  runtimeWorkProgressAt?: number | null;
}

export interface SessionIdlenessInput {
  taskStatus: string | null;
  taskCompletedAt?: string | null;
  state: SessionIdlenessState | null;
  now: Date;
  idleAfterMs: number;
  policy: 'prompt-turn-ended' | 'idle-interval-elapsed';
}

/** A project event wake that authorized a recovery; it must still be pending. */
export interface ProjectEventWakeRecoveryGuard {
  batchId: string;
  subscriptionId: string;
}

/** Source-task authority a prompt delivery (and any wake it causes) must still hold. */
export interface SessionRecoverySourceTaskGuard {
  taskId: string;
  projectId: string;
  chatSessionId: string;
  projectEventWake?: ProjectEventWakeRecoveryGuard | null;
  /** Pre-materialization event guard; after admission projectEventWake supplies this requirement. */
  requireSourceProjectMember?: boolean;
  requiredProjectMemberId?: string | null;
}

export interface SnapshotWakeClaimInput {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  taskId: string;
  recoveryAttemptId?: string | null;
  allowRestored?: boolean;
}

export interface SleepSnapshotLookupInput {
  projectId: string;
  chatSessionId: string;
  now?: Date;
}

/** The sleep-lifecycle columns of a restorable or in-flight snapshot. */
export interface SleepSnapshotLifecycle {
  expires_at: string | null;
  sleep_status: string | null;
  sleep_claimed_at: string | null;
  sleep_stopping_since: string | null;
  sleep_after: string | null;
  updated_at: string | null;
  created_at: string | null;
}

export interface TaskSleepIdentity {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
}

export interface SessionLifecyclePort {
  /** Default idle interval before an automatic session sleep. */
  readonly defaultSleepAfterMs: number;
  /** Canonical idleness classifier shared with the sleep sweep. */
  classifyIdleness(env: Env, input: SessionIdlenessInput): { idle: boolean; conclusive: boolean };
  /** Harness background work still holds a fresh lease at `now`. */
  hasFreshHarnessWorkLease(env: Env, state: SessionIdlenessState, now: Date): boolean;
  /** Terminal task statuses whose conversations the sleep lifecycle preserves. */
  isSleepPreservedTerminalTaskStatus(status: string | null | undefined): boolean;
  /** A parent-wake source task still authorizes recovery (non-terminal, still bound). */
  isSourceTaskGuardValid(env: Env, guard: SessionRecoverySourceTaskGuard): Promise<boolean>;
  /** A restorable snapshot carries an authorized wake claim for this task. */
  hasAuthorizedRestorableSnapshotWakeClaim(
    env: Env,
    input: SnapshotWakeClaimInput
  ): Promise<boolean>;
  /** The conversation's snapshot is restorable or its sleep is in flight. */
  findRestorableOrInFlightSleepSnapshot(
    env: Env,
    input: SleepSnapshotLookupInput
  ): Promise<SleepSnapshotLifecycle | null>;
  /** A stopping task's session sleep owns the runtime cleanup. */
  stoppingTaskSleepOwnsCleanup(env: Env, identity: TaskSleepIdentity): Promise<boolean>;
}

// ─── Prompt transport, node agent, runtime containers ───────────────────────

/** The live agent a durable prompt delivery reaches. */
export interface VmPromptDeliveryTarget {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  nodeId: string;
  agentSessionId: string;
  userId: string;
  runtimeIdentity: string;
  runtime: string;
}

/** Source-task authority carried by a delivery; a wake it causes must honor it. */
export type VmPromptDeliverySourceTaskGuard = Pick<
  SessionRecoverySourceTaskGuard,
  'taskId' | 'projectId' | 'chatSessionId' | 'projectEventWake' | 'requiredProjectMemberId'
>;

export interface VmPromptDeliveryAdapterInput {
  projectId: string;
  claim: PromptDeliveryClaim;
  allowLegacyVm: boolean;
  requestTimeoutMs: number;
  /**
   * Authoritative target already resolved by a shared runtime-liveness adapter.
   * This is used by reconciliation so a suspect D1 health mirror cannot undo
   * the probe-backed delivery verdict by being interpreted a second time here.
   */
  resolvedTarget?: VmPromptDeliveryTarget;
  /** Revalidates a parent wake immediately before recovery/container/VM mutations. */
  beforeSideEffect?: () => Promise<PromptDeliveryResult | null>;
  /** Synchronous durable claim fence after preparation, immediately before possible prompt submission. */
  beforeSubmit?: (capabilities: VmPromptDeliveryCapabilities) => boolean;
  /** Makes snapshot recovery's D1 claim conditional on the source parent. */
  sourceTaskGuard?: VmPromptDeliverySourceTaskGuard;
  /**
   * Stop-and-deliver hook, invoked (best-effort) when the target rejects the
   * submit because a prompt turn is already in flight AND the claim's message
   * class is urgent (`interrupt` or above). The adapter supplies the resolved
   * target; the caller owns the cancel + turn-end bookkeeping. A hook failure
   * never changes the busy retry result — it only degrades to parking in
   * `retry_wait` behind the busy turn, which is today's behaviour.
   */
  onBusyTurn?: (target: VmPromptDeliveryTarget) => Promise<void>;
}

/** Transport that hands a claimed durable prompt to a live agent runtime. */
export interface VmPromptDeliveryAdapter {
  submit(input: VmPromptDeliveryAdapterInput): Promise<PromptDeliveryResult>;
  reconcile(input: VmPromptDeliveryAdapterInput): Promise<PromptDeliveryResult>;
  /** Live steer into the running turn; adapters without it deliver steers as queued prompts. */
  steer?(input: VmPromptDeliveryAdapterInput): Promise<PromptDeliveryResult>;
  reconcileSteer?(input: VmPromptDeliveryAdapterInput): Promise<PromptDeliveryResult>;
}

export interface NodeAgentSessionRequest {
  nodeId: string;
  workspaceId: string;
  userId: string;
  /** Background tier timeout; omit for the node agent's interactive default. */
  requestTimeoutMs?: number;
}

export interface RuntimePort {
  /** The worker's VM/container prompt transport. */
  createPromptDeliveryAdapter(env: Env): VmPromptDeliveryAdapter;
  /** Cancel the agent session's in-flight prompt on its node. */
  cancelAgentSession(
    env: Env,
    request: NodeAgentSessionRequest & { agentSessionId: string }
  ): Promise<{ success: boolean; status: number }>;
  /** The node agent's raw agent-session inventory for a workspace (unvalidated). */
  listAgentSessions(env: Env, request: NodeAgentSessionRequest): Promise<unknown>;
  /** A slept Instant container runs nothing; probing it would wake it. */
  isSleepingContainerRuntime(node: {
    nodeRuntime: string | null;
    nodeStatus: string | null;
  }): boolean;
  /** A cf-container's lifecycle has ended, so its heartbeat silence is conclusive. */
  inspectContainerLifecycle(
    env: Env,
    nodeId: string
  ): Promise<{ status: string | null; terminal: boolean }>;
  /** Stop-then-delete handoff for an idle-expired workspace on its node. */
  scheduleWorkspaceDeletion(
    env: Env,
    input: { nodeId: string; workspaceId: string; userId: string }
  ): Promise<void>;
}

// ─── Notices, telemetry, operations ─────────────────────────────────────────

export interface ChildTaskSnapshot {
  taskId: string;
  status: string;
  title: string | null;
}

/** Builders for the SAM notice shown beside a message SAM injected into a chat. */
export interface NoticesPort {
  /** Build a notice; a failure is logged and yields null so delivery never depends on it. */
  safe(build: () => SamNotice | null, context: Record<string, unknown>): SamNotice | null;
  parentWake(
    children: readonly ChildTaskSnapshot[],
    reason: 'condition_met' | 'deadline_reached'
  ): SamNotice;
  projectEventWake(events: readonly ProjectEventRecord[]): SamNotice | null;
  scheduledMessage(input: {
    scheduleId: string;
    prompt: string;
    reason: string | null;
    origin: 'this_chat' | 'another_chat' | 'unknown_chat';
  }): SamNotice;
  stallCheckin(idleDurationMs: number): SamNotice;
}

export interface DurableExecutionMetric {
  metric:
    | 'prompt_delivery_attempt'
    | 'prompt_delivery_accepted'
    | 'prompt_delivery_retry'
    | 'prompt_delivery_failed'
    | 'prompt_delivery_ambiguous'
    | 'prompt_delivery_steered'
    | 'prompt_delivery_steer_fallback'
    | 'prompt_delivery_steer_pending'
    | 'checkpoint_episode_transition';
  projectId: string | null;
  sessionId: string | null;
  deliveryId?: string | null;
  checkpointEpisodeId?: string | null;
  attemptCount?: number;
  durationMs?: number;
  reason?: string | null;
}

export interface AcpActivityHealedMetric {
  metric: 'acp_activity_callback';
  outcome: 'healed';
  projectId: string | null;
  sessionId: string | null;
  nodeId?: string | null;
  workspaceId?: string | null;
  activity?: string | null;
  reason?: string | null;
  source: 'reconciliation_probe';
}

export interface PlatformErrorRecord {
  source: 'api';
  level: 'warn' | 'error';
  message: string;
  context: Record<string, unknown>;
}

export interface ObservabilityPort {
  recordDurableExecutionMetric(env: Env, metric: DurableExecutionMetric): void;
  recordAcpActivityMetric(env: Env, metric: AcpActivityHealedMetric): void;
  /** Persist an operator-visible platform error row (best-effort; never throws). */
  persistPlatformError(env: Env, record: PlatformErrorRecord): Promise<void>;
}

export interface StalledTaskClassifierConfig {
  transcriptMaxChars: number;
  messageLimit: number;
}

export interface OperationsPort {
  /** Record an archive circuit-breaker opening and notify operators once; never throws. */
  alertArchiveBreakerOpened(env: Env, opening: ProjectDataArchiveBreakerOpening): Promise<void>;
  /** Operational master brake for DO alarms; true means the alarm was deferred. */
  deferAlarmWhenDisabled(
    env: Env,
    storage: DurableObjectStorage,
    durableObject: string
  ): Promise<boolean>;
  /** Transcript window for the stalled-task loop classifier. */
  stalledTaskClassifierConfig(env: Env): StalledTaskClassifierConfig;
  /** Advisory classification of a paused reconciliation loop; null when unavailable. */
  classifyReconciliationLoop(
    env: Env,
    messages: Record<string, unknown>[]
  ): Promise<{ decision: string; confidence?: number | null; reason?: string | null } | null>;
}

export interface NotificationsPort {
  /** At least one push channel accepted the user's notification (Notification DO receipt). */
  hasConfirmedPushDelivery(env: Env, userId: string, notificationId: string): Promise<boolean>;
  /** Escalate an unanswered needs-input notification by re-sending its push. */
  resendPush(env: Env, userId: string, notificationId: string): Promise<void>;
}

export interface CredentialsPort {
  /** Collision-free key for a credential reference, as provider-limit events store it. */
  limitReferenceKey(reference: string | null | undefined): Promise<string | null>;
}

// ─── Aggregate + registry ────────────────────────────────────────────────────

export interface ProjectDataPorts {
  tasks: TaskLifecyclePort;
  taskLiveness: TaskRuntimeLivenessPort;
  sessions: SessionLifecyclePort;
  runtime: RuntimePort;
  credentials: CredentialsPort;
  notices: NoticesPort;
  notifications: NotificationsPort;
  observability: ObservabilityPort;
  operations: OperationsPort;
}

/**
 * Held on `globalThis`, not in a module variable, so a module-registry reset (a
 * test's `vi.resetModules()`, or a bundler duplicating this module) cannot leave a
 * second, unconfigured copy behind.
 *
 * Contract: the worker entry must evaluate `apps/api/src/project-data-wiring.ts`
 * (it exports the `ProjectData` class from there) before any ProjectData client,
 * cron job or Durable Object code runs. `apps/api/tests/unit/project-data-wiring.test.ts`
 * proves the entry does so.
 */
const PORTS_KEY = Symbol.for('sam.project-data.ports');

interface PortsRegistry {
  ports: Partial<ProjectDataPorts>;
  /** Built once per install, not per call: alarm sweeps read ports per candidate. */
  view: ProjectDataPorts;
}

interface PortsHolder {
  [PORTS_KEY]?: PortsRegistry;
}

function install(ports: Partial<ProjectDataPorts>): void {
  const view = new Proxy(ports, {
    get(target, name: string | symbol) {
      const port = Reflect.get(target, name);
      if (port === undefined && typeof name === 'string') {
        throw new Error(
          `ProjectData port "${name}" is not configured: call configureProjectDataPorts() from the worker entry`
        );
      }
      return port;
    },
  }) as ProjectDataPorts;
  (globalThis as PortsHolder)[PORTS_KEY] = { ports, view };
}

/** Install every port. The worker entry calls this once at module load. */
export function configureProjectDataPorts(ports: ProjectDataPorts): void {
  install({ ...ports });
}

/**
 * Install or replace a single port, keeping the others. For test setup, which loads
 * each port's worker modules separately so one test's partial mocks cannot break
 * the ports it never uses.
 */
export function configureProjectDataPort<K extends keyof ProjectDataPorts>(
  name: K,
  port: ProjectDataPorts[K]
): void {
  const current = (globalThis as PortsHolder)[PORTS_KEY]?.ports ?? {};
  install({ ...current, [name]: port });
}

const UNCONFIGURED: PortsRegistry = (() => {
  const ports: Partial<ProjectDataPorts> = {};
  return {
    ports,
    view: new Proxy(ports, {
      get(_target, name: string | symbol) {
        if (typeof name !== 'string') return undefined;
        throw new Error(
          `ProjectData port "${name}" is not configured: call configureProjectDataPorts() from the worker entry`
        );
      },
    }) as ProjectDataPorts,
  };
})();

/**
 * The configured ports. Reading a port the worker never installed throws, naming
 * it: that is a wiring bug, never a runtime condition to tolerate.
 */
export function projectDataPorts(): ProjectDataPorts {
  return ((globalThis as PortsHolder)[PORTS_KEY] ?? UNCONFIGURED).view;
}
