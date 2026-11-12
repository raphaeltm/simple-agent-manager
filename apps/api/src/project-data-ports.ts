/**
 * The worker's implementation of `ProjectDataPorts`: how ProjectData reaches task
 * lifecycle, task liveness, session recovery, node agents, prompt transport,
 * notices and telemetry, which other areas of the worker own.
 *
 * Installed once at module load by the worker entry (`index.ts`) and by test
 * setup. Every port receives ProjectData's narrow env. A Durable Object is
 * constructed with the whole Worker env, so `workerEnv()` widens it here, at
 * this one documented boundary (`.claude/rules/51`: a DO receives a structural
 * superset of its declared env). This replaces the per-call
 * `env as unknown as WorkerEnv` casts ProjectData modules used to carry.
 */
import type { NodeLifecycle } from './durable-objects/node-lifecycle';
import type { NotificationService } from './durable-objects/notification';
import { type ProjectDataPorts } from './durable-objects/project-data/ports';
import type { ProjectDataEnv } from './durable-objects/project-data/types';
import type { VmAgentContainer } from './durable-objects/vm-agent-container';
import { isVmAgentContainerLifecycleTerminal } from './durable-objects/vm-agent-container-lifecycle';
import type { Env } from './env';
import {
  classifyReconciliationLoop,
  getStalledTaskClassifierConfig,
} from './scheduled/stalled-task-classifier';
import { credentialLimitReferenceKey } from './services/credential-limit-events/values';
import { cancelAgentSessionOnNode, listAgentSessionsOnNode } from './services/node-agent';
import { persistError } from './services/observability';
import { deferAlarmWhenDisabled } from './services/operational-kill-switch';
import {
  parentWakeNotice,
  projectEventWakeNotice,
  safeNotice,
  scheduledMessageNotice,
  stallCheckinNotice,
} from './services/sam-notice-builders';
import {
  classifySessionIdleness,
  getFreshHarnessWorkLeaseExpiry,
  parseHarnessWorkConfig,
} from './services/session-idleness';
import { isSessionRecoverySourceTaskGuardValid } from './services/session-recovery-authority';
import { stoppingTaskSleepOwnsCleanup } from './services/session-sleep-task-convergence';
import { DEFAULT_SESSION_SLEEP_AFTER_MS } from './services/session-snapshot-artifacts';
import { hasAuthorizedRestorableSnapshotWakeClaim } from './services/session-snapshot-recovery-lifecycle';
import { findRestorableOrInFlightSleepSnapshot } from './services/session-snapshot-sleep-predicate';
import { isSleepPreservedTerminalTaskStatus } from './services/sleep-preserved-task-status';
import { isSleepingContainerRuntime } from './services/sleeping-container-runtime';
import {
  classifyTaskRuntimeDelivery,
  isSupersededTerminalReason,
  livenessEvidenceLogFields,
} from './services/task-runtime-liveness';
import { getLocalTaskRuntimeLiveness } from './services/task-runtime-liveness-local';
import { WAKEABLE_TASK_STATUSES } from './services/task-status';
import { transitionTaskToTerminal } from './services/task-terminal-transition';
import { recordAcpActivityCallbackMetric, recordDurableExecutionMetric } from './services/telemetry';
import { syncTriggerExecutionStatus } from './services/trigger-execution-sync';
import { DefaultVmPromptDeliveryAdapter } from './services/vm-prompt-delivery-adapter';

/**
 * ProjectData code runs inside the Worker (client, scheduled jobs) or inside the
 * ProjectData Durable Object, and both receive the Worker's full env object; the
 * narrow `ProjectDataEnv` type only limits what ProjectData itself may read.
 */
function workerEnv(env: ProjectDataEnv): Env {
  return env as Env;
}

