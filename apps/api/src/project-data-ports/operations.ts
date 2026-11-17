import type { OperationsPort } from '../durable-objects/project-data/ports';
import { alertProjectDataArchiveBreakerOpened } from '../scheduled/project-data-archive-breaker-alerts';
import {
  classifyReconciliationLoop,
  getStalledTaskClassifierConfig,
} from '../scheduled/stalled-task-classifier';
import { resolveAdminSetting } from '../services/admin-settings';
import { deferAlarmWhenDisabled } from '../services/operational-kill-switch';
import { workerEnv } from './worker-env';

/** Operational brakes, the stalled-task loop classifier and operator alerts. */
export const operationsPort: OperationsPort = {
  skipUnsubscribedGitHubCi: async (env) =>
    (await resolveAdminSetting(workerEnv(env), 'events.skipUnsubscribedGitHubCi')) === true,
  messageMergeConfig: async (env) => {
    const [enabled, maxRowBytes, recentIds, toolUpdatesEnabled] = await Promise.all([
      resolveAdminSetting(workerEnv(env), 'chat.messageMergingEnabled'),
      resolveAdminSetting(workerEnv(env), 'chat.messageMergeMaxRowBytes'),
      resolveAdminSetting(workerEnv(env), 'chat.messageMergeRecentIds'),
      resolveAdminSetting(workerEnv(env), 'chat.toolCallMergingEnabled'),
    ]);
    return {
      enabled: enabled === true,
      toolUpdatesEnabled: toolUpdatesEnabled === true,
      maxRowBytes: Number(maxRowBytes),
      recentIds: Number(recentIds),
    };
  },
  rowUsageIntervalMs: async (env) =>
    Number(await resolveAdminSetting(workerEnv(env), 'operations.projectDataRowUsageIntervalMs')),
  alertArchiveBreakerOpened: (env, opening) =>
    alertProjectDataArchiveBreakerOpened(workerEnv(env), opening),
  deferAlarmWhenDisabled: (env, storage, durableObject) =>
    deferAlarmWhenDisabled(workerEnv(env), storage, durableObject),
  stalledTaskClassifierConfig(env) {
    const config = getStalledTaskClassifierConfig(workerEnv(env));
    return { transcriptMaxChars: config.transcriptMaxChars, messageLimit: config.messageLimit };
  },
  classifyReconciliationLoop: (env, messages) =>
    classifyReconciliationLoop(workerEnv(env), messages),
};
