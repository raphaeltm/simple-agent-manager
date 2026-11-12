/**
 * The worker's implementation of the operations ports (`operations/ports.ts`).
 *
 * This is the only place that binds the operations layer to worker-owned services. Each
 * method closes over the request's `env`, so operations never pass the full worker `Env`.
 * Construction is a handful of closures per request; there is no I/O here.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from './db/schema';
import type { NotificationService } from './durable-objects/notification';
import { channelName } from './durable-objects/project-data/project-event-channels-config';
import { scheduleLimits } from './durable-objects/project-data/project-event-schedules-config';
import { resolveProjectEventLimits } from './durable-objects/project-data/project-events-limits';
import { resolveStorageSafetyConfig } from './durable-objects/project-data/storage-safety';
import type { Env } from './env';
import { requireProjectAccess, requireProjectCapability } from './middleware/project-auth';
import type { OperationPorts } from './operations/ports';
import type { OperationContext, OperationDeps } from './operations/types';
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
import {
  connectorPendingInteractions,
  prepareConnectorAgentAnswer,
} from './services/connector-agent-answer';
import { auditConnectorWrite, executeConnectorWrite } from './services/connector-execution';
import { getConnectorReadLimits } from './services/connector-read-settings';
import { listProjectCredentialLimits } from './services/credential-limit-events/read';
import { getInstallationToken } from './services/github-app';
import * as projectData from './services/project-data';
import { authorizeSendChat, sendChat, validateSendChatContent } from './services/send-chat';
import { requireSessionWriter } from './services/session-access';
import { parseHarnessWorkConfig } from './services/session-idleness';
import { submitTask } from './services/submit-task';
import { getRecentAssistantMessagesForTask } from './services/task-final-assistant-message';
import { clearTriggerPageCaches } from './services/trigger-cache';
import { createTrigger, validateCron } from './services/trigger-create';

export function createOperationPorts(env: Env): OperationPorts {
  const db = () => drizzle(env.DATABASE, { schema });
  return {
    config: {
      scheduleLimits: () => scheduleLimits(env),
      projectEventLimits: () => resolveProjectEventLimits(env),
      storageSafety: () => resolveStorageSafetyConfig(env),
      channelName: (value) => channelName(value, env),
      harnessWork: () => parseHarnessWorkConfig(env),
    },
    projectData: {
      getSession: (...a) => projectData.getSession(env, ...a),
      getSessionsByTaskIds: (...a) => projectData.getSessionsByTaskIds(env, ...a),
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
    },
    chat: {
      authorizeSend: (...a) => authorizeSendChat(env, ...a),
      send: (...a) => sendChat(env, ...a),
      validateSendContent: validateSendChatContent,
      stop: (...a) => stopChat(env, ...a),
      interrupt: (...a) => interruptChat(env, ...a),
      answerAttention: (...a) => answerAttention(env, ...a),
      answerAgentInteraction: (...a) => answerAgentInteraction(env, ...a),
      snapshotInteractions: (...a) => snapshotInteractions(env, ...a),
      resolveAgentState: (...a) => resolveChatAgentState(env, ...a),
      attachWakeState: (...a) => attachWakeState(db(), ...a),
    },
    tasks: {
      submit: (...a) => submitTask(env, ...a),
      cancel: (...a) => cancelTask(env, db(), ...a),
      recentAssistantMessages: (...a) => getRecentAssistantMessagesForTask(env, ...a),
      listAgentActivity: (...a) => listAgentActivityTasks(env, ...a),
      listCredentialLimits: (...a) => listProjectCredentialLimits(env, ...a),
    },
    triggers: {
      create: (...a) => createTrigger(db(), env, ...a),
      validateCron: (...a) => validateCron(env, ...a),
      clearPageCaches: clearTriggerPageCaches,
      rethrowScheduleError,
    },
    account: {
      listProfiles: (projectId, userId) => listProfiles(db(), projectId, userId, env),
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
  };
}

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