export const workerProjectDataPorts: ProjectDataPorts = {
  tasks: {
    transitionToTerminal: (env, request) => transitionTaskToTerminal(workerEnv(env), request),
    async preserveFailedWorkOrSurfaceLoss(env, input) {
      // Lazy: failed-task preservation pulls in the session-sleep lifecycle, which the
      // ProjectData alarm only needs on this rare expiry path.
      const preservation = await import('./services/failed-task-preservation');
      const { agentUnresponsive, ...target } = input;
      const outcome = agentUnresponsive
        ? ({ outcome: 'not_preservable', gap: 'agent_unresponsive' } as const)
        : await preservation.preserveFailedTaskWork(workerEnv(env), target);
      if (preservation.withholdsFailedTaskTeardown(outcome)) {
        return { preserved: true, outcome: outcome.outcome };
      }
      await preservation.surfaceFailedTaskWorkLoss(workerEnv(env), {
        taskId: input.taskId,
        projectId: input.projectId,
        chatSessionId: input.chatSessionId,
        reason: outcome.gap,
        source: input.source,
      });
      return { preserved: false };
    },
    async cleanupTaskRun(env, taskId) {
      // Lazy: the task runner is a large module graph off the alarm's hot path.
      const { cleanupTaskRun } = await import('./services/task-runner');
      await cleanupTaskRun(taskId, workerEnv(env));
    },
    syncTriggerExecutionStatus: (env, taskId, status, errorMessage) =>
      syncTriggerExecutionStatus(env.DATABASE, taskId, status, errorMessage),
    async submitReservedTask(env, input) {
      const { submitReservedTask } = await import('./services/reserved-task-submission');
      return submitReservedTask(workerEnv(env), input);
    },
    wakeableStatuses: WAKEABLE_TASK_STATUSES,
  },
  taskLiveness: {
    async getLocalTaskRuntimeVerdict(sql, env, task) {
      const liveness = await getLocalTaskRuntimeLiveness(sql, workerEnv(env), task);
      return {
        live: liveness.live,
        conclusive: liveness.conclusive,
        reason: liveness.reason,
        supersededTermination: isSupersededTerminalReason(liveness.reason),
        evidenceLogFields: livenessEvidenceLogFields(liveness),
        delivery: classifyTaskRuntimeDelivery(liveness),
      };
    },
  },
  sessions: {
    defaultSleepAfterMs: DEFAULT_SESSION_SLEEP_AFTER_MS,
    classifyIdleness: (env, input) =>
      classifySessionIdleness({ ...input, harnessWorkConfig: parseHarnessWorkConfig(env) }),
    hasFreshHarnessWorkLease(env, state, now) {
      const config = parseHarnessWorkConfig(env);
      return getFreshHarnessWorkLeaseExpiry(state, now, config.leaseMs, config.maxDurationMs) !== null;
    },
    isSleepPreservedTerminalTaskStatus,
    isSourceTaskGuardValid: (env, guard) => isSessionRecoverySourceTaskGuardValid(env.DATABASE, guard),
    hasAuthorizedRestorableSnapshotWakeClaim: (env, input) =>
      hasAuthorizedRestorableSnapshotWakeClaim(env.DATABASE, input),
    findRestorableOrInFlightSleepSnapshot: (env, input) =>
      findRestorableOrInFlightSleepSnapshot(env.DATABASE, workerEnv(env), input),
    stoppingTaskSleepOwnsCleanup: (env, identity) =>
      stoppingTaskSleepOwnsCleanup(env.DATABASE, identity),
  },
  runtime: {
    createPromptDeliveryAdapter: (env) => new DefaultVmPromptDeliveryAdapter(workerEnv(env)),
    cancelAgentSession: (env, request) =>
      cancelAgentSessionOnNode(
        request.nodeId,
        request.workspaceId,
        request.agentSessionId,
        workerEnv(env),
        request.userId,
        request.requestTimeoutMs ? { requestTimeoutMs: request.requestTimeoutMs } : {}
      ),
    listAgentSessions: (env, request) =>
      listAgentSessionsOnNode(
        request.nodeId,
        request.workspaceId,
        workerEnv(env),
        request.userId,
        request.requestTimeoutMs ? { requestTimeoutMs: request.requestTimeoutMs } : {}
      ),
    isSleepingContainerRuntime,
    async inspectContainerLifecycle(env, nodeId) {
      const binding = workerEnv(env).VM_AGENT_CONTAINER;
      if (!binding) throw new Error('VM_AGENT_CONTAINER binding is unavailable');
      const stub = binding.get(
        binding.idFromName(nodeId.toLowerCase())
      ) as DurableObjectStub<VmAgentContainer>;
      const lifecycle = await stub.inspectLifecycle();
      return {
        status: lifecycle.status,
        terminal: isVmAgentContainerLifecycleTerminal(lifecycle.status),
      };
    },
    async scheduleWorkspaceDeletion(env, input) {
      const namespace = workerEnv(env).NODE_LIFECYCLE;
      const stub = namespace.get(namespace.idFromName(input.nodeId));
      await (stub as unknown as NodeLifecycle).scheduleWorkspaceDeletion(
        input.nodeId,
        input.workspaceId,
        input.userId
      );
    },
  },
  credentials: {
    limitReferenceKey: credentialLimitReferenceKey,
  },
  notices: {
    safe: safeNotice,
    parentWake: parentWakeNotice,
    projectEventWake: projectEventWakeNotice,
    scheduledMessage: scheduledMessageNotice,
    stallCheckin: stallCheckinNotice,
  },
  notifications: {
    async hasConfirmedPushDelivery(env, userId, notificationId) {
      const stub = notificationStub(env, userId);
      return (await stub?.hasConfirmedPushDelivery(userId, notificationId)) ?? false;
    },
    async resendPush(env, userId, notificationId) {
      await notificationStub(env, userId)?.resendPushNotification(userId, notificationId);
    },
  },
  observability: {
    recordDurableExecutionMetric: (env, metric) =>
      recordDurableExecutionMetric(metric, workerEnv(env)),
    recordAcpActivityMetric: (env, metric) =>
      recordAcpActivityCallbackMetric(metric, workerEnv(env)),
    async persistPlatformError(env, record) {
      if (!env.OBSERVABILITY_DATABASE) return;
      await persistError(env.OBSERVABILITY_DATABASE, record, undefined);
    },
  },
  operations: {
    async alertArchiveBreakerOpened(env, opening) {
      const { alertProjectDataArchiveBreakerOpened } = await import(
        './scheduled/project-data-archive-breaker-alerts'
      );
      await alertProjectDataArchiveBreakerOpened(workerEnv(env), opening);
    },
    deferAlarmWhenDisabled: (env, storage, durableObject) =>
      deferAlarmWhenDisabled(workerEnv(env), storage, durableObject),
    stalledTaskClassifierConfig(env) {
      const config = getStalledTaskClassifierConfig(workerEnv(env));
      return { transcriptMaxChars: config.transcriptMaxChars, messageLimit: config.messageLimit };
    },
    classifyReconciliationLoop: (env, messages) =>
      classifyReconciliationLoop(workerEnv(env), messages),
  },
};

function notificationStub(
  env: ProjectDataEnv,
  userId: string
): DurableObjectStub<NotificationService> | null {
  if (!env.NOTIFICATION) return null;
  return env.NOTIFICATION.get(
    env.NOTIFICATION.idFromName(userId)
  ) as DurableObjectStub<NotificationService>;
}
