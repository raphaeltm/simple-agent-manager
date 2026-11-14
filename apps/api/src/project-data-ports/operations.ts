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
