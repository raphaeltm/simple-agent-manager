/**
 * The worker's implementation of the operations ports (`operations/ports.ts`).
 *
 * This is the only place that binds the operations layer to worker-owned services. Each
 * method closes over the request's `env`, so operations never pass the full worker `Env`.
 * Construction is a handful of closures per request; there is no I/O here.
 */
import type { OperationPorts, ProjectEventErrorKind } from '@simple-agent-manager/operations';
import type { OperationContext, OperationDeps } from '@simple-agent-manager/operations';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from './db/schema';
import type { NotificationService } from './durable-objects/notification';
import { isAgentMessageChannelName } from './durable-objects/project-data/agent-message-notice';
import { channelName } from './durable-objects/project-data/project-event-channels-config';
import { scheduleLimits } from './durable-objects/project-data/project-event-schedules-config';
import {
  ProjectEventCursorError,
  ProjectEventIdempotencyConflictError,
  ProjectEventLimitExceededError,
  ProjectEventNotFoundError,
  ProjectEventValidationError,
} from './durable-objects/project-data/project-events-contracts';
import { resolveProjectEventLimits } from './durable-objects/project-data/project-events-limits';
import { normalizeNullableText } from './durable-objects/project-data/project-events-values';
import { resolveStorageSafetyConfig } from './durable-objects/project-data/storage-safety';
import type { Env } from './env';
import { parsePositiveInt } from './lib/route-helpers';
import { getTrustedApiOrigin } from './lib/trusted-origins';
import { requireProjectAccess, requireProjectCapability } from './middleware/project-auth';
import { attachWakeState } from './routes/chat/wake-state';
import { answerAgentInteraction } from './routes/chat-acp-interactions';
import { resolveChatAgentState } from './routes/chat-agent-state';
import { answerAttention } from './routes/chat-attention';
import { interruptChat } from './routes/chat-cancel';
import { stopChat } from './routes/chat-stop';
import { rethrowScheduleError } from './routes/project-schedules';
import { snapshotInteractions } from './services/acp-interaction-store';
import { resolveAdminSetting, resolveAdminSettingDetailsMany } from './services/admin-settings';
import { listAgentActivityTasks } from './services/agent-activity';
import { listProfiles } from './services/agent-profiles';
import {
  getTokenUsage,
  getUserBudgetSettings,
  resolveEffectiveLimits,
} from './services/ai-token-budget';
import { cancelTask } from './services/cancel-task';
import { operationReceiptId } from './services/cli-operation-receipts';
import {
  connectorPendingInteractions,
  prepareConnectorAgentAnswer,
} from './services/connector-agent-answer';
import { auditConnectorWrite, executeConnectorWrite } from './services/connector-execution';
import { getConnectorReadLimits } from './services/connector-read-settings';
import {
  listOwnCredentialLimitsByReferences,
  listProjectCredentialLimits,
} from './services/credential-limit-events/read';
import { cronToHumanReadable } from './services/cron-utils';
import { getInstallationToken } from './services/github-app';
import { resolveProfileAccountBindings } from './services/profile-account-bindings';
import * as projectData from './services/project-data';
import { describeRootSearchCoverage } from './services/project-data-search-coverage';
import { startOrchestration } from './services/project-orchestrator';
import { authorizeSendChat, sendChat, validateSendChatContent } from './services/send-chat';
import { requireSessionWriter } from './services/session-access';
import {
  classifySessionIdleness,
  getFreshHarnessWorkLeaseExpiry,
  parseHarnessWorkConfig,
} from './services/session-idleness';
import { DEFAULT_SESSION_SLEEP_AFTER_MS } from './services/session-snapshots';
import { submitTask } from './services/submit-task';
import { getRecentAssistantMessagesForTask } from './services/task-final-assistant-message';
import {
  canTransitionTaskStatus,
  isTaskStatus,
  WAKEABLE_TASK_STATUSES,
} from './services/task-status';
import { clearTriggerPageCaches } from './services/trigger-cache';
import { createTrigger, validateCron } from './services/trigger-create';
import { resolveTriggerExecutionUserId } from './services/trigger-execution-principal';
import { triggerStatusUpdates } from './services/trigger-status';
import { getWorkspaceResourceHistory } from './services/workspace-resource-history';

/** Maps ProjectData's event/channel error classes to the kinds operations translate. */
function classifyProjectEventError(error: unknown): ProjectEventErrorKind | null {
  if (error instanceof ProjectEventNotFoundError) return 'not_found';
  if (error instanceof ProjectEventCursorError) return 'cursor';
  if (error instanceof ProjectEventValidationError) return 'validation';
  if (error instanceof ProjectEventLimitExceededError) return 'limit_exceeded';
  if (error instanceof ProjectEventIdempotencyConflictError) return 'idempotency_conflict';
  return null;
}

const WAKEABLE_TASK_STATUS_SET: ReadonlySet<string> = new Set(WAKEABLE_TASK_STATUSES);

export function createOperationPorts(env: Env): OperationPorts {
  const db = () => drizzle(env.DATABASE, { schema });
  return {
    config: {
      scheduleLimits: () => scheduleLimits(env),
      projectEventLimits: () => resolveProjectEventLimits(env),
      storageSafety: () => resolveStorageSafetyConfig(env),
      channelName: (value) => channelName(value, env),
      apiOrigin: () => getTrustedApiOrigin(env),
    },
    projectData: {
      getSession: (...a) => projectData.getSession(env, ...a),
      getSessionsByTaskIds: (...a) => projectData.getSessionsByTaskIds(env, ...a),
      listSessions: (...a) => projectData.listSessions(env, ...a),
      getArchivedToolPayloads: (...a) => projectData.getArchivedToolPayloads(env, ...a),
      getMessages: (...a) => projectData.getMessages(env, ...a),
      searchMessagesWithArchiveMetadata: (...a) =>
        projectData.searchMessagesWithArchiveMetadata(env, ...a),
      getLogicalTranscriptPage: (...a) => projectData.getLogicalTranscriptPage(env, ...a),
      getLogicalMessage: (...a) => projectData.getLogicalMessage(env, ...a),
      resolveTranscriptOwner: (...a) => projectData.resolveTranscriptOwner(env, ...a),
      getMailboxMessage: (...a) => projectData.getMailboxMessage(env, ...a),
      listActiveAttentionMarkers: (...a) => projectData.listActiveAttentionMarkers(env, ...a),
      searchKnowledgeObservations: (...a) => projectData.searchKnowledgeObservations(env, ...a),
      getIdeaWorkSnapshots: (...a) => projectData.getIdeaWorkSnapshots(env, ...a),
      addIdeaUpdate: (...a) => projectData.addIdeaUpdate(env, ...a),
      listIdeaUpdates: (...a) => projectData.listIdeaUpdates(env, ...a),
      deleteIdeaUpdate: (...a) => projectData.deleteIdeaUpdate(env, ...a),
      recordResourceLink: (...a) => projectData.recordResourceLink(env, ...a),
      removeResourceLink: (...a) => projectData.removeResourceLink(env, ...a),
      listResourceLinks: (...a) => projectData.listResourceLinks(env, ...a),
      listLinksForTargets: (...a) => projectData.listLinksForTargets(env, ...a),
      getResourceLinkSnapshot: (...a) => projectData.getResourceLinkSnapshot(env, ...a),
      listProjectEventChannels: (...a) => projectData.listProjectEventChannels(env, ...a),
      getProjectEventChannelHistory: (...a) => projectData.getProjectEventChannelHistory(env, ...a),
      listProjectEventChannelSubscribers: (...a) =>
        projectData.listProjectEventChannelSubscribers(env, ...a),
      getProjectEventSubscription: (...a) => projectData.getProjectEventSubscription(env, ...a),
      cancelProjectEventSubscription: (...a) =>
        projectData.cancelProjectEventSubscription(env, ...a),
      getProjectSchedule: (...a) => projectData.getProjectSchedule(env, ...a),
      listProjectSchedules: (...a) => projectData.listProjectSchedules(env, ...a),
      createProjectSchedule: (...a) => projectData.createProjectSchedule(env, ...a),
      mutateProjectSchedule: (...a) => projectData.mutateProjectSchedule(env, ...a),
      isAgentMessageChannelName,
      normalizeNullableText,
      classifyEventError: classifyProjectEventError,
      describeRootSearchCoverage,
    },
    settings: {
      resolve: (...a) => resolveAdminSetting(env, ...a),
      resolveDetailsMany: (...a) => resolveAdminSettingDetailsMany(env, ...a),
      connectorReadLimits: () => getConnectorReadLimits(env),
    },
    access: {
      requireProjectAccess: (projectId, userId) => requireProjectAccess(db(), projectId, userId),
      requireProjectCapability: (projectId, userId, capability) =>
        requireProjectCapability(db(), projectId, userId, capability),
      requireSessionWriter: (...a) => requireSessionWriter(env, ...a),
    },
    connector: {
      executeWrite: (ctx, ...a) => executeConnectorWrite({ ...ctx, env }, ...a),
      auditWrite: (ctx, ...a) => auditConnectorWrite({ ...ctx, env }, ...a),
      pendingInteractions: (...a) => connectorPendingInteractions(env, ...a),
      prepareAgentAnswer: (...a) => prepareConnectorAgentAnswer(env, ...a),
      receiptId: operationReceiptId,
    },
    chat: {
      authorizeSend: async (userId, projectId, sessionId) => {
        const authorized = await authorizeSendChat(env, userId, projectId, sessionId);
        return {
          send: (body, ...assertEffectAllowed) =>
            sendChat(env, userId, projectId, sessionId, body, authorized, ...assertEffectAllowed),
        };
      },
      validateSendContent: validateSendChatContent,
      stop: (...a) => stopChat(env, ...a),
      interrupt: (...a) => interruptChat(env, ...a),
      answerAttention: (...a) => answerAttention(env, ...a),
      answerAgentInteraction: (...a) => answerAgentInteraction(env, ...a),
      snapshotInteractions: (...a) => snapshotInteractions(env, ...a),
      resolveAgentState: (...a) => resolveChatAgentState(env, ...a),
      attachWakeState: (...a) => attachWakeState(db(), ...a),
      classifyTurnIdleness: ({ state, reportedState, taskStatus, taskCompletedAt, now }) => {
        const harnessWorkConfig = parseHarnessWorkConfig(env);
        const freshWork = getFreshHarnessWorkLeaseExpiry(
          state,
          now,
          harnessWorkConfig.leaseMs,
          harnessWorkConfig.maxDurationMs
        );
        const classificationState =
          reportedState ??
          (freshWork ? { ...state, activity: undefined, activityAt: undefined } : null);
        // A wake placeholder is not runtime activity evidence. Classify only the original observation.
        return classifySessionIdleness({
          taskStatus,
          taskCompletedAt,
          state: classificationState,
          now,
          idleAfterMs: parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS),
          harnessWorkConfig,
          policy: 'prompt-turn-ended',
        });
      },
    },
    tasks: {
      submit: (...a) => submitTask(env, ...a),
      cancel: (...a) => cancelTask(env, db(), ...a),
      recentAssistantMessages: (...a) => getRecentAssistantMessagesForTask(env, ...a),
      listAgentActivity: (...a) => listAgentActivityTasks(env, ...a),
      listCredentialLimits: (...a) => listProjectCredentialLimits(env, ...a),
      isStatus: isTaskStatus,
      canTransition: canTransitionTaskStatus,
      wakeableStatuses: WAKEABLE_TASK_STATUS_SET,
    },
    triggers: {
      create: (...a) => createTrigger(db(), env, ...a),
      validateCron: (...a) => validateCron(env, ...a),
      clearPageCaches: clearTriggerPageCaches,
      rethrowScheduleError,
      cronToHumanReadable,
      executionUserId: resolveTriggerExecutionUserId,
      statusUpdates: triggerStatusUpdates,
    },
    account: {
      listProfiles: (projectId, userId) => listProfiles(db(), projectId, userId, env),
      profileAccountBindings: (input) => resolveProfileAccountBindings(env, input),
      listOwnCredentialLimitsByReferences: (userId, references) =>
        listOwnCredentialLimitsByReferences(env, { userId, references }),
      tokenUsage: (userId) => getTokenUsage(env.KV, userId, env),
      budgetSettings: (userId) => getUserBudgetSettings(env.KV, userId),
      effectiveBudgetLimits: (settings) => resolveEffectiveLimits(settings, env),
      githubInstallationToken: (installationId) => getInstallationToken(installationId, env),
      listNotifications: (userId, options) =>
        (
          env.NOTIFICATION.get(env.NOTIFICATION.idFromName(userId)) as unknown as Pick<
            NotificationService,
            'listNotifications'
          >
        ).listNotifications(userId, options),
    },
    workspaces: {
      resourceHistory: (...a) => getWorkspaceResourceHistory(env, ...a),
    },
    missions: {
      startOrchestration: (projectId, missionId) => startOrchestration(env, projectId, missionId),
    },
  };
}

/** An operation context built by the worker, which still holds the full worker env. */
export type WorkerOperationContext = OperationContext & { env: Env };

/** Env plus ports, for worker code that calls operations helpers outside an `OperationContext`. */
export function operationDeps(env: Env): OperationDeps {
  return { env, ports: createOperationPorts(env) };
}

/**
 * The operation context for a request a person made in the browser.
 *
 * One definition, because two call sites writing the same actor literal is how the second one
 * quietly loses something — the first copy of this in `routes/tasks/crud.ts` dropped
 * `execCtx`, which is what lets an operation schedule bounded background work.
 *
 * `c.executionCtx` is a getter that throws when there is no execution context, which a
 * unit-test Hono app has; `lib/wait-until.ts` guards it for the same reason. The cast
 * reconciles Hono's `ExecutionContext` type, which omits the runtime's newer tracing field.
 */
export function webOperationContext(
  c: {
    env: Env;
    req: { header(name: string): string | undefined };
    executionCtx: { waitUntil(promise: Promise<unknown>): void };
  },
  userId: string
): OperationContext {
  let execCtx: ExecutionContext | undefined;
  try {
    execCtx = c.executionCtx as unknown as ExecutionContext;
  } catch {
    execCtx = undefined;
  }
  return {
    env: c.env,
    ports: createOperationPorts(c.env),
    requestId: c.req.header('cf-ray') ?? '',
    actor: { userId, via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
    execCtx,
  };
}
